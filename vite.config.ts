import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        id: '/',
        name: 'Horas · Registro de jornadas',
        short_name: 'Horas',
        description: 'Registro de jornadas, horas extra y períodos de pago.',
        lang: 'es-AR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#e2e8e1',
        background_color: '#e2e8e1',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'Cargar hoy',
            short_name: 'Hoy',
            url: '/?hoy=1',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,json}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        importScripts: ['/notifications.js'],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules') && /(?:react-dom|scheduler|\/react\/)/.test(id))
            return 'react'
          if (id.includes('node_modules') && /(?:\/dexie\/|\/zod\/)/.test(id)) return 'storage'
        },
      },
    },
  },
})
