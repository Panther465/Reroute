import type { CapacitorConfig } from '@capacitor/cli'

// The Android app: this same web app, built with `pnpm build:android` into dist-android and bundled into
// the APK (frontend/android). Its page runs at https://localhost inside the phone and calls the API at
// VITE_API_BASE (frontend/.env.android). README.md, "The Android app", has the steps.
const config: CapacitorConfig = {
  appId: 'com.reroute.app',
  appName: 'Reroute',
  webDir: 'dist-android',
  backgroundColor: '#EDF0EB',
  plugins: {
    // The edge-to-edge plugin keeps the page clear of the status and navigation bars, so the layout is the
    // browser's; Capacitor's own handling would only add CSS variables the web app doesn't use.
    SystemBars: { insetsHandling: 'disable' },
    EdgeToEdge: { statusBarColor: '#EDF0EB', navigationBarColor: '#FFFFFF' },
    SplashScreen: { launchShowDuration: 600, backgroundColor: '#EDF0EB', showSpinner: false },
    LocalNotifications: { smallIcon: 'ic_stat_reroute', iconColor: '#0B7A4B' },
    // Only Google: the other sign-ins (and their SDKs) stay out of the APK.
    SocialLogin: { providers: { google: true, facebook: false, apple: false, twitter: false } },
  },
}

export default config
