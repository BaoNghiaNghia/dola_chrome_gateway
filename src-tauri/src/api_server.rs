use crate::db;
use crate::execution_browser;
use crate::models::{
    AdapterBrowserCloseRequest, AdapterBrowserOpenRequest, AdapterClaimRequest,
    AdapterCompleteRequest, AdapterFailRequest, AdapterHeartbeatRequest,
    AdapterProfileStateRequest, AdapterProgressRequest, AdapterStartRequest,
    CreateGenerationJobRequest,
};
use crate::state::BackgroundRuntime;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn write_json(stream: &mut TcpStream, value: Value, status: u16) -> Result<(), String> {
    let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason_phrase(status),
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|e| format!("Cannot write Local API response: {e}"))
}

fn write_error(stream: &mut TcpStream, message: impl Into<String>, status: u16) {
    let _ = write_json(
        stream,
        json!({"error": {"message": message.into()}}),
        status,
    );
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;

    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end;

    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|e| format!("Cannot read Local API request: {e}"))?;
        if read == 0 {
            return Err("Connection closed before request headers were complete.".into());
        }
        buffer.extend_from_slice(&chunk[..read]);

        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err("Request is too large.".into());
        }

        if let Some(position) = find_header_end(&buffer) {
            header_end = position;
            break;
        }

        if buffer.len() > MAX_HEADER_BYTES {
            return Err("Request headers are too large.".into());
        }
    }

    let header_text = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| "Request headers must be valid UTF-8.".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP request line.".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP method.".to_string())?
        .to_string();
    let raw_path = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP path.".to_string())?;
    let path = raw_path
        .split('?')
        .next()
        .unwrap_or(raw_path)
        .trim_end_matches('/')
        .to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err("Request body is too large.".into());
    }

    let body_start = header_end + 4;
    let expected_total = body_start + content_length;
    while buffer.len() < expected_total {
        let remaining = expected_total - buffer.len();
        let read_size = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..read_size])
            .map_err(|e| format!("Cannot read Local API request body: {e}"))?;
        if read == 0 {
            return Err("Connection closed before request body was complete.".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    Ok(HttpRequest {
        method,
        path,
        headers,
        body: buffer[body_start..expected_total].to_vec(),
    })
}

fn authorized(request: &HttpRequest, db_path: &Path) -> bool {
    let settings = match db::get_local_api_settings(db_path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let expected = format!("Bearer {}", settings.api_key);
    request
        .headers
        .get("authorization")
        .is_some_and(|value| value == &expected)
}

fn handle_request(mut stream: TcpStream, db_path: &Path) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let status = if error.contains("too large") {
                413
            } else {
                400
            };
            write_error(&mut stream, error, status);
            return;
        }
    };

    if request.method == "GET" && request.path == "/health" {
        let _ = write_json(
            &mut stream,
            json!({
                "status": "ok",
                "service": "dola-chrome-gateway",
                "version": env!("CARGO_PKG_VERSION")
            }),
            200,
        );
        return;
    }

    if !authorized(&request, db_path) {
        write_error(&mut stream, "Unauthorized.", 401);
        return;
    }

    if request.method == "POST" && request.path == "/v1/adapter/claim" {
        let parsed = serde_json::from_slice::<AdapterClaimRequest>(&request.body)
            .map_err(|e| format!("Invalid adapter claim request: {e}"))
            .and_then(|payload| {
                db::claim_adapter_job(
                    db_path,
                    &payload.worker_id,
                    payload.lease_seconds.unwrap_or(120),
                )
            });
        match parsed {
            Ok(claim) => {
                let _ = write_json(&mut stream, json!({"claim": claim}), 200);
            }
            Err(error) => write_error(&mut stream, error, 400),
        }
        return;
    }

    if let Some(adapter_path) = request.path.strip_prefix("/v1/adapter/jobs/") {
        if request.method != "POST" {
            write_error(&mut stream, "Method not allowed.", 405);
            return;
        }

        if let Some(job_id) = adapter_path.strip_suffix("/browser/open") {
            let result = serde_json::from_slice::<AdapterBrowserOpenRequest>(&request.body)
                .map_err(|e| format!("Invalid browser open request: {e}"))
                .and_then(|payload| {
                    execution_browser::open(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        payload.start_url.as_deref(),
                    )
                });

            match result {
                Ok(session) => {
                    let _ = write_json(&mut stream, json!(session), 200);
                }
                Err(error) => {
                    let status = if error.contains("lease") || error.contains("owned") {
                        409
                    } else {
                        400
                    };
                    write_error(&mut stream, error, status);
                }
            }
            return;
        }

        if let Some(job_id) = adapter_path.strip_suffix("/browser/close") {
            let result = serde_json::from_slice::<AdapterBrowserCloseRequest>(&request.body)
                .map_err(|e| format!("Invalid browser close request: {e}"))
                .and_then(|payload| {
                    execution_browser::close(db_path, job_id, &payload.lease_token)
                });

            match result {
                Ok(()) => {
                    let _ = write_json(&mut stream, json!({"closed": true}), 200);
                }
                Err(error) => {
                    let status = if error.contains("lease") || error.contains("owned") {
                        409
                    } else {
                        400
                    };
                    write_error(&mut stream, error, status);
                }
            }
            return;
        }

        if let Some(job_id) = adapter_path.strip_suffix("/profile-state") {
            let result = serde_json::from_slice::<AdapterProfileStateRequest>(&request.body)
                .map_err(|e| format!("Invalid profile state request: {e}"))
                .and_then(|payload| {
                    let lease_token = payload.lease_token.clone();
                    db::update_leased_profile_state(db_path, job_id, &lease_token, payload)
                });

            match result {
                Ok(state) => {
                    let _ = write_json(&mut stream, json!(state), 200);
                }
                Err(error) => {
                    let status = if error.contains("lease") || error.contains("owned") {
                        409
                    } else {
                        400
                    };
                    write_error(&mut stream, error, status);
                }
            }
            return;
        }

        let Some((job_id, action)) = adapter_path.rsplit_once('/') else {
            write_error(&mut stream, "Adapter action is required.", 404);
            return;
        };

        let result = match action {
            "heartbeat" => serde_json::from_slice::<AdapterHeartbeatRequest>(&request.body)
                .map_err(|e| format!("Invalid heartbeat request: {e}"))
                .and_then(|payload| {
                    db::heartbeat_adapter_job(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        payload.lease_seconds.unwrap_or(120),
                    )
                }),
            "start" => serde_json::from_slice::<AdapterStartRequest>(&request.body)
                .map_err(|e| format!("Invalid start request: {e}"))
                .and_then(|payload| {
                    db::start_adapter_job(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        payload.external_task_id.as_deref(),
                        payload.deadline_at.as_deref(),
                    )
                }),
            "progress" => serde_json::from_slice::<AdapterProgressRequest>(&request.body)
                .map_err(|e| format!("Invalid progress request: {e}"))
                .and_then(|payload| {
                    db::progress_adapter_job(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        payload.external_task_id.as_deref(),
                        payload.progress_percent.unwrap_or(0),
                    )
                }),
            "complete" => serde_json::from_slice::<AdapterCompleteRequest>(&request.body)
                .map_err(|e| format!("Invalid complete request: {e}"))
                .and_then(|payload| {
                    db::complete_adapter_job(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        &payload.result_url,
                        payload.local_path.as_deref(),
                        payload.width,
                        payload.height,
                        payload.bitrate,
                        payload.file_size,
                        payload.no_watermark,
                        payload.source_kind.as_deref(),
                    )
                }),
            "fail" => serde_json::from_slice::<AdapterFailRequest>(&request.body)
                .map_err(|e| format!("Invalid fail request: {e}"))
                .and_then(|payload| {
                    db::fail_adapter_job(
                        db_path,
                        job_id,
                        &payload.lease_token,
                        payload.failure_code.as_deref(),
                        payload.error_message.as_deref(),
                        payload.retryable.unwrap_or(false),
                        payload.retry_after_seconds.unwrap_or(30),
                    )
                }),
            _ => {
                write_error(&mut stream, "Adapter action not found.", 404);
                return;
            }
        };

        match result {
            Ok(job) => {
                let _ = write_json(&mut stream, json!(job), 200);
            }
            Err(error) => {
                let status = if error.contains("lease") || error.contains("owned") {
                    409
                } else {
                    400
                };
                write_error(&mut stream, error, status);
            }
        }
        return;
    }

    if request.method == "GET" && request.path == "/v1/videos" {
        match db::list_generation_jobs(db_path) {
            Ok(jobs) => {
                let _ = write_json(&mut stream, json!({"data": jobs}), 200);
            }
            Err(error) => write_error(&mut stream, error, 500),
        }
        return;
    }

    if request.method == "POST" && request.path == "/v1/videos/generations" {
        let parsed = serde_json::from_slice::<CreateGenerationJobRequest>(&request.body)
            .map_err(|e| format!("Invalid generation request: {e}"))
            .and_then(|payload| db::create_generation_job(db_path, payload));
        match parsed {
            Ok(job) => {
                let _ = write_json(&mut stream, json!(job), 202);
            }
            Err(error) => write_error(&mut stream, error, 400),
        }
        return;
    }

    if let Some(job_path) = request.path.strip_prefix("/v1/videos/") {
        if request.method == "POST" {
            if let Some(job_id) = job_path.strip_suffix("/cancel") {
                match db::cancel_generation_job(db_path, job_id) {
                    Ok(job) => {
                        let _ = write_json(&mut stream, json!(job), 200);
                    }
                    Err(error) => write_error(&mut stream, error, 404),
                }
                return;
            }
            write_error(&mut stream, "Endpoint not found.", 404);
            return;
        }

        if request.method == "GET" {
            match db::get_generation_job(db_path, job_path) {
                Ok(Some(job)) => {
                    let _ = write_json(&mut stream, json!(job), 200);
                }
                Ok(None) => write_error(&mut stream, "Generation job not found.", 404),
                Err(error) => write_error(&mut stream, error, 500),
            }
            return;
        }

        write_error(&mut stream, "Method not allowed.", 405);
        return;
    }

    write_error(&mut stream, "Endpoint not found.", 404);
}

pub fn start(db_path: PathBuf, port: u16) -> Result<BackgroundRuntime, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Cannot bind Local API to 127.0.0.1:{port}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Cannot configure Local API listener: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = thread::Builder::new()
        .name("dola-local-api".into())
        .spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => handle_request(stream, &db_path),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        })
        .map_err(|e| format!("Cannot start Local API thread: {e}"))?;

    Ok(BackgroundRuntime::new(stop, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CreateGenerationJobRequest, CreateProfileRequest, GenerationJob,
        UpdateProfileOperationalStateRequest,
    };
    use chrono::Utc;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;
    use uuid::Uuid;

    fn temp_db() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("dola-api-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let db_path = root.join("test.sqlite3");
        db::init(&db_path).unwrap();
        (root, db_path)
    }

    fn free_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    fn send(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn response_body(response: &str) -> &str {
        response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    fn post_json(port: u16, path: &str, api_key: &str, body: &str) -> String {
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {api_key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        send(port, &request)
    }

    fn create_assigned_job(root: &Path, db_path: &Path) -> GenerationJob {
        let profiles_dir = root.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();

        let profile = db::create_profile(
            db_path,
            &profiles_dir,
            CreateProfileRequest {
                name: "Adapter profile".into(),
                email: None,
                group_name: None,
                services: vec![],
                tags: vec![],
                notes: None,
                proxy: None,
            },
        )
        .unwrap();

        db::update_profile_operational_state(
            db_path,
            &profile.id,
            UpdateProfileOperationalStateRequest {
                scheduling_enabled: Some(true),
                session_status: Some("healthy".into()),
                login_checked_at: Some(Utc::now().to_rfc3339()),
                cooldown_until: None,
                rate_limited_until: None,
                quota_blocked_until: None,
                credit_balance: None,
                used_today: Some(0),
                remaining: None,
                last_used_at: None,
            },
        )
        .unwrap();
        db::set_scheduler_enabled(db_path, true).unwrap();
        db::set_worker_enabled(db_path, true).unwrap();

        let job = db::create_generation_job(
            db_path,
            CreateGenerationJobRequest {
                prompt: "adapter lifecycle".into(),
                model: Some("seedance-2.5".into()),
                duration_seconds: Some(10),
                ratio: Some("1:1".into()),
            },
        )
        .unwrap();

        assert_eq!(crate::worker::allocation_tick(db_path).unwrap(), 1);
        db::get_generation_job(db_path, &job.id).unwrap().unwrap()
    }

    #[test]
    fn local_api_health_and_generation_creation_work() {
        let (root, db_path) = temp_db();
        let port = free_port();
        let runtime = start(db_path.clone(), port).unwrap();

        let health = send(
            port,
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(health.starts_with("HTTP/1.1 200 OK"));
        assert!(health.contains("\"status\":\"ok\""));

        let api_key = db::get_local_api_settings(&db_path).unwrap().api_key;
        let body = r#"{"prompt":"test generation","model":"seedance-2.5","durationSeconds":10,"ratio":"1:1"}"#;
        let request = format!(
            "POST /v1/videos/generations HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {api_key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let created = send(port, &request);
        assert!(created.starts_with("HTTP/1.1 202 Accepted"));
        assert!(created.contains("\"status\":\"queued\""));

        let jobs = db::list_generation_jobs(&db_path).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].prompt, "test generation");

        runtime.stop();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adapter_http_lifecycle_completes_assigned_job() {
        let (root, db_path) = temp_db();
        let assigned = create_assigned_job(&root, &db_path);
        let port = free_port();
        let runtime = start(db_path.clone(), port).unwrap();
        let api_key = db::get_local_api_settings(&db_path).unwrap().api_key;

        let claim = post_json(
            port,
            "/v1/adapter/claim",
            &api_key,
            r#"{"workerId":"adapter-test","leaseSeconds":120}"#,
        );
        assert!(claim.starts_with("HTTP/1.1 200 OK"));
        let claim_json: Value = serde_json::from_str(response_body(&claim)).unwrap();
        let lease_token = claim_json["claim"]["leaseToken"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            claim_json["claim"]["job"]["id"].as_str(),
            Some(assigned.id.as_str())
        );

        let start_body =
            format!(r#"{{"leaseToken":"{lease_token}","externalTaskId":"seed-task-1"}}"#);
        let started = post_json(
            port,
            &format!("/v1/adapter/jobs/{}/start", assigned.id),
            &api_key,
            &start_body,
        );
        assert!(started.contains("\"status\":\"starting\""));

        let progress_body = format!(
            r#"{{"leaseToken":"{lease_token}","externalTaskId":"seed-task-1","progressPercent":42}}"#
        );
        let progress = post_json(
            port,
            &format!("/v1/adapter/jobs/{}/progress", assigned.id),
            &api_key,
            &progress_body,
        );
        assert!(progress.contains("\"status\":\"generating\""));
        assert!(progress.contains("\"progressPercent\":42"));

        let complete_body = format!(
            r#"{{"leaseToken":"{lease_token}","resultUrl":"https://example.test/result.mp4","localPath":"C:\\Dola\\downloads\\job.mp4","width":1920,"height":1080,"bitrate":8000000,"fileSize":12345678,"noWatermark":true,"sourceKind":"video_model"}}"#
        );
        let completed = post_json(
            port,
            &format!("/v1/adapter/jobs/{}/complete", assigned.id),
            &api_key,
            &complete_body,
        );
        assert!(completed.contains("\"status\":\"completed\""));
        assert!(completed.contains("\"progressPercent\":100"));

        let stored = db::get_generation_job(&db_path, &assigned.id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.attempt_count, 1);
        assert_eq!(stored.progress_percent, 100);
        assert!(stored.lease_owner.is_none());
        assert_eq!(
            stored.result_url.as_deref(),
            Some("https://example.test/result.mp4")
        );
        assert_eq!(
            stored.local_path.as_deref(),
            Some("C:\\Dola\\downloads\\job.mp4")
        );
        assert_eq!(stored.result_width, Some(1920));
        assert_eq!(stored.result_height, Some(1080));
        assert_eq!(stored.result_bitrate, Some(8_000_000));
        assert_eq!(stored.result_file_size, Some(12_345_678));
        assert_eq!(stored.result_no_watermark, Some(true));
        assert_eq!(stored.result_source_kind.as_deref(), Some("video_model"));

        runtime.stop();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adapter_runtime_recovery_preserves_external_task_for_resume() {
        let (root, db_path) = temp_db();
        let assigned = create_assigned_job(&root, &db_path);

        let claim = db::claim_adapter_job(&db_path, "seedance-adapter-4242-1", 120)
            .unwrap()
            .unwrap();
        let started = db::start_adapter_job(
            &db_path,
            &assigned.id,
            &claim.lease_token,
            Some("conversation-123"),
            None,
        )
        .unwrap();
        assert_eq!(started.status, "starting");

        let profiles =
            db::recover_adapter_runtime_leases(&db_path, "seedance-adapter-4242-").unwrap();
        assert_eq!(profiles.len(), 1);

        let recovered = db::get_generation_job(&db_path, &assigned.id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, "recovering");
        assert_eq!(
            recovered.external_task_id.as_deref(),
            Some("conversation-123")
        );
        assert!(recovered.lease_owner.is_none());
        assert!(recovered.lease_expires_at.is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adapter_can_update_assigned_profile_health() {
        let (root, db_path) = temp_db();
        let assigned = create_assigned_job(&root, &db_path);
        let profile_id = assigned.profile_id.clone().unwrap();
        let port = free_port();
        let runtime = start(db_path.clone(), port).unwrap();
        let api_key = db::get_local_api_settings(&db_path).unwrap().api_key;

        let claim = post_json(
            port,
            "/v1/adapter/claim",
            &api_key,
            r#"{"workerId":"adapter-health","leaseSeconds":120}"#,
        );
        let claim_json: Value = serde_json::from_str(response_body(&claim)).unwrap();
        let lease_token = claim_json["claim"]["leaseToken"].as_str().unwrap();

        let body = format!(
            r#"{{"leaseToken":"{lease_token}","sessionStatus":"needs_login","loginCheckedAt":"2026-09-25T12:00:00Z"}}"#
        );
        let response = post_json(
            port,
            &format!("/v1/adapter/jobs/{}/profile-state", assigned.id),
            &api_key,
            &body,
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("\"availability\":\"needs_login\""));

        let profile = db::get_profile(&db_path, &profile_id).unwrap().unwrap();
        assert_eq!(profile.operational.session_status, "needs_login");
        assert_eq!(profile.operational.availability, "needs_login");

        runtime.stop();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adapter_retryable_failure_requeues_job() {
        let (root, db_path) = temp_db();
        let assigned = create_assigned_job(&root, &db_path);
        let port = free_port();
        let runtime = start(db_path.clone(), port).unwrap();
        let api_key = db::get_local_api_settings(&db_path).unwrap().api_key;

        let claim = post_json(
            port,
            "/v1/adapter/claim",
            &api_key,
            r#"{"workerId":"adapter-retry","leaseSeconds":120}"#,
        );
        let claim_json: Value = serde_json::from_str(response_body(&claim)).unwrap();
        let lease_token = claim_json["claim"]["leaseToken"].as_str().unwrap();

        let fail_body = format!(
            r#"{{"leaseToken":"{lease_token}","failureCode":"temporary","errorMessage":"retry me","retryable":true,"retryAfterSeconds":1}}"#
        );
        let failed = post_json(
            port,
            &format!("/v1/adapter/jobs/{}/fail", assigned.id),
            &api_key,
            &fail_body,
        );
        assert!(failed.contains("\"status\":\"queued\""));

        let stored = db::get_generation_job(&db_path, &assigned.id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, "queued");
        assert_eq!(stored.attempt_count, 1);
        assert!(stored.profile_id.is_none());
        assert!(stored.lease_owner.is_none());
        assert!(stored.next_retry_at.is_some());

        runtime.stop();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn protected_endpoint_rejects_missing_bearer_token() {
        let (root, db_path) = temp_db();
        let port = free_port();
        let runtime = start(db_path, port).unwrap();

        let response = send(
            port,
            "GET /v1/videos HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized"));

        runtime.stop();
        let _ = fs::remove_dir_all(root);
    }
}
