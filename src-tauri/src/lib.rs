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
