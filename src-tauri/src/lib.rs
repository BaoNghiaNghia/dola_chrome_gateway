mod chrome;
mod commands;
mod db;
mod models;
mod proxy;
mod state;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(format!(
                    "Cannot resolve app data directory: {e}"
                )))?;
            let profiles_dir = app_data_dir.join("profiles");
            std::fs::create_dir_all(&profiles_dir)?;

            let db_path = app_data_dir.join("profiles.sqlite3");
            db::init(&db_path).map_err(std::io::Error::other)?;
            db::mark_interrupted_jobs_recovering(&db_path).map_err(std::io::Error::other)?;
            app.manage(AppState::new(db_path, profiles_dir));
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
