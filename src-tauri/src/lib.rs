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
use tauri::Manager;

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
            let profiles_dir = app_data_dir.join("profiles");
            std::fs::create_dir_all(&profiles_dir)?;

            let db_path = app_data_dir.join("profiles.sqlite3");
            db::init(&db_path).map_err(std::io::Error::other)?;
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
            commands::close_profile,
            commands::list_workspaces,
            commands::create_workspace,
            commands::delete_workspace,
            commands::get_system_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dola Chrome Gateway");
}
