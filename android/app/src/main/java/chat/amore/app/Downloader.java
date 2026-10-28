package chat.amore.app;

import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Saves a file from the server into the phone's Downloads folder. Done here (not with Android's
 * DownloadManager) so it works with the server's own certificate and the session cookie.
 */
final class Downloader {
    private Downloader() {}

    private static final AtomicInteger ids = new AtomicInteger(5000);

    static void start(Context ctx, String url, String name, String mime) {
        Context c = ctx.getApplicationContext();
        String safe = name == null || name.isEmpty() ? "file" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        int id = ids.incrementAndGet();
        new Thread(() -> {
            Uri saved = null;
            try {
                HttpURLConnection conn = Net.open(c, url, "GET");
                conn.setReadTimeout(60000);
                if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
                String type = mime != null && !mime.isEmpty() ? mime : conn.getContentType();
                if (type == null) type = "application/octet-stream";
                long total = conn.getContentLengthLong();
                OutputStream out;
                File legacyFile = null;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, type);
                    v.put(MediaStore.Downloads.IS_PENDING, 1);
                    saved = c.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    out = c.getContentResolver().openOutputStream(saved);
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    dir.mkdirs();
                    legacyFile = unique(dir, safe);
                    out = new FileOutputStream(legacyFile);
                }
                Notifs.download(c, id, safe, total > 0 ? 0 : -1, false, null);
                long got = 0;
                long lastPaint = 0;
                try (InputStream in = conn.getInputStream(); OutputStream o = out) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        o.write(buf, 0, n);
                        got += n;
                        if (System.currentTimeMillis() - lastPaint > 500) {
                            lastPaint = System.currentTimeMillis();
                            Notifs.download(c, id, safe, total > 0 ? (int) (got * 100 / total) : -1, false, null);
                        }
                    }
                }
                conn.disconnect();
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.IS_PENDING, 0);
                    c.getContentResolver().update(saved, v, null, null);
                } else {
                    saved = FileProvider.getUriForFile(c, c.getPackageName() + ".files", legacyFile);
                }
                Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(saved, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent open = PendingIntent.getActivity(c, id, view, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notifs.download(c, id, safe, 100, true, open);
            } catch (Exception e) {
                if (saved != null && Build.VERSION.SDK_INT >= 29) {
                    ContentResolver r = c.getContentResolver();
                    try {
                        r.delete(saved, null, null);
                    } catch (Exception ignored) {
                    }
                }
                Notifs.downloadFailed(c, id, safe);
            }
        }, "amore-download").start();
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; f.exists(); i++) f = new File(dir, base + " (" + i + ")" + ext);
        return f;
    }
}
