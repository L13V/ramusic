@echo off
rem Delayed expansion is required below: %VAR% inside a parenthesised block is
rem substituted when the block is PARSED, so a variable that `set /p` fills in
rem at run time reads back empty. That is why this used to delete the pid file,
rem announce success, and leave the server running.
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo Stopping spotify-tv-jam...

rem 1) Close the full-screen (kiosk) TV window — only the one this app opened.
rem    Matched on the kiosk profile path start.bat actually passes (a folder
rem    under this repo), not on the project name: the old '*spotify-tv-jam*'
rem    pattern only matched when the checkout happened to be in a folder of
rem    that name, so on any other path the TV window was left open.
set "KIOSKDIR=%~dp0app\.data\kiosk"
powershell -NoProfile -Command "$d=$env:KIOSKDIR; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($d.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

rem 2) Stop the server by the PID it wrote (exact — leaves other Node apps alone).
if exist "app\.data\server.pid" (
  set "SRVPID="
  set /p SRVPID=<"app\.data\server.pid"
  if defined SRVPID (
    taskkill /PID !SRVPID! /T /F >nul 2>&1
  )
  del "app\.data\server.pid" >nul 2>&1
) else (
  rem Fallback: match this project's server.js if no pid file.
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)

echo Done. Everything is stopped.
endlocal
