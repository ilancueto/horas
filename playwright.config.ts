import { defineConfig, devices } from '@playwright/test'

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
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'celular',
      testIgnore: '**/sync.e2e.ts',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
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
  ],
})
