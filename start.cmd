@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node 23.4 or newer, then run this again.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
