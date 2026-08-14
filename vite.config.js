import { defineConfig } from 'vite';
import { createPwaBuildPlugin } from './server/build/pwa-plugin.js';
import { createDeepSeekVitePlugin } from './server/deepseek/vite-plugin.js';
import { createNeteaseVitePlugin } from './server/netease/vite-plugin.js';

export default defineConfig({
  base: './',
  root: '.',
  publicDir: 'public',
  plugins: [createNeteaseVitePlugin(), createDeepSeekVitePlugin(), createPwaBuildPlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    open: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2015',
  },
});
