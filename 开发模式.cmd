@echo off
rem ---------------------------------------------------------------------------
rem Sucai dev launcher - vite with HMR plus the Electron shell in --dev mode.
rem Electron waits for http://localhost:5188 before it opens its window.
rem
rem This does NOT package anything. For the built installer use:
rem     release\
rem Requires Node.js >= 20.19 (recommended 22 LTS) on PATH.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js not found on PATH. Please install Node.js 22 LTS first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

echo Starting Sucai in dev mode (vite + Electron). Press Ctrl+C to stop.
echo.
call npm run electron:dev
exit /b %errorlevel%

:failed
echo [ERROR] npm install failed.
pause
exit /b 1
