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

echo 3. Starting Secure Worldwide HTTPS Tunnel...
echo ========================================================
echo Your fixed URL is: https://sentinel-aravind.loca.lt
echo If prompted for a tunnel password, enter: 152.57.228.19
echo ========================================================

npx.cmd localtunnel --port 3000 --subdomain sentinel-aravind
pause
