import { defineConfig, devices } from '@playwright/test';

const SOCKET_PROXY_URL = process.env.SOCKET_IO_PROXY_URL ?? 'https://socket-proxy.local';
const DEV_SERVER_PORT = Number.parseInt(process.env.E2E_DEV_SERVER_PORT ?? '4173', 10);
const LOCAL_LAN_HOST = process.env.E2E_LAN_HOST ?? process.env.ANDROID_PROXY_LAN_IP;
const DEV_SERVER_HOST = process.env.E2E_DEV_SERVER_HOST ?? LOCAL_LAN_HOST ?? '127.0.0.1';
const BASE_URL = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      // Provide Socket.IO proxy host for fetch-based fallbacks.
      'X-Socket-Proxy': SOCKET_PROXY_URL,
    },
  },
  webServer: {
    command: `npm run --prefix example-app start -- --host ${DEV_SERVER_HOST} --port ${DEV_SERVER_PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_SOCKET_PROXY_URL: SOCKET_PROXY_URL,
      VITE_SOCKET_PROXY_URL_ANDROID: SOCKET_PROXY_URL,
      VITE_SOCKET_PROXY_URL_IOS: SOCKET_PROXY_URL,
      VITE_SOCKET_PROXY_URL_WEB: SOCKET_PROXY_URL,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
