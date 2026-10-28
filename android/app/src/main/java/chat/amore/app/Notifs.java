package chat.amore.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.util.LruCache;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;

import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * All notifications the app shows. Message and call notifications are tagged with the server URL
 * (several servers can be added). Ids: 1 = background service, 2 = in call, 3 = incoming call,
 * 1000+chatId = messages of that chat.
 */
final class Notifs {
    private Notifs() {}

    static final String CH_MSG = "messages";
    static final String CH_CALL = "calls";
    static final String CH_SVC = "service";
    static final String CH_INCALL = "incall";
    static final String CH_DL = "downloads";

    static final int ID_SERVICE = 1;
    static final int ID_INCALL = 2;
    static final int ID_RING = 3;
    static final String KEY_REPLY = "reply";

    /** One shown message line. */
    private static final class Line {
        final String sender;
        final String senderKey;
        final String text;
        final long time;
        final String avatar;

        Line(String sender, String senderKey, String text, String avatar) {
            this.sender = sender;
            this.senderKey = senderKey;
            this.text = text;
            this.avatar = avatar;
            this.time = System.currentTimeMillis();
        }
    }

    private static final Map<String, List<Line>> lines = new HashMap<>();
    private static final Map<String, Integer> unread = new HashMap<>();
    private static final LruCache<String, Bitmap> avatars = new LruCache<>(60);

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel msg = new NotificationChannel(CH_MSG, "پیام‌ها", NotificationManager.IMPORTANCE_HIGH);
        msg.enableVibration(true);
        nm.createNotificationChannel(msg);

        NotificationChannel call = new NotificationChannel(CH_CALL, "تماس‌های ورودی", NotificationManager.IMPORTANCE_HIGH);
        call.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        call.enableVibration(true);
        call.setVibrationPattern(new long[] {0, 800, 600, 800});
        call.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(call);

        NotificationChannel svc = new NotificationChannel(CH_SVC, "اتصال پس‌زمینه", NotificationManager.IMPORTANCE_MIN);
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);

        NotificationChannel incall = new NotificationChannel(CH_INCALL, "تماس در جریان", NotificationManager.IMPORTANCE_LOW);
        incall.setShowBadge(false);
        nm.createNotificationChannel(incall);

        nm.createNotificationChannel(new NotificationChannel(CH_DL, "دانلودها", NotificationManager.IMPORTANCE_LOW));
    }

    /** Opens the app (on the given server) with an extra; carries the per-install key. */
    static PendingIntent openApp(Context c, int requestCode, String server, String key, String value) {
        Intent i = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (key != null) i.putExtra(key, value).putExtra("k", Prefs.intentKey(c));
        if (server != null) i.putExtra("srv", server);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent openApp(Context c, int requestCode, String key, String value) {
        return openApp(c, requestCode, null, key, value);
    }

    private static void show(Context c, String tag, int id, Notification n) {
        try {
            NotificationManagerCompat.from(c).notify(tag, id, n);
        } catch (SecurityException e) {
            // Notification permission not granted.
        }
    }

    static Notification service(Context c, String text) {
        return new NotificationCompat.Builder(c, CH_SVC)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("AmoreChat")
                .setContentText(text)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(openApp(c, 1, null, null))
                .build();
    }

    static void updateService(Context c, String text) {
        show(c, null, ID_SERVICE, service(c, text));
    }

    static Notification inCall(Context c, String title) {
        return new NotificationCompat.Builder(c, CH_INCALL)
                .setSmallIcon(R.drawable.ic_call)
                .setContentTitle("در تماس")
                .setContentText(title)
                .setOngoing(true)
                .setUsesChronometer(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(openApp(c, 2, null, null))
                .build();
    }

    // ---------- Avatars ----------

    /** Round picture for a file id from the server (cached); null if unavailable. */
    static Bitmap avatar(Context c, String server, String fileId) {
        if (fileId == null || fileId.isEmpty() || "null".equals(fileId)) return null;
        String k = server + "#" + fileId;
        Bitmap b = avatars.get(k);
        if (b != null) return b;
        try {
            HttpURLConnection conn = Net.open(c, server + "/api/files/" + fileId, "GET");
            conn.setReadTimeout(8000);
            if (conn.getResponseCode() != 200) return null;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 2;
            Bitmap raw = BitmapFactory.decodeStream(conn.getInputStream(), null, o);
            conn.disconnect();
            if (raw == null) return null;
            b = circle(raw, 128);
            avatars.put(k, b);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    private static Bitmap circle(Bitmap src, int size) {
        Bitmap scaled = Bitmap.createScaledBitmap(src, size, size, true);
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        new Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, p);
        return out;
    }

    private static Person person(String name, String key, Bitmap icon) {
        Person.Builder b = new Person.Builder().setName(name == null || name.isEmpty() ? "AmoreChat" : name).setKey(key);
        if (icon != null) b.setIcon(IconCompat.createWithBitmap(icon));
        return b.build();
    }

    // ---------- Messages ----------

    static synchronized int unreadFor(String server) {
        Integer n = unread.get(server);
        return n == null ? 0 : n;
    }

    static synchronized void clearUnread(String server) {
        unread.remove(server);
    }

    /**
     * Conversation-style notification (sender picture, last messages) with "Reply" and
     * "Mark as read" buttons. Network work (avatars) happens here: call from a background thread.
     */
    static void message(Context c, String server, String serverName, boolean showServer, long chatId, String title, String senderName,
            String senderKey, String senderAvatar, String chatAvatar, String text, boolean group, boolean mentioned) {
        String k = server + "#" + chatId;
        List<Line> l;
        synchronized (Notifs.class) {
            l = lines.get(k);
            if (l == null) lines.put(k, l = new ArrayList<>());
            l.add(new Line(senderName, senderKey, text, senderAvatar));
            while (l.size() > 8) l.remove(0);
            Integer n = unread.get(server);
            unread.put(server, n == null ? 1 : n + 1);
            l = new ArrayList<>(l);
        }
        Person me = new Person.Builder().setName("من").setKey("me").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (group) style.setConversationTitle((mentioned ? "@ " : "") + title).setGroupConversation(true);
        for (Line x : l) {
            Bitmap pic = avatar(c, server, x.avatar != null ? x.avatar : group ? null : chatAvatar);
            style.addMessage(x.text, x.time, person(group ? x.sender : title, x.senderKey, pic));
        }
        Bitmap large = avatar(c, server, chatAvatar);

        int req = (int) (chatId % 100000) + server.hashCode() % 1000 * 100000;
        Intent reply = new Intent(c, ActionReceiver.class).setAction(ActionReceiver.REPLY).putExtra("srv", server).putExtra("chatId", chatId);
        PendingIntent replyPi = PendingIntent.getBroadcast(c, req, reply, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        NotificationCompat.Action replyAction = new NotificationCompat.Action.Builder(0, "پاسخ", replyPi)
                .addRemoteInput(new RemoteInput.Builder(KEY_REPLY).setLabel("پیام…").build())
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .build();
        Intent read = new Intent(c, ActionReceiver.class).setAction(ActionReceiver.READ).putExtra("srv", server).putExtra("chatId", chatId);
        PendingIntent readPi = PendingIntent.getBroadcast(c, req + 1, read, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Action readAction = new NotificationCompat.Action.Builder(0, "خوانده شد", readPi)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                .setShowsUserInterface(false)
                .build();

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_MSG)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF6366F1)
                .setContentTitle((mentioned ? "@ " : "") + title)
                .setContentText(group ? senderName + ": " + text : text)
                .setStyle(style)
                .setNumber(l.size())
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setGroup(server)
                .addAction(replyAction)
                .addAction(readAction)
                .setContentIntent(openApp(c, req + 2, server, "chatId", String.valueOf(chatId)));
        if (large != null) b.setLargeIcon(large);
        if (showServer) b.setSubText(serverName);
        show(c, server, (int) (1000 + chatId), b.build());
    }

    /** After a quick reply: show it in the conversation and stop the alert. */
    static synchronized void replied(Context c, String server, long chatId, String text) {
        String k = server + "#" + chatId;
        List<Line> l = lines.get(k);
        if (l == null) return;
        l.add(new Line("من", "me", text, null));
        lines.remove(k);
        cancelChat(c, server, chatId);
    }

    static synchronized void cancelChat(Context c, String server, long chatId) {
        lines.remove(server + "#" + chatId);
        NotificationManagerCompat.from(c).cancel(server, (int) (1000 + chatId));
    }

    static synchronized void cancelAllMessages(Context c, String server) {
        for (String k : new ArrayList<>(lines.keySet())) {
            if (!k.startsWith(server + "#")) continue;
            lines.remove(k);
            NotificationManagerCompat.from(c).cancel(server, (int) (1000 + Long.parseLong(k.substring(k.indexOf('#') + 1))));
        }
        unread.remove(server);
    }

    // ---------- Calls ----------

    /** Ringing call: full screen on a locked phone, with answer / decline buttons. */
    static void call(Context c, String server, String serverName, boolean showServer, String callId, String name, boolean video) {
        Intent decline = new Intent(c, ActionReceiver.class).setAction(ActionReceiver.DECLINE).putExtra("callId", callId).putExtra("srv", server);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, 3, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answerPi = openApp(c, 4, server, "answerCall", callId);
        PendingIntent fullPi = openApp(c, 5, server, "ringingCall", callId);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_CALL)
                .setSmallIcon(R.drawable.ic_call)
                .setColor(0xFF10B981)
                .setContentTitle(name)
                .setContentText(video ? "تماس تصویری ورودی" : "تماس صوتی ورودی")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setTimeoutAfter(60000)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(fullPi)
                .addAction(0, "رد تماس", declinePi)
                .addAction(0, "پاسخ", answerPi);
        if (showServer) b.setSubText(serverName);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        show(c, null, ID_RING, n);
    }

    static void cancelCall(Context c) {
        NotificationManagerCompat.from(c).cancel(ID_RING);
    }

    // ---------- Downloads ----------

    static Notification download(Context c, int id, String name, int percent, boolean done, PendingIntent open) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_DL)
                .setSmallIcon(done ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_download)
                .setContentTitle(name)
                .setOnlyAlertOnce(true);
        if (done) {
            b.setContentText("دانلود شد").setAutoCancel(true);
            if (open != null) b.setContentIntent(open);
        } else {
            b.setContentText("در حال دانلود…").setProgress(100, Math.max(0, percent), percent < 0).setOngoing(true);
        }
        Notification n = b.build();
        show(c, null, id, n);
        return n;
    }

    static void downloadFailed(Context c, int id, String name) {
        show(c, null, id, new NotificationCompat.Builder(c, CH_DL)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(name)
                .setContentText("دانلود ناموفق بود")
                .setAutoCancel(true)
                .build());
    }
}
