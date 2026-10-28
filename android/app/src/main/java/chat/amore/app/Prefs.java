package chat.amore.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * App settings. Several AmoreChat servers can be added (each with its own account); one is shown
 * at a time, notifications come from all of them.
 */
final class Prefs {
    private Prefs() {}

    static final class Server {
        final String url;
        final String ca; // PEM of the server's own CA (offline installs), or null
        final String name;

        Server(String url, String ca, String name) {
            this.url = url;
            this.ca = ca;
            this.name = name;
        }

        String host() {
            return Uri.parse(url).getHost();
        }
    }

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("amore", Context.MODE_PRIVATE);
    }

    // ---------- Servers ----------

    static synchronized List<Server> servers(Context c) {
        List<Server> out = new ArrayList<>();
        String raw = p(c).getString("servers", null);
        if (raw == null) {
            // Before multi-server: one server + its CA.
            String s = p(c).getString("server", null);
            if (s != null) out.add(new Server(s, p(c).getString("ca", null), Uri.parse(s).getHost()));
            return out;
        }
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new Server(o.getString("url"), o.optString("ca", null), o.optString("name", Uri.parse(o.getString("url")).getHost())));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static void save(Context c, List<Server> list) {
        JSONArray a = new JSONArray();
        try {
            for (Server s : list) {
                JSONObject o = new JSONObject().put("url", s.url).put("name", s.name);
                if (s.ca != null) o.put("ca", s.ca);
                a.put(o);
            }
        } catch (Exception ignored) {
        }
        p(c).edit().putString("servers", a.toString()).apply();
    }

    static Server find(Context c, String urlOrHost) {
        if (urlOrHost == null) return null;
        for (Server s : servers(c)) {
            if (s.url.equals(urlOrHost) || urlOrHost.equalsIgnoreCase(s.host())) return s;
        }
        return null;
    }

    /** The server shown right now. */
    static String server(Context c) {
        String cur = p(c).getString("server", null);
        if (cur != null && find(c, cur) != null) return cur;
        List<Server> all = servers(c);
        return all.isEmpty() ? null : all.get(0).url;
    }

    static String serverHost(Context c) {
        String s = server(c);
        return s == null ? null : Uri.parse(s).getHost();
    }

    static boolean isKnownHost(Context c, String host) {
        return host != null && find(c, host) != null;
    }

    /** Adds (or updates) a server and shows it. */
    static synchronized void setServer(Context c, String url, String caPem) {
        List<Server> list = servers(c);
        List<Server> next = new ArrayList<>();
        String name = Uri.parse(url).getHost();
        for (Server s : list) if (!s.url.equals(url)) next.add(s);
        next.add(new Server(url, caPem, name));
        save(c, next);
        p(c).edit().putString("server", url).apply();
    }

    static void switchTo(Context c, String url) {
        p(c).edit().putString("server", url).apply();
    }

    static synchronized void removeServer(Context c, String url) {
        List<Server> next = new ArrayList<>();
        for (Server s : servers(c)) if (!s.url.equals(url)) next.add(s);
        save(c, next);
        if (url.equals(p(c).getString("server", null))) {
            p(c).edit().putString("server", next.isEmpty() ? null : next.get(0).url).apply();
        }
    }

    /** CA for the current server. */
    static String ca(Context c) {
        Server s = find(c, server(c));
        return s == null ? null : s.ca;
    }

    static String caFor(Context c, String urlOrHost) {
        Server s = find(c, urlOrHost);
        return s == null ? null : s.ca;
    }

    // ---------- Other settings ----------

    static boolean background(Context c) {
        return p(c).getBoolean("background", true);
    }

    static void setBackground(Context c, boolean on) {
        p(c).edit().putBoolean("background", on).apply();
    }

    static boolean appLock(Context c) {
        return p(c).getBoolean("lock", false);
    }

    static void setAppLock(Context c, boolean on) {
        p(c).edit().putBoolean("lock", on).apply();
    }

    /** Random per-install key: only the app's own notifications may open a chat or answer a call. */
    static String intentKey(Context c) {
        String k = p(c).getString("ik", null);
        if (k == null) {
            k = java.util.UUID.randomUUID().toString();
            p(c).edit().putString("ik", k).apply();
        }
        return k;
    }

    static boolean askedPermissions(Context c) {
        return p(c).getBoolean("asked", false);
    }

    static void setAskedPermissions(Context c) {
        p(c).edit().putBoolean("asked", true).apply();
    }
}
