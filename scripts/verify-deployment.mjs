import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_COLD_START_TIMEOUT_MS = 90_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const REVALIDATE_CACHE = 'no-cache';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export class DeploymentVerificationError extends Error {
  constructor(message, code = 'DEPLOYMENT_VERIFICATION_FAILED') {
    super(message);
    this.name = 'DeploymentVerificationError';
    this.code = code;
  }
}

export async function verifyDeployment(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = options.log || (() => {});
  const username = String(options.username || '');
  const password = String(options.password || '');
  const expectedCsp = normalizeExpectedCsp(options.expectedCsp);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const coldStartTimeoutMs = positiveInteger(options.coldStartTimeoutMs, DEFAULT_COLD_START_TIMEOUT_MS);

  if (typeof fetchImpl !== 'function') {
    throw new DeploymentVerificationError('当前 Node.js 运行时不支持 fetch');
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new DeploymentVerificationError('Beta 用户名和密码必须同时提供');
  }

  const requester = createRequester({ baseUrl, fetchImpl, requestTimeoutMs });
  const health = await runCheck(log, '冷启动与公开健康检查', async () => {
    const initial = await waitForHealth(requester, coldStartTimeoutMs);
    assertHeader(initial.response, 'cache-control', 'no-store', '/healthz');
    const warmStartedAt = Date.now();
    const warmResponse = await requester('/healthz');
    const warmElapsedMs = Date.now() - warmStartedAt;
    assertStatus(warmResponse, 200, '/healthz warm request');
    if (warmElapsedMs > requestTimeoutMs) {
      throw new DeploymentVerificationError(`唤醒后的 /healthz 超过 ${requestTimeoutMs}ms`);
    }
    const payload = await readJson(warmResponse, '/healthz');
    assertHealthPayload(payload);
    assertExpectedMetadata(payload, options);
    return { ...payload, coldStartMs: initial.elapsedMs, warmHealthMs: warmElapsedMs };
  });

  await runCheck(log, '未认证请求被 Beta 门禁拒绝', async () => {
    const response = await requester('/');
    assertStatus(response, 401, 'unauthenticated /');
    assertHeader(response, 'cache-control', 'no-store', 'unauthenticated /');
    if (!/Basic realm="ANISON Beta"/.test(response.headers.get('www-authenticate') || '')) {
      throw new DeploymentVerificationError('未认证首页缺少 ANISON Beta Basic challenge');
    }
  });

  if (!username) {
    log('ℹ 未提供 Beta 凭据；已完成公开健康检查和 401 边界验证');
    return { baseUrl: baseUrl.origin, health, scope: 'public-only' };
  }

  const session = await runCheck(log, 'Beta 登录与会话 Cookie', async () => {
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const response = await requester('/', { headers: { Authorization: authorization } });
    assertStatus(response, 200, 'authenticated /');
    const setCookie = response.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0];
    if (!/^anison_beta_session=[A-Za-z0-9_-]+$/.test(cookie)) {
      throw new DeploymentVerificationError('认证成功后未收到有效的 Beta 会话 Cookie');
    }
    return { cookie, response, html: await response.text() };
  });

  await runCheck(log, '首页缓存与安全响应头', async () => {
    assertHeader(session.response, 'cache-control', REVALIDATE_CACHE, '/');
    assertHeader(session.response, 'x-content-type-options', 'nosniff', '/');
    assertHeader(session.response, 'x-frame-options', 'DENY', '/');
    assertHeader(session.response, 'referrer-policy', 'strict-origin-when-cross-origin', '/');
    assertHeader(session.response, 'permissions-policy', 'camera=(), microphone=(), geolocation=()', '/');
    if (baseUrl.protocol === 'https:') {
      assertHeader(session.response, 'strict-transport-security', 'max-age=15552000', '/');
    }
    assertCsp(session.response, expectedCsp);
    if (!/ANISON/i.test(session.html)) {
      throw new DeploymentVerificationError('认证后的首页不包含 ANISON 标识');
    }
  });

  const cookieHeaders = { Cookie: session.cookie };
  const workerMetadata = await runCheck(log, 'manifest、Service Worker 与安装图标', async () => {
    const manifest = await requester('/manifest.webmanifest', { headers: cookieHeaders });
    assertStatus(manifest, 200, '/manifest.webmanifest');
    assertHeader(manifest, 'cache-control', REVALIDATE_CACHE, '/manifest.webmanifest');
    assertMime(manifest, /application\/(?:manifest\+json|json)/i, '/manifest.webmanifest');
    await readJson(manifest, '/manifest.webmanifest');

    const worker = await requester('/sw.js', { headers: cookieHeaders });
    assertStatus(worker, 200, '/sw.js');
    assertHeader(worker, 'cache-control', REVALIDATE_CACHE, '/sw.js');
    assertHeader(worker, 'service-worker-allowed', '/', '/sw.js');
    assertMime(worker, /javascript/i, '/sw.js');
    const workerSource = await worker.text();
    const metadata = parseWorkerMetadata(workerSource);
    assertWorkerMetadata(metadata, health);

    for (const iconPath of [
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
      '/icons/apple-touch-icon.png',
    ]) {
      const icon = await requester(iconPath, { headers: cookieHeaders });
      assertStatus(icon, 200, iconPath);
      assertHeader(icon, 'cache-control', REVALIDATE_CACHE, iconPath);
      assertMime(icon, /image\/png/i, iconPath);
      await icon.arrayBuffer();
    }
    return metadata;
  });

  await runCheck(log, '哈希资源 MIME、缓存和构建元数据', async () => {
    const assetPaths = extractAssetPaths(session.html);
    if (!assetPaths.some(value => value.endsWith('.js')) || !assetPaths.some(value => value.endsWith('.css'))) {
      throw new DeploymentVerificationError('首页没有同时引用哈希 JavaScript 和 CSS 资源');
    }
    let metadataFound = false;
    for (const assetPath of assetPaths) {
      const asset = await requester(assetPath, { headers: cookieHeaders });
      assertStatus(asset, 200, assetPath);
      assertHeader(asset, 'cache-control', IMMUTABLE_CACHE, assetPath);
      assertMime(asset, assetPath.endsWith('.js') ? /javascript/i : /text\/css/i, assetPath);
      const source = await asset.text();
      if (assetPath.endsWith('.js') && source.includes(health.version) && source.includes(health.commit)) {
        metadataFound = true;
      }
    }
    if (!metadataFound) {
      throw new DeploymentVerificationError('哈希 JavaScript 中的版本或提交号与 /healthz 不一致');
    }
  });

  await runCheck(log, '未知 API 保持 JSON Network Only 边界', async () => {
    const response = await requester('/api/not-found', { headers: cookieHeaders });
    assertStatus(response, 404, '/api/not-found');
    assertHeader(response, 'cache-control', 'no-store', '/api/not-found');
    assertMime(response, /application\/json/i, '/api/not-found');
    const payload = await readJson(response, '/api/not-found');
    if (payload?.error?.code !== 'API_NOT_FOUND') {
      throw new DeploymentVerificationError('/api/not-found 未返回 API_NOT_FOUND');
    }
  });

  return {
    baseUrl: baseUrl.origin,
    health,
    buildId: workerMetadata.buildId,
    csp: expectedCsp,
    scope: 'full',
  };
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new DeploymentVerificationError('必须提供有效的部署基址');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new DeploymentVerificationError('部署基址只能包含协议、主机和端口');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new DeploymentVerificationError('远程部署必须使用 HTTPS；HTTP 仅允许 loopback');
  }
  return new URL(url.origin);
}

function createRequester({ baseUrl, fetchImpl, requestTimeoutMs }) {
  return async function request(pathname, init = {}, timeoutMs = requestTimeoutMs) {
    const target = new URL(pathname, baseUrl);
    if (target.origin !== baseUrl.origin) {
      throw new DeploymentVerificationError('拒绝向部署 Origin 以外发送请求');
    }
    let response;
    try {
      response = await fetchImpl(target, {
        ...init,
        headers: { Accept: '*/*', ...(init.headers || {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DeploymentVerificationError(`${target.pathname} 请求失败：${safeErrorMessage(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DeploymentVerificationError(`${target.pathname} 意外返回重定向 ${response.status}`);
    }
    return response;
  };
}

async function waitForHealth(requester, timeoutMs) {
  const startedAt = Date.now();
  let lastMessage = '尚未收到响应';
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    try {
      const response = await requester('/healthz', {}, Math.min(15_000, Math.max(1, remaining)));
      if (response.status === 200) {
        const payload = await readJson(response, '/healthz');
        assertHealthPayload(payload);
        return { response, payload, elapsedMs: Date.now() - startedAt };
      }
      lastMessage = `HTTP ${response.status}`;
    } catch (error) {
      lastMessage = safeErrorMessage(error);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(0, remaining))));
  }
  throw new DeploymentVerificationError(`/healthz 未在 ${timeoutMs}ms 内就绪：${lastMessage}`);
}

async function runCheck(log, label, operation) {
  const result = await operation();
  log(`✓ ${label}`);
  return result;
}

function assertHealthPayload(payload) {
  if (payload?.ok !== true || typeof payload.version !== 'string' || typeof payload.commit !== 'string') {
    throw new DeploymentVerificationError('/healthz 响应缺少 ok、version 或 commit');
  }
}

function assertExpectedMetadata(health, options) {
  if (options.expectedVersion && health.version !== String(options.expectedVersion)) {
    throw new DeploymentVerificationError(`/healthz 版本不符：期望 ${options.expectedVersion}，实际 ${health.version}`);
  }
  if (options.expectedCommit && health.commit !== String(options.expectedCommit)) {
    throw new DeploymentVerificationError('/healthz 提交号与预期不符');
  }
}

function assertWorkerMetadata(metadata, health) {
  if (metadata.version !== health.version || metadata.commit !== health.commit) {
    throw new DeploymentVerificationError('Service Worker 与 /healthz 的版本或提交号不一致');
  }
  const shortCommit = health.commit === 'local' ? 'local' : health.commit.slice(0, 12);
  if (!metadata.buildId.startsWith(`${health.version}+${shortCommit}+`)) {
    throw new DeploymentVerificationError('Service Worker BUILD_ID 与版本/提交号不一致');
  }
}

function parseWorkerMetadata(source) {
  return {
    buildId: readWorkerConstant(source, 'BUILD_ID'),
    version: readWorkerConstant(source, 'APP_VERSION'),
    commit: readWorkerConstant(source, 'APP_COMMIT'),
  };
}

function readWorkerConstant(source, name) {
  const match = String(source).match(new RegExp(`^const ${name} = (.+);$`, 'm'));
  if (!match) throw new DeploymentVerificationError(`Service Worker 缺少 ${name}`);
  try {
    const value = JSON.parse(match[1]);
    if (typeof value !== 'string' || !value) throw new Error('not a string');
    return value;
  } catch {
    throw new DeploymentVerificationError(`Service Worker 的 ${name} 无效`);
  }
}

function extractAssetPaths(html) {
  const paths = [];
  const pattern = /["'](\/assets\/[^"'?#]+\.(?:js|css))["']/g;
  for (const match of String(html).matchAll(pattern)) {
    if (!paths.includes(match[1])) paths.push(match[1]);
  }
  return paths;
}

function assertCsp(response, expectedCsp) {
  const enforce = response.headers.get('content-security-policy');
  const reportOnly = response.headers.get('content-security-policy-report-only');
  if (expectedCsp === 'enforce' && (!enforce || reportOnly)) {
    throw new DeploymentVerificationError('CSP 不是预期的 enforce 模式');
  }
  if (expectedCsp === 'report-only' && (!reportOnly || enforce)) {
    throw new DeploymentVerificationError('CSP 不是预期的 report-only 模式');
  }
  const active = expectedCsp === 'enforce' ? enforce : reportOnly;
  if (!/default-src 'self'/.test(active || '') || !/connect-src 'self'/.test(active || '')) {
    throw new DeploymentVerificationError('CSP 缺少预期的 default-src/connect-src 边界');
  }
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new DeploymentVerificationError(`${label} 状态码应为 ${expected}，实际为 ${response.status}`);
  }
}

function assertHeader(response, name, expected, label) {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new DeploymentVerificationError(`${label} 的 ${name} 应为 ${expected}，实际为 ${actual || '<missing>'}`);
  }
}

function assertMime(response, expected, label) {
  const actual = response.headers.get('content-type') || '';
  if (!expected.test(actual)) {
    throw new DeploymentVerificationError(`${label} 的 Content-Type 不符合预期`);
  }
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new DeploymentVerificationError(`${label} 没有返回有效 JSON`);
  }
}

function normalizeExpectedCsp(value) {
  const mode = String(value || 'report-only').trim().toLowerCase();
  if (!['report-only', 'enforce'].includes(mode)) {
    throw new DeploymentVerificationError('ANISON_EXPECTED_CSP 必须是 report-only 或 enforce');
  }
  return mode;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new DeploymentVerificationError('超时参数必须是正整数');
  }
  return number;
}

function safeErrorMessage(error) {
  return String(error?.message || error?.code || '未知错误').replace(/[\r\n]+/g, ' ').slice(0, 240);
}

async function main() {
  const baseUrl = process.argv[2] || process.env.ANISON_DEPLOYMENT_URL;
  const report = await verifyDeployment({
    baseUrl,
    username: process.env.BETA_AUTH_USERNAME,
    password: process.env.BETA_AUTH_PASSWORD,
    expectedVersion: process.env.ANISON_EXPECTED_VERSION,
    expectedCommit: process.env.ANISON_EXPECTED_COMMIT,
    expectedCsp: process.env.ANISON_EXPECTED_CSP,
    log: line => console.log(line),
  });
  console.log(`✓ 部署验证完成：${report.baseUrl}`);
  console.log(`  版本 ${report.health.version} · 提交 ${report.health.commit.slice(0, 12)} · 范围 ${report.scope}`);
  if (report.buildId) console.log(`  BUILD_ID ${report.buildId}`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch(error => {
    console.error(`✗ 部署验证失败：${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

export const __testables__ = {
  extractAssetPaths,
  normalizeExpectedCsp,
  parseWorkerMetadata,
};
