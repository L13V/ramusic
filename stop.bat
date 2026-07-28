@echo off
cd /d "%~dp0"
echo Stopping spotify-tv-jam...

rem 1) Close the full-screen (kiosk) TV window — only the one this app opened.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*spotify-tv-jam*kiosk*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

rem 2) Stop the server by the PID it wrote (exact — leaves other Node apps alone).
if exist "app\.data\server.pid" (
  set /p SRVPID=<"app\.data\server.pid"
  taskkill /PID %SRVPID% /F >nul 2>&1
  del "app\.data\server.pid" >nul 2>&1
) else (
  rem Fallback: match this project's server.js if no pid file.
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)

echo Done. Everything is stopped.
