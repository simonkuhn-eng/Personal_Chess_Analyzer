@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Personal Chess Analyzer - Update ^& Build
cd /d "%~dp0"

set "APP_DIR=%~dp0release\PersonalChessAnalyzer-win32-x64"
set "APP_EXE=%APP_DIR%\PersonalChessAnalyzer.exe"

echo ========================================================
echo   Personal Chess Analyzer - Update ^& Neu-Erstellung
echo ========================================================
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

for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('call npm -v') do set "NPM_VER=%%v"
echo Umgebung: Node %NODE_VER% / npm %NPM_VER%
echo.

REM Laufende Instanz prüfen und optional sanft beenden (verhindert EBUSY beim Kopieren)
tasklist /FI "IMAGENAME eq PersonalChessAnalyzer.exe" 2>nul | find /I "PersonalChessAnalyzer.exe" >nul
if not errorlevel 1 (
    echo [HINWEIS] PersonalChessAnalyzer.exe laeuft aktuell noch und blockiert sonst das Update.
    choice /C JN /N /M "Laufende App jetzt schliessen? [J/N]: "
    if errorlevel 2 (
        echo [ABBRUCH] Bitte PersonalChessAnalyzer.exe manuell beenden und update.bat erneut starten.
        goto :failed
    )
    echo Beende PersonalChessAnalyzer.exe ...
    taskkill /IM PersonalChessAnalyzer.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    tasklist /FI "IMAGENAME eq PersonalChessAnalyzer.exe" 2>nul | find /I "PersonalChessAnalyzer.exe" >nul
    if not errorlevel 1 (
        taskkill /F /IM PersonalChessAnalyzer.exe >nul 2>&1
        timeout /t 2 /nobreak >nul
    )
    tasklist /FI "IMAGENAME eq PersonalChessAnalyzer.exe" 2>nul | find /I "PersonalChessAnalyzer.exe" >nul
    if not errorlevel 1 (
        echo [FEHLER] PersonalChessAnalyzer.exe konnte nicht geschlossen werden. Bitte manuell beenden.
        goto :failed
    )
    echo.
)

REM 1. Optionaler nicht-destruktiver Git-Pull (niemals git reset/checkout!)
if exist ".git" (
    where git >nul 2>&1
    if not errorlevel 1 (
        git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
        if not errorlevel 1 (
            echo [1/3] Pruefe Git-Updates ^(git pull --ff-only^)...
            git pull --ff-only
            if errorlevel 1 (
                echo [HINWEIS] Git-Pull wurde uebersprungen ^(z. B. offline oder lokale Aenderungen^). Fahre mit lokalem Stand fort.
            )
            echo.
        ) else (
            echo [1/3] Kein Git-Upstream konfiguriert - Git-Pull uebersprungen.
            echo.
        )
    ) else (
        echo [1/3] Git nicht installiert - Git-Pull uebersprungen.
        echo.
    )
) else (
    echo [1/3] Kein Git-Repository - Git-Pull uebersprungen.
    echo.
)

REM 2. Abhängigkeiten nur aktualisieren, wenn nötig
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="0" if exist "package-lock.json" if exist "node_modules\.package-lock.json" (
    node -e "const fs=require('fs');process.exit(fs.statSync('package-lock.json').mtimeMs>fs.statSync('node_modules/.package-lock.json').mtimeMs?1:0);"
    if errorlevel 1 set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
    echo [2/3] Installiere bzw. aktualisiere npm-Abhaengigkeiten...
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :failed
    echo.
) else (
    echo [2/3] npm-Abhaengigkeiten sind aktuell - uebersprungen.
    echo.
)

REM 3. Standalone-App neu bauen & verifizieren
echo [3/3] Baue Windows Standalone-App ^(npm run package:win^)...
call npm run package:win
if errorlevel 1 goto :failed

if not exist "%APP_EXE%" (
    echo [FEHLER] Erwartete Datei nicht gefunden: "%APP_EXE%"
    goto :failed
)

echo.
echo ========================================================
echo   Update erfolgreich abgeschlossen!
echo   App: %APP_EXE%
echo ========================================================
echo.

set "LAUNCH_CHOICE="
set /p "LAUNCH_CHOICE=Personal Chess Analyzer jetzt starten? [J/n]: "
if "%LAUNCH_CHOICE%"=="" set "LAUNCH_CHOICE=J"
if /I "%LAUNCH_CHOICE%"=="J" goto :launch_app
if /I "%LAUNCH_CHOICE%"=="JA" goto :launch_app

echo Fertig. Starten Sie die App jederzeit per Doppelklick auf Start_Chess_Analyzer.bat.
exit /b 0

:launch_app
echo Starte Personal Chess Analyzer...
set "NODE_ENV=production"
set "ELECTRON_RUN_AS_NODE="
start "" /D "%APP_DIR%" "%APP_EXE%"
exit /b 0

:failed
echo.
echo ========================================================
echo   FEHLER: Update oder Build ist fehlgeschlagen!
echo ========================================================
pause
exit /b 1
