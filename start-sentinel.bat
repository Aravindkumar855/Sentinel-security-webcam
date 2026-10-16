@echo off
title Sentinel Security Webcam
echo ========================================================
echo   Starting Sentinel Security Webcam Server...
echo ========================================================
cd /d "%~dp0"

echo Opening browser at http://localhost:3000 in 2 seconds...
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

npm.cmd start
if %ERRORLEVEL% NEQ 0 (
    node server/server.js
)
pause
