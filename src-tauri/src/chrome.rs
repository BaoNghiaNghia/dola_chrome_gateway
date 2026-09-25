use crate::models::ProxySettings;
use crate::proxy;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

fn push_candidate(candidates: &mut Vec<PathBuf>, root: Option<String>) {
    if let Some(root) = root {
        candidates.push(
            PathBuf::from(root)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
}

pub fn find_chrome_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    push_candidate(&mut candidates, std::env::var("PROGRAMFILES").ok());
    push_candidate(&mut candidates, std::env::var("PROGRAMFILES(X86)").ok());
    push_candidate(&mut candidates, std::env::var("LOCALAPPDATA").ok());

    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(path);
    }

    Command::new("where")
        .arg("chrome.exe")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| PathBuf::from(line.trim()))
        })
}

pub fn launch(
    profile_path: &Path,
    start_url: Option<&str>,
    proxy_settings: &ProxySettings,
) -> Result<u32, String> {
    if let Some(pid) = find_profile_pid(profile_path)? {
        return Err(format!(
            "This Chrome profile is already running (PID {pid}). Close it before opening another instance."
        ));
    }

    let chrome = find_chrome_executable().ok_or_else(|| {
        "Google Chrome was not found. Install Chrome or add chrome.exe to PATH.".to_string()
    })?;

    std::fs::create_dir_all(profile_path)
        .map_err(|e| format!("Cannot create profile directory: {e}"))?;

    let mut command = Command::new(chrome);
    command
        .arg(format!("--user-data-dir={}", profile_path.to_string_lossy()))
        .arg("--no-first-run")
        .arg("--new-window");

    if let Some(proxy_server) = proxy::proxy_server_arg(proxy_settings)? {
        command.arg(format!("--proxy-server={proxy_server}"));
    }

    let child = command
        .arg(start_url.unwrap_or("about:blank"))
        .spawn()
        .map_err(|e| format!("Cannot start Chrome: {e}"))?;

    Ok(child.id())
}

#[cfg(target_os = "windows")]
fn chrome_processes() -> Result<Vec<(u32, String)>, String> {
    let script = r#"
$items = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Select-Object ProcessId, CommandLine
if ($null -eq $items) {
  Write-Output '[]'
} else {
  $items | ConvertTo-Json -Compress
}
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("Cannot inspect Chrome processes: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "[]" {
        return Ok(Vec::new());
    }

    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Cannot parse Chrome process list: {e}"))?;
    let items = match value {
        Value::Array(items) => items,
        single => vec![single],
    };

    Ok(items
        .into_iter()
        .filter_map(|item| {
            let pid = item.get("ProcessId")?.as_u64()? as u32;
            let command_line = item
                .get("CommandLine")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some((pid, command_line))
        })
        .collect())
}

#[cfg(not(target_os = "windows"))]
fn chrome_processes() -> Result<Vec<(u32, String)>, String> {
    Ok(Vec::new())
}

fn normalize_path_for_match(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

pub fn discover_profile_pids(
    profiles: &[(String, PathBuf)],
) -> Result<HashMap<String, u32>, String> {
    let needles = profiles
        .iter()
        .map(|(id, path)| (id.clone(), normalize_path_for_match(path)))
        .collect::<Vec<_>>();
    let processes = chrome_processes()?;
    let mut discovered = HashMap::new();

    for (pid, command_line) in processes {
        let normalized = command_line.replace('/', "\\").to_lowercase();
        if !normalized.contains("--user-data-dir") {
            continue;
        }

        for (profile_id, needle) in &needles {
            if normalized.contains(needle) {
                discovered.entry(profile_id.clone()).or_insert(pid);
                break;
            }
        }
    }

    Ok(discovered)
}

pub fn find_profile_pid(profile_path: &Path) -> Result<Option<u32>, String> {
    let profiles = vec![("__single__".to_string(), profile_path.to_path_buf())];
    Ok(discover_profile_pids(&profiles)?.remove("__single__"))
}

#[cfg(target_os = "windows")]
pub fn is_pid_running(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            text.contains(&format!(",\"{pid}\","))
        }
        _ => false,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_pid_running(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn request_graceful_close(pid: u32) -> Result<(), String> {
    let script = format!(
        "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($null -ne $p) {{ [void]$p.CloseMainWindow() }}"
    );
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("Cannot request graceful Chrome shutdown: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn request_graceful_close(_pid: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn force_close_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| format!("Cannot force-close Chrome process: {e}"))?;

    if output.status.success() || !is_pid_running(pid) {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "Chrome did not close cleanly.".into()
        } else {
            message
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn force_close_process_tree(_pid: u32) -> Result<(), String> {
    Err("Chrome process management is currently supported on Windows only.".into())
}

pub fn close_profile(profile_path: &Path, known_pid: Option<u32>) -> Result<(), String> {
    let pid = match known_pid.filter(|pid| is_pid_running(*pid)) {
        Some(pid) => Some(pid),
        None => find_profile_pid(profile_path)?,
    };

    let Some(pid) = pid else {
        return Ok(());
    };

    request_graceful_close(pid)?;

    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if find_profile_pid(profile_path)?.is_none() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    force_close_process_tree(pid)
}
