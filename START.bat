@echo off
setlocal
title Dola Chrome Gateway

cd /d "%~dp0"

rem Rust installed by rustup is normally here. Add it automatically for old terminals.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found.
  echo Install Node.js, then double-click START.bat again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm was not found.
  echo Reinstall Node.js, then double-click START.bat again.
  echo.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Rust/Cargo was not found.
  echo Install Rust with rustup, then double-click START.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\." (
  echo.
  echo [Dola] First run: installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

echo.
echo [Dola] Starting Chrome Gateway...
echo [Dola] Close this terminal only when you want to stop the development app.
echo.

call npm start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [ERROR] Dola Chrome Gateway could not start.
echo Review the error above, then press any key to close.
echo.
pause >nul
exit /b 1
