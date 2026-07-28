@echo off
cd /d "%~dp0app"
title spotify-tv-jam  --  KEEP OPEN. Press Ctrl+C or close this window to STOP.
echo.
echo ==== spotify-tv-jam ====
echo.
echo This window RUNS the app. To stop everything:
echo    - press Ctrl+C here, or just close this window, and
echo    - run stop.bat (closes the full-screen TV window too).
echo.
if not exist node_modules (
  echo Installing dependencies, this can take a minute...
  call npm install
)
echo Starting server + opening full-screen...
rem Kiosk Chrome runs in its own isolated profile under .data\kiosk so stop.bat
rem can close exactly this window and nothing else of yours.
start "" cmd /c "timeout /t 5 /nobreak >nul & start chrome --user-data-dir=""%~dp0app\.data\kiosk"" --new-window --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000"
call npm start
