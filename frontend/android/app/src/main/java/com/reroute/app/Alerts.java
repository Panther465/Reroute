package com.reroute.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONObject;

/**
 * Reroute's alert notifications, shown by the app itself for a push: the channel, icon and number the page gives
 * the same alert through the notifications plugin (src/native/notifications.ts), so a pushed alert and the page's
 * own for that moment replace each other rather than stack. The page's notifications are shown here too
 * (RerouteMessagingPlugin.show), so whichever copy of an alert comes second is left out, even if the first was
 * swiped away. An alert that replaces another under the same tag ("Leave now" after "Leave in 9 min") sounds.
 */
final class Alerts {

    static final String CHANNEL = "alerts";
    /** A pushed alert's details on the tap that opens the app (RerouteMessagingPlugin hands them to the page). */
    static final String EXTRA_ALERT = "com.reroute.app.alert";
    /** How far apart two copies of one alert may come: the live stream's and the push's arrive within moments. */
    /** Shorter than the five minutes between the server's checks, so a new plan's alert in the same words still shows. */
    static final long SAME_ALERT_MS = 4 * 60 * 1000L;
    /** A different alert under the same tag this soon after the last replaces it without sounding again. */
    static final long QUIET_REPLACE_MS = 2 * 60 * 1000L;

    /** What this process showed lately, by notification number: the words and when. */
    private static final Map<Integer, Shown> recent = new HashMap<>();

    private static final class Shown {

        final String body;
        final long at;

        Shown(String body, long at) {
            this.body = body;
            this.at = at;
        }
    }

    private Alerts() {}

    /** A notification's number from its tag: FNV-1a, worked out as notificationId() in notifications.ts. */
    static int notificationId(String tag) {
        int h = 0x811c9dc5;
        for (int i = 0; i < tag.length(); i++) {
            h ^= tag.charAt(i);
            h *= 0x01000193;
        }
        int id = h & 0x7fffffff;
        return id == 0 ? 1 : id;
    }

    /** The channel the page makes when it starts, made here too for a push that arrives before the app has run. */
    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Alerts", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Time to leave, nearly there and arrived.");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    /** This alert (its number and words) was shown in the last few minutes, by this process or before it. */
    static boolean shownLately(Context context, int id, String body, long now) {
        for (Iterator<Shown> it = recent.values().iterator(); it.hasNext(); ) if (now - it.next().at > SAME_ALERT_MS) it.remove();
        Shown mine = recent.get(id);
        if (mine != null && mine.body.equals(body)) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        try {
            for (StatusBarNotification shown : manager.getActiveNotifications()) {
                CharSequence text = shown.getNotification().extras.getCharSequence(Notification.EXTRA_TEXT);
                if (shown.getId() == id && text != null && body.contentEquals(text) && now - shown.getPostTime() <= SAME_ALERT_MS) return true;
            }
        } catch (RuntimeException e) {
            // Android couldn't say what's showing: show it.
        }
        return false;
    }

    /** A notification with this number is in the shade now. */
    static boolean active(Context context, int id) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return true;
        try {
            for (StatusBarNotification shown : manager.getActiveNotifications()) if (shown.getId() == id) return true;
        } catch (RuntimeException e) {
            return true;
        }
        return false;
    }

    /** One at a time, so a push and the page's copy of the same alert can't both pass the check above. */
    static synchronized void show(Context context, String title, String body, String tag) {
        show(context, title, body, tag, null);
    }

    /** As above, and a tap hands the page the push's details (`data`), as if it had arrived with the app open. */
    static synchronized void show(Context context, String title, String body, String tag, Map<String, String> data) {
        NotificationManagerCompat notifications = NotificationManagerCompat.from(context);
        if (!notifications.areNotificationsEnabled()) return;
        int id = notificationId(tag);
        long now = System.currentTimeMillis();
        if (shownLately(context, id, body, now)) return;
        // Another alert under this tag a moment ago (the page's own words for the moment the server's push names):
        // this one takes its place quietly. "Leave now", minutes after "Leave in 10 min", still sounds.
        Shown last = recent.get(id);
        boolean quiet = last != null && now - last.at < QUIET_REPLACE_MS;
        // The traveller swiped that one away a moment ago: its other words for the same moment aren't shown either.
        if (quiet && !active(context, id)) return;
        recent.put(id, new Shown(body, now));
        ensureChannel(context);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reroute)
            .setColor(ContextCompat.getColor(context, R.color.reroute_green))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setOnlyAlertOnce(quiet)
            .setAutoCancel(true);
        // Android 7 has no channels: the sound and buzz are asked for on each notification.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setDefaults(Notification.DEFAULT_ALL);
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null && data != null) open.putExtra(EXTRA_ALERT, new JSONObject(data).toString());
        if (open != null) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            builder.setContentIntent(PendingIntent.getActivity(context, id, open, flags));
        }
        try {
            notifications.notify(id, builder.build());
        } catch (SecurityException e) {
            // Notifications were turned off in Android's settings a moment ago: nothing to show.
        }
    }
}
