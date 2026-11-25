package com.personal.chessanalyzer;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {

    private static final String APP_ORIGIN_HOST = "appassets.androidplatform.net";
    private static final String APP_ENTRY_URL =
            "https://appassets.androidplatform.net/assets/public/index.html";
    private static final String KEY_PENDING_EXPORT_PATH = "pca_pending_export_path";
    private static final int MAX_LAN_RESPONSE_CHARS = 32 * 1024 * 1024;

    private final ExecutorService httpExecutor = Executors.newFixedThreadPool(2);
    private WebView webView;
    @Nullable
    private ValueCallback<Uri[]> pendingFileCallback;
    @Nullable
    private String pendingExportTempPath;

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(
                    new ActivityResultContracts.StartActivityForResult(),
                    result -> {
                        if (pendingFileCallback == null) {
                            return;
                        }
                        Uri[] uris = WebChromeClient.FileChooserParams.parseResult(
                                result.getResultCode(),
                                result.getData()
                        );
                        pendingFileCallback.onReceiveValue(uris);
                        pendingFileCallback = null;
                    }
            );

    private final ActivityResultLauncher<Intent> createDocumentLauncher =
            registerForActivityResult(
                    new ActivityResultContracts.StartActivityForResult(),
                    result -> {
                        String exportPath = pendingExportTempPath;
                        pendingExportTempPath = null;
                        if (exportPath == null) {
                            return;
                        }
                        File tempFile = new File(exportPath);
                        if (result.getResultCode() != RESULT_OK || result.getData() == null) {
                            deleteTempFile(tempFile);
                            return;
                        }
                        Uri targetUri = result.getData().getData();
                        if (targetUri == null || !tempFile.exists()) {
                            deleteTempFile(tempFile);
                            return;
                        }
                        try (InputStream in = new FileInputStream(tempFile);
                             OutputStream out = getContentResolver().openOutputStream(targetUri)) {
                            if (out == null) {
                                throw new IOException("Unable to open output stream");
                            }
                            byte[] buffer = new byte[16384];
                            int read;
                            while ((read = in.read(buffer)) != -1) {
                                out.write(buffer, 0, read);
                            }
                            out.flush();
                            Toast.makeText(this, R.string.export_saved, Toast.LENGTH_SHORT).show();
                        } catch (IOException ex) {
                            Toast.makeText(this, R.string.export_failed, Toast.LENGTH_LONG).show();
                        } finally {
                            deleteTempFile(tempFile);
                        }
                    }
            );

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (savedInstanceState != null) {
            pendingExportTempPath = savedInstanceState.getString(KEY_PENDING_EXPORT_PATH);
        }

        boolean isDebuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(isDebuggable);

        webView = new WebView(this);
        setContentView(webView);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_ORIGIN_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new AndroidExportBridge(), "AndroidExport");

        webView.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {
                Uri url = request.getUrl();
                if (APP_ORIGIN_HOST.equalsIgnoreCase(url.getHost())) {
                    WebResourceResponse response = assetLoader.shouldInterceptRequest(url);
                    if (response != null && url.getPath() != null && url.getPath().endsWith(".wasm")) {
                        response.setMimeType("application/wasm");
                    }
                    return response;
                }
                if ("http".equalsIgnoreCase(url.getScheme())) {
                    return new WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            403,
                            "Cleartext HTTP blocked in WebView",
                            null,
                            new ByteArrayInputStream(new byte[0])
                    );
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view,
                    WebResourceRequest request
            ) {
                Uri url = request.getUrl();
                if (APP_ORIGIN_HOST.equalsIgnoreCase(url.getHost())) {
                    return false;
                }
                openExternalUrl(url);
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                }
                pendingFileCallback = filePathCallback;

                Intent intent = fileChooserParams != null
                        ? fileChooserParams.createIntent()
                        : new Intent(Intent.ACTION_GET_CONTENT)
                                .addCategory(Intent.CATEGORY_OPENABLE)
                                .setType("application/json");

                try {
                    fileChooserLauncher.launch(intent);
                    return true;
                } catch (ActivityNotFoundException ex) {
                    if (pendingFileCallback != null) {
                        pendingFileCallback.onReceiveValue(null);
                        pendingFileCallback = null;
                    }
                    Toast.makeText(MainActivity.this, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show();
                    return false;
                }
            }

            @Override
            public boolean onCreateWindow(
                    WebView view,
                    boolean isDialog,
                    boolean isUserGesture,
                    Message resultMsg
            ) {
                if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                    return false;
                }
                WebView targetView = new WebView(view.getContext());
                targetView.getSettings().setAllowFileAccess(false);
                targetView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(
                            WebView popupView,
                            WebResourceRequest request
                    ) {
                        Uri url = request.getUrl();
                        if (!APP_ORIGIN_HOST.equalsIgnoreCase(url.getHost())) {
                            openExternalUrl(url);
                        } else {
                            webView.loadUrl(url.toString());
                        }
                        popupView.destroy();
                        return true;
                    }
                });

                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(targetView);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null) {
                return;
            }
            String suggestedName = sanitizeFilename(URLUtil.guessFileName(
                    url,
                    contentDisposition,
                    mimetype != null ? mimetype : "application/json"
            ));

            if (url.startsWith("data:")) {
                handleDataUrlExport(url, suggestedName);
                return;
            }

            if (url.startsWith("blob:")) {
                webView.evaluateJavascript(
                        "(function(){"
                                + "fetch(" + JSONObject.quote(url) + ")"
                                + ".then(function(r){return r.text();})"
                                + ".then(function(t){if(window.AndroidExport){window.AndroidExport.saveFile(" + JSONObject.quote(suggestedName) + ",t);}});"
                                + "})();",
                        null
                );
                return;
            }

            openExternalUrl(Uri.parse(url));
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView == null) {
                    finish();
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){return typeof window.__pcaHandleBack==='function'?Boolean(window.__pcaHandleBack()):false;})()",
                        value -> {
                            if ("true".equals(value)) {
                                return;
                            }
                            if (webView != null && webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                finish();
                            }
                        }
                );
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_ENTRY_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (pendingExportTempPath != null) {
            outState.putString(KEY_PENDING_EXPORT_PATH, pendingExportTempPath);
        }
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        httpExecutor.shutdownNow();
        if (isFinishing() && pendingExportTempPath != null) {
            deleteTempFile(new File(pendingExportTempPath));
            pendingExportTempPath = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static void deleteTempFile(@Nullable File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static String sanitizeFilename(@Nullable String filename) {
        String base = filename == null ? "" : filename.trim().replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_");
        if (base.isEmpty() || ".".equals(base) || "..".equals(base)) {
            base = "personal-chess-analyzer-backup.json";
        }
        if (!base.toLowerCase(Locale.ROOT).endsWith(".json")) {
            base = base + ".json";
        }
        return base;
    }

    private static boolean isPrivateOrLoopbackHost(@Nullable String rawHost) {
        if (rawHost == null || rawHost.isEmpty()) {
            return false;
        }
        String host = rawHost.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1);
        }
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host) || host.endsWith(".local")) {
            return true;
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) {
                    return false;
                }
            }
        } catch (NumberFormatException ex) {
            return false;
        }
        return octets[0] == 10
                || octets[0] == 127
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
    }

    private void handleDataUrlExport(String dataUrl, String filename) {
        int commaIndex = dataUrl.indexOf(',');
        if (commaIndex < 0) {
            return;
        }
        String meta = dataUrl.substring(5, commaIndex);
        String payload = dataUrl.substring(commaIndex + 1);
        byte[] bytes;
        if (meta.contains(";base64")) {
            bytes = Base64.decode(payload, Base64.DEFAULT);
        } else {
            bytes = Uri.decode(payload).getBytes(StandardCharsets.UTF_8);
        }
        launchCreateDocument(filename, bytes);
    }

    private void launchCreateDocument(String filename, byte[] bytes) {
        if (pendingExportTempPath != null) {
            deleteTempFile(new File(pendingExportTempPath));
            pendingExportTempPath = null;
        }
        String safeName = sanitizeFilename(filename);
        File tempFile = new File(getCacheDir(), "pca-export-" + UUID.randomUUID() + ".json");
        try (OutputStream out = new FileOutputStream(tempFile)) {
            out.write(bytes);
            out.flush();
        } catch (IOException ex) {
            deleteTempFile(tempFile);
            Toast.makeText(this, R.string.export_failed, Toast.LENGTH_LONG).show();
            return;
        }
        pendingExportTempPath = tempFile.getAbsolutePath();
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json")
                .putExtra(Intent.EXTRA_TITLE, safeName);
        try {
            createDocumentLauncher.launch(intent);
        } catch (ActivityNotFoundException ex) {
            pendingExportTempPath = null;
            deleteTempFile(tempFile);
            Toast.makeText(this, R.string.export_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void openExternalUrl(@Nullable Uri uri) {
        if (uri == null) {
            return;
        }
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException ex) {
            Toast.makeText(this, R.string.browser_unavailable, Toast.LENGTH_SHORT).show();
        }
    }

    public final class AndroidExportBridge {
        @JavascriptInterface
        public void saveFile(String filename, String content) {
            final String safeName = sanitizeFilename(filename);
            final byte[] bytes = (content != null ? content : "")
                    .getBytes(StandardCharsets.UTF_8);
            runOnUiThread(() -> launchCreateDocument(safeName, bytes));
        }

        @JavascriptInterface
        public void httpRequestAsync(
                final String requestId,
                final String method,
                final String urlString,
                final String jsonBody
        ) {
            httpExecutor.execute(() -> {
                int status = 0;
                String responseBody = "";
                String errorMessage = "";
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(urlString);
                    String protocol = url.getProtocol();
                    if (!"http".equalsIgnoreCase(protocol) && !"https".equalsIgnoreCase(protocol)) {
                        throw new IOException("Unsupported protocol: " + protocol);
                    }
                    String reqMethod = method != null && !method.isEmpty()
                            ? method.toUpperCase(Locale.ROOT)
                            : "POST";
                    String path = url.getPath();
                    boolean isAllowedSyncEndpoint =
                            ("POST".equals(reqMethod) && "/api/lan-sync/sync".equals(path))
                                    || ("GET".equals(reqMethod) && "/api/lan-sync/ping".equals(path));
                    if (!isAllowedSyncEndpoint) {
                        throw new IOException("Blocked bridge request path/method");
                    }
                    if ("http".equalsIgnoreCase(protocol) && !isPrivateOrLoopbackHost(url.getHost())) {
                        throw new IOException("Cleartext HTTP only allowed for local/LAN sync");
                    }
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod(reqMethod);
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(45000);
                    conn.setRequestProperty("Accept", "application/json");
                    if (jsonBody != null && !"GET".equalsIgnoreCase(reqMethod)) {
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        byte[] input = jsonBody.getBytes(StandardCharsets.UTF_8);
                        conn.setFixedLengthStreamingMode(input.length);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(input);
                            os.flush();
                        }
                    }

                    status = conn.getResponseCode();
                    InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    if (stream != null) {
                        StringBuilder sb = new StringBuilder();
                        try (BufferedReader reader = new BufferedReader(
                                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                            char[] buf = new char[8192];
                            int totalChars = 0;
                            int read;
                            while ((read = reader.read(buf)) != -1) {
                                totalChars += read;
                                if (totalChars > MAX_LAN_RESPONSE_CHARS) {
                                    throw new IOException("LAN sync response exceeded 32 MB limit");
                                }
                                sb.append(buf, 0, read);
                            }
                        }
                        responseBody = sb.toString();
                    }
                } catch (Exception ex) {
                    errorMessage = ex.getMessage() != null ? ex.getMessage() : ex.toString();
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }

                final String jsCall = "window.__pcaNativeHttpDone && window.__pcaNativeHttpDone("
                        + JSONObject.quote(requestId != null ? requestId : "") + ","
                        + status + ","
                        + JSONObject.quote(responseBody) + ","
                        + JSONObject.quote(errorMessage) + ");";
                runOnUiThread(() -> {
                    if (webView != null) {
                        webView.evaluateJavascript(jsCall, null);
                    }
                });
            });
        }
    }
}
