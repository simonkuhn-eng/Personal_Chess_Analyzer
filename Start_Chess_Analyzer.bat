@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Personal Chess Analyzer
cd /d "%~dp0"

set "APP_DIR=%~dp0release\PersonalChessAnalyzer-win32-x64"
set "APP_EXE=%APP_DIR%\PersonalChessAnalyzer.exe"
set "APP_HTML=%APP_DIR%\resources\app\dist\index.html"
set "APP_MAIN=%APP_DIR%\resources\app\dist-electron\electron\main.js"

if exist "%APP_EXE%" if exist "%APP_HTML%" if exist "%APP_MAIN%" goto :launch

echo ========================================================
echo   Personal Chess Analyzer - Erstmaliger Standalone-Build
echo ========================================================
echo.
echo Standalone-App wird vorbereitet ^(einmalig, danach direkter Start^)...
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [FEHLER] Node.js wurde nicht gefunden.
    echo Bitte Node.js LTS installieren: https://nodejs.org/
    goto :failed
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [FEHLER] npm wurde nicht gefunden. Bitte Node.js inkl. npm installieren.
    goto :failed
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [1/2] Installiere Abhaengigkeiten...
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :failed
)

echo [2/2] Erstelle Windows Standalone-Paket...
call npm run package:win
if errorlevel 1 goto :failed

if not exist "%APP_EXE%" (
    echo [FEHLER] Standalone-Programm wurde nicht unter "%APP_EXE%" erstellt.
    goto :failed
)

:launch
set "NODE_ENV=production"
set "ELECTRON_RUN_AS_NODE="
start "" /D "%APP_DIR%" "%APP_EXE%"
exit /b 0

:failed
echo.
echo Start oder Build fehlgeschlagen. Die Anwendung wurde nicht gestartet.
pause
exit /b 1
