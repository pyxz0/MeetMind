@echo off
rem ============================================================
rem  MeetMind Frontend launcher
rem  Double-click to run the frontend dev server in its own console.
rem  Press Ctrl+C or close the window to stop the service.
rem ============================================================
title MeetMind Frontend :5173

cd /d "%~dp0frontend"

echo ============================================================
echo   MeetMind Frontend
echo   URL  : http://127.0.0.1:5173/
echo   Stop : Ctrl+C
echo ============================================================
echo.

node node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5173

echo.
echo [frontend exited] code = %ERRORLEVEL%
echo Press any key to close this window...
pause >nul
