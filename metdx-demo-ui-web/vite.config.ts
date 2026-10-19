import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The proxy server (server/, built separately) listens on 8551 in dev.
const PROXY_TARGET = process.env.METDX_PROXY_TARGET ?? 'http://localhost:8551';

// Public base path of the build ("/" by default; a sub-path on GitHub Pages).
const BASE = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: PROXY_TARGET, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/ol/') || id.includes('node_modules/rbush/')) return 'vendor-ol';
          if (id.includes('node_modules/@mui/') || id.includes('node_modules/@emotion/')) return 'vendor-mui';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'server/**', 'test/e2e/**'],
    css: false,
  },
});
