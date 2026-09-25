use crate::chrome;
use crate::db;
use crate::models::{
    BrowserProfile, CreateGenerationJobRequest, CreateProfileRequest, CreateWorkspaceRequest,
    GenerationJob, ProfileOperationalState, ProxyCheckResult, ProxyPoolItem, ProxyPoolItemRequest,
    ProxyPoolState, ProxySettings, ProxySettingsRequest, SchedulerState, SystemInfo,
    UpdateGenerationJobRequest, UpdateProfileOperationalStateRequest, Workspace,
};
use crate::proxy;
use crate::state::AppState;
use chrono::Utc;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_SIMULTANEOUS_PROFILES: usize = 4;

fn sync_processes_for_profiles(
    profiles: &[BrowserProfile],
    state: &AppState,
) -> Result<(), String> {
    let profile_paths = profiles
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                PathBuf::from(profile.profile_path.as_str()),
            )
        })
        .collect::<Vec<_>>();

    let discovered = chrome::discover_profile_pids(&profile_paths)?;
    let running_ids = discovered.keys().cloned().collect::<Vec<_>>();
    db::release_stale_proxy_assignments(&state.db_path, &running_ids)?;

    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    *processes = discovered;
    Ok(())
}

fn refresh_processes(state: &AppState) -> Result<(), String> {
    let profiles = db::list_profiles(&state.db_path)?;
    sync_processes_for_profiles(&profiles, state)
}

fn is_profile_running(profile_id: &str, state: &AppState) -> Result<bool, String> {
    refresh_processes(state)?;
    Ok(state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?
        .contains_key(profile_id))
}

fn decorate_running_state(
    profiles: &mut [BrowserProfile],
    state: &AppState,
) -> Result<(), String> {
    sync_processes_for_profiles(profiles, state)?;
    let processes = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;

    for profile in profiles {
        if let Some(pid) = processes.get(&profile.id) {
            profile.is_running = true;
            profile.pid = Some(*pid);
        } else {
            profile.is_running = false;
            profile.pid = None;
            profile.active_proxy = None;
        }
    }
    Ok(())
}

fn check_and_record_profile_proxy(
    profile_id: &str,
    settings: &ProxySettings,
    state: &AppState,
) -> Result<ProxyCheckResult, String> {
    match proxy::check(settings) {
        Ok(result) => {
            db::record_proxy_check(&state.db_path, profile_id, &result)?;
            Ok(result)
        }
        Err(error) => {
            let _ = db::record_proxy_failure(
                &state.db_path,
                profile_id,
                &Utc::now().to_rfc3339(),
            );
            Err(error)
        }
    }
}

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

fn validate_pool_request(request: &ProxyPoolItemRequest) -> Result<(), String> {
    let settings = ProxySettings {
        enabled: request.enabled,
        protocol: request.protocol.clone(),
        host: request.host.clone(),
        port: request.port,
        auth_username: request.auth_username.clone(),
        rotation_mode: "sticky".into(),
        rotation_url: request.rotation_url.clone(),
        ..ProxySettings::default()
    };
    proxy::validate(&settings)
}

fn check_and_record_pool_proxy(
    item: &ProxyPoolItem,
    state: &AppState,
) -> Result<ProxyCheckResult, String> {
    let settings = pool_item_settings(item);
    match proxy::check(&settings) {
        Ok(result) => {
            db::record_pool_proxy_check(&state.db_path, &item.id, &result)?;
            Ok(result)
        }
        Err(error) => {
            let _ = db::record_pool_proxy_failure(
                &state.db_path,
                &item.id,
                &Utc::now().to_rfc3339(),
            );
            Err(error)
        }
    }
}

fn prepare_pool_proxy(
    item: &ProxyPoolItem,
    state: &AppState,
) -> Result<(ProxySettings, ProxyCheckResult), String> {
    let settings = pool_item_settings(item);
    proxy::validate(&settings)?;

    // A rotation URL means this proxy slot can request a fresh exit IP.
    // Rotation happens once immediately before the browser batch is launched.
    if item
        .rotation_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|url| !url.is_empty())
    {
        proxy::rotate(&settings)?;
    }

    let result = check_and_record_pool_proxy(item, state)?;
    Ok((settings, result))
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<BrowserProfile>, String> {
    let mut profiles = db::list_profiles(&state.db_path)?;
    decorate_running_state(&mut profiles, &state)?;
    Ok(profiles)
}

#[tauri::command]
pub fn create_profile(
    request: CreateProfileRequest,
    state: State<'_, AppState>,
) -> Result<BrowserProfile, String> {
    // Per-profile proxy settings are retained for backward compatibility,
    // but the system proxy pool controls launch routing when configured.
    if let Some(settings) = request.proxy.as_ref() {
        let materialized = ProxySettings {
            enabled: settings.enabled,
            protocol: settings.protocol.clone(),
            host: settings.host.clone(),
            port: settings.port,
            auth_username: settings.auth_username.clone(),
            rotation_mode: settings.rotation_mode.clone(),
            rotation_url: settings.rotation_url.clone(),
            ..ProxySettings::default()
        };
        proxy::validate(&materialized)?;
    }

    db::create_profile(&state.db_path, &state.profiles_dir, request)
}

#[tauri::command]
pub fn delete_profile(profile_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if is_profile_running(&profile_id, &state)? {
        return Err("Close this Chrome profile before removing it.".into());
    }
    db::release_profile_proxy_assignment(&state.db_path, &profile_id)?;
    db::delete_profile(&state.db_path, &profile_id)
}

// Legacy per-profile proxy commands remain callable so existing databases/UI versions do not break.
#[tauri::command]
pub fn update_profile_proxy(
    profile_id: String,
    request: ProxySettingsRequest,
    state: State<'_, AppState>,
) -> Result<ProxySettings, String> {
    if is_profile_running(&profile_id, &state)? {
        return Err(
            "Close this Chrome profile before changing proxy settings.".into(),
        );
    }

    let settings = ProxySettings {
        enabled: request.enabled,
        protocol: request.protocol.clone(),
        host: request.host.clone(),
        port: request.port,
        auth_username: request.auth_username.clone(),
        rotation_mode: request.rotation_mode.clone(),
        rotation_url: request.rotation_url.clone(),
        ..ProxySettings::default()
    };
    proxy::validate(&settings)?;
    db::update_proxy_settings(&state.db_path, &profile_id, request)
}

#[tauri::command]
pub fn test_profile_proxy(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ProxyCheckResult, String> {
    let settings = db::get_proxy_settings(&state.db_path, &profile_id)?;
    check_and_record_profile_proxy(&profile_id, &settings, &state)
}

#[tauri::command]
pub fn rotate_profile_proxy(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ProxyCheckResult, String> {
    if is_profile_running(&profile_id, &state)? {
        return Err("Close this Chrome profile before rotating its proxy.".into());
    }

    let settings = db::get_proxy_settings(&state.db_path, &profile_id)?;
    if !settings.enabled {
        return Err("Enable proxy before rotating it.".into());
    }

    proxy::rotate(&settings)?;
    check_and_record_profile_proxy(&profile_id, &settings, &state)
}

#[tauri::command]
pub fn get_scheduler_state(state: State<'_, AppState>) -> Result<SchedulerState, String> {
    let mut profiles = db::list_profiles(&state.db_path)?;
    decorate_running_state(&mut profiles, &state)?;
    let ready_profiles = profiles
        .iter()
        .filter(|profile| !profile.is_running && profile.operational.availability == "ready")
        .count();
    let blocked_profiles = profiles
        .iter()
        .filter(|profile| !profile.is_running && profile.operational.availability != "ready")
        .count();

    Ok(SchedulerState {
        enabled: db::get_scheduler_enabled(&state.db_path)?,
        ready_profiles,
        blocked_profiles,
    })
}

#[tauri::command]
pub fn set_scheduler_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<SchedulerState, String> {
    db::set_scheduler_enabled(&state.db_path, enabled)?;
    get_scheduler_state(state)
}

#[tauri::command]
pub fn update_profile_operational_state(
    profile_id: String,
    request: UpdateProfileOperationalStateRequest,
    state: State<'_, AppState>,
) -> Result<ProfileOperationalState, String> {
    db::update_profile_operational_state(&state.db_path, &profile_id, request)
}

#[tauri::command]
pub fn clear_profile_operational_blocks(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ProfileOperationalState, String> {
    db::clear_profile_operational_blocks(&state.db_path, &profile_id)
}

#[tauri::command]
pub fn open_smart_profiles(
    count: Option<usize>,
    start_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if !db::get_scheduler_enabled(&state.db_path)? {
        return Err("Smart Scheduler is disabled.".into());
    }

    let desired = count.unwrap_or(MAX_SIMULTANEOUS_PROFILES).clamp(1, MAX_SIMULTANEOUS_PROFILES);
    let mut profiles = db::list_profiles(&state.db_path)?;
    decorate_running_state(&mut profiles, &state)?;

    let running_count = profiles.iter().filter(|profile| profile.is_running).count();
    let capacity = MAX_SIMULTANEOUS_PROFILES.saturating_sub(running_count);
    let target = desired.min(capacity);
    if target == 0 {
        return Ok(Vec::new());
    }

    let mut ready = profiles
        .into_iter()
        .filter(|profile| {
            !profile.is_running
                && profile.operational.scheduling_enabled
                && profile.operational.availability == "ready"
        })
        .collect::<Vec<_>>();

    ready.sort_by(|a, b| {
        a.operational
            .last_used_at
            .cmp(&b.operational.last_used_at)
            .then_with(|| a.name.cmp(&b.name))
    });

    let selected = ready
        .into_iter()
        .take(target)
        .map(|profile| profile.id)
        .collect::<Vec<_>>();

    if selected.is_empty() {
        return Err(
            "No scheduler-ready profiles are available. Verify sessions or clear cooldown/rate-limit states first."
                .into(),
        );
    }

    open_profile_ids(selected, start_url, &state)
}

#[tauri::command]
pub fn list_generation_jobs(state: State<'_, AppState>) -> Result<Vec<GenerationJob>, String> {
    db::list_generation_jobs(&state.db_path)
}

#[tauri::command]
pub fn create_generation_job(
    request: CreateGenerationJobRequest,
    state: State<'_, AppState>,
) -> Result<GenerationJob, String> {
    db::create_generation_job(&state.db_path, request)
}

#[tauri::command]
pub fn update_generation_job(
    job_id: String,
    request: UpdateGenerationJobRequest,
    state: State<'_, AppState>,
) -> Result<GenerationJob, String> {
    db::update_generation_job(&state.db_path, &job_id, request)
}

#[tauri::command]
pub fn cancel_generation_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<GenerationJob, String> {
    db::cancel_generation_job(&state.db_path, &job_id)
}

#[tauri::command]
pub fn get_proxy_pool_state(state: State<'_, AppState>) -> Result<ProxyPoolState, String> {
    refresh_processes(&state)?;
    Ok(ProxyPoolState {
        enabled: db::get_global_proxy_enabled(&state.db_path)?,
        items: db::list_proxy_pool(&state.db_path)?,
    })
}

#[tauri::command]
pub fn set_proxy_pool_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ProxyPoolState, String> {
    db::set_global_proxy_enabled(&state.db_path, enabled)?;
    Ok(ProxyPoolState {
        enabled,
        items: db::list_proxy_pool(&state.db_path)?,
    })
}

#[tauri::command]
pub fn create_proxy_pool_item(
    request: ProxyPoolItemRequest,
    state: State<'_, AppState>,
) -> Result<ProxyPoolItem, String> {
    validate_pool_request(&request)?;
    db::create_proxy_pool_item(&state.db_path, request)
}

#[tauri::command]
pub fn update_proxy_pool_item(
    proxy_id: String,
    request: ProxyPoolItemRequest,
    state: State<'_, AppState>,
) -> Result<ProxyPoolItem, String> {
    refresh_processes(&state)?;
    if db::is_pool_proxy_assigned(&state.db_path, &proxy_id)? {
        return Err("This proxy is in use by a running profile. Close it before editing.".into());
    }

    validate_pool_request(&request)?;
    db::update_proxy_pool_item(&state.db_path, &proxy_id, request)
}

#[tauri::command]
pub fn delete_proxy_pool_item(
    proxy_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    refresh_processes(&state)?;
    db::delete_proxy_pool_item(&state.db_path, &proxy_id)
}

#[tauri::command]
pub fn test_proxy_pool_item(
    proxy_id: String,
    state: State<'_, AppState>,
) -> Result<ProxyCheckResult, String> {
    let item = db::get_proxy_pool_item(&state.db_path, &proxy_id)?
        .ok_or_else(|| "Proxy does not exist.".to_string())?;
    check_and_record_pool_proxy(&item, &state)
}

#[tauri::command]
pub fn rotate_proxy_pool_item(
    proxy_id: String,
    state: State<'_, AppState>,
) -> Result<ProxyCheckResult, String> {
    refresh_processes(&state)?;
    if db::is_pool_proxy_assigned(&state.db_path, &proxy_id)? {
        return Err("This proxy is currently assigned to a running profile.".into());
    }

    let item = db::get_proxy_pool_item(&state.db_path, &proxy_id)?
        .ok_or_else(|| "Proxy does not exist.".to_string())?;
    let settings = pool_item_settings(&item);
    proxy::rotate(&settings)?;
    check_and_record_pool_proxy(&item, &state)
}

fn open_profile_ids(
    profile_ids: Vec<String>,
    start_url: Option<String>,
    state: &AppState,
) -> Result<Vec<String>, String> {
    if profile_ids.is_empty() {
        return Ok(Vec::new());
    }
    if profile_ids.len() > MAX_SIMULTANEOUS_PROFILES {
        return Err(format!(
            "You can open at most {MAX_SIMULTANEOUS_PROFILES} profiles at once."
        ));
    }

    let unique: HashSet<&String> = profile_ids.iter().collect();
    if unique.len() != profile_ids.len() {
        return Err("Duplicate profile IDs were supplied.".into());
    }

    refresh_processes(state)?;

    let running_ids = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())?;
        processes.keys().cloned().collect::<HashSet<_>>()
    };

    let current_running = running_ids.len();
    let new_profile_ids = profile_ids
        .iter()
        .filter(|id| !running_ids.contains(*id))
        .cloned()
        .collect::<Vec<_>>();

    if current_running + new_profile_ids.len() > MAX_SIMULTANEOUS_PROFILES {
        return Err(format!(
            "Only {MAX_SIMULTANEOUS_PROFILES} Chrome profiles can run at the same time."
        ));
    }

    // Resolve every requested profile before rotating any proxy.
    let mut profiles_to_open = Vec::with_capacity(new_profile_ids.len());
    for profile_id in &new_profile_ids {
        let profile = db::get_profile(&state.db_path, profile_id)?
            .ok_or_else(|| format!("Profile {profile_id} does not exist."))?;
        profiles_to_open.push(profile);
    }

    let pool_enabled = db::get_global_proxy_enabled(&state.db_path)?;
    let mut prepared_proxies: Vec<(ProxyPoolItem, ProxySettings, ProxyCheckResult)> = Vec::new();

    if pool_enabled && !profiles_to_open.is_empty() {
        let candidates = db::list_available_pool_proxies(&state.db_path, 1000)?;
        if candidates.len() < profiles_to_open.len() {
            return Err(format!(
                "Proxy Pool is ON, but only {} unused proxy slot(s) are available for {} new profile(s). Add or enable more proxies first.",
                candidates.len(),
                profiles_to_open.len()
            ));
        }

        let mut failures = Vec::new();
        for item in candidates {
            match prepare_pool_proxy(&item, state) {
                Ok((settings, check)) => {
                    prepared_proxies.push((item, settings, check));
                    if prepared_proxies.len() == profiles_to_open.len() {
                        break;
                    }
                }
                Err(error) => {
                    failures.push(format!("{}: {}", item.name, error));
                }
            }
        }

        if prepared_proxies.len() < profiles_to_open.len() {
            let detail = if failures.is_empty() {
                String::new()
            } else {
                format!(" Failed: {}", failures.join(" | "))
            };
            return Err(format!(
                "Proxy Pool could not prepare {} healthy proxy slot(s) for this batch.{}",
                profiles_to_open.len(),
                detail
            ));
        }
    }

    let direct = ProxySettings::default();
    let mut opened = profile_ids
        .iter()
        .filter(|id| running_ids.contains(*id))
        .cloned()
        .collect::<Vec<_>>();

    for (index, profile) in profiles_to_open.iter().enumerate() {
        let effective_proxy = if pool_enabled {
            let (item, settings, check) = &prepared_proxies[index];
            db::assign_pool_proxy(
                &state.db_path,
                &profile.id,
                &item.id,
                check.public_ip.as_deref(),
            )?;
            settings
        } else {
            &direct
        };

        match chrome::launch(
            Path::new(&profile.profile_path),
            start_url.as_deref(),
            effective_proxy,
        ) {
            Ok(pid) => {
                state
                    .processes
                    .lock()
                    .map_err(|_| "Process state is unavailable.".to_string())?
                    .insert(profile.id.clone(), pid);
                db::touch_last_opened(&state.db_path, &profile.id)?;
                db::touch_profile_used(&state.db_path, &profile.id)?;
                opened.push(profile.id.clone());
            }
            Err(error) => {
                if pool_enabled {
                    let _ = db::release_profile_proxy_assignment(&state.db_path, &profile.id);
                }
                return Err(format!("Could not open profile {}: {error}", profile.name));
            }
        }
    }

    Ok(opened)
}

#[tauri::command]
pub fn open_profiles(
    profile_ids: Vec<String>,
    start_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    open_profile_ids(profile_ids, start_url, &state)
}

#[tauri::command]
pub fn close_profile(profile_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let profile = db::get_profile(&state.db_path, &profile_id)?
        .ok_or_else(|| "Profile does not exist.".to_string())?;

    refresh_processes(&state)?;
    let known_pid = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?
        .get(&profile_id)
        .copied();

    chrome::close_profile(Path::new(&profile.profile_path), known_pid)?;

    state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?
        .remove(&profile_id);
    db::release_profile_proxy_assignment(&state.db_path, &profile_id)?;

    Ok(())
}

#[tauri::command]
pub fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    db::list_workspaces(&state.db_path)
}

#[tauri::command]
pub fn create_workspace(
    request: CreateWorkspaceRequest,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    db::create_workspace(&state.db_path, &request.name, &request.profile_ids)
}

#[tauri::command]
pub fn delete_workspace(workspace_id: String, state: State<'_, AppState>) -> Result<(), String> {
    db::delete_workspace(&state.db_path, &workspace_id)
}

#[tauri::command]
pub fn get_system_info(state: State<'_, AppState>) -> Result<SystemInfo, String> {
    Ok(SystemInfo {
        chrome_path: chrome::find_chrome_executable()
            .map(|path| path.to_string_lossy().to_string()),
        data_dir: state
            .profiles_dir
            .parent()
            .unwrap_or(&state.profiles_dir)
            .to_string_lossy()
            .to_string(),
        max_simultaneous_profiles: MAX_SIMULTANEOUS_PROFILES,
    })
}
