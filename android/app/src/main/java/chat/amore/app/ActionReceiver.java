package chat.amore.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

import org.json.JSONObject;

/** Notification buttons that work without opening the app: decline a call, reply, mark as read. */
public class ActionReceiver extends BroadcastReceiver {
    static final String DECLINE = "chat.amore.app.DECLINE";
    static final String REPLY = "chat.amore.app.REPLY";
    static final String READ = "chat.amore.app.READ";

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        String server = intent.getStringExtra("srv");
        if (server == null || Prefs.find(c, server) == null) server = Prefs.server(c);
        final String srv = server;
        Context app = c.getApplicationContext();
        PendingResult pending = goAsync();

        if (DECLINE.equals(action)) {
            Notifs.cancelCall(c);
            String callId = intent.getStringExtra("callId");
            new Thread(() -> {
                if (callId != null) Net.post(app, srv, "/api/calls/" + callId + "/decline", "{}");
                pending.finish();
            }).start();
            return;
        }

        long chatId = intent.getLongExtra("chatId", 0);
        if (REPLY.equals(action)) {
            Bundle in = RemoteInput.getResultsFromIntent(intent);
            CharSequence text = in == null ? null : in.getCharSequence(Notifs.KEY_REPLY);
            if (text == null || text.toString().trim().isEmpty()) {
                pending.finish();
                return;
            }
            new Thread(() -> {
                try {
                    int code = Net.post(app, srv, "/api/chats/" + chatId + "/messages", new JSONObject().put("text", text.toString().trim()).toString());
                    if (code >= 200 && code < 300) {
                        Net.post(app, srv, "/api/chats/" + chatId + "/read-all", "{}");
                        Notifs.replied(app, srv, chatId, text.toString());
                    }
                } catch (Exception ignored) {
                }
                pending.finish();
            }).start();
            return;
        }

        if (READ.equals(action)) {
            Notifs.cancelChat(c, srv, chatId);
            new Thread(() -> {
                Net.post(app, srv, "/api/chats/" + chatId + "/read-all", "{}");
                pending.finish();
            }).start();
            return;
        }
        pending.finish();
    }
}
