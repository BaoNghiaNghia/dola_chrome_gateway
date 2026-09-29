# Building Dola Chrome Gateway

## Requirements

- Windows 10/11
- Node.js 20+
- Rust toolchain with Cargo
- Microsoft Visual C++ build tools required by Tauri
- Node.js must also be installed on the target PC if Seedance Automation is used

## Commands

### Verify the project

```powershell
npm run check
```

Runs:
- TypeScript + Vite production build
- Rust `cargo check`
- Seedance adapter syntax/tests

### Build portable app

```powershell
npm run build:portable
```

Output:

```text
release\windows\portable\
  Dola-Chrome-Gateway.exe
  adapter\
```

Keep the `adapter` folder next to the executable.

### Build Windows installer

```powershell
npm run build:win
```

This creates:
- portable build under `release\windows\portable`
- NSIS installer under `release\windows`
- `build-info.txt` with version and runtime defaults

## Automatic rebuild workflow

This repository uses Git hooks from `.githooks`.

Enable them once per clone:

```powershell
npm run setup:autobuild
```

After setup:

- Every `git commit` automatically runs `npm run build:portable`. A failed build blocks the commit.
- Every `git push` automatically runs `npm run build:win`. A failed Windows/NSIS build blocks the push.
- Every successful merge/pull automatically rebuilds the portable tool.
- Generated artifacts are refreshed under `release\windows`.

For emergency diagnostics only, a single Git operation can bypass the hook by setting `DOLA_SKIP_AUTO_BUILD=1`. Normal development should not use this.

## Runtime defaults

- Chrome session root: `E:\Dola Chrome`
- Default page: `https://www.dola.com/chat`
- Default page zoom: 85%
- Maximum simultaneous profiles: 4
- Seedance Automation requires Node.js 20+ on the target PC

The application does not create `E:\Dola Chrome` automatically. It must already exist before creating or opening profiles.
