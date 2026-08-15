import { createFixedWindowRateLimiter } from '../http/common.js';
import { createDeepSeekMiddleware } from './middleware.js';

export function createDeepSeekVitePlugin(options = {}) {
  const middleware = createDeepSeekMiddleware({
    ...options,
    trustProxy: false,
    rateLimiter: options.rateLimiter || createFixedWindowRateLimiter({
      limit: 60,
      windowMs: 10 * 60 * 1000,
      maxClients: 1000,
      ...options.rateLimit,
    }),
  });
  return {
    name: 'anison-deepseek-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
