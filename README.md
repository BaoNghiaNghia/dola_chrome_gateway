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
POST /v1/adapter/jobs/{job_id}/profile-state
POST /v1/adapter/jobs/{job_id}/browser/open
POST /v1/adapter/jobs/{job_id}/browser/close
```

Example:

```cmd
curl -X POST http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"A handheld UGC video\",\"model\":\"seedance-2.5\",\"durationSeconds\":10,\"ratio\":\"1:1\"}"
```

The allocation worker is disabled by default. When enabled, it requires Smart Scheduler to be ON and assigns queued jobs to Ready profiles using least-recently-used ordering. Its current mode is `allocation_only`: it reserves a profile and changes the job to `assigned`.

The adapter protocol uses short-lived per-job leases so two adapter processes cannot execute the same job concurrently. A claim returns a lease token plus assigned profile context. The adapter renews that lease with heartbeat calls, then reports `start`, `progress`, `complete`, or `fail`. Retryable failures are returned to the queue with a backoff and their profile assignment is cleared so the scheduler can select another Ready profile.

For browser execution, an adapter can open the job's assigned persistent Chrome profile through `/browser/open`. The gateway keeps the profile's existing `--user-data-dir` session, applies the system Proxy Pool before launch when enabled, and starts Chrome DevTools on `127.0.0.1` with an ephemeral port. The response contains `cdpHttpUrl` and `browserWebsocketUrl` for that local adapter session. A profile already running without the gateway's local DevTools mode is not silently reattached; it must be closed and reopened through the adapter endpoint. `/browser/close` closes only that assigned profile and releases its proxy slot.

Automatic Seedance website interaction itself remains isolated in the adapter layer; the Tauri core does not store login credentials or extract browser cookies.

## Seedance execution adapter

The repository includes a dependency-free Node.js adapter under `adapter/`. It connects only to the gateway's loopback API and to the loopback Chrome DevTools endpoint created for the leased profile.

### Recommended: one-click runtime

1. In **Profiles**, mark usable logged-in profiles as **Ready**.
2. Open **Queue**.
3. In **Automation Runtime**, choose concurrency/timeout settings if needed.
4. Turn **Automation Runtime** ON.

The app then starts **Smart Scheduler -> Local API -> Profile Allocator -> Seedance Adapter** in the correct order and passes the gateway key to the child process internally. The Local API key does not need to be revealed for normal use. Adapter output is available from **View logs** in the same card.

The adapter scripts are bundled as Tauri resources for packaged builds. Node.js 20+ still needs to be available on the machine; the runtime card reports `Node READY` or `Node MISSING`.

### Manual/debug fallback

The old manual launcher remains available for troubleshooting:

```cmd
set DOLA_GATEWAY_KEY=YOUR_REVEALED_KEY
START_ADAPTER.bat
```

Or:

```cmd
set DOLA_GATEWAY_KEY=YOUR_REVEALED_KEY
npm run adapter
```

Useful optional environment settings for manual mode:

```text
DOLA_GATEWAY_URL=http://127.0.0.1:8787
DOLA_ADAPTER_CONCURRENCY=1
DOLA_ADAPTER_TIMEOUT_SECONDS=1200
DOLA_ADAPTER_MANUAL_VERIFICATION_SECONDS=180
DOLA_DOWNLOAD_DIR=C:\\path\\to\\downloads
```

The adapter currently automates the normal Dola UI flow for Seedance 2.0/2.5: open the persistent profile, verify that the chat composer is available, open video generation, select model/ratio/duration, submit the prompt, capture the resulting conversation ID, then monitor the conversation for the generated video. Dola durations supported by this adapter are **10s, 15s, and 30s**.

### Original / high-quality result extraction

When Dola returns a completed video, the adapter now reads both `download_url` and `video_model`. It parses `video_model.video_list`, base64-decodes its `main_url` entries, and treats those entries as the original-stream candidates. Selection order is:

1. Dola `video_model` original-stream candidates before the generic `download_url`.
2. Highest actual resolution when width/height metadata is available.
3. Resolution/quality hints when present.
4. Highest bitrate as the final quality tie-breaker.

Before completion, the selected URL is also loaded as video metadata inside the assigned Chrome session so the job can record the actual browser-visible `videoWidth × videoHeight` when the CDN permits metadata probing. This is what the Queue uses to identify a real **1080-class** output rather than inferring 1080p from bitrate alone.

The selected stream is downloaded automatically. Managed Automation Runtime stores completed files under the app-data `downloads` directory; manual adapter mode can override this with `DOLA_DOWNLOAD_DIR`. The job stores the local path, file size, resolution, bitrate, source kind, and whether the selected source came from the original/no-watermark-priority `video_model` path. If that original candidate cannot be downloaded, the adapter falls back to Dola's `download_url` and does **not** mark the fallback as no-watermark.

This is source selection, not post-processing: the gateway does not crop, blur, inpaint, or otherwise remove a watermark from an already-watermarked video.

The adapter does **not** extract login cookies and does **not** solve verification challenges. If Dola displays a verification/captcha frame, the visible Chrome window stays open for the configured manual-verification window while the adapter keeps the job lease alive. If verification is not completed, the job is returned to the retry flow with a cooldown.

Adapter-detected account problems feed back into Profile Health:

- session unavailable -> **Need login**
- daily generation limit -> temporary **Quota blocked**
- insufficient credit -> scheduling disabled until manually re-enabled
- verification timeout -> short **Cooldown**

Run the dependency-free adapter unit tests with:

```cmd
npm run adapter:test
```

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
