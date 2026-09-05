@echo off
setlocal

rem Read-only report on why a USB stick will not open. Writes nothing to any
rem disk, but the checks themselves need the same rights the writer does.
fltmc filters >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for Administrator rights...
  powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0' -ErrorAction Stop } catch { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo The Administrator prompt was refused, so the checks cannot run.
    echo.
    pause
  )
  exit /b
)

cd /d "%~dp0imager"
title RAMTECH Imager  --  drive diagnostics
call npm run --silent diagnose
echo.
pause
