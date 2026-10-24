package com.reroute.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Reroute's alerts as push notifications (Firebase Cloud Messaging). The server sends each as a data message, and
 * this shows it through Alerts, so it takes the place of the page's own alert for the same moment. Android runs this
 * even when it has frozen the app or cut its network, which is what the live stream can't get past.
 */
public class RerouteMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String body = data.get("body");
        String tag = data.get("tag");
        if (body == null || tag == null) return;
        // Firebase drops an alert that couldn't reach the phone in its time (the server sends its time to live), so
        // what arrives is still worth showing. On screen, the page shows alerts itself, as it does the live stream's.
        if (MainActivity.onScreen && RerouteMessagingPlugin.deliver(data)) return;
        String title = data.get("title");
        Alerts.show(this, title == null ? "Reroute" : title, body, tag, data);
    }

    @Override
    public void onNewToken(String token) {
        // Nothing to do here: the page registers the phone each time the app opens, and so hands over this one then.
    }
}
