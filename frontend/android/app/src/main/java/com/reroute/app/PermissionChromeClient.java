package com.reroute.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Capacitor's web view client, but Android's permission dialog closed with Back is "not allowed". Capacitor counts the
 * empty answer Android gives then as allowed: the page was told it could have the phone's location, Android refused it
 * the location, and the page's location watch asked again at once, a dialog after every Back, with no way out but to
 * choose. The microphone had the same flaw. A permission the app already holds isn't asked for again, and the
 * approximate location alone is enough (Android 12 and later offer it instead of the precise one).
 */
final class PermissionChromeClient extends BridgeWebChromeClient {

    private static final String FINE = Manifest.permission.ACCESS_FINE_LOCATION;
    private static final String COARSE = Manifest.permission.ACCESS_COARSE_LOCATION;

    private final Bridge bridge;
    private final ActivityResultLauncher<String[]> ask;
    /** What to do with Android's answer to the dialog on screen; one at a time, as Capacitor's own. */
    private Consumer<Map<String, Boolean>> answer;

    PermissionChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        ask = bridge.registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), (result) -> {
            Consumer<Map<String, Boolean>> a = answer;
            answer = null;
            if (a != null) a.accept(result);
        });
    }

    /** Whether Android's answer grants any of these: an empty answer (the dialog closed with Back) grants nothing. */
    static boolean anyGranted(Map<String, Boolean> result, String... permissions) {
        for (String p : permissions) if (Boolean.TRUE.equals(result.get(p))) return true;
        return false;
    }

    /** Whether Android's answer grants every one of these: an empty answer grants nothing. */
    static boolean allGranted(Map<String, Boolean> result, List<String> permissions) {
        if (permissions.isEmpty()) return true;
        for (String p : permissions) if (!Boolean.TRUE.equals(result.get(p))) return false;
        return true;
    }

    private boolean holds(String permission) {
        return ContextCompat.checkSelfPermission(bridge.getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void askFor(String[] permissions, Consumer<Map<String, Boolean>> then) {
        // A dialog still waiting is answered "no" rather than never: its page would wait forever.
        Consumer<Map<String, Boolean>> waiting = answer;
        answer = then;
        if (waiting != null) waiting.accept(Collections.emptyMap());
        ask.launch(permissions);
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        if (holds(FINE) || holds(COARSE)) {
            callback.invoke(origin, true, false);
            return;
        }
        askFor(new String[] { COARSE, FINE }, (result) -> callback.invoke(origin, anyGranted(result, FINE, COARSE), false));
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        List<String> resources = Arrays.asList(request.getResources());
        List<String> needed = new ArrayList<>();
        if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !holds(Manifest.permission.CAMERA)) needed.add(Manifest.permission.CAMERA);
        if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !holds(Manifest.permission.RECORD_AUDIO)) needed.add(Manifest.permission.RECORD_AUDIO);
        if (needed.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        askFor(needed.toArray(new String[0]), (result) -> {
            if (allGranted(result, needed)) request.grant(request.getResources());
            else request.deny();
        });
    }
}
