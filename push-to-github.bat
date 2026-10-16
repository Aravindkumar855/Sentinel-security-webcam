@echo off
title Push Sentinel to GitHub (Aravindkumar855)
echo ========================================================
echo   Pushing to GitHub: Aravindkumar855/sentinel-security-webcam
echo ========================================================
cd /d "%~dp0"

git push -u origin main

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ----------------------------------------------------
    echo If it failed: Make sure you created the empty repo at:
    echo https://github.com/new with name: sentinel-security-webcam
    echo ----------------------------------------------------
) else (
    echo.
    echo ====================================================
    echo SUCCESS! Your repository is now live at:
    echo https://github.com/Aravindkumar855/sentinel-security-webcam
    echo ====================================================
)
pause
