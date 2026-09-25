use crate::db;
use crate::models::CreateGenerationJobRequest;
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
