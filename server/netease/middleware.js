import {
  HttpError,
  createFixedWindowRateLimiter,
  ensureRequestContext,
  getClientId,
  sendApiError,
  sendJson,
  readJsonBody,
  validateBrowserApiRequest,
} from '../http/common.js';

export const NETEASE_API_PATH = '/api/netease/preview';
export const NETEASE_MAX_REQUEST_BYTES = 8 * 1024;
export const NETEASE_MAX_INPUT_LENGTH = 4096;

const PUBLIC_ERROR_CODES = new Set([
  'INVALID_INPUT',
  'UNSUPPORTED_HOST',
  'SONG_NOT_FOUND',
  'ORIGINAL_LYRIC_MISSING',
  'UPSTREAM_BUSY',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_INVALID_RESPONSE',
]);

export function createNeteasePreviewMiddleware(service, options = {}) {
  if (!service || typeof service.preview !== 'function') {
    throw new TypeError('Netease preview service is required');
  }
  const rateLimiter = options.rateLimiter || createFixedWindowRateLimiter({
    limit: 20,
    windowMs: 10 * 60 * 1000,
    maxClients: 1000,
  });

  return async function neteasePreviewMiddleware(request, response, next) {
    const requestUrl = new URL(request.url || '/', 'http://anison.local');
    if (requestUrl.pathname !== NETEASE_API_PATH) {
      next();
      return;
    }

    ensureRequestContext(request, response, options);
    try {
      if (request.method !== 'POST') {
        throw new HttpError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405, false);
      }
      validateBrowserApiRequest(request, options);

      const rate = rateLimiter.consume(getClientId(request, options));
      if (!rate.allowed) {
        throw new HttpError('RATE_LIMITED', '请求过于频繁，请稍后重试', 429, true, {
          retryAfter: rate.retryAfter,
        });
      }

      const body = await readJsonBody(request, { maxBytes: NETEASE_MAX_REQUEST_BYTES });
      validatePreviewBody(body);
      const result = await service.preview(body.input);
      sendJson(response, 200, result);
    } catch (error) {
      sendApiError(request, response, normalizeNeteaseError(error));
    }
  };
}

function validatePreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('INVALID_INPUT', '请求内容格式无效', 400, false);
  }
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== 'input' || typeof body.input !== 'string') {
    throw new HttpError('INVALID_INPUT', '请求只允许包含文本字段 input', 400, false);
  }
  if (!body.input.trim() || body.input.length > NETEASE_MAX_INPUT_LENGTH) {
    throw new HttpError(
      'INVALID_INPUT',
      body.input.length > NETEASE_MAX_INPUT_LENGTH ? '分享内容过长，请只保留歌曲链接' : '请输入网易云歌曲链接、分享文本或歌曲 ID',
      400,
      false,
    );
  }
}

function normalizeNeteaseError(error) {
  if (error instanceof HttpError) return error;
  if (PUBLIC_ERROR_CODES.has(error?.code)) {
    if (error.code === 'UPSTREAM_BUSY') error.retryAfter ||= 5;
    return error;
  }
  return new HttpError('UPSTREAM_INVALID_RESPONSE', '解析网易云歌曲失败，请稍后重试', 502, true);
}

export const createPreviewMiddleware = createNeteasePreviewMiddleware;
export { createFixedWindowRateLimiter };
// 兼容旧测试和扩展代码；默认实现已经改为固定时间窗。
export const createTokenBucketRateLimiter = createFixedWindowRateLimiter;

export const __testables__ = {
  validatePreviewBody,
  normalizeNeteaseError,
  PUBLIC_ERROR_CODES,
};
