# Dola Chrome Gateway

Windows desktop manager for isolated, persistent Chrome profiles.

## Quick start on Windows

The easiest way to run the project is to double-click:

```text
START.bat
```

The launcher automatically:

- opens from the correct project directory,
- adds Rust/Cargo to PATH,
- installs npm dependencies on the first run if needed,
- starts the Tauri desktop app.

From Command Prompt, the short equivalent is:

```cmd
npm start
```


## MVP

- Create local Chrome profiles backed by one dedicated `--user-data-dir` each.
- Keep browser login sessions inside Chrome data, not in the app database.
- Store only profile/workspace metadata in SQLite.
- Search and group profiles.
- Select and open up to 4 profiles at once.
- Track locally launched Chrome processes and close them from the app.
- Save reusable workspaces containing 1-4 profiles.
- Detect common Google Chrome installation locations on Windows.
- Optional system-wide rotating Proxy Pool. When OFF, new Chrome launches use the direct machine connection.
- HTTP, HTTPS, and SOCKS5 proxy slots with one reserved proxy per running profile.
- Rotate-before-allocation, proxy preflight, health, latency, last public IP, and fail-closed batch launch.
- Running Chrome profiles are rediscovered from their `--user-data-dir` after manager restarts, preventing duplicate launches.
- Profile close requests graceful Chrome shutdown first, then uses force-close only as a fallback.
- Smart Scheduler with per-profile session health, scheduler enable/disable, cooldown, rate-limit, quota-block, credits, usage, and least-recently-used selection.
- Scheduler-ready profiles can be launched automatically with `Open Smart`; blocked profiles are skipped.
- Persistent Seedance generation queue stored in SQLite with queued/assigned/starting/generating/recovering/completed/failed/cancelled states.
- Interrupted generation jobs in `starting` or `generating` automatically return as `recovering` after an app restart.
- Queue UI supports Seedance model, duration, aspect ratio, persistent job creation, status inspection, cancellation, progress, attempts, lease ownership, and retry visibility.
- A lease-based execution-adapter protocol lets a separate local Seedance adapter claim jobs, heartbeat, report progress, complete results, or fail/retry without coupling website automation to the Tauri core.

## Local API and allocation worker

The Queue tab can start a local HTTP API bound only to `127.0.0.1`. All endpoints except `/health` require the gateway bearer key shown in the app.

Available endpoints:

```text
GET  /health
GET  /v1/videos
POST /v1/videos/generations
GET  /v1/videos/{job_id}
POST /v1/videos/{job_id}/cancel

POST /v1/adapter/claim
POST /v1/adapter/jobs/{job_id}/heartbeat
POST /v1/adapter/jobs/{job_id}/start
POST /v1/adapter/jobs/{job_id}/progress
POST /v1/adapter/jobs/{job_id}/complete
POST /v1/adapter/jobs/{job_id}/fail
```

Example:

```cmd
curl -X POST http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"A handheld UGC video\",\"model\":\"seedance-2.5\",\"durationSeconds\":10,\"ratio\":\"1:1\"}"
```

The allocation worker is disabled by default. When enabled, it requires Smart Scheduler to be ON and assigns queued jobs to Ready profiles using least-recently-used ordering. Its current mode is `allocation_only`: it reserves a profile and changes the job to `assigned`.

The adapter protocol uses short-lived per-job leases so two adapter processes cannot execute the same job concurrently. A claim returns a lease token plus assigned profile context. The adapter renews that lease with heartbeat calls, then reports `start`, `progress`, `complete`, or `fail`. Retryable failures are returned to the queue with a backoff and their profile assignment is cleared so the scheduler can select another Ready profile. Automatic Seedance website interaction itself remains isolated in the adapter layer.

## Stack

- Tauri 2
- React 19 + TypeScript
- Rust
- SQLite via rusqlite

## Local development

Prerequisites:

1. Node.js 20+
2. Rust stable with Cargo
3. Microsoft C++ Build Tools required by Tauri on Windows
4. Google Chrome

Install JavaScript dependencies:

```cmd
npm install
```

Run the desktop app:

```cmd
npm run tauri dev
```

Build the frontend only:

```cmd
npm run build
```

Build a Windows installer:

```cmd
npm run tauri build
```

## Data safety

The SQLite database stores metadata only. Login cookies, local storage, extensions, and browser session data stay inside each Chrome user-data directory under the Tauri application data directory.

Removing a profile entry from the manager does not delete its Chrome user-data directory in the MVP.
