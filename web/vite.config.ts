import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The page model (project cleaning, props schemas, component markup, base CSS) is shared source: the builder canvas renders with the very same code the server uses.
      '@pagemodel': r('../server/src/pagemodel/shared/index.ts'),
      // The allow-list scrubber for error reports is shared source too: one policy for the server and the browser (docs/MONITORING.md).
      '@monitoring-scrub': r('../server/src/monitoring/scrub.ts'),
      zod: r('./node_modules/zod'),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: Object.fromEntries(['/api', '/preview', '/uploads', '/beacon.js'].map((p) => [p, process.env.API_ORIGIN ?? 'http://localhost:3000'])),
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
