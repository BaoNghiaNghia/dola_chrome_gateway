use chrono::Utc;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

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

pub fn resolve_adapter_script(resource_dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = vec![resource_dir.join("adapter").join("seedance-adapter.mjs")];

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("adapter").join("seedance-adapter.mjs"));
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Seedance adapter script was not found. Rebuild the app with adapter resources bundled."
                .to_string()
        })
}

fn open_log_file(app_data_dir: &Path) -> Result<(PathBuf, std::fs::File), String> {
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Cannot create adapter log directory: {e}"))?;
    let log_path = logs_dir.join("seedance-adapter.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Cannot open adapter log file: {e}"))?;
    Ok((log_path, file))
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
    let download_dir = app_data_dir.join("downloads");
    fs::create_dir_all(&download_dir)
        .map_err(|e| format!("Cannot create video download directory: {e}"))?;
    let (log_path, stdout_file) = open_log_file(app_data_dir)?;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("Cannot clone adapter log handle: {e}"))?;

    let mut command = Command::new(&node_path);
    command
        .arg(&script_path)
        .current_dir(
            script_path
                .parent()
                .ok_or_else(|| "Adapter script directory is invalid.".to_string())?,
        )
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
            "Seedance adapter exited immediately with {status}. {}",
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
