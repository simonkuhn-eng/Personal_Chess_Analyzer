# Personal Chess Analyzer — Android App

Standalone Android wrapper for **Personal Chess Analyzer** using Android `WebViewAssetLoader` (HTTPS same-origin app assets) + Capacitor-compatible metadata (`capacitor.config.json`) + the automatic `window.electronAPI` mobile bridge (`src/mobile/mobileBridge.ts` & `src/mobile/mobileEngine.ts`).

## Architecture Overview

1. **Web/Mobile Bridge (`src/mobile/mobileBridge.ts`)**
   - Activated automatically in `src/main.tsx` via `ensureMobileElectronAPI()` **only** when `window.electronAPI` is undefined (Android WebView or browser — Electron desktop stays completely untouched).
   - Stores games, app settings, and import sync cursors persistently in IndexedDB (`pca_mobile_db_v1`) with `localStorage` fallback.
   - Connects directly to Chess.com PubAPI (`api.chess.com`) and Lichess (`lichess.org`) using `fetch()` without requiring a backend proxy.
   - Exports/imports backups (`DataBundle` v1 JSON) using `window.AndroidExport.saveFile` (Android Storage Access Framework) and `<input type="file">`.

2. **Offline Chess Engine (`src/mobile/mobileEngine.ts`)**
   - Probes optional `./stockfish.js` WebWorker if bundled into `public/` / `dist/`.
   - Falls back cleanly offline to a built-in TypeScript Negamax Alpha-Beta (depth 3 + quiescence search + transposition table + MVV-LVA/PST ordering) evaluator powered by `chess.js`, so PGN evaluation, training deck judging, and move comparisons work without external binaries.

3. **Native Android Host (`android-app/android/`)**
   - Target SDK 34 (`compileSdk 34`, `minSdk 24`, `targetSdk 34`), AndroidX (`appcompat`, `webkit`, `activity`), zero proprietary SDK bloat.
   - `MainActivity.java` mounts `android/app/src/main/assets/public/` on `https://appassets.androidplatform.net/assets/public/index.html` via `WebViewAssetLoader`, avoiding `file://` ES-module CORS failures while keeping IndexedDB/localStorage persistent across launches.
   - Includes file picker support (`WebChromeClient.onShowFileChooser`), Storage Access Framework JSON backup export (`AndroidExport` + `DownloadListener` for `blob:`/`data:` URLs), external link delegation to Android's browser, rotation preservation (`configChanges`), and hardware back-button history navigation.

## Prerequisites on Windows

1. **Node.js** (v18+ — verified `v24.12.0` on this host)
2. **JDK 21** (required for AGP 8.5 / Gradle 8.7 — e.g. Eclipse Adoptium JDK 21)
3. **Android SDK (API 34)**:
   - Install Android Studio (includes Android SDK, Build Tools 34.0.0, Platform `android-34`, and bundled Gradle) **or** Android Command-line Tools (`sdkmanager "platforms;android-34" "build-tools;34.0.0"`).
   - Set `ANDROID_HOME` (default `%LOCALAPPDATA%\Android\Sdk`).
4. **Gradle 8.7** (included automatically when opening `android-app/android/` in Android Studio, or install Gradle 8.7 and run `gradle wrapper --gradle-version 8.7` inside `android-app/android/` to generate `gradle-wrapper.jar`).

## Sync Web Assets & Build APK

From the repository root:

```bash
npm run build
node android-app/sync-web-assets.mjs
```

Then build the debug APK:

- **Option A (CLI / `build-apk.bat`)**:
  Run `android-app\build-apk.bat`. It auto-detects JDK 21 and Android SDK, builds `dist/` if needed, runs `sync-web-assets.mjs`, and outputs:
  `android-app\android\app\build\outputs\apk\debug\app-debug.apk`
- **Option B (Android Studio)**:
  Open `android-app/android/` in Android Studio, let Gradle sync finish, and run **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

> **Optional Stockfish WASM/JS note**: Place a browser-compatible single-threaded `stockfish.js` worker in `public/stockfish.js` before `npm run build` if you later want full Stockfish WASM depth inside Android WebView; otherwise the built-in offline engine runs automatically.
