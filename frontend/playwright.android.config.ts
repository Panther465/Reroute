import { defineConfig } from '@playwright/test'

// The Android app's parity check: e2e-android drives the installed debug APK on an emulator or a phone
// through adb, inside the app's own web view. README.md, "The Android app", has the steps:
//   pnpm exec playwright test -c playwright.android.config.ts
export default defineConfig({
  testDir: 'e2e-android',
  timeout: 120_000,
  // One app on one device: the tests take turns, in order.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
})
