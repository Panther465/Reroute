package com.reroute.app;

import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Debug builds only (this file is in src/debug): the local Docker stack's certificate is self-signed and
 * names only localhost, so the emulator (10.0.2.2) and a phone on the Wi-Fi (the PC's LAN address) would be
 * refused. The web view accepts it for loopback and private network addresses, never for a public host.
 * Release builds use src/release/.../DevNetwork.java, which does nothing.
 */
final class DevNetwork {

    private DevNetwork() {}

    static void install(Bridge bridge) {
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    if (isPrivateHost(Uri.parse(error.getUrl()).getHost())) handler.proceed();
                    else super.onReceivedSslError(view, handler, error);
                }
            }
        );
    }

    /** Loopback, the emulator's 10.0.2.2, private IPv4 ranges (RFC 1918) and .local names. */
    static boolean isPrivateHost(String host) {
        if (host == null) return false;
        if (host.equals("localhost") || host.endsWith(".local")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) return false;
            }
        } catch (NumberFormatException e) {
            return false;
        }
        return octets[0] == 127 || octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
    }
}
