use crate::chrome;
use crate::db;
use crate::models::{ExecutionBrowserSession, ProxyPoolItem, ProxySettings};
use crate::proxy;
use chrono::Utc;
use std::path::{Path, PathBuf};

const MAX_SIMULTANEOUS_PROFILES: usize = 4;

fn pool_item_settings(item: &ProxyPoolItem) -> ProxySettings {
    ProxySettings {
        enabled: true,
        protocol: item.protocol.clone(),
        host: item.host.clone(),
        port: item.port,
        auth_username: item.auth_username.clone(),
        rotation_mode: "sticky".into(),
        rotation_url: item.rotation_url.clone(),
        last_ip: item.last_ip.clone(),
        health: item.health.clone(),
        last_latency_ms: item.last_latency_ms,
        last_checked_at: item.last_checked_at.clone(),
    }
}

fn validate_start_url(start_url: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = start_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if raw == "about:blank" || raw.starts_with("https://") || raw.starts_with("http://") {
        return Ok(Some(raw.to_string()));
    }

    Err("Execution browser startUrl must use http://, https://, or about:blank.".into())
}

fn sync_running_profiles(db_path: &Path) -> Result<Vec<String>, String> {
    let profiles = db::list_profiles(db_path)?;
    let paths = profiles
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                PathBuf::from(profile.profile_path.as_str()),
            )
        })
        .collect::<Vec<_>>();
    let discovered = chrome::discover_profile_pids(&paths)?;
    let running_ids = discovered.keys().cloned().collect::<Vec<_>>();
    db::release_stale_proxy_assignments(db_path, &running_ids)?;
    Ok(running_ids)
}

fn prepare_proxy_for_profile(db_path: &Path, profile_id: &str) -> Result<ProxySettings, String> {
    if !db::get_global_proxy_enabled(db_path)? {
        return Ok(ProxySettings::default());
    }

    let candidates = db::list_available_pool_proxies(db_path, 1000)?;
    if candidates.is_empty() {
        return Err(
            "Proxy Pool is enabled, but no unused proxy slot is available for this execution browser."
                .into(),
        );
    }

    let mut failures = Vec::new();
    for item in candidates {
        let settings = pool_item_settings(&item);
        if let Err(error) = proxy::validate(&settings) {
            failures.push(format!("{}: {}", item.name, error));
            continue;
        }

        if item
            .rotation_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|url| !url.is_empty())
        {
            if let Err(error) = proxy::rotate(&settings) {
                let _ = db::record_pool_proxy_failure(db_path, &item.id, &Utc::now().to_rfc3339());
                failures.push(format!("{}: {}", item.name, error));
                continue;
            }
        }

        match proxy::check(&settings) {
            Ok(check) => {
                db::record_pool_proxy_check(db_path, &item.id, &check)?;
                db::assign_pool_proxy(db_path, profile_id, &item.id, check.public_ip.as_deref())?;
                return Ok(settings);
            }
            Err(error) => {
                let _ = db::record_pool_proxy_failure(db_path, &item.id, &Utc::now().to_rfc3339());
                failures.push(format!("{}: {}", item.name, error));
            }
        }
    }

    Err(format!(
        "Proxy Pool could not prepare a healthy proxy for the execution browser. {}",
        failures.join(" | ")
    ))
}

pub fn open(
    db_path: &Path,
    job_id: &str,
    lease_token: &str,
    start_url: Option<&str>,
) -> Result<ExecutionBrowserSession, String> {
    let job = db::get_leased_generation_job(db_path, job_id, lease_token)?;
    let profile_id = job
        .profile_id
        .as_deref()
        .ok_or_else(|| "Generation job has no assigned profile.".to_string())?;
    let start_url = validate_start_url(start_url)?;

    let running_ids = sync_running_profiles(db_path)?;
    let already_running = running_ids.iter().any(|id| id == profile_id);
    if !already_running && running_ids.len() >= MAX_SIMULTANEOUS_PROFILES {
        return Err(format!(
            "Cannot open execution browser because {MAX_SIMULTANEOUS_PROFILES} Chrome profiles are already running."
        ));
    }

    let profile = db::get_profile(db_path, profile_id)?
        .ok_or_else(|| "Assigned profile no longer exists.".to_string())?;
    let profile_path = PathBuf::from(&profile.profile_path);

    let effective_proxy = if already_running {
        if db::get_global_proxy_enabled(db_path)? && profile.active_proxy.is_none() {
            return Err(
                "This running profile has no Proxy Pool assignment. Close it and let the adapter reopen it so routing stays consistent."
                    .into(),
            );
        }
        if let Some(active) = profile.active_proxy.as_ref() {
            let item = db::get_proxy_pool_item(db_path, &active.proxy_id)?.ok_or_else(|| {
                "The running profile's assigned proxy no longer exists.".to_string()
            })?;
            pool_item_settings(&item)
        } else {
            ProxySettings::default()
        }
    } else {
        prepare_proxy_for_profile(db_path, profile_id)?
    };

    let browser =
        match chrome::launch_debuggable(&profile_path, start_url.as_deref(), &effective_proxy) {
            Ok(browser) => browser,
            Err(error) => {
                if !already_running {
                    let _ = db::release_profile_proxy_assignment(db_path, profile_id);
                }
                return Err(error);
            }
        };

    db::touch_last_opened(db_path, profile_id)?;
    let refreshed = db::get_profile(db_path, profile_id)?
        .ok_or_else(|| "Execution profile disappeared after launch.".to_string())?;

    Ok(ExecutionBrowserSession {
        profile_id: profile_id.to_string(),
        pid: browser.pid,
        devtools_port: browser.devtools_port,
        cdp_http_url: format!("http://127.0.0.1:{}", browser.devtools_port),
        browser_websocket_url: browser.browser_websocket_url,
        active_proxy: refreshed.active_proxy,
    })
}

pub fn close(db_path: &Path, job_id: &str, lease_token: &str) -> Result<(), String> {
    let job = db::get_leased_generation_job(db_path, job_id, lease_token)?;
    let profile_id = job
        .profile_id
        .as_deref()
        .ok_or_else(|| "Generation job has no assigned profile.".to_string())?;
    let profile = db::get_profile(db_path, profile_id)?
        .ok_or_else(|| "Assigned profile no longer exists.".to_string())?;
    let profile_path = PathBuf::from(&profile.profile_path);
    let pid = chrome::find_profile_pid(&profile_path)?;

    chrome::close_profile(&profile_path, pid)?;
    db::release_profile_proxy_assignment(db_path, profile_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_url_validation_accepts_only_web_or_blank_urls() {
        assert_eq!(
            validate_start_url(Some("https://example.com")).unwrap(),
            Some("https://example.com".to_string())
        );
        assert_eq!(
            validate_start_url(Some("about:blank")).unwrap(),
            Some("about:blank".to_string())
        );
        assert!(validate_start_url(Some("file:///c:/secret.txt")).is_err());
        assert!(validate_start_url(Some("javascript:alert(1)")).is_err());
    }
}
