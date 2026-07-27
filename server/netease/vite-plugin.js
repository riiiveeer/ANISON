import { randomUUID } from 'node:crypto';
import { createNeteasePreviewService } from './service.js';

const API_PATH = '/api/netease/preview';
const MAX_REQUEST_BYTES = 8192;

export function createNeteaseVitePlugin(options = {}) {
  const service = options.service || createNeteasePreviewService(options);
  const middleware = createPreviewMiddleware(service);

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

export function createPreviewMiddleware(service) {
  return async function neteasePreviewMiddleware(request, response, next) {
    const requestUrl = new URL(request.url || '/', 'http://anison.local');
    if (requestUrl.pathname !== API_PATH) {
      next();
      return;
    }

    const requestId = randomUUID().slice(0, 8);
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST 请求', retryable: false },
      });
      return;
    }

    if (!isSameOriginRequest(request)) {
      sendJson(response, 403, {
        ok: false,
        error: { code: 'ORIGIN_REJECTED', message: '请求来源不受信任', retryable: false },
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await service.preview(body?.input);
      sendJson(response, 200, result);
    } catch (error) {
      const status = Number(error?.status) || 502;
      const code = error?.code || 'UPSTREAM_INVALID_RESPONSE';
      console.warn(`[netease:${requestId}] ${code}`);
      sendJson(response, status, {
        ok: false,
        error: {
          code,
          message: error instanceof Error ? error.message : '解析网易云歌曲失败',
          retryable: Boolean(error?.retryable),
        },
      });
    }
  };
}

function isSameOriginRequest(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    const error = new Error('请求内容必须为 JSON');
    error.code = 'INVALID_INPUT';
    error.status = 400;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      const error = new Error('请求内容过长');
      error.code = 'INVALID_INPUT';
      error.status = 400;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求 JSON 格式无效');
    error.code = 'INVALID_INPUT';
    error.status = 400;
    throw error;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

export const __testables__ = {
  API_PATH,
  MAX_REQUEST_BYTES,
  isSameOriginRequest,
};
