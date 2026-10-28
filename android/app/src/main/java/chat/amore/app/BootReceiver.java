package chat.amore.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reconnect for notifications after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        NotifyService.start(c);
    }
}
