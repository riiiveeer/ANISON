import { createNeteasePreviewService } from './service.js';
import {
  createNeteasePreviewMiddleware,
  createPreviewMiddleware,
  createFixedWindowRateLimiter,
  createTokenBucketRateLimiter,
} from './middleware.js';

export function createNeteaseVitePlugin(options = {}) {
  const service = options.service || createNeteasePreviewService(options);
  const middleware = createNeteasePreviewMiddleware(service, {
    ...options,
    trustProxy: false,
    rateLimiter: options.rateLimiter || createFixedWindowRateLimiter({
      limit: 20,
      windowMs: 10 * 60 * 1000,
      maxClients: 1000,
      ...options.rateLimit,
    }),
  });

  return {
    name: 'anison-netease-preview',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export {
  createNeteasePreviewMiddleware,
  createPreviewMiddleware,
  createFixedWindowRateLimiter,
  createTokenBucketRateLimiter,
};
