use crate::db;
use crate::state::BackgroundRuntime;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub fn allocation_tick(db_path: &Path) -> Result<usize, String> {
    let settings = db::get_worker_settings(db_path)?;
    if !settings.enabled {
        return Ok(0);
    }
    if settings.mode != "allocation_only" {
        return Err(format!("Unsupported worker mode: {}", settings.mode));
    }
    if !db::get_scheduler_enabled(db_path)? {
        return Err("Smart Scheduler is disabled.".into());
    }

    let active_count = db::count_active_job_assignments(db_path)?;
    if active_count >= settings.max_concurrent_jobs {
        db::record_worker_tick(db_path, None)?;
        return Ok(0);
    }

    let capacity = settings.max_concurrent_jobs - active_count;
    let active_profile_ids = db::list_active_job_profile_ids(db_path)?
        .into_iter()
        .collect::<HashSet<_>>();

    let mut ready_profiles = db::list_profiles(db_path)?
        .into_iter()
        .filter(|profile| {
            profile.operational.scheduling_enabled
                && profile.operational.availability == "ready"
                && !active_profile_ids.contains(&profile.id)
        })
        .collect::<Vec<_>>();

    ready_profiles.sort_by(|a, b| {
        a.operational
            .last_used_at
            .cmp(&b.operational.last_used_at)
            .then_with(|| a.name.cmp(&b.name))
    });

    if ready_profiles.is_empty() {
        if !db::list_queued_generation_jobs(db_path, 1)?.is_empty() {
            return Err("No scheduler-ready profiles are available for queued jobs.".into());
        }
        db::record_worker_tick(db_path, None)?;
        return Ok(0);
    }

    let claim_count = capacity.min(ready_profiles.len());
    let jobs = db::list_queued_generation_jobs(db_path, claim_count)?;
    let mut assigned = 0usize;

    for (job, profile) in jobs.iter().zip(ready_profiles.iter()) {
        if db::assign_generation_job(db_path, &job.id, &profile.id)? {
            assigned += 1;
        }
    }

    db::record_worker_tick(db_path, None)?;
    Ok(assigned)
}

pub fn start(db_path: PathBuf) -> Result<BackgroundRuntime, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = thread::Builder::new()
        .name("dola-allocation-worker".into())
        .spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let settings = match db::get_worker_settings(&db_path) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = db::record_worker_tick(&db_path, Some(error.as_str()));
                        thread::sleep(Duration::from_secs(1));
                        continue;
                    }
                };

                if !settings.enabled {
                    break;
                }

                if let Err(error) = allocation_tick(&db_path) {
                    let _ = db::record_worker_tick(&db_path, Some(error.as_str()));
                }

                let sleep_ms = settings.poll_interval_ms.clamp(250, 60_000);
                let mut slept = 0u64;
                while slept < sleep_ms && !thread_stop.load(Ordering::SeqCst) {
                    let step = (sleep_ms - slept).min(250);
                    thread::sleep(Duration::from_millis(step));
                    slept += step;
                }
            }
        })
        .map_err(|e| format!("Cannot start allocation worker: {e}"))?;

    Ok(BackgroundRuntime::new(stop, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CreateGenerationJobRequest, CreateProfileRequest, UpdateProfileOperationalStateRequest,
    };
    use std::fs;
    use uuid::Uuid;

    fn setup() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("dola-worker-test-{}", Uuid::new_v4()));
        let profiles_dir = root.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();
        let db_path = root.join("test.sqlite3");
        db::init(&db_path).unwrap();
        (root, db_path, profiles_dir)
    }

    fn mark_healthy(db_path: &Path, profile_id: &str, last_used_at: Option<&str>) {
        db::update_profile_operational_state(
            db_path,
            profile_id,
            UpdateProfileOperationalStateRequest {
                scheduling_enabled: Some(true),
                session_status: Some("healthy".into()),
                login_checked_at: Some("2026-09-25T00:00:00Z".into()),
                cooldown_until: None,
                rate_limited_until: None,
                quota_blocked_until: None,
                credit_balance: None,
                used_today: Some(0),
                remaining: None,
                last_used_at: last_used_at.map(str::to_string),
            },
        )
        .unwrap();
    }

    #[test]
    fn allocation_tick_assigns_oldest_ready_profile() {
        let (root, db_path, profiles_dir) = setup();

        let first = db::create_profile(
            &db_path,
            &profiles_dir,
            CreateProfileRequest {
                name: "Older ready".into(),
                email: None,
                group_name: None,
                services: vec![],
                tags: vec![],
                notes: None,
                proxy: None,
            },
        )
        .unwrap();
        let second = db::create_profile(
            &db_path,
            &profiles_dir,
            CreateProfileRequest {
                name: "Newer ready".into(),
                email: None,
                group_name: None,
                services: vec![],
                tags: vec![],
                notes: None,
                proxy: None,
            },
        )
        .unwrap();

        mark_healthy(&db_path, &first.id, Some("2026-09-20T00:00:00Z"));
        mark_healthy(&db_path, &second.id, Some("2026-09-24T00:00:00Z"));
        db::set_scheduler_enabled(&db_path, true).unwrap();
        db::set_worker_enabled(&db_path, true).unwrap();

        let job = db::create_generation_job(
            &db_path,
            CreateGenerationJobRequest {
                prompt: "allocator test".into(),
                model: Some("seedance-2.5".into()),
                duration_seconds: Some(10),
                ratio: Some("1:1".into()),
            },
        )
        .unwrap();

        let assigned = allocation_tick(&db_path).unwrap();
        assert_eq!(assigned, 1);

        let job = db::get_generation_job(&db_path, &job.id).unwrap().unwrap();
        assert_eq!(job.status, "assigned");
        assert_eq!(job.profile_id.as_deref(), Some(first.id.as_str()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn allocation_tick_skips_need_login_profiles() {
        let (root, db_path, profiles_dir) = setup();

        let profile = db::create_profile(
            &db_path,
            &profiles_dir,
            CreateProfileRequest {
                name: "Needs login".into(),
                email: None,
                group_name: None,
                services: vec![],
                tags: vec![],
                notes: None,
                proxy: None,
            },
        )
        .unwrap();

        db::update_profile_operational_state(
            &db_path,
            &profile.id,
            UpdateProfileOperationalStateRequest {
                scheduling_enabled: Some(true),
                session_status: Some("needs_login".into()),
                login_checked_at: Some("2026-09-25T00:00:00Z".into()),
                cooldown_until: None,
                rate_limited_until: None,
                quota_blocked_until: None,
                credit_balance: None,
                used_today: Some(0),
                remaining: None,
                last_used_at: None,
            },
        )
        .unwrap();

        db::set_scheduler_enabled(&db_path, true).unwrap();
        db::set_worker_enabled(&db_path, true).unwrap();
        db::create_generation_job(
            &db_path,
            CreateGenerationJobRequest {
                prompt: "blocked allocator test".into(),
                model: None,
                duration_seconds: None,
                ratio: None,
            },
        )
        .unwrap();

        let error = allocation_tick(&db_path).unwrap_err();
        assert!(error.contains("No scheduler-ready profiles"));

        let _ = fs::remove_dir_all(root);
    }
}
