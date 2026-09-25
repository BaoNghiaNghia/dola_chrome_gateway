use crate::chrome;
use crate::db;
use crate::models::{
    BrowserProfile, CreateProfileRequest, CreateWorkspaceRequest, ProxyCheckResult, ProxySettings,
    ProxySettingsRequest, SystemInfo, Workspace,
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
        }
    }
    Ok(())
}

fn check_and_record_proxy(
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
    db::delete_profile(&state.db_path, &profile_id)
}

#[tauri::command]
pub fn update_profile_proxy(
    profile_id: String,
    request: ProxySettingsRequest,
    state: State<'_, AppState>,
) -> Result<ProxySettings, String> {
    if is_profile_running(&profile_id, &state)? {
        return Err(
            "Close this Chrome profile before changing proxy settings. The proxy stays sticky while Chrome is running."
                .into(),
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
    check_and_record_proxy(&profile_id, &settings, &state)
}

#[tauri::command]
pub fn rotate_profile_proxy(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ProxyCheckResult, String> {
    if is_profile_running(&profile_id, &state)? {
        return Err(
            "Close this Chrome profile before rotating its proxy. Rotation is intentionally blocked during an active browser session."
                .into(),
        );
    }

    let settings = db::get_proxy_settings(&state.db_path, &profile_id)?;
    if !settings.enabled {
        return Err("Enable proxy before rotating it.".into());
    }

    proxy::rotate(&settings)?;
    check_and_record_proxy(&profile_id, &settings, &state)
}

fn prepare_proxy_for_launch(
    profile_id: &str,
    settings: &ProxySettings,
    state: &AppState,
) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }

    proxy::validate(settings)?;

    if settings.rotation_mode == "rotate_on_launch" {
        proxy::rotate(settings).map_err(|error| {
            format!("Proxy rotation failed for profile {profile_id}; Chrome was not opened: {error}")
        })?;
    }

    check_and_record_proxy(profile_id, settings, state).map_err(|error| {
        format!("Proxy preflight failed for profile {profile_id}; Chrome was not opened: {error}")
    })?;

    Ok(())
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
    let current_running = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?
        .len();

    let already_running = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())?;
        profile_ids
            .iter()
            .filter(|id| processes.contains_key(*id))
            .count()
    };
    let new_count = profile_ids.len().saturating_sub(already_running);

    if current_running + new_count > MAX_SIMULTANEOUS_PROFILES {
        return Err(format!(
            "Only {MAX_SIMULTANEOUS_PROFILES} Chrome profiles can run at the same time."
        ));
    }

    let mut opened = Vec::new();
    for profile_id in profile_ids {
        let already_running = state
            .processes
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())?
            .contains_key(&profile_id);

        if already_running {
            opened.push(profile_id);
            continue;
        }

        let profile = db::get_profile(&state.db_path, &profile_id)?
            .ok_or_else(|| format!("Profile {profile_id} does not exist."))?;

        prepare_proxy_for_launch(&profile_id, &profile.proxy, state)?;

        let pid = chrome::launch(
            Path::new(&profile.profile_path),
            start_url.as_deref(),
            &profile.proxy,
        )?;
        state
            .processes
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())?
            .insert(profile_id.clone(), pid);
        db::touch_last_opened(&state.db_path, &profile_id)?;
        opened.push(profile_id);
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
