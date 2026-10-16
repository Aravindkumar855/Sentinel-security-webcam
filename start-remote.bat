@echo off
title Sentinel Security Webcam - Worldwide Remote Access
echo ========================================================
echo   Starting Sentinel with Worldwide Remote Tunnel...
echo ========================================================
cd /d "%~dp0"

echo 1. Launching Sentinel Server in background...
start "" node server/server.js

echo 2. Waiting for server to initialize...
timeout /t 3 /nobreak >nul

echo 3. Starting Secure Worldwide Cloudflare HTTPS Tunnel...
echo ========================================================
echo Open the generated https://*.trycloudflare.com link on your phone!
echo ========================================================
if exist "%~dp0cloudflared.exe" (
    "%~dp0cloudflared.exe" tunnel --url http://localhost:3000
) else (
    npx.cmd localtunnel --port 3000
)
pause
