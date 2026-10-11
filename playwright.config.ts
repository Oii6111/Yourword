import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: 'npm run dev -- --port 5175',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    env: { CONTEXT_WORDS_DATA_DIR: path.join(os.tmpdir(), `context-words-e2e-${process.pid}`) },
  },
});
