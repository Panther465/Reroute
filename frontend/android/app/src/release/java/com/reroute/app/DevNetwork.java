package com.reroute.app;

import com.getcapacitor.Bridge;

/** Release builds: every certificate is checked as usual. (Debug builds have their own DevNetwork, for the local stack.) */
final class DevNetwork {

    private DevNetwork() {}

    static void install(Bridge bridge) {}
}
