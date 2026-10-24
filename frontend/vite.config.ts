/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * `--mode android` builds the same app for the Android app (Capacitor bundles dist-android into the APK):
 * no service worker (its files are already on the phone), and the API's address is required, since the
 * app's own page (https://localhost inside the phone) isn't where the API is.
 */
function androidOutDir(mode: string) {
  const base = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE ?? ''
  if (!/^https:\/\/[^/]+/.test(base)) {
    throw new Error(
      "Set VITE_API_BASE to the API's https address for the Android build (frontend/.env.android): https://10.0.2.2 for the emulator, your PC's LAN address for a phone, the real host for a release.",
    )
  }
  return 'dist-android'
}

// Vite config — https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/',
  build: {
    outDir: mode === 'android' ? androidOutDir(mode) : 'dist',
    sourcemap: mode === 'development' ? 'inline' : false,
    // MapLibre is one large library, loaded only when a map is on screen.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Keep the app shell small: the heavy libraries load in their own cacheable chunks.
        manualChunks(id) {
          // Motion and Radix are left to the bundler (a manual chunk would also pull in their shared
          // dependencies, React included), so Sign in loads neither up front: its hero animation
          // loads after first paint.
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (/node_modules\/(react|react-dom|react-router|scheduler|@tanstack\/[^/]+)\//.test(id)) return 'react'
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // The Android app's files are on the phone already: no service worker, so an update never serves an old copy.
      disable: mode === 'android',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Reroute',
        short_name: 'Reroute',
        description: "Running late? We'll reroute your day.",
        theme_color: '#0B7A4B',
        background_color: '#EDF0EB',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        // API responses are cached by the persisted query cache, not the service worker.
        navigateFallbackDenylist: [/^\/v1\//],
        // MapLibre is large and its map needs a connection anyway: cache it the first time a map opens.
        // The landing page's screenshots are for first-time visitors, not for offline use. (The rendered Roo's
        // sheets are WebP, which isn't precached either.)
        globIgnores: ['**/maplibre*', 'landing/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/maplibre'),
            handler: 'CacheFirst',
            options: { cacheName: 'maplibre', expiration: { maxEntries: 8 } },
          },
          {
            // Roo in 3D: its rendered sheet, the first time a live Roo of that size appears, and its stills
            // (three sheets, and nine moods at two sizes).
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/roo-'),
            handler: 'CacheFirst',
            options: { cacheName: 'roo', expiration: { maxEntries: 24 } },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'map-tiles', expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 14 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // API_PROXY=https://localhost sends both APIs through the Docker stack's NGINX (its local
    // certificate is self-signed, hence secure: false); unset, the APIs run outside Docker.
    proxy: (process.env.API_PROXY
      ? { '/v1': { target: process.env.API_PROXY, changeOrigin: true, secure: false } }
      : {
          // Raasta first: its prefix is more specific than /v1.
          '/v1/raasta': { target: 'http://localhost:8001', changeOrigin: true },
          '/v1': { target: 'http://localhost:8000', changeOrigin: true },
        }) as Record<string, ProxyOptions>,
  },
  test: {
    environment: 'jsdom',
    pool: 'threads',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
}))
