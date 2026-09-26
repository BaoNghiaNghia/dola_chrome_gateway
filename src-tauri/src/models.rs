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
pub struct ProfileOperationalState {
    pub scheduling_enabled: bool,
    pub session_status: String,
    pub login_checked_at: Option<String>,
    pub cooldown_until: Option<String>,
    pub rate_limited_until: Option<String>,
    pub quota_blocked_until: Option<String>,
    pub credit_balance: Option<f64>,
    pub used_today: u32,
    pub remaining: Option<u32>,
    pub last_used_at: Option<String>,
    pub availability: String,
    pub availability_reason: Option<String>,
}

impl Default for ProfileOperationalState {
    fn default() -> Self {
        Self {
            scheduling_enabled: true,
            session_status: "unknown".into(),
            login_checked_at: None,
            cooldown_until: None,
            rate_limited_until: None,
            quota_blocked_until: None,
            credit_balance: None,
            used_today: 0,
            remaining: None,
            last_used_at: None,
            availability: "unknown".into(),
            availability_reason: Some("Session has not been verified yet.".into()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileOperationalStateRequest {
    pub scheduling_enabled: Option<bool>,
    pub session_status: Option<String>,
    pub login_checked_at: Option<String>,
    pub cooldown_until: Option<String>,
    pub rate_limited_until: Option<String>,
    pub quota_blocked_until: Option<String>,
    pub credit_balance: Option<f64>,
    pub used_today: Option<u32>,
    pub remaining: Option<u32>,
    pub last_used_at: Option<String>,
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
    pub operational: ProfileOperationalState,
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
pub struct SchedulerState {
    pub enabled: bool,
    pub ready_profiles: usize,
    pub blocked_profiles: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationJob {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub duration_seconds: u32,
    pub ratio: String,
    pub status: String,
    pub profile_id: Option<String>,
    pub proxy_id: Option<String>,
    pub external_task_id: Option<String>,
    pub result_url: Option<String>,
    pub local_path: Option<String>,
    pub result_width: Option<u32>,
    pub result_height: Option<u32>,
    pub result_bitrate: Option<u64>,
    pub result_file_size: Option<u64>,
    pub result_no_watermark: Option<bool>,
    pub result_source_kind: Option<String>,
    pub failure_code: Option<String>,
    pub error_message: Option<String>,
    pub deadline_at: Option<String>,
    pub last_poll_at: Option<String>,
    pub progress_percent: u8,
    pub attempt_count: u32,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGenerationJobRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub duration_seconds: Option<u32>,
    pub ratio: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGenerationJobRequest {
    pub status: Option<String>,
    pub profile_id: Option<String>,
    pub proxy_id: Option<String>,
    pub external_task_id: Option<String>,
    pub result_url: Option<String>,
    pub failure_code: Option<String>,
    pub error_message: Option<String>,
    pub deadline_at: Option<String>,
    pub last_poll_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterClaimRequest {
    pub worker_id: String,
    pub lease_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProfileContext {
    pub id: String,
    pub name: String,
    pub profile_path: String,
    pub active_proxy: Option<ActiveProxyAssignment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterClaim {
    pub lease_token: String,
    pub lease_expires_at: String,
    pub job: GenerationJob,
    pub profile: AdapterProfileContext,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterHeartbeatRequest {
    pub lease_token: String,
    pub lease_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStartRequest {
    pub lease_token: String,
    pub external_task_id: Option<String>,
    pub deadline_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProgressRequest {
    pub lease_token: String,
    pub external_task_id: Option<String>,
    pub progress_percent: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCompleteRequest {
    pub lease_token: String,
    pub result_url: String,
    pub local_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitrate: Option<u64>,
    pub file_size: Option<u64>,
    pub no_watermark: Option<bool>,
    pub source_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFailRequest {
    pub lease_token: String,
    pub failure_code: Option<String>,
    pub error_message: Option<String>,
    pub retryable: Option<bool>,
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProfileStateRequest {
    pub lease_token: String,
    pub scheduling_enabled: Option<bool>,
    pub session_status: Option<String>,
    pub login_checked_at: Option<String>,
    pub cooldown_until: Option<String>,
    pub rate_limited_until: Option<String>,
    pub quota_blocked_until: Option<String>,
    pub credit_balance: Option<f64>,
    pub used_today: Option<u32>,
    pub remaining: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterBrowserOpenRequest {
    pub lease_token: String,
    pub start_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterBrowserCloseRequest {
    pub lease_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionBrowserSession {
    pub profile_id: String,
    pub pid: u32,
    pub devtools_port: u16,
    pub cdp_http_url: String,
    pub browser_websocket_url: String,
    pub active_proxy: Option<ActiveProxyAssignment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiState {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub base_url: String,
    pub api_key_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuntimeState {
    pub running: bool,
    pub pid: Option<u32>,
    pub concurrency: u8,
    pub timeout_seconds: u64,
    pub manual_verification_seconds: u64,
    pub node_path: Option<String>,
    pub script_path: Option<String>,
    pub log_path: Option<String>,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuntimeConfigRequest {
    pub concurrency: Option<u8>,
    pub timeout_seconds: Option<u64>,
    pub manual_verification_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerState {
    pub enabled: bool,
    pub running: bool,
    pub mode: String,
    pub max_concurrent_jobs: usize,
    pub poll_interval_ms: u64,
    pub active_assignments: usize,
    pub queued_jobs: usize,
    pub last_tick_at: Option<String>,
    pub last_error: Option<String>,
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
