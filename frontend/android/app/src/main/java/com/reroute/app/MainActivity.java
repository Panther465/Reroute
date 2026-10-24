package com.reroute.app;

import android.content.Intent;
import android.os.Bundle;
import java.lang.ref.WeakReference;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

/**
 * Reroute's web app in Capacitor's web view. Additions: Google's authorization screen (Calendar access, and the
 * code for the server) reports back through onActivityResult; pushed alerts (RerouteMessagingPlugin and Service);
 * Android's permission dialog closed with Back is "not allowed" (PermissionChromeClient); and debug builds may reach
 * the local stack, whose certificate is self-signed (DevNetwork; release builds contain none of that).
 */
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    /** Reroute is on screen: a pushed alert goes to the page, which shows it itself (RerouteMessagingService). */
    static volatile boolean onScreen = false;
    /** The app's own screen while it's alive (not Rico's bar, RicoBarActivity, which is one too). */
    static WeakReference<MainActivity> live = new WeakReference<>(null);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RerouteMessagingPlugin.class);
        registerPlugin(RicoWakePlugin.class);
        super.onCreate(savedInstanceState);
        DevNetwork.install(getBridge());
        // Still in onCreate: it registers for Android's permission answers, which must happen before the screen starts.
        getBridge().getWebView().setWebChromeClient(new PermissionChromeClient(getBridge()));
        if (!(this instanceof RicoBarActivity)) {
            live = new WeakReference<>(this);
            // One page at a time: Rico's bar goes when the app itself opens.
            RicoBarActivity bar = RicoBarActivity.live.get();
            if (bar != null && !bar.isFinishing()) bar.finish();
        }
    }

    /**
     * As a browser does for a tab in the background: the page learns it's hidden (document.visibilityState), so the web
     * app's alerts become phone notifications. JavaScript keeps running; only animations and the like pause.
     */
    @Override
    public void onPause() {
        onScreen = false;
        super.onPause();
        if (getBridge() != null) getBridge().getWebView().onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null) getBridge().getWebView().onResume();
        onScreen = true;
        // Rico's pop-up over other apps goes once the app itself is up.
        RicoPopUp.hideSoon(this);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN || requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) return;
        PluginHandle handle = getBridge().getPlugin("SocialLogin");
        Plugin plugin = handle == null ? null : handle.getInstance();
        if (plugin instanceof SocialLoginPlugin) ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }

    /** Required by the sign-in plugin to show that onActivityResult above passes Google's answer on. */
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
