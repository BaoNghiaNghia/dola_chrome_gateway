@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

if "%DOLA_GATEWAY_KEY%"=="" (
  echo.
  echo [ERROR] DOLA_GATEWAY_KEY is not set.
  echo.
  echo 1. Open Dola Gateway ^> Queue ^> Local API.
  echo 2. Turn Local API ON and click "Reveal key".
  echo 3. In Command Prompt run:
  echo.
  echo    set DOLA_GATEWAY_KEY=YOUR_KEY
  echo    START_ADAPTER.bat
  echo.
  pause
  exit /b 1
)

if "%DOLA_GATEWAY_URL%"=="" set "DOLA_GATEWAY_URL=http://127.0.0.1:8787"

echo Starting Seedance adapter...
echo Gateway: %DOLA_GATEWAY_URL%
echo.
node adapter\seedance-adapter.mjs
