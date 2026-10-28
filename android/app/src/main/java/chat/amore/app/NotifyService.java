package chat.amore.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Notifications without Google: one light, permanent connection (server-sent events) to each
 * AmoreChat server the user added. Keeps working when the international internet is cut, as
 * long as the phone can reach the servers. Android requires the silent "connected" notification.
 */
public class NotifyService extends Service {
    /** Per-server status, shown in the profile page and the status notification. */
    static final Map<String, String> statuses = new ConcurrentHashMap<>();
    static final Map<String, Boolean> connections = new ConcurrentHashMap<>();
    /** Status of the server currently shown (profile page). */
    static volatile String lastStatus = "در حال اتصال…";
    static volatile boolean connected;

    private final Map<String, Listener> listeners = new ConcurrentHashMap<>();
    private volatile boolean running;
    private String shownStatus;

    static void start(Context c) {
        if (Prefs.server(c) == null || !Prefs.background(c)) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, NotifyService.class));
        } catch (Exception e) {
            // Not allowed to start from the background right now; MainActivity starts it next time.
        }
    }

    /** Reconnect now (after signing in, or when servers were added / removed). */
    static void kick(Context c) {
        if (Prefs.server(c) == null || !Prefs.background(c)) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, NotifyService.class).setAction("kick"));
        } catch (Exception ignored) {
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, NotifyService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Notifs.channels(this);
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        try {
            ServiceCompat.startForeground(this, Notifs.ID_SERVICE, Notifs.service(this, "در حال اتصال…"), type);
        } catch (Exception e) {
            stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = true;
        boolean kick = intent != null && "kick".equals(intent.getAction());
        sync(kick);
        return START_STICKY;
    }

    /** One listener per added server: start new ones, stop removed ones, optionally reconnect all. */
    private synchronized void sync(boolean reconnect) {
        List<String> want = new ArrayList<>();
        for (Prefs.Server s : Prefs.servers(this)) want.add(s.url);
        for (String url : new ArrayList<>(listeners.keySet())) {
            if (!want.contains(url)) {
                listeners.remove(url).halt();
                statuses.remove(url);
                connections.remove(url);
            }
        }
        for (String url : want) {
            Listener l = listeners.get(url);
            if (l == null || !l.isAlive()) {
                l = new Listener(url);
                listeners.put(url, l);
                l.start();
            } else if (reconnect) {
                l.reconnect();
            }
        }
        if (want.isEmpty()) stopSelf();
        updateSummary();
    }

    private void setStatus(String url, String text, boolean ok) {
        statuses.put(url, text);
        connections.put(url, ok);
        if (url.equals(Prefs.server(this))) {
            lastStatus = text;
            connected = ok;
        }
        updateSummary();
    }

    /** "متصل" when every server is connected, else the first problem (with the server name). */
    private synchronized void updateSummary() {
        List<Prefs.Server> all = Prefs.servers(this);
        String text = null;
        int ok = 0;
        for (Prefs.Server s : all) {
            if (Boolean.TRUE.equals(connections.get(s.url))) ok++;
            else if (text == null) {
                String st = statuses.get(s.url);
                text = (all.size() > 1 ? s.name + ": " : "") + (st == null ? "در حال اتصال…" : st);
            }
        }
        if (text == null) text = all.size() > 1 ? "متصل به " + ok + " سرور" : "متصل";
        if (text.equals(shownStatus)) return;
        shownStatus = text;
        Notifs.updateService(this, text);
    }

    private final class Listener extends Thread {
        final String url;
        private volatile boolean stopped;
        private volatile HttpURLConnection conn;

        Listener(String url) {
            super("amore-notify");
            this.url = url;
        }

        void halt() {
            stopped = true;
            reconnect();
        }

        void reconnect() {
            HttpURLConnection c = conn;
            if (c != null) new Thread(c::disconnect).start();
            interrupt();
        }

        @Override
        public void run() {
            long backoff = 2000;
            while (running && !stopped && Prefs.find(NotifyService.this, url) != null) {
                try {
                    HttpURLConnection c = Net.open(NotifyService.this, url + "/api/notify/stream", "GET");
                    c.setRequestProperty("Accept", "text/event-stream");
                    c.setReadTimeout(75000); // the server pings every 25 s
                    conn = c;
                    int code = c.getResponseCode();
                    if (code == 401) {
                        // Logged out: nothing to listen for until the user signs in again.
                        setStatus(url, "برای دریافت اعلان وارد شوید", false);
                        pause(30000);
                        continue;
                    }
                    if (code == 404) {
                        // The server runs a version from before the Android app (needs 0.7 or newer).
                        setStatus(url, "سرور قدیمی است؛ مدیر باید سرور را به‌روزرسانی کند", false);
                        pause(300000);
                        continue;
                    }
                    if (code != 200) throw new java.io.IOException("خطای سرور (HTTP " + code + ")");
                    setStatus(url, "متصل", true);
                    backoff = 2000;
                    BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                    String line;
                    while (running && !stopped && (line = r.readLine()) != null) {
                        if (line.startsWith("data:")) handle(url, line.substring(5).trim());
                    }
                } catch (javax.net.ssl.SSLException e) {
                    setStatus(url, "خطای گواهی امنیتی (SSL) سرور؛ تلاش دوباره…", false);
                } catch (java.net.SocketTimeoutException e) {
                    setStatus(url, "سرور جواب نمی‌دهد؛ تلاش دوباره…", false);
                } catch (java.net.UnknownHostException | java.net.ConnectException e) {
                    setStatus(url, "سرور در دسترس نیست (اینترنت؟)؛ تلاش دوباره…", false);
                } catch (Exception e) {
                    String m = e.getMessage();
                    setStatus(url, m != null && m.startsWith("خطای") ? m : "قطع شد؛ تلاش دوباره…", false);
                } finally {
                    HttpURLConnection c = conn;
                    if (c != null) c.disconnect();
                    conn = null;
                }
                if (!running || stopped) break;
                if (Thread.interrupted()) {
                    backoff = 2000;
                    continue;
                }
                pause(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
        }

        private void pause(long ms) {
            try {
                Thread.sleep(ms);
            } catch (InterruptedException ignored) {
                // reconnect requested: retry right away
            }
        }
    }

    private void handle(String server, String data) {
        try {
            JSONObject o = new JSONObject(data);
            String type = o.optString("type");
            // The server on screen shows and sounds its own messages while the app is open.
            boolean onScreen = MainActivity.visible && server.equals(Prefs.server(this));
            Prefs.Server s = Prefs.find(this, server);
            String name = s == null ? "" : s.name;
            boolean many = Prefs.servers(this).size() > 1;
            switch (type) {
                case "message":
                    if (onScreen) return;
                    String text = o.has("text") ? o.optString("text") : o.optString("body");
                    Notifs.message(this, server, name, many, o.getLong("chatId"), o.optString("title"), o.optString("senderName", o.optString("title")),
                            server + ":" + o.optLong("senderId"), o.isNull("senderAvatar") ? null : o.optString("senderAvatar", null),
                            o.isNull("chatAvatar") ? null : o.optString("chatAvatar", null), text, o.optBoolean("group"), o.optBoolean("mentioned"));
                    MainActivity.notifyUnreadChanged();
                    break;
                case "read":
                    Notifs.cancelChat(this, server, o.getLong("chatId"));
                    break;
                case "call":
                    if (onScreen) return;
                    Notifs.call(this, server, name, many, o.getString("callId"), o.optString("name"), o.optBoolean("video"));
                    break;
                case "call_end":
                    Notifs.cancelCall(this);
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {
        }
    }

    /** Swiped away from the recent apps: keep listening (the service is separate from the screen). */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        start(getApplicationContext());
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        connected = false;
        for (Listener l : listeners.values()) l.halt();
        listeners.clear();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
