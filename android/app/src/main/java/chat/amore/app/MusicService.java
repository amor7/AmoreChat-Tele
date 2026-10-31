package chat.amore.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Music from the page keeps playing with the screen off: this keeps the app alive and shows the
 * player in the notification, on the lock screen and for headset buttons. The sound itself stays in
 * the page; its buttons go back there (window.__amoreMusic).
 */
public class MusicService extends Service {
    private static final String CHANNEL = "music";
    private static final int ID = 7301;
    private static final long ACTIONS = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO;

    private MediaSession session;
    private boolean playing;

    /** From the page: the current song, or no title when the player closed. */
    static void update(Context c, String title, String artist, boolean playing, long position, long duration, float speed) {
        try {
            ContextCompat.startForegroundService(c, new Intent(c, MusicService.class).putExtra("title", title).putExtra("artist", artist)
                    .putExtra("playing", playing).putExtra("position", position).putExtra("duration", duration).putExtra("speed", speed));
        } catch (Exception ignored) {
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, MusicService.class));
    }

    private void toPage(String cmd, long ms) {
        MainActivity.musicCommand(cmd, ms);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSession(this, "AmoreChat");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { toPage("play", 0); }
            @Override public void onPause() { toPage("pause", 0); }
            @Override public void onSkipToNext() { toPage("next", 0); }
            @Override public void onSkipToPrevious() { toPage("prev", 0); }
            @Override public void onSeekTo(long ms) { toPage("seek", ms); }
            @Override public void onStop() { toPage("close", 0); }
        });
        session.setActive(true);
    }

    private PendingIntent button(String cmd, int code) {
        Intent i = new Intent(this, MusicService.class).putExtra("cmd", cmd);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action action(int icon, String label, String cmd, int code) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, button(cmd, code)).build();
    }

    private Notification notification(String title, String artist) {
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "پخش موزیک", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .addAction(action(android.R.drawable.ic_media_previous, "قبلی", "prev", 1))
                .addAction(playing ? action(android.R.drawable.ic_media_pause, "توقف", "pause", 2) : action(android.R.drawable.ic_media_play, "پخش", "play", 2))
                .addAction(action(android.R.drawable.ic_media_next, "بعدی", "next", 3))
                .addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "بستن", "close", 4))
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra("title") : null;
        String cmd = intent != null ? intent.getStringExtra("cmd") : null;
        if (cmd != null) {
            toPage(cmd, 0);
            return START_NOT_STICKY;
        }
        // Android restarted or started the service with nothing to show.
        if (title == null) title = "AmoreChat";
        String artist = intent != null ? intent.getStringExtra("artist") : "";
        playing = intent != null && intent.getBooleanExtra("playing", false);
        long position = intent != null ? intent.getLongExtra("position", 0) : 0;
        long duration = intent != null ? intent.getLongExtra("duration", 0) : 0;
        float speed = intent != null ? intent.getFloatExtra("speed", 1f) : 1f;
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, duration)
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(ACTIONS)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, position, playing ? speed : 0f)
                .build());
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        try {
            ServiceCompat.startForeground(this, ID, notification(title, artist), type);
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
