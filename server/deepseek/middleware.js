import {
  HttpError,
  createFixedWindowRateLimiter,
  ensureRequestContext,
  getClientId,
  readJsonBody,
  readResponseBodyLimited,
  sendApiError,
  sendJson,
  validateBrowserApiRequest,
} from '../http/common.js';
import {
  DEEPSEEK_API_PATH,
  DEEPSEEK_UPSTREAM_URL,
  SUPPORTED_DEEPSEEK_MODELS,
} from '../../shared/deepseek-config.js';

export const DEEPSEEK_MAX_REQUEST_BYTES = 64 * 1024;
export const DEEPSEEK_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEEPSEEK_TIMEOUT_MS = 45_000;

const ALLOWED_FIELDS = new Set(['model', 'messages', 'thinking', 'temperature', 'max_tokens']);

export function createDeepSeekMiddleware(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('DeepSeek fetch implementation is required');
  const rateLimiter = options.rateLimiter || createFixedWindowRateLimiter({
    limit: 60,
    windowMs: 10 * 60 * 1000,
    maxClients: 1000,
  });
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_TIMEOUT_MS;
  const upstreamUrl = options.upstreamUrl || DEEPSEEK_UPSTREAM_URL;

  return async function deepSeekMiddleware(request, response, next) {
    const requestUrl = new URL(request.url || '/', 'http://anison.local');
    if (requestUrl.pathname !== DEEPSEEK_API_PATH) {
      next();
      return;
    }

    ensureRequestContext(request, response, options);
    let disconnected = false;
    let timedOut = false;
    const upstreamController = new AbortController();
    const onRequestAborted = () => {
      disconnected = true;
      upstreamController.abort();
    };
    const onResponseClose = () => {
      if (!response.writableEnded) {
        disconnected = true;
        upstreamController.abort();
      }
    };
    request.once('aborted', onRequestAborted);
    response.once('close', onResponseClose);

    try {
      if (request.method !== 'POST') {
        throw new HttpError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405, false);
      }
      validateBrowserApiRequest(request, options);
      const authorization = validateAuthorization(request.headers.authorization);

      const rate = rateLimiter.consume(getClientId(request, options));
      if (!rate.allowed) {
        throw new HttpError('RATE_LIMITED', 'AI 请求过于频繁，请稍后重试', 429, true, {
          retryAfter: rate.retryAfter,
        });
      }

      const requestBody = validateDeepSeekBody(await readJsonBody(request, {
        maxBytes: DEEPSEEK_MAX_REQUEST_BYTES,
      }));

      const timeout = setTimeout(() => {
        timedOut = true;
        upstreamController.abort();
      }, timeoutMs);
      timeout.unref?.();

      let upstreamResponse;
      try {
        upstreamResponse = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: authorization,
          },
          body: JSON.stringify(requestBody),
          redirect: 'error',
          signal: upstreamController.signal,
        });
        if (!upstreamResponse.ok) throw mapDeepSeekStatus(upstreamResponse);

        const rawBody = await readResponseBodyLimited(upstreamResponse, DEEPSEEK_MAX_RESPONSE_BYTES);
        let payload;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          throw new HttpError('UPSTREAM_INVALID_RESPONSE', 'DeepSeek 返回了无法解析的数据', 502, true);
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new HttpError('UPSTREAM_INVALID_RESPONSE', 'DeepSeek 返回的数据结构无效', 502, true);
        }
        if (!disconnected) sendJson(response, 200, payload);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (disconnected) return;
      if (timedOut || error?.name === 'TimeoutError') {
        sendApiError(request, response, new HttpError(
          'UPSTREAM_TIMEOUT',
          'DeepSeek 响应超时，请稍后重试',
          504,
          true,
        ));
        return;
      }
      if (error?.name === 'AbortError') {
        sendApiError(request, response, new HttpError(
          'UPSTREAM_UNAVAILABLE',
          '暂时无法连接 DeepSeek，请稍后重试',
          502,
          true,
        ));
        return;
      }
      sendApiError(request, response, normalizeDeepSeekError(error));
    } finally {
      request.off('aborted', onRequestAborted);
      response.off('close', onResponseClose);
    }
  };
}

export function validateDeepSeekBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('INVALID_REQUEST', 'AI 请求内容格式无效', 400, false);
  }
  const unknownField = Object.keys(body).find(field => !ALLOWED_FIELDS.has(field));
  if (unknownField) {
    throw new HttpError('UNKNOWN_FIELD', `AI 请求包含不支持的字段：${unknownField}`, 400, false);
  }
  if (!SUPPORTED_DEEPSEEK_MODELS.includes(body.model)) {
    throw new HttpError('INVALID_MODEL', '当前 AI 模型不受支持，请在设置中重新选择', 400, false);
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    throw new HttpError('INVALID_MESSAGES', 'messages 必须只包含一条用户消息', 400, false);
  }
  const [message] = body.messages;
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some(field => !['role', 'content'].includes(field))
    || message.role !== 'user'
    || typeof message.content !== 'string'
    || !message.content.trim()) {
    throw new HttpError('INVALID_MESSAGES', 'messages 必须是一条非空的 user 消息', 400, false);
  }
  if (body.thinking !== undefined && (
    !body.thinking
    || typeof body.thinking !== 'object'
    || Array.isArray(body.thinking)
    || Object.keys(body.thinking).length !== 1
    || body.thinking.type !== 'disabled'
  )) {
    throw new HttpError('INVALID_THINKING', 'thinking 只允许设为 disabled', 400, false);
  }
  if (body.temperature !== undefined && (
    typeof body.temperature !== 'number'
    || !Number.isFinite(body.temperature)
    || body.temperature < 0
    || body.temperature > 2
  )) {
    throw new HttpError('INVALID_TEMPERATURE', 'temperature 必须在 0 到 2 之间', 400, false);
  }
  if (body.max_tokens !== undefined && (
    !Number.isInteger(body.max_tokens)
    || body.max_tokens < 1
    || body.max_tokens > 800
  )) {
    throw new HttpError('INVALID_MAX_TOKENS', 'max_tokens 必须是 1 到 800 的整数', 400, false);
  }

  return {
    model: body.model,
    messages: [{ role: 'user', content: message.content }],
    thinking: body.thinking || { type: 'disabled' },
    temperature: body.temperature ?? 0.3,
    max_tokens: body.max_tokens ?? 800,
  };
}

function validateAuthorization(value) {
  const authorization = String(value || '');
  if (!/^Bearer [^\s]+$/.test(authorization)) {
    throw new HttpError('DEEPSEEK_AUTH_REQUIRED', '请先设置有效的 DeepSeek API Key', 401, false);
  }
  return authorization;
}

function mapDeepSeekStatus(response) {
  if (response.status === 401 || response.status === 403) {
    return new HttpError('DEEPSEEK_UNAUTHORIZED', 'DeepSeek API Key 无效或已过期', 401, false);
  }
  if (response.status === 429) {
    return new HttpError('DEEPSEEK_RATE_LIMITED', 'DeepSeek 请求过于频繁，请稍后重试', 429, true, {
      retryAfter: parseRetryAfter(response.headers?.get?.('retry-after')),
    });
  }
  if (response.status >= 500) {
    return new HttpError('UPSTREAM_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后重试', 502, true);
  }
  return new HttpError('UPSTREAM_INVALID_RESPONSE', 'DeepSeek 拒绝了当前请求', 502, false);
}

function normalizeDeepSeekError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError('UPSTREAM_UNAVAILABLE', '暂时无法连接 DeepSeek，请稍后重试', 502, true);
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 30;
}

export const __testables__ = {
  ALLOWED_FIELDS,
  validateAuthorization,
  mapDeepSeekStatus,
  parseRetryAfter,
};
