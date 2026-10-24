package com.reroute.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** A pushed alert takes the place of the page's own: both must give the same tag the same notification number. */
public class AlertsTest {

    @Test
    public void numbersAlertsAsThePageDoes() {
        // Worked out with notificationId() from src/native/notifications.ts.
        assertEquals(205859538, Alerts.notificationId("leave-1"));
        assertEquals(820149920, Alerts.notificationId("leave-12"));
        assertEquals(142489880, Alerts.notificationId("morning-trip-001-2"));
        assertEquals(999996129, Alerts.notificationId("arrive-2"));
        assertEquals(932692745, Alerts.notificationId("task-bank"));
        assertEquals(18652613, Alerts.notificationId(""));
    }
}
