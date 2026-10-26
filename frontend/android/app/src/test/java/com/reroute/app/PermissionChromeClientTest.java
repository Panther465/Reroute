package com.reroute.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Android's answer to a permission dialog: closed with Back, it grants nothing (Capacitor took that as "allowed"). */
public class PermissionChromeClientTest {

    private static final String FINE = "android.permission.ACCESS_FINE_LOCATION";
    private static final String COARSE = "android.permission.ACCESS_COARSE_LOCATION";
    private static final String MIC = "android.permission.RECORD_AUDIO";

    @Test
    public void theDialogClosedWithBackGrantsNothing() {
        assertFalse(PermissionChromeClient.anyGranted(Map.of(), FINE, COARSE));
        assertFalse(PermissionChromeClient.allGranted(Map.of(), List.of(MIC)));
    }

    @Test
    public void theLocationIsAllowedWithThePreciseOrTheApproximateOne() {
        assertTrue(PermissionChromeClient.anyGranted(Map.of(FINE, true, COARSE, true), FINE, COARSE));
        assertTrue(PermissionChromeClient.anyGranted(Map.of(FINE, false, COARSE, true), FINE, COARSE));
        assertFalse(PermissionChromeClient.anyGranted(Map.of(FINE, false, COARSE, false), FINE, COARSE));
    }

    @Test
    public void theMicrophoneNeedsEveryPermissionAsked() {
        assertTrue(PermissionChromeClient.allGranted(Map.of(MIC, true), List.of(MIC)));
        assertFalse(PermissionChromeClient.allGranted(Map.of(MIC, false), List.of(MIC)));
        assertTrue(PermissionChromeClient.allGranted(Map.of(), List.of()));
    }
}
