@echo off
rem ============================================================
rem  MeetMind Backend launcher
rem  Double-click to run the backend in its own console window.
rem  Press Ctrl+C or close the window to stop the service.
rem ============================================================
title MeetMind Backend :3000

cd /d "%~dp0backend"

echo ============================================================
echo   MeetMind Backend
echo   API     : http://127.0.0.1:3000/api
echo   Health  : http://127.0.0.1:3000/api
echo   Stop    : Ctrl+C
echo ============================================================
echo.

node dist\main.js

echo.
echo [backend exited] code = %ERRORLEVEL%
echo Press any key to close this window...
pause >nul
