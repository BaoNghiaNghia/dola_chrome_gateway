use crate::models::ProxySettings;
use crate::proxy;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_START_URL: &str = "https://www.dola.com/chat";
pub const DEFAULT_ZOOM_PERCENT: u8 = 85;
const DEFAULT_ZOOM_LEVEL: f64 = -0.8913862538012496;

fn mark_profile_shutdown_clean(profile_path: &Path) -> Result<(), String> {
    if !profile_path.is_dir() {
        return Err(format!(
            "Chrome session storage is unavailable at {}.",
            profile_path.display()
        ));
    }

    let preferences_path = profile_path.join("Default").join("Preferences");
    let mut preferences: Value = if preferences_path.is_file() {
        let raw = std::fs::read_to_string(&preferences_path)
            .map_err(|e| format!("Cannot read Chrome Preferences: {e}"))?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("Cannot parse Chrome Preferences: {e}"))?
    } else {
        Value::Object(Default::default())
    };

    let root = preferences
        .as_object_mut()
        .ok_or_else(|| "Chrome Preferences root is invalid.".to_string())?;

    let profile = root
        .entry("profile".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let profile = profile
        .as_object_mut()
        .ok_or_else(|| "Chrome profile Preferences are invalid.".to_string())?;
    profile.insert("exit_type".to_string(), Value::String("Normal".to_string()));
    profile.insert("exited_cleanly".to_string(), Value::Bool(true));

    let partition = root
        .entry("partition".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let partition = partition
        .as_object_mut()
        .ok_or_else(|| "Chrome partition Preferences are invalid.".to_string())?;

    // Chromium stores zoom preferences as dictionaries keyed by storage
    // partition. The default storage partition has an empty relative path,
    // which Chromium encodes as the key "x".
    let zoom_level = serde_json::Number::from_f64(DEFAULT_ZOOM_LEVEL)
        .ok_or_else(|| "Default Chrome zoom level is invalid.".to_string())?;

    let default_zoom_levels = partition
        .entry("default_zoom_level".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !default_zoom_levels.is_object() {
        *default_zoom_levels = Value::Object(Default::default());
    }
    default_zoom_levels
        .as_object_mut()
        .ok_or_else(|| "Chrome default zoom Preferences are invalid.".to_string())?
        .insert("x".to_string(), Value::Number(zoom_level));

    let per_host_zoom_levels = partition
        .entry("per_host_zoom_levels".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !per_host_zoom_levels.is_object() {
        *per_host_zoom_levels = Value::Object(Default::default());
    }
    per_host_zoom_levels
        .as_object_mut()
        .ok_or_else(|| "Chrome host zoom Preferences are invalid.".to_string())?
        .insert("x".to_string(), Value::Object(Default::default()));

    if let Some(parent) = preferences_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot prepare Chrome Preferences directory: {e}"))?;
    }

    let serialized = serde_json::to_vec(&preferences)
        .map_err(|e| format!("Cannot serialize Chrome Preferences: {e}"))?;
    std::fs::write(&preferences_path, serialized)
        .map_err(|e| format!("Cannot update Chrome Preferences: {e}"))
}

fn ensure_managed_profile_storage(profile_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let required_root = Path::new(r"E:\Dola Chrome\Profiles");
        let candidate = normalize_path_for_match(profile_path);
        let required = normalize_path_for_match(required_root);
        if !candidate.starts_with(&(required + "\\")) {
            return Err(format!(
                "Chrome profile storage must be under E:\\Dola Chrome\\Profiles. Current path: {}. No new session was created.",
                profile_path.display()
            ));
        }
    }

    if !profile_path.is_dir() {
        return Err(format!(
            "Chrome session storage is missing at {}. No new session was created.",
            profile_path.display()
        ));
    }

    Ok(())
}

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

#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn SystemParametersInfoW(
        ui_action: u32,
        ui_param: u32,
        pv_param: *mut std::ffi::c_void,
        f_win_ini: u32,
    ) -> i32;
    fn EnumWindows(
        callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
        l_param: isize,
    ) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn MoveWindow(
        hwnd: isize,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        repaint: i32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
fn primary_work_area() -> (i32, i32, i32, i32) {
    const SPI_GETWORKAREA: u32 = 0x0030;
    let mut rect = WinRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            (&mut rect as *mut WinRect).cast::<std::ffi::c_void>(),
            0,
        )
    };

    if ok == 0 || rect.right <= rect.left || rect.bottom <= rect.top {
        (0, 0, 1920, 1080)
    } else {
        (
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
        )
    }
}

#[cfg(not(target_os = "windows"))]
fn primary_work_area() -> (i32, i32, i32, i32) {
    (0, 0, 1920, 1080)
}

fn grid_bounds(slot: usize) -> WindowBounds {
    const COLUMNS: i32 = 3;
    const ROWS: i32 = 3;

    let (origin_x, origin_y, screen_width, screen_height) = primary_work_area();
    let column = (slot % COLUMNS as usize) as i32;
    let row = ((slot / COLUMNS as usize) % ROWS as usize) as i32;
    let width = (screen_width / COLUMNS).max(1);
    let height = (screen_height / ROWS).max(1);

    WindowBounds {
        x: origin_x + column * width,
        y: origin_y + row * height,
        width,
        height,
    }
}

fn apply_grid_args(command: &mut Command, slot: usize) {
    let bounds = grid_bounds(slot);
    command
        .arg(format!("--window-position={},{}", bounds.x, bounds.y))
        .arg(format!("--window-size={},{}", bounds.width, bounds.height));
}

#[cfg(target_os = "windows")]
struct FindWindowContext {
    pid: u32,
    hwnd: isize,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn find_window_callback(hwnd: isize, l_param: isize) -> i32 {
    let context = &mut *(l_param as *mut FindWindowContext);
    let mut pid = 0_u32;
    GetWindowThreadProcessId(hwnd, &mut pid);

    if pid == context.pid && IsWindowVisible(hwnd) != 0 {
        context.hwnd = hwnd;
        return 0;
    }

    1
}

#[cfg(target_os = "windows")]
fn find_visible_window(pid: u32) -> Option<isize> {
    let mut context = FindWindowContext { pid, hwnd: 0 };
    unsafe {
        EnumWindows(
            Some(find_window_callback),
            (&mut context as *mut FindWindowContext) as isize,
        );
    }

    (context.hwnd != 0).then_some(context.hwnd)
}

#[cfg(target_os = "windows")]
pub fn tile_windows(pids: &[u32]) {
    let mut pids = pids.to_vec();
    pids.sort_unstable();
    pids.dedup();

    for (slot, pid) in pids.into_iter().enumerate() {
        let bounds = grid_bounds(slot);
        let deadline = Instant::now() + Duration::from_secs(2);

        while Instant::now() < deadline {
            if let Some(hwnd) = find_visible_window(pid) {
                unsafe {
                    MoveWindow(
                        hwnd,
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        1,
                    );
                }
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn tile_windows(_pids: &[u32]) {}

pub fn launch(
    profile_path: &Path,
    start_url: Option<&str>,
    proxy_settings: &ProxySettings,
    window_slot: usize,
) -> Result<DebugBrowserInfo, String> {
    launch_debuggable(profile_path, start_url, proxy_settings, window_slot)
}

pub fn launch_login(
    profile_path: &Path,
    start_url: Option<&str>,
    proxy_settings: &ProxySettings,
    window_slot: usize,
) -> Result<u32, String> {
    if let Some(pid) = find_profile_pid(profile_path)? {
        return Err(format!(
            "This Chrome profile is already running (PID {pid}). Close it before opening login mode."
        ));
    }

    let chrome = find_chrome_executable().ok_or_else(|| {
        "Google Chrome was not found. Install Chrome or add chrome.exe to PATH.".to_string()
    })?;

    ensure_managed_profile_storage(profile_path)?;
    mark_profile_shutdown_clean(profile_path)?;

    // Login mode intentionally avoids DevTools / remote-debugging flags.
    // Google can reject authentication flows when Chrome is launched with
    // automation/debugging endpoints enabled.
    let mut command = Command::new(chrome);
    command
        .arg(format!(
            "--user-data-dir={}",
            profile_path.to_string_lossy()
        ))
        .arg("--new-window");
    apply_grid_args(&mut command, window_slot);

    if let Some(proxy_server) = proxy::proxy_server_arg(proxy_settings)? {
        command.arg(format!("--proxy-server={proxy_server}"));
    }

    let child = command
        .arg(start_url.unwrap_or(DEFAULT_START_URL))
        .spawn()
        .map_err(|e| format!("Cannot start Chrome login mode: {e}"))?;

    Ok(child.id())
}

#[derive(Debug, Clone)]
pub struct DebugBrowserInfo {
    pub pid: u32,
    pub devtools_port: u16,
    pub browser_websocket_url: String,
}

fn devtools_active_port_path(profile_path: &Path) -> PathBuf {
    profile_path.join("DevToolsActivePort")
}

fn parse_devtools_active_port(raw: &str) -> Result<(u16, String), String> {
    let mut lines = raw.lines();
    let port = lines
        .next()
        .ok_or_else(|| "DevToolsActivePort is missing its port.".to_string())?
        .trim()
        .parse::<u16>()
        .map_err(|_| "DevToolsActivePort contains an invalid port.".to_string())?;
    if port == 0 {
        return Err("DevToolsActivePort contains port 0.".into());
    }

    let browser_path = lines
        .next()
        .ok_or_else(|| "DevToolsActivePort is missing its browser websocket path.".to_string())?
        .trim();
    if !browser_path.starts_with("/devtools/browser/") {
        return Err("DevToolsActivePort contains an invalid browser websocket path.".into());
    }

    Ok((port, format!("ws://127.0.0.1:{port}{browser_path}")))
}

fn devtools_port_is_reachable(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&address.into(), Duration::from_millis(300)).is_ok()
}

pub fn read_devtools_active_port(profile_path: &Path) -> Result<Option<(u16, String)>, String> {
    let path = devtools_active_port_path(profile_path);
    if !path.is_file() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    parse_devtools_active_port(&raw).map(Some)
}

pub fn launch_debuggable(
    profile_path: &Path,
    start_url: Option<&str>,
    proxy_settings: &ProxySettings,
    window_slot: usize,
) -> Result<DebugBrowserInfo, String> {
    if let Some(pid) = find_profile_pid(profile_path)? {
        if let Some((port, browser_websocket_url)) = read_devtools_active_port(profile_path)? {
            if devtools_port_is_reachable(port) {
                return Ok(DebugBrowserInfo {
                    pid,
                    devtools_port: port,
                    browser_websocket_url,
                });
            }
        }
        return Err(format!(
            "This Chrome profile is already running (PID {pid}) without adapter DevTools enabled. Close it and let the adapter reopen it."
        ));
    }

    let chrome = find_chrome_executable().ok_or_else(|| {
        "Google Chrome was not found. Install Chrome or add chrome.exe to PATH.".to_string()
    })?;
    ensure_managed_profile_storage(profile_path)?;
    mark_profile_shutdown_clean(profile_path)?;

    let active_port_path = devtools_active_port_path(profile_path);
    if active_port_path.exists() {
        std::fs::remove_file(&active_port_path).map_err(|e| {
            format!(
                "Cannot remove stale {} before adapter launch: {e}",
                active_port_path.display()
            )
        })?;
    }

    let mut command = Command::new(chrome);
    command
        .arg(format!(
            "--user-data-dir={}",
            profile_path.to_string_lossy()
        ))
        .arg("--no-first-run")
        .arg("--new-window")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=0");
    apply_grid_args(&mut command, window_slot);

    if let Some(proxy_server) = proxy::proxy_server_arg(proxy_settings)? {
        command.arg(format!("--proxy-server={proxy_server}"));
    }

    let child = command
        .arg(start_url.unwrap_or(DEFAULT_START_URL))
        .spawn()
        .map_err(|e| format!("Cannot start Chrome execution browser: {e}"))?;
    let spawned_pid = child.id();

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Some((port, browser_websocket_url)) = read_devtools_active_port(profile_path)? {
            let pid = find_profile_pid(profile_path)?.unwrap_or(spawned_pid);
            return Ok(DebugBrowserInfo {
                pid,
                devtools_port: port,
                browser_websocket_url,
            });
        }

        if !is_pid_running(spawned_pid) && find_profile_pid(profile_path)?.is_none() {
            return Err("Chrome exited before its local DevTools endpoint became ready.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = close_profile(profile_path, Some(spawned_pid));
    Err("Chrome started but its local DevTools endpoint was not ready within 8 seconds.".into())
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
                let is_browser_root = !normalized.contains("--type=");
                if is_browser_root {
                    discovered.insert(profile_id.clone(), pid);
                } else {
                    discovered.entry(profile_id.clone()).or_insert(pid);
                }
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
    let pid = find_profile_pid(profile_path)?
        .or_else(|| known_pid.filter(|pid| is_pid_running(*pid)));

    let Some(pid) = pid else {
        let _ = mark_profile_shutdown_clean(profile_path);
        return Ok(());
    };

    request_graceful_close(pid)?;

    // We already resolved the browser root PID above. Re-scanning every Chrome
    // command line through PowerShell/CIM on each wait tick is unnecessarily
    // expensive, so only follow the resolved PID while waiting for shutdown.
    let graceful_deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < graceful_deadline {
        if !is_pid_running(pid) {
            let _ = mark_profile_shutdown_clean(profile_path);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }

    force_close_process_tree(pid)?;

    let force_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < force_deadline {
        if !is_pid_running(pid) {
            let _ = mark_profile_shutdown_clean(profile_path);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }

    Err("Chrome process tree did not exit after force-close.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devtools_active_port_file() {
        let (port, websocket_url) =
            parse_devtools_active_port("9222\n/devtools/browser/test-browser-id\n").unwrap();
        assert_eq!(port, 9222);
        assert_eq!(
            websocket_url,
            "ws://127.0.0.1:9222/devtools/browser/test-browser-id"
        );
    }

    #[test]
    fn rejects_invalid_devtools_active_port_file() {
        assert!(parse_devtools_active_port("0\n/devtools/browser/id\n").is_err());
        assert!(parse_devtools_active_port("9222\n/not-devtools/id\n").is_err());
        assert!(parse_devtools_active_port("not-a-port\n/devtools/browser/id\n").is_err());
    }

    #[test]
    fn writes_default_partition_zoom_as_85_percent() {
        let root = std::env::temp_dir().join(format!(
            "dola-chrome-zoom-{}",
            uuid::Uuid::new_v4()
        ));
        let default_dir = root.join("Default");
        std::fs::create_dir_all(&default_dir).unwrap();
        std::fs::write(
            default_dir.join("Preferences"),
            r#"{
              "profile":{"exit_type":"Crashed","exited_cleanly":false},
              "partition":{
                "default_zoom_level":0,
                "per_host_zoom_levels":{
                  "x":{"www.dola.com":{"zoom_level":0}}
                }
              }
            }"#,
        )
        .unwrap();

        mark_profile_shutdown_clean(&root).unwrap();

        let raw = std::fs::read_to_string(default_dir.join("Preferences")).unwrap();
        let preferences: Value = serde_json::from_str(&raw).unwrap();
        let zoom_level = preferences["partition"]["default_zoom_level"]["x"]
            .as_f64()
            .unwrap();

        assert!((1.2_f64.powf(zoom_level) - 0.85).abs() < 0.000_001);
        assert_eq!(
            preferences["partition"]["per_host_zoom_levels"]["x"],
            Value::Object(Default::default())
        );
        assert_eq!(preferences["profile"]["exit_type"], "Normal");
        assert_eq!(preferences["profile"]["exited_cleanly"], true);

        let _ = std::fs::remove_dir_all(root);
    }
}
