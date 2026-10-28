package chat.amore.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebStorage;
import android.widget.Toast;

import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.SSLException;

/**
 * The app: a full-screen WebView showing the AmoreChat server's own web app, plus the
 * native pieces a browser can't do (background notifications, ringing calls, sharing into
 * the app, downloads, trusting an offline server's certificate).
 */
public class MainActivity extends Activity {
    static volatile boolean visible;

    private static final int REQ_FILE = 1;
    private static final int REQ_MEDIA = 2;
    private static final int REQ_NOTIF = 3;
    private static final int REQ_STORAGE = 4;
    private static final String SHARE_HOST = "amore-share.invalid";
    private static final String SETUP_URL = "file:///android_asset/setup.html";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";

    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPerm;
    private boolean pageReady;
    private final List<String> pendingJs = new ArrayList<>();
    private final Map<String, Uri> shared = new ConcurrentHashMap<>();
    private volatile X509Certificate setupCa;
    private String[] pendingDownload;
    private android.widget.FrameLayout root;
    private android.view.View lockCover;
    private boolean locked;
    private long pausedAt;
    private static java.lang.ref.WeakReference<MainActivity> current = new java.lang.ref.WeakReference<>(null);
    private static final long LOCK_AFTER_MS = 60_000;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Notifs.channels(this);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // Tests (debug builds only) can point the app at a server directly.
        String testServer = getIntent().getStringExtra("server");
        if (BuildConfig.DEBUG && testServer != null) Prefs.setServer(this, testServer, null);

        current = new java.lang.ref.WeakReference<>(this);
        web = new WebView(this);
        root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(0xFF0B0E1A);
        root.addView(web);
        setContentView(root);
        // Same on every Android version (15+ forces it): draw edge to edge, pad for the bars ourselves.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Keep the page out from under the status / navigation bars and the keyboard.
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            androidx.core.graphics.Insets b = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                    | androidx.core.view.WindowInsetsCompat.Type.ime() | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return androidx.core.view.WindowInsetsCompat.CONSUMED;
        });
        if (Prefs.appLock(this)) lock();
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUserAgentString(s.getUserAgentString() + " AmoreChat-Android/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "AmoreAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        // Links that download (backups, files, the app update) go to our downloader:
        // a WebView ignores them otherwise.
        web.setDownloadListener((url, userAgent, contentDisposition, mime, length) -> {
            Uri u = Uri.parse(url);
            if (!isServer(u)) return;
            if (url.endsWith(".apk") || "application/vnd.android.package-archive".equals(mime)) {
                Updater.install(this, url);
                return;
            }
            String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mime);
            Downloader.start(this, url, name, mime);
            Toast.makeText(this, "دانلود شروع شد", Toast.LENGTH_SHORT).show();
        });

        String server = Prefs.server(this);
        if (server == null) {
            web.loadUrl(SETUP_URL);
        } else {
            web.loadUrl(server + "/");
            startup();
        }
        handleIntent(getIntent());
    }

    /** Once a server is chosen: notification permission and the background connection. */
    private void startup() {
        if (Build.VERSION.SDK_INT >= 33 && !Prefs.askedPermissions(this)
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Prefs.setAskedPermissions(this);
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
        NotifyService.start(this);
    }

    private boolean isServer(Uri u) {
        return u != null && Prefs.isKnownHost(this, u.getHost());
    }

    /** Show another added server (its own account and cookies). */
    private void showServer(String url) {
        Prefs.switchTo(this, url);
        Notifs.cancelAllMessages(this, url);
        Notifs.clearUnread(url);
        Trust.verifiedLeaves.clear();
        pageReady = false;
        web.clearHistory();
        web.loadUrl(url + "/");
    }

    /** A notification arrived for some server: let the page refresh the server switcher badges. */
    static void notifyUnreadChanged() {
        MainActivity a = current.get();
        if (a == null) return;
        try {
            a.toWeb(new JSONObject().put("type", "servers"));
        } catch (Exception ignored) {
        }
    }

    // ---------- App lock (fingerprint / face / screen lock) ----------

    private void lock() {
        if (locked) return;
        locked = true;
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        if (lockCover == null) {
            android.widget.LinearLayout cover = new android.widget.LinearLayout(this);
            cover.setOrientation(android.widget.LinearLayout.VERTICAL);
            cover.setGravity(android.view.Gravity.CENTER);
            cover.setBackgroundColor(0xFF0B0E1A);
            android.widget.TextView icon = new android.widget.TextView(this);
            icon.setText("🔒");
            icon.setTextSize(48);
            icon.setGravity(android.view.Gravity.CENTER);
            android.widget.Button open = new android.widget.Button(this);
            open.setText("باز کردن AmoreChat");
            open.setOnClickListener(v -> authenticate(this::unlock));
            cover.addView(icon);
            cover.addView(open);
            lockCover = cover;
        }
        if (lockCover.getParent() == null) root.addView(lockCover, new android.widget.FrameLayout.LayoutParams(-1, -1));
    }

    private void unlock() {
        locked = false;
        if (lockCover != null) root.removeView(lockCover);
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
    }

    /** Fingerprint / face, or the phone's PIN / pattern; calls ok on success. */
    private void authenticate(Runnable ok) {
        android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) {
            Toast.makeText(this, "برای قفل برنامه، اول برای گوشی قفل صفحه (رمز، الگو یا اثر انگشت) بگذارید", Toast.LENGTH_LONG).show();
            ok.run();
            return;
        }
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                android.hardware.biometrics.BiometricPrompt.Builder b = new android.hardware.biometrics.BiometricPrompt.Builder(this)
                        .setTitle("AmoreChat")
                        .setSubtitle("برای باز کردن برنامه هویت خود را تأیید کنید");
                if (Build.VERSION.SDK_INT >= 30) {
                    b.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
                            | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                } else {
                    b.setDeviceCredentialAllowed(true);
                }
                b.build().authenticate(new android.os.CancellationSignal(), getMainExecutor(),
                        new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult r) {
                                ok.run();
                            }
                        });
                return;
            } catch (Exception e) {
                // Some phones refuse the fingerprint prompt: fall back to the phone's PIN / pattern screen.
            }
        }
        pendingUnlock = ok;
        try {
            Intent i = km.createConfirmDeviceCredentialIntent("AmoreChat", "برای باز کردن برنامه هویت خود را تأیید کنید");
            if (i != null) startActivityForResult(i, REQ_UNLOCK);
            else ok.run();
        } catch (Exception e) {
            pendingUnlock = null;
            Toast.makeText(this, "تأیید هویت روی این گوشی ممکن نشد", Toast.LENGTH_LONG).show();
        }
    }

    private Runnable pendingUnlock;
    private static final int REQ_UNLOCK = 9;

    // ---------- Native -> web events ----------

    void toWeb(JSONObject event) {
        String js = "(window.__amoreQ=window.__amoreQ||[]).push(" + event + ");window.dispatchEvent(new Event('amore-native'));";
        runOnUiThread(() -> {
            if (pageReady) web.evaluateJavascript(js, null);
            else pendingJs.add(js);
        });
    }

    /** The WebView keeps running in the background (calls!), so tell the page when it's really hidden. */
    private void setHidden(boolean hidden) {
        if (!pageReady) return;
        web.evaluateJavascript(
                "(function(h){try{Object.defineProperty(document,'hidden',{configurable:true,get:function(){return h}});"
                        + "Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return h?'hidden':'visible'}});"
                        + "document.dispatchEvent(new Event('visibilitychange'))}catch(e){}})(" + hidden + ")",
                null);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        try {
            String action = intent.getAction();
            if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                handleShare(intent);
                setIntent(new Intent(this, MainActivity.class));
                return;
            }
            // Other apps can start this activity too: only trust extras from our own notifications.
            if (!Prefs.intentKey(this).equals(intent.getStringExtra("k"))) return;
            String srv = intent.getStringExtra("srv");
            if (srv != null && Prefs.find(this, srv) != null && !srv.equals(Prefs.server(this))) showServer(srv);
            String chatId = intent.getStringExtra("chatId");
            if (chatId != null) toWeb(new JSONObject().put("type", "open-chat").put("chatId", Long.parseLong(chatId)));
            String answer = intent.getStringExtra("answerCall");
            if (answer != null) {
                Notifs.cancelCall(this);
                toWeb(new JSONObject().put("type", "answer").put("callId", answer));
            }
            if (intent.getStringExtra("ringingCall") != null) Notifs.cancelCall(this);
        } catch (Exception ignored) {
        }
    }

    private void handleShare(Intent intent) throws Exception {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        JSONArray files = new JSONArray();
        for (Uri u : uris) {
            String id = Long.toHexString(System.nanoTime()) + files.length();
            shared.put(id, u);
            String name = "file";
            long size = -1;
            try (Cursor c = getContentResolver().query(u, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int z = c.getColumnIndex(OpenableColumns.SIZE);
                    if (n >= 0) name = c.getString(n);
                    if (z >= 0) size = c.getLong(z);
                }
            } catch (Exception ignored) {
            }
            String type = getContentResolver().getType(u);
            files.put(new JSONObject().put("url", "https://" + SHARE_HOST + "/" + id).put("name", name).put("type", type == null ? "" : type).put("size", size));
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (files.length() == 0 && text == null) return;
        toWeb(new JSONObject().put("type", "share").put("files", files).put("text", text == null ? "" : text));
    }

    // ---------- Lifecycle ----------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        String srv = Prefs.server(this);
        if (srv != null) {
            Notifs.cancelAllMessages(this, srv);
            Notifs.clearUnread(srv);
        }
        setHidden(false);
        if (Prefs.appLock(this) && pausedAt > 0 && System.currentTimeMillis() - pausedAt > LOCK_AFTER_MS) lock();
        if (locked) authenticate(this::unlock);
    }

    @Override
    protected void onPause() {
        visible = false;
        pausedAt = System.currentTimeMillis();
        setHidden(true);
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AmoreAndroid");
            web.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // The page closes its open dialog / menu first (step-by-step Back); otherwise history.
        web.evaluateJavascript("window.__amoreBack ? window.__amoreBack() : false", (handled) -> {
            if ("true".equals(handled)) return;
            String at = web.getUrl();
            String cur = Prefs.server(MainActivity.this);
            if (at != null && at.startsWith(SETUP_URL + "?add") && cur != null) showServer(cur);
            else if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_UNLOCK && pendingUnlock != null) {
            Runnable r = pendingUnlock;
            pendingUnlock = null;
            if (resultCode == RESULT_OK) r.run();
        }
        if (requestCode == REQ_FILE && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCb = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_MEDIA && pendingPerm != null) {
            List<String> grant = new ArrayList<>();
            for (String r : pendingPerm.getResources()) {
                String p = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) ? Manifest.permission.RECORD_AUDIO
                        : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) ? Manifest.permission.CAMERA : null;
                if (p != null && checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) grant.add(r);
            }
            if (grant.isEmpty()) pendingPerm.deny();
            else pendingPerm.grant(grant.toArray(new String[0]));
            pendingPerm = null;
        }
        if (requestCode == REQ_STORAGE && pendingDownload != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) Downloader.start(this, pendingDownload[0], pendingDownload[1], pendingDownload[2]);
            pendingDownload = null;
        }
    }

    // ---------- WebView clients ----------

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String scheme = u.getScheme();
            if ("file".equals(scheme) || "blob".equals(scheme) || "data".equals(scheme) || isServer(u)) return false;
            // Links to other sites open in the browser, never inside the app.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            pageReady = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            if (url != null && (url.startsWith(SETUP_URL) || url.startsWith(OFFLINE_URL))) view.clearHistory();
            for (String js : pendingJs) view.evaluateJavascript(js, null);
            pendingJs.clear();
            if (!visible) setHidden(true);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
            if (req.isForMainFrame() && isServer(req.getUrl())) view.loadUrl(OFFLINE_URL);
        }

        /** Offline servers with their own CA: accept only certificates that chain to the stored CA. */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Uri u = Uri.parse(error.getUrl());
            X509Certificate ca = Trust.caFor(MainActivity.this, u.getHost());
            X509Certificate leaf = Trust.leafOf(error.getCertificate());
            if (!isServer(u) || ca == null || leaf == null) {
                handler.cancel();
                return;
            }
            String fp = Trust.sha256(leaf);
            if (Trust.verifiedLeaves.contains(fp)) {
                handler.proceed();
                return;
            }
            new Thread(() -> {
                boolean ok = false;
                try {
                    X509Certificate[] chain = Trust.fetchChain(u.getHost(), u.getPort() > 0 ? u.getPort() : 443);
                    ok = chain != null && chain.length > 0 && Trust.sha256(chain[0]).equals(fp) && Trust.chainTrusted(chain, ca);
                } catch (Exception ignored) {
                }
                final boolean trusted = ok;
                if (trusted) Trust.verifiedLeaves.add(fp);
                runOnUiThread(() -> {
                    if (trusted) handler.proceed();
                    else handler.cancel();
                });
            }).start();
        }

        /** Files shared into the app are served to the page from a private fake host. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!SHARE_HOST.equals(u.getHost())) return null;
            Uri file = shared.get(u.getLastPathSegment());
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            if (file == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
            try {
                InputStream in = getContentResolver().openInputStream(file);
                String type = getContentResolver().getType(file);
                return new WebResourceResponse(type == null ? "application/octet-stream" : type, null, 200, "OK", headers, in);
            } catch (Exception e) {
                return new WebResourceResponse("text/plain", "utf-8", 500, "Error", headers, null);
            }
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest req) {
            runOnUiThread(() -> {
                if (!isServer(req.getOrigin())) {
                    req.deny();
                    return;
                }
                List<String> missing = new ArrayList<>();
                for (String r : req.getResources()) {
                    String p = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) ? Manifest.permission.RECORD_AUDIO
                            : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) ? Manifest.permission.CAMERA : null;
                    if (p != null && checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
                }
                if (missing.isEmpty()) {
                    req.grant(req.getResources());
                } else {
                    if (pendingPerm != null) pendingPerm.deny();
                    pendingPerm = req;
                    requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            Intent i = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(i, null), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCb = null;
                return false;
            }
        }
    }

    // ---------- JS bridge: window.AmoreAndroid ----------

    private class Bridge {
        /** Debug builds only (tests): can the app itself reach this URL? */
        @JavascriptInterface
        public String probe(String url) {
            if (!BuildConfig.DEBUG) return "disabled";
            // DNS lookups have no timeout of their own: bound the whole attempt.
            java.util.concurrent.FutureTask<String> task = new java.util.concurrent.FutureTask<>(() -> {
                HttpURLConnection c = (HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                int code = c.getResponseCode();
                c.disconnect();
                return "HTTP " + code;
            });
            new Thread(task).start();
            try {
                return task.get(7, java.util.concurrent.TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException e) {
                task.cancel(true);
                return "ERR timeout (no network)";
            } catch (Exception e) {
                Throwable t = e.getCause() != null ? e.getCause() : e;
                return "ERR " + t.getClass().getSimpleName() + ": " + t.getMessage();
            }
        }

        @JavascriptInterface
        public String info() {
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                return new JSONObject()
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("versionCode", BuildConfig.VERSION_CODE)
                        .put("background", Prefs.background(MainActivity.this))
                        .put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(getPackageName()))
                        .put("notifications", NotificationManagerCompat.from(MainActivity.this).areNotificationsEnabled())
                        .put("server", Prefs.server(MainActivity.this))
                        .put("status", NotifyService.lastStatus)
                        .put("connected", NotifyService.connected)
                        .put("fullScreen", Build.VERSION.SDK_INT < 34 || ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).canUseFullScreenIntent())
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void setBackground(boolean on) {
            Prefs.setBackground(MainActivity.this, on);
            runOnUiThread(() -> {
                if (on) NotifyService.start(MainActivity.this);
                else NotifyService.stop(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void batterySettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            });
        }

        @JavascriptInterface
        public void notificationSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
        }

        /** Download the newer APK from the server and open Android's installer. */
        @JavascriptInterface
        public void installUpdate() {
            String server = Prefs.server(MainActivity.this);
            if (server != null) runOnUiThread(() -> Updater.install(MainActivity.this, server + "/app/amorechat.apk"));
        }

        @JavascriptInterface
        public void fullScreenSettings() {
            if (Build.VERSION.SDK_INT < 34) return;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) {
                }
            });
        }

        /** Added servers: [{url, name, current, unread}] */
        @JavascriptInterface
        public String servers() {
            JSONArray a = new JSONArray();
            String cur = Prefs.server(MainActivity.this);
            try {
                for (Prefs.Server s : Prefs.servers(MainActivity.this)) {
                    a.put(new JSONObject().put("url", s.url).put("name", s.name).put("current", s.url.equals(cur))
                            .put("unread", Notifs.unreadFor(s.url)).put("status", NotifyService.statuses.get(s.url))
                            .put("connected", Boolean.TRUE.equals(NotifyService.connections.get(s.url))));
                }
            } catch (Exception ignored) {
            }
            return a.toString();
        }

        @JavascriptInterface
        public void switchServer(String url) {
            if (Prefs.find(MainActivity.this, url) == null) return;
            // A moment later: a menu closing on the page may still step back in its history, which
            // would otherwise undo this navigation (older pages, served from cache, do that).
            runOnUiThread(() -> web.postDelayed(() -> showServer(url), 350));
        }

        /** Add another server (the setup page); the current one stays signed in. */
        @JavascriptInterface
        public void addServer() {
            runOnUiThread(() -> web.postDelayed(() -> {
                pageReady = false;
                web.loadUrl(SETUP_URL + "?add=1");
            }, 350));
        }

        @JavascriptInterface
        public void cancelAdd() {
            String cur = Prefs.server(MainActivity.this);
            if (cur != null) runOnUiThread(() -> showServer(cur));
        }

        @JavascriptInterface
        public void removeServer(String url) {
            runOnUiThread(() -> {
                forgetServer(url);
                Prefs.removeServer(MainActivity.this, url);
                Notifs.cancelAllMessages(MainActivity.this, url);
                NotifyService.kick(MainActivity.this);
                String next = Prefs.server(MainActivity.this);
                if (next == null) {
                    NotifyService.stop(MainActivity.this);
                    web.clearHistory();
                    web.loadUrl(SETUP_URL);
                } else {
                    showServer(next);
                }
            });
        }

        /** Status / navigation bar color follows the page's theme. */
        @JavascriptInterface
        public void setBars(String color, boolean dark) {
            runOnUiThread(() -> {
                try {
                    int c = android.graphics.Color.parseColor(color.trim());
                    root.setBackgroundColor(c);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                    androidx.core.view.WindowInsetsControllerCompat w = androidx.core.view.WindowCompat.getInsetsController(getWindow(), root);
                    w.setAppearanceLightStatusBars(!dark);
                    w.setAppearanceLightNavigationBars(!dark);
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public boolean appLock() {
            return Prefs.appLock(MainActivity.this);
        }

        /** Turning the lock on (or off) asks for the fingerprint / screen lock first. */
        @JavascriptInterface
        public void setAppLock(boolean on) {
            runOnUiThread(() -> authenticate(() -> {
                Prefs.setAppLock(MainActivity.this, on);
                try {
                    toWeb(new JSONObject().put("type", "lock").put("on", on));
                } catch (Exception ignored) {
                }
            }));
        }

        /** Old name: leaves the current server and adds another one. */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> {
                String cur = Prefs.server(MainActivity.this);
                if (cur != null) Prefs.removeServer(MainActivity.this, cur);
                NotifyService.kick(MainActivity.this);
                Trust.verifiedLeaves.clear();
                web.clearHistory();
                web.loadUrl(SETUP_URL);
            });
        }

        @JavascriptInterface
        public void signedIn() {
            NotifyService.kick(MainActivity.this);
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> {
                String server = Prefs.server(MainActivity.this);
                web.loadUrl(server == null ? SETUP_URL : server + "/");
            });
        }

        @JavascriptInterface
        public void inCall(boolean on, String title) {
            runOnUiThread(() -> {
                if (on) CallService.start(MainActivity.this, title);
                else CallService.stop(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void download(String url, String name, String mime) {
            String server = Prefs.server(MainActivity.this);
            if (server == null) return;
            String abs = url.startsWith("http") ? url : server + (url.startsWith("/") ? "" : "/") + url;
            if (!isServer(Uri.parse(abs))) return;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    pendingDownload = new String[] {abs, name, mime};
                    requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                    return;
                }
                Downloader.start(MainActivity.this, abs, name, mime);
                Toast.makeText(MainActivity.this, "دانلود شروع شد", Toast.LENGTH_SHORT).show();
            });
        }

        // ----- First-run setup page -----

        @JavascriptInterface
        public void checkServer(String input) {
            new Thread(() -> setupReply(check(input))).start();
        }

        @JavascriptInterface
        public void useServer(String url, boolean withCa) {
            runOnUiThread(() -> {
                String pem = null;
                try {
                    if (withCa && setupCa != null) pem = Trust.toPem(setupCa);
                } catch (Exception ignored) {
                }
                Prefs.setServer(MainActivity.this, url, pem);
                NotifyService.kick(MainActivity.this);
                Trust.verifiedLeaves.clear();
                web.clearHistory();
                web.loadUrl(url + "/");
                startup();
            });
        }
    }

    /** Everything this phone keeps for a server: sign out there (best effort), cookies, stored data. */
    private void forgetServer(String url) {
        CookieManager cm = CookieManager.getInstance();
        String cookies = cm.getCookie(url);
        X509Certificate ca = null;
        try {
            ca = Trust.caFor(this, Uri.parse(url).getHost());
        } catch (Exception ignored) {
        }
        final X509Certificate serverCa = ca;
        android.util.Log.i("AmoreChat", "forget " + url + " cookies=" + (cookies == null ? "none" : cookies.length()));
        if (cookies != null) {
            new Thread(() -> {
                try {
                    HttpURLConnection c = Net.open(this, url + "/api/auth/logout", "POST", serverCa);
                    c.setRequestProperty("Cookie", cookies);
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(5000);
                    // A JSON body: a bare POST gets Android's default form content type, which the server refuses.
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (java.io.OutputStream o = c.getOutputStream()) {
                        o.write("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                    android.util.Log.i("AmoreChat", "logout " + url + " -> " + c.getResponseCode());
                    c.disconnect();
                } catch (Exception e) {
                    // unreachable (e.g. the server is gone): the local data goes anyway
                    android.util.Log.i("AmoreChat", "logout " + url + " failed: " + e);
                }
            }, "amore-logout").start();
            for (String part : cookies.split(";")) {
                String name = part.split("=", 2)[0].trim();
                if (!name.isEmpty()) cm.setCookie(url, name + "=; Max-Age=0; Path=/");
            }
            cm.flush();
        }
        try {
            WebStorage.getInstance().deleteOrigin(url);
        } catch (Exception ignored) {
        }
        Notifs.clearUnread(url);
        Trust.verifiedLeaves.clear();
    }

    private void setupReply(JSONObject r) {
        runOnUiThread(() -> web.evaluateJavascript("window.onNative && window.onNative(" + r + ")", null));
    }

    /** Is there an AmoreChat server at this address? Handles offline servers with their own CA. */
    private JSONObject check(String input) {
        JSONObject r = new JSONObject();
        try {
            String in = input.trim().replaceAll("/+$", "");
            boolean explicit = in.startsWith("http://") || in.startsWith("https://");
            Uri u = Uri.parse(explicit ? in : "https://" + in);
            if (u.getHost() == null || u.getHost().isEmpty()) return r.put("error", "آدرس نامعتبر است");
            String url = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            try {
                String site = siteName(url, null);
                return r.put("ok", true).put("url", url).put("site", site).put("secure", url.startsWith("https"));
            } catch (SSLException e) {
                // Offline install (TLS_MODE=internal): get the server's CA over plain HTTP and let the
                // user compare its fingerprint with the one shown on the server's /ca page.
                X509Certificate ca = fetchCa(u.getHost());
                X509Certificate[] chain = Trust.fetchChain(u.getHost(), u.getPort() > 0 ? u.getPort() : 443);
                if (ca == null || !Trust.chainTrusted(chain, ca)) return r.put("error", "گواهی امنیتی این سرور معتبر نیست");
                String site = siteName(url, ca);
                setupCa = ca;
                r.put("trust", true).put("url", url).put("site", site).put("fingerprint", Trust.sha256(ca));
                // The same server may also answer on plain http: offer it as an option.
                if (!explicit) {
                    String http = "http://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
                    try {
                        siteName(http, null);
                        r.put("http", http);
                    } catch (Exception ignored) {
                        // https only
                    }
                }
                return r;
            } catch (Exception e) {
                if (!explicit) {
                    String http = "http://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
                    try {
                        String site = siteName(http, null);
                        return r.put("ok", true).put("url", http).put("site", site).put("secure", false);
                    } catch (Exception ignored) {
                    }
                }
                return r.put("error", "سرور پیدا نشد یا در دسترس نیست");
            }
        } catch (Exception e) {
            try {
                return r.put("error", "خطا: " + e.getMessage());
            } catch (Exception ignored) {
                return r;
            }
        }
    }

    private String siteName(String url, X509Certificate ca) throws Exception {
        HttpURLConnection c = Net.open(this, url + "/api/config", "GET", ca);
        c.setConnectTimeout(8000);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            JSONObject o = new JSONObject(Net.readAll(c.getInputStream()));
            if (!o.has("version")) throw new Exception("not AmoreChat");
            return o.optString("siteName", "AmoreChat");
        } finally {
            c.disconnect();
        }
    }

    private X509Certificate fetchCa(String host) {
        try {
            HttpURLConnection c = (HttpURLConnection) new java.net.URL("http://" + host + "/ca.crt").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setInstanceFollowRedirects(false);
            try (InputStream in = c.getInputStream()) {
                return Trust.parse(Net.readBytes(in));
            } finally {
                c.disconnect();
            }
        } catch (Exception e) {
            return null;
        }
    }

}
