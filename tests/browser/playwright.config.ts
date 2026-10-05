import { defineConfig } from '@playwright/test';

const baseURL = process.env.TRIPTAB_LAYOUT_URL || 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Layout tests require a local preview because API responses are fixtures.');
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  use: { baseURL, serviceWorkers: 'block', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: {
      browserName: 'chromium',
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: process.env.TRIPTAB_LAYOUT_URL ? undefined : {
    command: 'npm start -- --port 8787',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
