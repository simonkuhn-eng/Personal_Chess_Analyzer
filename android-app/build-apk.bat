@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "ANDROID_DIR=%SCRIPT_DIR%android"

echo ====================================================================
echo Personal Chess Analyzer - Android Debug APK Builder
echo ====================================================================

rem 1. Auto-detect JDK 21 (required by AGP 8.5 / Gradle 8.7)
set "DETECTED_JDK="
if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" set "DETECTED_JDK=%JAVA_HOME%"
)

if not defined DETECTED_JDK (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-21*") do (
        if exist "%%~fD\bin\java.exe" set "DETECTED_JDK=%%~fD"
    )
)
if not defined DETECTED_JDK (
    for /d %%D in ("%ProgramFiles%\Eclipse Adoptium\jdk-21*" "%ProgramFiles%\Java\jdk-21*" "%ProgramFiles%\Microsoft\jdk-21*") do (
        if exist "%%~fD\bin\java.exe" set "DETECTED_JDK=%%~fD"
    )
)
if not defined DETECTED_JDK (
    if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
        set "DETECTED_JDK=%ProgramFiles%\Android\Android Studio\jbr"
    )
)

if defined DETECTED_JDK (
    set "JAVA_HOME=%DETECTED_JDK%"
    set "PATH=%JAVA_HOME%\bin;%PATH%"
    echo [OK] Using JAVA_HOME=%JAVA_HOME%
) else (
    echo [WARN] JDK 21 was not found automatically. Checking default java...
    java -version >nul 2>&1 || (
        echo [ERROR] No Java runtime found. Install Eclipse Adoptium JDK 21 and set JAVA_HOME.
        exit /b 1
    )
)

rem 2. Auto-detect Android SDK
set "DETECTED_SDK="
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platforms" set "DETECTED_SDK=%ANDROID_HOME%"
if not defined DETECTED_SDK if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platforms" set "DETECTED_SDK=%ANDROID_SDK_ROOT%"
if not defined DETECTED_SDK if exist "%LOCALAPPDATA%\Android\Sdk" set "DETECTED_SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined DETECTED_SDK if exist "C:\Android\Sdk" set "DETECTED_SDK=C:\Android\Sdk"
if not defined DETECTED_SDK if exist "C:\Android" if exist "C:\Android\platforms" set "DETECTED_SDK=C:\Android"

if not defined DETECTED_SDK (
    echo [ERROR] Android SDK not found.
    echo Checked: %%ANDROID_HOME%%, %%ANDROID_SDK_ROOT%%, "%LOCALAPPDATA%\Android\Sdk", "C:\Android\Sdk", "C:\Android".
    echo Please install Android Studio ^(or Android SDK Command-line Tools + platform android-34 + build-tools 34.0.0^)
    echo and set ANDROID_HOME before running build-apk.bat.
    exit /b 1
)

set "ANDROID_HOME=%DETECTED_SDK%"
set "ANDROID_SDK_ROOT=%DETECTED_SDK%"
echo [OK] Using ANDROID_HOME=%ANDROID_HOME%

rem Write local.properties if missing so Gradle always knows sdk.dir
if not exist "%ANDROID_DIR%\local.properties" (
    set "ESCAPED_SDK=%DETECTED_SDK:\=\\%"
    set "ESCAPED_SDK=!ESCAPED_SDK::=\:!"
    > "%ANDROID_DIR%\local.properties" echo sdk.dir=!ESCAPED_SDK!
    echo [OK] Created %ANDROID_DIR%\local.properties
)

rem 3. Ensure web build exists and sync assets into Android assets/public
if not exist "%REPO_ROOT%\dist\index.html" (
    echo [INFO] dist\index.html not found. Building Vite bundle in repository root...
    pushd "%REPO_ROOT%"
    call npm run build
    if errorlevel 1 (
        popd
        echo [ERROR] Vite build failed.
        exit /b 1
    )
    popd
)

node "%SCRIPT_DIR%sync-web-assets.mjs"
if errorlevel 1 (
    echo [ERROR] Failed to sync web assets into Android assets directory.
    exit /b 1
)

rem 4. Run Gradle wrapper (or system gradle if wrapper JAR is not yet bootstrapped)
set "WRAPPER_JAR=%ANDROID_DIR%\gradle\wrapper\gradle-wrapper.jar"
pushd "%ANDROID_DIR%"
if exist "%WRAPPER_JAR%" (
    call "%ANDROID_DIR%\gradlew.bat" assembleDebug
) else (
    where gradle >nul 2>&1
    if errorlevel 1 (
        popd
        echo [ERROR] "%WRAPPER_JAR%" is missing and system "gradle" is not on PATH.
        echo Either open "%ANDROID_DIR%" once in Android Studio or install Gradle 8.7 and run:
        echo     cd /d "%ANDROID_DIR%" ^&^& gradle wrapper --gradle-version 8.7
        exit /b 1
    )
    call gradle assembleDebug
)
set "GRADLE_EXIT=%ERRORLEVEL%"
popd

if not "%GRADLE_EXIT%"=="0" (
    echo [ERROR] Gradle assembleDebug failed with exit code %GRADLE_EXIT%.
    exit /b %GRADLE_EXIT%
)

set "APK_PATH=%ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk"
echo ====================================================================
if exist "%APK_PATH%" (
    echo [SUCCESS] Debug APK created:
    echo   %APK_PATH%
) else (
    echo [WARN] Build finished, check outputs under %ANDROID_DIR%\app\build\outputs\apk\debug\
)
echo ====================================================================
exit /b 0
