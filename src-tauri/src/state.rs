use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub db_path: PathBuf,
    pub profiles_dir: PathBuf,
    pub processes: Mutex<HashMap<String, u32>>,
}

impl AppState {
    pub fn new(db_path: PathBuf, profiles_dir: PathBuf) -> Self {
        Self {
            db_path,
            profiles_dir,
            processes: Mutex::new(HashMap::new()),
        }
    }
}
