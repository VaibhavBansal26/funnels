import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The page block model (schema, sanitiser, deterministic renderer) is shared source: the builder canvas renders with the very same code the server uses.
      '@blocks': r('../server/src/blocks/index.ts'),
      zod: r('./node_modules/zod'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/preview': 'http://localhost:3000', '/beacon.js': 'http://localhost:3000' },
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
