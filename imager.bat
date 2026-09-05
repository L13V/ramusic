@echo off
setlocal

rem Raw disk writes need Administrator, so ask for it here rather than after the
rem app is already up: elevating a running Electron means relaunching it, and a
rem relaunch loses the console this window is holding open.
fltmc filters >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for Administrator rights...
  powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0' -ErrorAction Stop } catch { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo The Administrator prompt was refused, so the USB stick cannot be written.
    echo Choose Yes on the prompt, or right-click imager.bat and pick
    echo "Run as administrator".
    echo.
    pause
  )
  exit /b
)

cd /d "%~dp0imager"
title RAMTECH Imager  --  KEEP OPEN while writing a USB stick.
echo.
echo ==== RAMTECH Imager ====
echo.
echo Writes RAMTECH OS to a USB stick. This window is running as Administrator
echo -- raw disk writes need that.
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed -- see the messages above.
    pause
    exit /b 1
  )
)

echo Starting...
call npm start
if errorlevel 1 (
  echo.
  echo The imager exited with an error -- the messages above say why.
  pause
)
