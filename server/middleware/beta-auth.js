import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  HttpError,
  createFixedWindowRateLimiter,
  getClientId,
  markErrorCode,
  sendApiError,
} from '../http/common.js';

export const BETA_COOKIE_NAME = 'anison_beta_session';
export const BETA_SESSION_SECONDS = 12 * 60 * 60;

export function resolveBetaAuthConfig(options = {}) {
  const username = options.username ?? process.env.BETA_AUTH_USERNAME ?? '';
  const password = options.password ?? process.env.BETA_AUTH_PASSWORD ?? '';
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('BETA_AUTH_USERNAME 与 BETA_AUTH_PASSWORD 必须同时配置或同时留空');
  }
  return {
    enabled: Boolean(username && password),
    username: String(username),
    password: String(password),
  };
}

export function createBetaAuthMiddleware(options = {}) {
  const config = resolveBetaAuthConfig(options);
  if (!config.enabled) return function betaAuthDisabled(_request, _response, next) { next(); };

  const now = options.now || Date.now;
  const randomToken = options.randomToken || (() => randomBytes(32).toString('base64url'));
  const secureCookie = options.secureCookie ?? (options.nodeEnv || process.env.NODE_ENV) === 'production';
  const sessions = new Map();
  const failedAttemptLimiter = options.failedAttemptLimiter || createFixedWindowRateLimiter({
    limit: 10,
    windowMs: 10 * 60 * 1000,
    maxClients: 1000,
    now,
  });

  return function betaAuthMiddleware(request, response, next) {
    if (new URL(request.url || '/', 'http://anison.local').pathname === '/healthz') {
      next();
      return;
    }

    pruneSessions(sessions, now());
    const cookieToken = parseCookies(request.headers.cookie)[BETA_COOKIE_NAME];
    if (cookieToken && hasValidSession(sessions, cookieToken, now())) {
      next();
      return;
    }

    const credentials = parseBasicAuthorization(request.headers.authorization);
    const validCredentials = credentials
      && constantTimeEqual(credentials.username, config.username)
      && constantTimeEqual(credentials.password, config.password);
    if (validCredentials) {
      const token = randomToken();
      sessions.set(token, now() + BETA_SESSION_SECONDS * 1000);
      while (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
      response.setHeader('Set-Cookie', serializeSessionCookie(token, { secure: secureCookie }));
      next();
      return;
    }

    const rate = failedAttemptLimiter.consume(getClientId(request, options));
    if (!rate.allowed) {
      rejectRequest(request, response, new HttpError(
        'BETA_AUTH_RATE_LIMITED',
        '访问验证尝试过多，请稍后重试',
        429,
        true,
        { retryAfter: rate.retryAfter },
      ));
      return;
    }
    rejectRequest(request, response, new HttpError(
      'BETA_AUTH_REQUIRED',
      '此 ANISON Beta 需要访问凭据',
      401,
      false,
    ));
  };
}

function rejectRequest(request, response, error) {
  const pathname = new URL(request.url || '/', 'http://anison.local').pathname;
  if (pathname.startsWith('/api/')) {
    sendApiError(request, response, error);
    return;
  }
  markErrorCode(request, error.code);
  response.statusCode = error.status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('WWW-Authenticate', 'Basic realm="ANISON Beta", charset="UTF-8"');
  if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
  response.end(error.message);
}

function parseBasicAuthorization(value) {
  const authorization = String(value || '');
  const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function parseCookies(value) {
  const cookies = {};
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // 忽略格式错误的 Cookie。
    }
  }
  return cookies;
}

function serializeSessionCookie(token, options = {}) {
  const attributes = [
    `${BETA_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${BETA_SESSION_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

function hasValidSession(sessions, candidate, timestamp) {
  let matched = false;
  for (const [token, expiresAt] of sessions) {
    if (expiresAt > timestamp && constantTimeEqual(candidate, token)) matched = true;
  }
  return matched;
}

function pruneSessions(sessions, timestamp) {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= timestamp) sessions.delete(token);
  }
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

export const __testables__ = {
  parseBasicAuthorization,
  parseCookies,
  serializeSessionCookie,
  hasValidSession,
  constantTimeEqual,
};
