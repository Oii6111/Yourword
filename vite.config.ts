import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import contextWordsBackend from './server/api.mjs';

export default defineConfig({
  plugins: [react(), contextWordsBackend()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
  },
});
