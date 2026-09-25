use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub struct BackgroundRuntime {
    pub stop: Arc<AtomicBool>,
    pub handle: Option<JoinHandle<()>>,
}

impl BackgroundRuntime {
    pub fn new(stop: Arc<AtomicBool>, handle: JoinHandle<()>) -> Self {
        Self {
            stop,
            handle: Some(handle),
        }
    }

    pub fn is_running(&self) -> bool {
        self.handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub struct AppState {
    pub db_path: PathBuf,
    pub profiles_dir: PathBuf,
    pub processes: Mutex<HashMap<String, u32>>,
    pub api_runtime: Mutex<Option<BackgroundRuntime>>,
    pub worker_runtime: Mutex<Option<BackgroundRuntime>>,
}

impl AppState {
    pub fn new(db_path: PathBuf, profiles_dir: PathBuf) -> Self {
        Self {
            db_path,
            profiles_dir,
            processes: Mutex::new(HashMap::new()),
            api_runtime: Mutex::new(None),
            worker_runtime: Mutex::new(None),
        }
    }
}
