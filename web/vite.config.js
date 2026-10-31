import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const backend = process.env.BACKEND || 'http://localhost:3000';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  // Lets the app notice when the server runs a newer version than the cached copy.
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'AmoreChat',
        short_name: 'AmoreChat',
        description: 'پیام‌رسان داخلی',
        lang: 'fa',
        dir: 'rtl',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#2563eb',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // webp/json: the emoji sprite, so emoji work offline too.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webp,json}'],
        importScripts: ['sw-extra.js'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io(\/|\?|$)/, /^\/healthz(\?|$)/, /^\/rtc(\/|\?|$)/, /^\/app(\/|\?|$)/, /^\/ca(\.crt|-help)?(\?|$)/],
        // Pictures already seen (photos, avatars, video thumbnails) stay visible offline.
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => request.destination === 'image' && url.pathname.startsWith('/api/files/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'files',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
      '/rtc': { target: backend, ws: true },
    },
  },
});
