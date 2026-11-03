import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { include: ['astronomy-engine'] },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 750,
    commonjsOptions: { include: [/node_modules/, /vendor\/astronomy-engine/] },
  },
});
