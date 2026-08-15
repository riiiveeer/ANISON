import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createDeepSeekMiddleware } from './deepseek/middleware.js';
import {
  HttpError,
  createRequestContextMiddleware,
  sendApiError,
} from './http/common.js';
import { createBetaAuthMiddleware } from './middleware/beta-auth.js';
import {
  createCompressionMiddleware,
  createSecurityMiddleware,
} from './middleware/security.js';
import { createNeteasePreviewMiddleware } from './netease/middleware.js';
import { createNeteasePreviewService } from './netease/service.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultDistDirectory = path.resolve(serverDirectory, '../dist');

const IMMUTABLE_ASSET_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

export function createApp(options = {}) {
  const app = express();
  const distDirectory = path.resolve(options.distDirectory || defaultDistDirectory);
  const version = String(options.version || packageMetadata.version || 'unknown');
  const commit = String(options.commit || process.env.RENDER_GIT_COMMIT || process.env.APP_COMMIT_SHA || 'local');
  const logger = options.logger === undefined ? console.log : options.logger;

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(createRequestContextMiddleware({
    logger,
    now: options.now,
    requestIdFactory: options.requestIdFactory,
  }));
  app.use(createCompressionMiddleware(options.compression));
  app.use(createSecurityMiddleware({
    cspMode: options.cspMode,
    nodeEnv: options.nodeEnv,
  }));
  app.use(createBetaAuthMiddleware({
    username: options.betaAuthUsername,
    password: options.betaAuthPassword,
    secureCookie: options.secureCookie,
    nodeEnv: options.nodeEnv,
    now: options.now,
    randomToken: options.randomToken,
    failedAttemptLimiter: options.betaAuthRateLimiter,
    trustProxy: true,
  }));

  app.get('/healthz', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, version, commit });
  });

  const neteaseService = options.neteaseService || createNeteasePreviewService({
    ...(options.neteaseOptions || {}),
    fetchImpl: options.neteaseFetch || options.neteaseOptions?.fetchImpl,
  });
  app.use(createNeteasePreviewMiddleware(neteaseService, {
    trustProxy: true,
    rateLimiter: options.neteaseRateLimiter,
    logger,
    now: options.now,
    requestIdFactory: options.requestIdFactory,
  }));
  app.use(createDeepSeekMiddleware({
    trustProxy: true,
    fetchImpl: options.deepSeekFetch,
    rateLimiter: options.deepSeekRateLimiter,
    timeoutMs: options.deepSeekTimeoutMs,
    upstreamUrl: options.deepSeekUpstreamUrl,
    logger,
    now: options.now,
    requestIdFactory: options.requestIdFactory,
  }));

  app.use('/assets', express.static(path.join(distDirectory, 'assets'), {
    index: false,
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
    setHeaders(response) {
      response.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE);
    },
  }));

  app.use(express.static(distDirectory, {
    index: false,
    fallthrough: true,
    maxAge: 0,
    setHeaders(response, filePath) {
      response.setHeader('Cache-Control', REVALIDATE_CACHE);
      if (path.basename(filePath) === 'sw.js') {
        response.setHeader('Service-Worker-Allowed', '/');
      }
    },
  }));

  app.get(['/', '/index.html'], (_request, response, next) => {
    response.setHeader('Cache-Control', REVALIDATE_CACHE);
    response.sendFile(path.join(distDirectory, 'index.html'), error => {
      if (error) next(error);
    });
  });

  app.use('/api', (request, response) => {
    sendApiError(request, response, new HttpError(
      'API_NOT_FOUND',
      '接口不存在',
      404,
      false,
    ));
  });

  app.use((_request, response) => {
    response.status(404).type('text/plain').send('Not Found');
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    sendApiError(request, response, new HttpError(
      error?.status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      error?.status === 404 ? '资源不存在' : '服务器暂时无法处理请求',
      error?.status === 404 ? 404 : 500,
      error?.status !== 404,
    ));
  });

  return app;
}

export const __testables__ = {
  defaultDistDirectory,
  IMMUTABLE_ASSET_CACHE,
  REVALIDATE_CACHE,
};
