use crate::models::{
    BrowserProfile, CreateProfileRequest, ProxyCheckResult, ProxySettings, ProxySettingsRequest,
    Workspace,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

fn connection(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Cannot open database: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Cannot enable database constraints: {e}"))?;
    Ok(conn)
}

pub fn init(db_path: &Path) -> Result<(), String> {
    let conn = connection(db_path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            group_name TEXT,
            services_json TEXT NOT NULL DEFAULT '[]',
            tags_json TEXT NOT NULL DEFAULT '[]',
            notes TEXT,
            profile_path TEXT NOT NULL UNIQUE,
            last_opened_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile_proxy_settings (
            profile_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            protocol TEXT NOT NULL DEFAULT 'http',
            host TEXT NOT NULL DEFAULT '',
            port INTEGER NOT NULL DEFAULT 0,
            auth_username TEXT,
            rotation_mode TEXT NOT NULL DEFAULT 'rotate_on_launch',
            rotation_url TEXT,
            last_ip TEXT,
            health TEXT NOT NULL DEFAULT 'disabled',
            last_latency_ms INTEGER,
            last_checked_at TEXT,
            FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_profiles (
            workspace_id TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, profile_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_profiles_group_name ON profiles(group_name);
        CREATE INDEX IF NOT EXISTS idx_workspace_profiles_position
            ON workspace_profiles(workspace_id, position);
        "#,
    )
    .map_err(|e| format!("Cannot initialize database: {e}"))?;
    Ok(())
}

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserProfile> {
    let services_json: String = row.get(4)?;
    let tags_json: String = row.get(5)?;

    Ok(BrowserProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        group_name: row.get(3)?,
        services: serde_json::from_str(&services_json).unwrap_or_default(),
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        notes: row.get(6)?,
        profile_path: row.get(7)?,
        proxy: ProxySettings::default(),
        is_running: false,
        pid: None,
        last_opened_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn get_proxy_settings_conn(conn: &Connection, profile_id: &str) -> Result<ProxySettings, String> {
    conn.query_row(
        "SELECT enabled, protocol, host, port, auth_username, rotation_mode, rotation_url,
                last_ip, health, last_latency_ms, last_checked_at
         FROM profile_proxy_settings WHERE profile_id = ?1",
        params![profile_id],
        |row| {
            let latency: Option<i64> = row.get(9)?;
            Ok(ProxySettings {
                enabled: row.get::<_, i64>(0)? != 0,
                protocol: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, i64>(3)?.max(0) as u16,
                auth_username: row.get(4)?,
                rotation_mode: row.get(5)?,
                rotation_url: row.get(6)?,
                last_ip: row.get(7)?,
                health: row.get(8)?,
                last_latency_ms: latency.map(|value| value.max(0) as u64),
                last_checked_at: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|value| value.unwrap_or_default())
}

pub fn get_proxy_settings(db_path: &Path, profile_id: &str) -> Result<ProxySettings, String> {
    let conn = connection(db_path)?;
    get_proxy_settings_conn(&conn, profile_id)
}

pub fn list_profiles(db_path: &Path) -> Result<Vec<BrowserProfile>, String> {
    let conn = connection(db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, email, group_name, services_json, tags_json, notes, profile_path,
                    last_opened_at, created_at, updated_at
             FROM profiles
             ORDER BY COALESCE(last_opened_at, created_at) DESC, name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let mut profiles = stmt
        .query_map([], row_to_profile)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for profile in &mut profiles {
        profile.proxy = get_proxy_settings_conn(&conn, &profile.id)?;
    }

    Ok(profiles)
}

pub fn get_profile(db_path: &Path, id: &str) -> Result<Option<BrowserProfile>, String> {
    let conn = connection(db_path)?;
    let mut profile = conn
        .query_row(
            "SELECT id, name, email, group_name, services_json, tags_json, notes, profile_path,
                    last_opened_at, created_at, updated_at
             FROM profiles WHERE id = ?1",
            params![id],
            row_to_profile,
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(profile) = profile.as_mut() {
        profile.proxy = get_proxy_settings_conn(&conn, id)?;
    }

    Ok(profile)
}

pub fn create_profile(
    db_path: &Path,
    profile_dir: &Path,
    request: CreateProfileRequest,
) -> Result<BrowserProfile, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Profile name is required.".into());
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let profile_path = profile_dir
        .join(&id)
        .join("chrome-data")
        .to_string_lossy()
        .to_string();

    std::fs::create_dir_all(&profile_path)
        .map_err(|e| format!("Cannot create Chrome profile directory: {e}"))?;

    let services_json = serde_json::to_string(&request.services).map_err(|e| e.to_string())?;
    let tags_json = serde_json::to_string(&request.tags).map_err(|e| e.to_string())?;
    let proxy_request = request.proxy.unwrap_or(ProxySettingsRequest {
        enabled: false,
        protocol: "http".into(),
        host: String::new(),
        port: 0,
        auth_username: None,
        rotation_mode: "rotate_on_launch".into(),
        rotation_url: None,
    });

    let mut conn = connection(db_path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO profiles
         (id, name, email, group_name, services_json, tags_json, notes, profile_path,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &id,
            name,
            request.email.as_deref().filter(|value| !value.trim().is_empty()),
            request.group_name.as_deref().filter(|value| !value.trim().is_empty()),
            services_json,
            tags_json,
            request.notes.as_deref().filter(|value| !value.trim().is_empty()),
            &profile_path,
            &now,
            &now
        ],
    )
    .map_err(|e| format!("Cannot create profile: {e}"))?;

    tx.execute(
        "INSERT INTO profile_proxy_settings
         (profile_id, enabled, protocol, host, port, auth_username, rotation_mode, rotation_url, health)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &id,
            proxy_request.enabled as i64,
            proxy_request.protocol.trim().to_lowercase(),
            proxy_request.host.trim(),
            proxy_request.port as i64,
            proxy_request
                .auth_username
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            proxy_request.rotation_mode,
            proxy_request
                .rotation_url
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            if proxy_request.enabled { "unchecked" } else { "disabled" }
        ],
    )
    .map_err(|e| format!("Cannot save proxy settings: {e}"))?;

    tx.commit().map_err(|e| e.to_string())?;
    get_profile(db_path, &id)?.ok_or_else(|| "Created profile could not be loaded.".into())
}

pub fn update_proxy_settings(
    db_path: &Path,
    profile_id: &str,
    request: ProxySettingsRequest,
) -> Result<ProxySettings, String> {
    let conn = connection(db_path)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Profile does not exist.".into());
    }

    conn.execute(
        "INSERT INTO profile_proxy_settings
         (profile_id, enabled, protocol, host, port, auth_username, rotation_mode, rotation_url, health)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(profile_id) DO UPDATE SET
            enabled = excluded.enabled,
            protocol = excluded.protocol,
            host = excluded.host,
            port = excluded.port,
            auth_username = excluded.auth_username,
            rotation_mode = excluded.rotation_mode,
            rotation_url = excluded.rotation_url,
            health = CASE WHEN excluded.enabled = 1 THEN 'unchecked' ELSE 'disabled' END",
        params![
            profile_id,
            request.enabled as i64,
            request.protocol.trim().to_lowercase(),
            request.host.trim(),
            request.port as i64,
            request
                .auth_username
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            request.rotation_mode,
            request
                .rotation_url
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            if request.enabled { "unchecked" } else { "disabled" }
        ],
    )
    .map_err(|e| format!("Cannot update proxy settings: {e}"))?;

    get_proxy_settings_conn(&conn, profile_id)
}

pub fn record_proxy_check(
    db_path: &Path,
    profile_id: &str,
    result: &ProxyCheckResult,
) -> Result<(), String> {
    let conn = connection(db_path)?;
    conn.execute(
        "UPDATE profile_proxy_settings
         SET last_ip = COALESCE(?1, last_ip),
             health = ?2,
             last_latency_ms = ?3,
             last_checked_at = ?4
         WHERE profile_id = ?5",
        params![
            result.public_ip.as_deref(),
            if result.reachable { "healthy" } else { "offline" },
            result.latency_ms.map(|value| value as i64),
            result.checked_at.as_str(),
            profile_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_proxy_failure(
    db_path: &Path,
    profile_id: &str,
    message_time: &str,
) -> Result<(), String> {
    let conn = connection(db_path)?;
    conn.execute(
        "UPDATE profile_proxy_settings
         SET health = 'offline', last_latency_ms = NULL, last_checked_at = ?1
         WHERE profile_id = ?2",
        params![message_time, profile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn touch_last_opened(db_path: &Path, id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let conn = connection(db_path)?;
    conn.execute(
        "UPDATE profiles SET last_opened_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_profile(db_path: &Path, id: &str) -> Result<(), String> {
    let conn = connection(db_path)?;
    conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create_workspace(
    db_path: &Path,
    name: &str,
    profile_ids: &[String],
) -> Result<Workspace, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Workspace name is required.".into());
    }
    if profile_ids.is_empty() || profile_ids.len() > 4 {
        return Err("A workspace must contain between 1 and 4 profiles.".into());
    }

    let mut unique = profile_ids.to_vec();
    unique.sort();
    unique.dedup();
    if unique.len() != profile_ids.len() {
        return Err("Workspace contains duplicate profiles.".into());
    }

    let mut conn = connection(db_path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for id in profile_ids {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Profile {id} does not exist."));
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![&id, name, &now],
    )
    .map_err(|e| e.to_string())?;

    for (position, profile_id) in profile_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO workspace_profiles (workspace_id, profile_id, position)
             VALUES (?1, ?2, ?3)",
            params![&id, profile_id, position as i64],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(Workspace {
        id,
        name: name.to_string(),
        profile_ids: profile_ids.to_vec(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_workspaces(db_path: &Path) -> Result<Vec<Workspace>, String> {
    let conn = connection(db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, updated_at
             FROM workspaces ORDER BY updated_at DESC, name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let base = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut workspaces = Vec::with_capacity(base.len());
    for (id, name, created_at, updated_at) in base {
        let mut profiles_stmt = conn
            .prepare(
                "SELECT profile_id FROM workspace_profiles
                 WHERE workspace_id = ?1 ORDER BY position ASC",
            )
            .map_err(|e| e.to_string())?;
        let profile_ids = profiles_stmt
            .query_map(params![&id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        workspaces.push(Workspace {
            id,
            name,
            profile_ids,
            created_at,
            updated_at,
        });
    }

    Ok(workspaces)
}

pub fn delete_workspace(db_path: &Path, id: &str) -> Result<(), String> {
    let conn = connection(db_path)?;
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
