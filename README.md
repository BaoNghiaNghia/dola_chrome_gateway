# Dola Chrome Gateway

Windows desktop manager for isolated, persistent Chrome profiles.

## MVP

- Create local Chrome profiles backed by one dedicated `--user-data-dir` each.
- Keep browser login sessions inside Chrome data, not in the app database.
- Store only profile/workspace metadata in SQLite.
- Search and group profiles.
- Select and open up to 4 profiles at once.
- Track locally launched Chrome processes and close them from the app.
- Save reusable workspaces containing 1-4 profiles.
- Detect common Google Chrome installation locations on Windows.
- Optional per-profile proxy toggle. When OFF, Chrome is launched without `--proxy-server`.
- HTTP, HTTPS, and SOCKS5 proxy endpoints.
- Sticky, rotate-on-launch, and manual rotation modes.
- Fail-closed proxy preflight: an enabled proxy must be reachable before Chrome launches.
- Proxy health, latency, and last public IP shown in the UI when available.
- Proxy changes and manual rotation are blocked while the profile is running.
- Running Chrome profiles are rediscovered from their `--user-data-dir` after manager restarts, preventing duplicate launches.
- Profile close requests graceful Chrome shutdown first, then uses force-close only as a fallback.

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
