/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { VitePWA } from 'vite-plugin-pwa'

// Vite config — https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/',
  build: {
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
        globIgnores: ['**/maplibre*'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/maplibre'),
            handler: 'CacheFirst',
            options: { cacheName: 'maplibre', expiration: { maxEntries: 8 } },
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
