import { defineConfig, devices } from '@playwright/test'

// Runs against a running stack (docker compose up): E2E_BASE_URL=https://localhost pnpm e2e
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Every test drives the same seeded demo trip (trip-001), and the flow test resets it, so tests
  // run one at a time: in parallel they would change the trip under each other.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
})
