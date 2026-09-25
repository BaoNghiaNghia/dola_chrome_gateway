use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub auth_username: Option<String>,
    pub rotation_mode: String,
    pub rotation_url: Option<String>,
    pub last_ip: Option<String>,
    pub health: String,
    pub last_latency_ms: Option<u64>,
    pub last_checked_at: Option<String>,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            protocol: "http".into(),
            host: String::new(),
            port: 0,
            auth_username: None,
            rotation_mode: "rotate_on_launch".into(),
            rotation_url: None,
            last_ip: None,
            health: "disabled".into(),
            last_latency_ms: None,
            last_checked_at: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettingsRequest {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub auth_username: Option<String>,
    pub rotation_mode: String,
    pub rotation_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCheckResult {
    pub reachable: bool,
    pub public_ip: Option<String>,
    pub latency_ms: Option<u64>,
    pub checked_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPoolItem {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub auth_username: Option<String>,
    pub rotation_url: Option<String>,
    pub last_ip: Option<String>,
    pub health: String,
    pub last_latency_ms: Option<u64>,
    pub last_checked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPoolItemRequest {
    pub name: String,
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub auth_username: Option<String>,
    pub rotation_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPoolState {
    pub enabled: bool,
    pub items: Vec<ProxyPoolItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProxyAssignment {
    pub proxy_id: String,
    pub proxy_name: String,
    pub endpoint: String,
    pub public_ip: Option<String>,
    pub assigned_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub group_name: Option<String>,
    pub services: Vec<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub profile_path: String,
    pub proxy: ProxySettings,
    pub active_proxy: Option<ActiveProxyAssignment>,
    pub is_running: bool,
    pub pid: Option<u32>,
    pub last_opened_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileRequest {
    pub name: String,
    pub email: Option<String>,
    pub group_name: Option<String>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub proxy: Option<ProxySettingsRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub profile_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub profile_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub chrome_path: Option<String>,
    pub data_dir: String,
    pub max_simultaneous_profiles: usize,
}
