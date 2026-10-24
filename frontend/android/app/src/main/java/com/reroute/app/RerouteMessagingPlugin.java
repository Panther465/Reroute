package com.reroute.app;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.lang.ref.WeakReference;
import java.util.Map;

/**
 * Firebase Cloud Messaging for the page (src/native/push.ts): this phone's token, to register with the server, and
 * the alerts that arrive while the app is on screen. A build without google-services.json has no Firebase: both
 * methods say so, and the app runs without push.
 */
@CapacitorPlugin(name = "RerouteMessaging")
public class RerouteMessagingPlugin extends Plugin {

    private static WeakReference<RerouteMessagingPlugin> running = new WeakReference<>(null);

    @Override
    public void load() {
        running = new WeakReference<>(this);
    }

    /** Hands an alert to the page; false when there's no page listening (not started yet, or gone). */
    static boolean deliver(Map<String, String> data) {
        RerouteMessagingPlugin plugin = running.get();
        if (plugin == null || !plugin.hasListeners("alert")) return false;
        JSObject alert = new JSObject();
        for (Map.Entry<String, String> entry : data.entrySet()) alert.put(entry.getKey(), entry.getValue());
        plugin.notifyListeners("alert", alert);
        return true;
    }

    private boolean firebase(PluginCall call) {
        if (!FirebaseApp.getApps(getContext()).isEmpty()) return true;
        call.reject("Push isn't set up in this build (no google-services.json).", "UNAVAILABLE");
        return false;
    }

    /** The page's own alert as a notification, shown as a push is (Alerts), so the two copies show once. */
    @PluginMethod
    public void show(PluginCall call) {
        String body = call.getString("body");
        String tag = call.getString("tag");
        if (body == null || tag == null) {
            call.reject("An alert needs its words and tag.");
            return;
        }
        Alerts.show(getContext(), call.getString("title", "Reroute"), body, tag);
        call.resolve();
    }

    /** The alert whose notification opened the app, once (its tap carries the push's details), or nothing. */
    @PluginMethod
    public void launchAlert(PluginCall call) {
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        JSObject out = new JSObject();
        JSObject alert = intent != null ? takeAlert(intent) : null;
        if (alert != null) out.put("alert", alert);
        call.resolve(out);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject alert = takeAlert(intent);
        if (alert != null) notifyListeners("alert", alert);
    }

    /** The alert on a tap from its notification, removed from the intent so it's handed over once. */
    private static JSObject takeAlert(Intent intent) {
        String json = intent.getStringExtra(Alerts.EXTRA_ALERT);
        if (json == null) return null;
        intent.removeExtra(Alerts.EXTRA_ALERT);
        try {
            return new JSObject(json);
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    @PluginMethod
    public void token(PluginCall call) {
        if (!firebase(call)) return;
        // Firebase makes this phone a token only once the traveller turns alerts on (auto-init is off in the manifest),
        // and keeps it fresh from then on, until forget().
        FirebaseMessaging.getInstance()
            .getToken()
            .addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    FirebaseMessaging.getInstance().setAutoInitEnabled(true);
                    JSObject out = new JSObject();
                    out.put("token", task.getResult());
                    call.resolve(out);
                } else {
                    // Not "unavailable": Firebase is in this build but couldn't answer now (no signal), so it's asked again.
                    call.reject("Firebase gave no token.", "FAILED", task.getException());
                }
            });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        if (!firebase(call)) return;
        // No new token behind the traveller's back: the next one comes when alerts are turned on again.
        FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        FirebaseMessaging.getInstance()
            .deleteToken()
            .addOnCompleteListener(task -> {
                if (task.isSuccessful()) call.resolve();
                else call.reject("Firebase kept the token.", "UNAVAILABLE", task.getException());
            });
    }
}
