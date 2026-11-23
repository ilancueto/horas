import { defineConfig, devices } from '@playwright/test'

// Prueba de humo bajo la subruta de GitHub Pages: build en `dist-pages/` (`npm run build:pages`).
const pages = '**/pages.e2e.ts'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  workers: 3,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:47683',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'escritorio',
      testIgnore: pages,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'celular',
      testIgnore: ['**/sync.e2e.ts', pages],
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'pages',
      testMatch: pages,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        baseURL: 'http://127.0.0.1:47685',
      },
    },
  ],
  webServer: [
    {
      command: 'npm run preview -- --strictPort --port 47683',
      url: 'http://127.0.0.1:47683',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --strictPort --port 47684',
      url: 'http://127.0.0.1:47684',
      reuseExistingServer: false,
      env: {
        VITE_SYNC_URL: 'https://horas-test.workers.dev',
      },
    },
    {
      command: 'npm run preview -- --base /horas/ --outDir dist-pages --strictPort --port 47685',
      url: 'http://127.0.0.1:47685/horas/',
      reuseExistingServer: false,
      env: { VITE_BASE: '/horas/' },
    },
  ],
})
