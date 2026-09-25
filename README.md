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
- Persistent Seedance generation queue stored in SQLite with queued/starting/generating/recovering/completed/failed/cancelled states.
- Interrupted generation jobs in `starting` or `generating` automatically return as `recovering` after an app restart.
- Queue UI supports Seedance model, duration, aspect ratio, persistent job creation, status inspection, and cancellation. The website execution adapter is intentionally a separate next phase.

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
