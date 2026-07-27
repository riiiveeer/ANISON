import { defineConfig } from 'vite';
import { createNeteaseVitePlugin } from './server/netease/vite-plugin.js';

function createDeepSeekProxy() {
  return {
    target: 'https://api.deepseek.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/deepseek/, ''),
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, request) => {
        const authorization = request.headers.authorization;
        if (authorization) proxyReq.setHeader('Authorization', authorization);
      });
    },
  };
}

export default defineConfig({
  base: './',
  root: '.',
  publicDir: 'public',
  plugins: [createNeteaseVitePlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    open: false,
    proxy: {
      '/api/deepseek': createDeepSeekProxy(),
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api/deepseek': createDeepSeekProxy(),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2015',
  },
});
