import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Base pública: `/` por defecto; en GitHub Pages, `/horas/`. Siempre empieza y termina en `/`.
const rawBase = process.env.VITE_BASE || '/'
const withLeading = rawBase.startsWith('/') ? rawBase : '/' + rawBase
const base = withLeading.endsWith('/') ? withLeading : withLeading + '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        id: base,
        name: 'Horas · Registro de jornadas',
        short_name: 'Horas',
        description: 'Registro de jornadas, horas extra y períodos de pago.',
        lang: 'es-AR',
        start_url: base,
        scope: base,
        display: 'standalone',
        theme_color: '#e2e8e1',
        background_color: '#e2e8e1',
        icons: [
          { src: base + 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: base + 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: base + 'icon-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Cargar hoy',
            short_name: 'Hoy',
            url: base + '?hoy=1',
            icons: [{ src: base + 'icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,json}'],
        navigateFallback: base + 'index.html',
        cleanupOutdatedCaches: true,
        // Relativo al service worker, que vive en la base.
        importScripts: ['notifications.js'],
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
