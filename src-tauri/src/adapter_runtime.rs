use chrono::Utc;
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

const NODE_ADAPTER_BOOTSTRAP: &str = r#"
const { pathToFileURL } = require('node:url');
const entrypoint = process.argv[1];
if (!entrypoint) {
  console.error('Missing Seedance adapter entrypoint.');
  process.exit(2);
}
import(pathToFileURL(entrypoint).href).catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
"#;

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }

    path.to_path_buf()
}

#[derive(Debug, Clone)]
pub struct AdapterRuntimeConfig {
    pub concurrency: u8,
    pub timeout_seconds: u64,
    pub manual_verification_seconds: u64,
}

impl Default for AdapterRuntimeConfig {
    fn default() -> Self {
        Self {
            concurrency: 1,
            timeout_seconds: 1_200,
            manual_verification_seconds: 180,
        }
    }
}

impl AdapterRuntimeConfig {
    pub fn normalized(
        concurrency: Option<u8>,
        timeout_seconds: Option<u64>,
        manual_verification_seconds: Option<u64>,
        current: &Self,
    ) -> Self {
        Self {
            concurrency: concurrency.unwrap_or(current.concurrency).clamp(1, 4),
            timeout_seconds: timeout_seconds
                .unwrap_or(current.timeout_seconds)
                .clamp(120, 7_200),
            manual_verification_seconds: manual_verification_seconds
                .unwrap_or(current.manual_verification_seconds)
                .clamp(30, 1_800),
        }
    }
}

pub struct AdapterProcessRuntime {
    child: Child,
    pub node_path: PathBuf,
    pub script_path: PathBuf,
    pub log_path: PathBuf,
    pub started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDownloadCompletion {
    pub local_path: String,
    pub downloaded_at: String,
}

pub struct ProfileDownloadWatcherRuntime {
    child: Child,
}

impl ProfileDownloadWatcherRuntime {
    pub fn stop(mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Drop for ProfileDownloadWatcherRuntime {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl AdapterProcessRuntime {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(mut self) -> Result<(), String> {
        if self.is_running() {
            self.child
                .kill()
                .map_err(|e| format!("Cannot stop Seedance adapter process: {e}"))?;
        }
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for AdapterProcessRuntime {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            #[cfg(target_os = "windows")]
            candidates.push(dir.join("node.exe"));
            #[cfg(not(target_os = "windows"))]
            candidates.push(dir.join("node"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(program_files) = std::env::var_os("PROGRAMFILES") {
            candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("nodejs")
                    .join("node.exe"),
            );
        }
    }

    candidates
}

pub fn find_node_executable() -> Option<PathBuf> {
    executable_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn push_adapter_candidates_from_ancestors(
    candidates: &mut Vec<PathBuf>,
    start: &Path,
    file_name: &str,
) {
    for base in start.ancestors().take(8) {
        candidates.push(base.join("adapter").join(file_name));
        candidates.push(
            base.join("resources")
                .join("adapter")
                .join(file_name),
        );
    }
}

fn adapter_script_candidates(resource_dir: &Path, file_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // Installed/bundled resource locations.
    push_adapter_candidates_from_ancestors(&mut candidates, resource_dir, file_name);

    // Portable and dev executable locations. In tauri dev the executable
    // lives under src-tauri/target/debug while the adapter directory lives at
    // the repository root, so walking ancestors is required.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            push_adapter_candidates_from_ancestors(
                &mut candidates,
                executable_dir,
                file_name,
            );
        }
    }

    // Development working directory can be either repository root or
    // src-tauri depending on how Tauri was launched.
    if let Ok(current_dir) = std::env::current_dir() {
        push_adapter_candidates_from_ancestors(&mut candidates, &current_dir, file_name);
    }

    candidates.dedup();
    candidates
}

fn resolve_adapter_resource(resource_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let candidates = adapter_script_candidates(resource_dir, file_name);
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .ok_or_else(|| {
            let searched = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" | ");
            format!(
                "Adapter resource {file_name} was not found. Searched: {searched}. Rebuild the app so adapter resources are included."
            )
        })
}

pub fn resolve_adapter_script(resource_dir: &Path) -> Result<PathBuf, String> {
    resolve_adapter_resource(resource_dir, "seedance-adapter.mjs")
}

fn download_storage_dir(_app_data_dir: &Path) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let root = PathBuf::from(r"E:\Dola Chrome");
        if !root.is_dir() {
            return Err(
                "Dola Chrome storage is unavailable at E:\\Dola Chrome. Video download was not started."
                    .into(),
            );
        }
        return Ok(root.join("Downloads"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(_app_data_dir.join("downloads"))
    }
}

fn open_named_log_file(
    app_data_dir: &Path,
    name: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Cannot create adapter log directory: {e}"))?;
    let log_path = logs_dir.join(name);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Cannot open adapter log file: {e}"))?;
    Ok((log_path, file))
}

fn open_log_file(app_data_dir: &Path) -> Result<(PathBuf, std::fs::File), String> {
    open_named_log_file(app_data_dir, "seedance-adapter.log")
}

fn resolve_profile_watcher_script(resource_dir: &Path) -> Result<PathBuf, String> {
    resolve_adapter_resource(resource_dir, "profile-download-watcher.mjs")
}

pub fn start_profile_download_watcher(
    resource_dir: &Path,
    app_data_dir: &Path,
    profile_id: &str,
    browser_websocket_url: &str,
    browser_pid: u32,
) -> Result<ProfileDownloadWatcherRuntime, String> {
    let node_path = find_node_executable().ok_or_else(|| {
        "Node.js was not found. Install Node.js 20+ before opening profiles with auto-download."
            .to_string()
    })?;
    let script_path = resolve_profile_watcher_script(resource_dir)?;
    let download_dir = download_storage_dir(app_data_dir)?;
    fs::create_dir_all(&download_dir).map_err(|e| {
        format!(
            "Cannot create video download directory at {}: {e}",
            download_dir.display()
        )
    })?;

    let status_dir = app_data_dir.join("runtime").join("profile-download-status");
    fs::create_dir_all(&status_dir)
        .map_err(|e| format!("Cannot create profile download status directory: {e}"))?;
    let status_path = status_dir.join(format!("{profile_id}.json"));
    let _ = fs::remove_file(&status_path);

    let (_log_path, stdout_file) =
        open_named_log_file(app_data_dir, "profile-download-watcher.log")?;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("Cannot clone profile watcher log handle: {e}"))?;

    let node_script_path = node_compatible_path(&script_path);
    let node_working_dir = node_compatible_path(
        script_path
            .parent()
            .ok_or_else(|| "Profile watcher script directory is invalid.".to_string())?,
    );

    let mut command = Command::new(&node_path);
    command
        .arg("-e")
        .arg(NODE_ADAPTER_BOOTSTRAP)
        .arg(&node_script_path)
        .arg(browser_websocket_url)
        .arg(profile_id)
        .arg(browser_pid.to_string())
        .current_dir(&node_working_dir)
        .env("DOLA_DOWNLOAD_DIR", &download_dir)
        .env("DOLA_PROFILE_STATUS_FILE", &status_path)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start profile auto-download watcher: {e}"))?;

    thread::sleep(Duration::from_millis(250));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("Cannot inspect profile auto-download watcher: {e}"))?
    {
        return Err(format!(
            "Profile auto-download watcher exited immediately with {status}."
        ));
    }

    Ok(ProfileDownloadWatcherRuntime { child })
}

pub fn collect_profile_download_completions(
    app_data_dir: &Path,
) -> Result<Vec<(String, ProfileDownloadCompletion)>, String> {
    let status_dir = app_data_dir.join("runtime").join("profile-download-status");
    let Ok(entries) = fs::read_dir(&status_dir) else {
        return Ok(Vec::new());
    };

    let mut completions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(profile_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let completion = match serde_json::from_str::<ProfileDownloadCompletion>(&raw) {
            Ok(completion) => completion,
            Err(_) => continue,
        };

        completions.push((profile_id.to_string(), completion));
        let _ = fs::remove_file(&path);
    }

    Ok(completions)
}

pub fn start(
    resource_dir: &Path,
    app_data_dir: &Path,
    gateway_url: &str,
    api_key: &str,
    config: &AdapterRuntimeConfig,
) -> Result<AdapterProcessRuntime, String> {
    let node_path = find_node_executable().ok_or_else(|| {
        "Node.js was not found. Install Node.js 20+ or add node.exe to PATH before starting Automation Runtime."
            .to_string()
    })?;
    let script_path = resolve_adapter_script(resource_dir)?;
    let download_dir = download_storage_dir(app_data_dir)?;
    fs::create_dir_all(&download_dir).map_err(|e| {
        format!(
            "Cannot create video download directory at {}: {e}",
            download_dir.display()
        )
    })?;
    let (log_path, stdout_file) = open_log_file(app_data_dir)?;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("Cannot clone adapter log handle: {e}"))?;

    let node_script_path = node_compatible_path(&script_path);
    let node_working_dir = node_compatible_path(
        script_path
            .parent()
            .ok_or_else(|| "Adapter script directory is invalid.".to_string())?,
    );

    let mut command = Command::new(&node_path);
    command
        .arg("-e")
        .arg(NODE_ADAPTER_BOOTSTRAP)
        .arg(&node_script_path)
        .current_dir(&node_working_dir)
        .env("DOLA_GATEWAY_URL", gateway_url)
        .env("DOLA_GATEWAY_KEY", api_key)
        .env("DOLA_DOWNLOAD_DIR", &download_dir)
        .env("DOLA_ADAPTER_CONCURRENCY", config.concurrency.to_string())
        .env(
            "DOLA_ADAPTER_TIMEOUT_SECONDS",
            config.timeout_seconds.to_string(),
        )
        .env(
            "DOLA_ADAPTER_MANUAL_VERIFICATION_SECONDS",
            config.manual_verification_seconds.to_string(),
        )
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        format!(
            "Cannot start Seedance adapter with {}: {e}",
            node_path.display()
        )
    })?;

    thread::sleep(Duration::from_millis(300));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("Cannot inspect Seedance adapter process: {e}"))?
    {
        let tail = read_log_tail(&log_path, 8_000).unwrap_or_default();
        return Err(format!(
            "Seedance adapter exited immediately with {status}. Node: {}. Entrypoint: {}. {}",
            node_path.display(),
            node_script_path.display(),
            tail.trim()
        ));
    }

    Ok(AdapterProcessRuntime {
        child,
        node_path,
        script_path,
        log_path,
        started_at: Utc::now().to_rfc3339(),
    })
}

pub fn read_log_tail(path: &Path, max_bytes: usize) -> Result<String, String> {
    if !path.is_file() {
        return Ok(String::new());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| format!("Cannot open adapter log: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Cannot inspect adapter log: {e}"))?
        .len();
    let start = len.saturating_sub(max_bytes as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("Cannot seek adapter log: {e}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read adapter log: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn adapter_config_is_bounded() {
        let current = AdapterRuntimeConfig::default();
        let config = AdapterRuntimeConfig::normalized(Some(9), Some(10), Some(9_999), &current);
        assert_eq!(config.concurrency, 4);
        assert_eq!(config.timeout_seconds, 120);
        assert_eq!(config.manual_verification_seconds, 1_800);
    }

    #[test]
    fn starts_and_stops_managed_node_process_when_node_is_available() {
        if find_node_executable().is_none() {
            return;
        }

        let root = std::env::temp_dir().join(format!("dola-adapter-runtime-{}", Uuid::new_v4()));
        let adapter_dir = root.join("adapter");
        fs::create_dir_all(&adapter_dir).unwrap();
        fs::write(
            adapter_dir.join("seedance-adapter.mjs"),
            "setInterval(() => {}, 1000);",
        )
        .unwrap();

        let config = AdapterRuntimeConfig::default();
        let mut runtime = start(&root, &root, "http://127.0.0.1:1", "test-key", &config).unwrap();

        assert!(runtime.pid() > 0);
        assert!(runtime.is_running());
        runtime.stop().unwrap();

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn starts_real_workspace_adapter_entrypoint_when_available() {
        if find_node_executable().is_none() {
            return;
        }

        let Ok(workspace_root) = std::env::current_dir() else {
            return;
        };
        if !workspace_root
            .join("adapter")
            .join("seedance-adapter.mjs")
            .is_file()
        {
            return;
        }

        let app_data_dir =
            std::env::temp_dir().join(format!("dola-adapter-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&app_data_dir).unwrap();

        let config = AdapterRuntimeConfig::default();
        let mut runtime = start(
            &workspace_root,
            &app_data_dir,
            "http://127.0.0.1:1",
            "test-key",
            &config,
        )
        .unwrap();

        assert!(runtime.pid() > 0);
        assert!(runtime.is_running());
        runtime.stop().unwrap();

        let log = read_log_tail(&app_data_dir.join("logs").join("seedance-adapter.log"), 16_000)
            .unwrap_or_default();
        assert!(!log.contains("EISDIR"));
        assert!(!log.contains("resolveMainPath"));

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn resolves_bundled_adapter_script() {
        let root = std::env::temp_dir().join(format!("dola-adapter-resource-{}", Uuid::new_v4()));
        let adapter_dir = root.join("adapter");
        fs::create_dir_all(&adapter_dir).unwrap();
        let script = adapter_dir.join("seedance-adapter.mjs");
        fs::write(&script, "console.log('ok')").unwrap();

        let resolved = resolve_adapter_script(&root).unwrap();
        assert_eq!(resolved, script);

        let _ = fs::remove_dir_all(root);
    }
}
