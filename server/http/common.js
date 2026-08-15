import { randomUUID } from 'node:crypto';

export const API_REQUEST_HEADER = 'x-anison-request';
export const API_REQUEST_HEADER_VALUE = '1';

const REQUEST_CONTEXT = Symbol('anisonRequestContext');

export class HttpError extends Error {
  constructor(code, message, status = 400, retryable = false, options = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = options.retryAfter;
  }
}

export function createRequestContextMiddleware(options = {}) {
  return function requestContextMiddleware(request, response, next) {
    ensureRequestContext(request, response, options);
    next();
  };
}

export function ensureRequestContext(request, response, options = {}) {
  if (request[REQUEST_CONTEXT]) return request[REQUEST_CONTEXT];

  const now = options.now || Date.now;
  const context = {
    requestId: String((options.requestIdFactory || randomUUID)()),
    startedAt: now(),
    errorCode: '',
  };
  request[REQUEST_CONTEXT] = context;
  response.setHeader('X-Request-Id', context.requestId);

  const logger = options.logger === undefined ? console.log : options.logger;
  if (typeof logger === 'function') {
    response.once('finish', () => {
      const pathname = safePathname(request.originalUrl || request.url);
      logger(JSON.stringify({
        requestId: context.requestId,
        method: String(request.method || ''),
        path: pathname,
        status: response.statusCode,
        durationMs: Math.max(0, now() - context.startedAt),
        errorCode: context.errorCode,
      }));
    });
  }
  return context;
}

export function getRequestContext(request) {
  return request[REQUEST_CONTEXT] || null;
}

export function markErrorCode(request, code) {
  const context = getRequestContext(request);
  if (context) context.errorCode = String(code || '');
}

export function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

export function sendApiError(request, response, error, fallback = {}) {
  const status = normalizeStatus(error?.status, fallback.status || 500);
  const code = String(error?.code || fallback.code || 'INTERNAL_ERROR');
  const message = String(error?.message || fallback.message || '服务器暂时无法处理请求');
  const retryable = Boolean(error?.retryable ?? fallback.retryable);
  markErrorCode(request, code);

  const headers = {};
  const retryAfter = Number(error?.retryAfter ?? fallback.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    headers['Retry-After'] = String(Math.ceil(retryAfter));
  }
  sendJson(response, status, {
    ok: false,
    error: { code, message, retryable },
  }, headers);
}

export async function readJsonBody(request, options = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024;
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new HttpError('INVALID_CONTENT_TYPE', '请求内容必须为 JSON', 400, false);
  }

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError('REQUEST_TOO_LARGE', '请求内容过长', 413, false);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError('REQUEST_TOO_LARGE', '请求内容过长', 413, false);
    }
    chunks.push(chunk);
  }

  if (total === 0) throw new HttpError('INVALID_JSON', '请求 JSON 格式无效', 400, false);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError('INVALID_JSON', '请求 JSON 格式无效', 400, false);
  }
}

export function validateBrowserApiRequest(request, options = {}) {
  if (!isSameOriginRequest(request, options)) {
    throw new HttpError('ORIGIN_REJECTED', '请求来源不受信任', 403, false);
  }
  if (String(request.headers[API_REQUEST_HEADER] || '') !== API_REQUEST_HEADER_VALUE) {
    throw new HttpError('CSRF_HEADER_REQUIRED', '请求缺少必要的安全标识', 403, false);
  }
}

export function isSameOriginRequest(request, options = {}) {
  const origin = request.headers.origin;
  if (!origin) return false;

  try {
    const parsedOrigin = new URL(String(origin));
    const protocol = getRequestProtocol(request, options);
    const host = String(request.headers.host || '').trim().toLowerCase();
    return Boolean(host) && parsedOrigin.origin.toLowerCase() === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

export function getRequestProtocol(request, options = {}) {
  if (options.trustProxy && typeof request.protocol === 'string') return request.protocol;
  return request.socket?.encrypted ? 'https' : 'http';
}

export function getClientId(request, options = {}) {
  if (typeof options.clientId === 'function') return String(options.clientId(request) || 'unknown');
  if (options.trustProxy && typeof request.ip === 'string') return request.ip;
  return String(request.socket?.remoteAddress || 'unknown');
}

export function createFixedWindowRateLimiter(options = {}) {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const maxClients = options.maxClients ?? 1000;
  const now = options.now || Date.now;
  const clients = new Map();

  return {
    consume(clientId) {
      const timestamp = now();
      const key = String(clientId || 'unknown');
      let bucket = clients.get(key);
      if (!bucket || timestamp >= bucket.resetAt) {
        bucket = { count: 0, resetAt: timestamp + windowMs, touchedAt: timestamp };
      }
      bucket.count += 1;
      bucket.touchedAt = timestamp;
      clients.delete(key);
      clients.set(key, bucket);
      pruneClientBuckets(clients, timestamp, maxClients);
      return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        retryAfter: bucket.count <= limit ? 0 : Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000)),
      };
    },
    get size() {
      return clients.size;
    },
  };
}

export async function readResponseBodyLimited(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应过大', 502, true);
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new HttpError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应过大', 502, true);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应过大', 502, true);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function pruneClientBuckets(clients, timestamp, maxClients) {
  for (const [key, bucket] of clients) {
    if (timestamp >= bucket.resetAt) clients.delete(key);
  }
  while (clients.size > maxClients) clients.delete(clients.keys().next().value);
}

function safePathname(url) {
  try {
    return new URL(url || '/', 'http://anison.local').pathname;
  } catch {
    return '/';
  }
}

function normalizeStatus(status, fallback) {
  const value = Number(status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : fallback;
}

export const __testables__ = {
  REQUEST_CONTEXT,
  safePathname,
  pruneClientBuckets,
};
