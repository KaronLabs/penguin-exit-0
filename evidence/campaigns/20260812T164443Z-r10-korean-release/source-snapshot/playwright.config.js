import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  globalSetup: './tests/browser/global-setup.mjs',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      // 3-engine functional tests: exclude @performance (CDP is Chromium-only)
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      grep: /^(?!.*@performance)/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /^(?!.*@performance)/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      grep: /^(?!.*@performance)/,
    },
    {
      // CDP HeapProfiler is Chromium-only. Performance spec MUST NOT run on Firefox/WebKit.
      name: 'chromium-perf',
      use: { ...devices['Desktop Chrome'] },
      grep: /@performance/,
    },
  ],
});
