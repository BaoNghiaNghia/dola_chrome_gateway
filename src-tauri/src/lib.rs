mod adapter_runtime;
mod api_server;
mod chrome;
mod commands;
mod db;
mod execution_browser;
mod models;
mod proxy;
mod state;
mod worker;

use state::AppState;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(target_os = "windows")]
fn profiles_storage_dir(_app_data_dir: &Path) -> PathBuf {
    PathBuf::from(r"E:\Dola Chrome").join("Profiles")
}

#[cfg(not(target_os = "windows"))]
fn profiles_storage_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("profiles")
}

fn prepare_profiles_storage(profiles_dir: &Path) -> std::io::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        let required_root = profiles_dir
            .parent()
            .unwrap_or(profiles_dir);
        if !required_root.is_dir() {
            return Ok(false);
        }
    }

    fs::create_dir_all(profiles_dir)?;
    Ok(true)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn paths_match(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn migrate_profiles_to_storage(db_path: &Path, profiles_dir: &Path) -> Result<(), String> {
    let profiles = db::list_profiles(db_path)?;
    let profile_paths = profiles
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                PathBuf::from(profile.profile_path.as_str()),
            )
        })
        .collect::<Vec<_>>();
    let running = chrome::discover_profile_pids(&profile_paths).unwrap_or_default();

    for profile in profiles {
        let current = PathBuf::from(&profile.profile_path);
        let target_root = profiles_dir.join(&profile.id);
        let target = target_root.join("chrome-data");

        if paths_match(&current, &target) {
            continue;
        }

        if running.contains_key(&profile.id) {
            eprintln!(
                "Skipping profile storage migration for {} because Chrome is running.",
                profile.id
            );
            continue;
        }

        if target.exists() {
            if let Err(error) = db::update_profile_path(db_path, &profile.id, &target) {
                eprintln!(
                    "Could not switch profile {} to existing storage target: {}",
                    profile.id, error
                );
            }
            continue;
        }

        if !current.exists() {
            eprintln!(
                "Skipping profile {} migration because its current Chrome session storage is missing at {}.",
                profile.id,
                current.display()
            );
            continue;
        }

        let staging_root = profiles_dir.join(format!(".migrating-{}", profile.id));
        let staging = staging_root.join("chrome-data");
        if staging_root.exists() {
            let _ = fs::remove_dir_all(&staging_root);
        }

        if let Err(error) = copy_dir_recursive(&current, &staging) {
            eprintln!(
                "Could not copy profile {} to {}: {}",
                profile.id,
                staging.display(),
                error
            );
            let _ = fs::remove_dir_all(&staging_root);
            continue;
        }

        if let Err(error) = fs::rename(&staging_root, &target_root) {
            eprintln!(
                "Could not finalize profile {} migration to {}: {}",
                profile.id,
                target_root.display(),
                error
            );
            let _ = fs::remove_dir_all(&staging_root);
            continue;
        }

        if let Err(error) = db::update_profile_path(db_path, &profile.id, &target) {
            eprintln!(
                "Profile {} was copied to {} but its database path could not be updated: {}",
                profile.id,
                target.display(),
                error
            );
            continue;
        }

        if let Err(error) = fs::remove_dir_all(&current) {
            eprintln!(
                "Profile {} now uses {} but the old copy at {} could not be removed: {}",
                profile.id,
                target.display(),
                current.display(),
                error
            );
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::other(format!("Cannot resolve app data directory: {e}"))
            })?;
            let resource_dir = app.path().resource_dir().map_err(|e| {
                std::io::Error::other(format!("Cannot resolve app resource directory: {e}"))
            })?;
            let profiles_dir = profiles_storage_dir(&app_data_dir);
            let profile_storage_ready = prepare_profiles_storage(&profiles_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "Cannot access Dola Chrome profile storage at {}: {error}",
                    profiles_dir.display()
                ))
            })?;

            let db_path = app_data_dir.join("profiles.sqlite3");
            db::init(&db_path).map_err(std::io::Error::other)?;
            if profile_storage_ready {
                migrate_profiles_to_storage(&db_path, &profiles_dir)
                    .map_err(std::io::Error::other)?;
            } else {
                eprintln!(
                    "Dola Chrome storage root is unavailable. Expected E:\\Dola Chrome; profile creation and launch will remain blocked."
                );
            }
            db::mark_interrupted_jobs_recovering(&db_path).map_err(std::io::Error::other)?;

            let state = AppState::new(
                app_data_dir.clone(),
                resource_dir,
                db_path.clone(),
                profiles_dir,
            );

            let api_settings =
                db::get_local_api_settings(&db_path).map_err(std::io::Error::other)?;
            if api_settings.enabled {
                match api_server::start(db_path.clone(), api_settings.port) {
                    Ok(runtime) => {
                        *state
                            .api_runtime
                            .lock()
                            .map_err(|_| std::io::Error::other("Local API state lock failed"))? =
                            Some(runtime);
                    }
                    Err(_) => {
                        let _ = db::set_local_api_enabled(&db_path, false);
                    }
                }
            }

            let worker_settings =
                db::get_worker_settings(&db_path).map_err(std::io::Error::other)?;
            if worker_settings.enabled {
                match worker::start(db_path.clone()) {
                    Ok(runtime) => {
                        *state
                            .worker_runtime
                            .lock()
                            .map_err(|_| std::io::Error::other("Worker state lock failed"))? =
                            Some(runtime);
                    }
                    Err(_) => {
                        let _ = db::set_worker_enabled(&db_path, false);
                    }
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::create_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::update_profile_proxy,
            commands::test_profile_proxy,
            commands::rotate_profile_proxy,
            commands::get_scheduler_state,
            commands::set_scheduler_enabled,
            commands::update_profile_operational_state,
            commands::clear_profile_operational_blocks,
            commands::open_smart_profiles,
            commands::list_generation_jobs,
            commands::create_generation_job,
            commands::update_generation_job,
            commands::cancel_generation_job,
            commands::reveal_generation_result,
            commands::get_local_api_state,
            commands::set_local_api_enabled,
            commands::set_local_api_port,
            commands::reveal_local_api_key,
            commands::rotate_local_api_key,
            commands::get_worker_state,
            commands::set_worker_enabled,
            commands::run_worker_tick,
            commands::get_automation_runtime_state,
            commands::update_automation_runtime_config,
            commands::set_automation_runtime_enabled,
            commands::get_automation_runtime_log,
            commands::get_proxy_pool_state,
            commands::set_proxy_pool_enabled,
            commands::create_proxy_pool_item,
            commands::update_proxy_pool_item,
            commands::delete_proxy_pool_item,
            commands::test_proxy_pool_item,
            commands::rotate_proxy_pool_item,
            commands::open_profiles,
            commands::open_profile_login_mode,
            commands::close_profile,
            commands::list_workspaces,
            commands::create_workspace,
            commands::delete_workspace,
            commands::get_system_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dola Chrome Gateway");
}
