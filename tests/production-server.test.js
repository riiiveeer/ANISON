import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { startServer } from '../server/index.js';
import { closeServer } from '../server/lifecycle.js';

async function withProductionServer(operation, appOptions = {}) {
  const distDirectory = await mkdtemp(path.join(os.tmpdir(), 'anison-server-'));
  await mkdir(path.join(distDirectory, 'assets'));
  await mkdir(path.join(distDirectory, 'icons'));
  await writeFile(path.join(distDirectory, 'index.html'), '<!doctype html><title>ANISON</title>');
  await writeFile(path.join(distDirectory, 'manifest.webmanifest'), '{"name":"ANISON"}');
  await writeFile(path.join(distDirectory, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  await writeFile(path.join(distDirectory, 'icons', 'icon-192.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(path.join(distDirectory, 'assets', 'app-123.js'), 'console.log("ANISON")');

  const app = createApp({
    distDirectory,
    version: 'test-version',
    commit: 'test-commit',
    logger: null,
    betaAuthUsername: '',
    betaAuthPassword: '',
    ...appOptions,
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(distDirectory, { recursive: true, force: true });
  }
}

test('生产服务器：健康检查返回版本和提交信息', async () => {
  await withProductionServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      ok: true,
      version: 'test-version',
      commit: 'test-commit',
    });
  });
});

test('生产服务器：同一端口提供首页和正确的静态缓存策略', async () => {
  await withProductionServer(async baseUrl => {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ANISON/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');

    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');

    const worker = await fetch(`${baseUrl}/sw.js`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    assert.equal(worker.headers.get('service-worker-allowed'), '/');
    assert.match(worker.headers.get('content-type'), /javascript/);

    const icon = await fetch(`${baseUrl}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/png/);

    const asset = await fetch(`${baseUrl}/assets/app-123.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});

test('生产服务器：未知 API 不会回退到首页', async () => {
  await withProductionServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'API_NOT_FOUND');
  });
});

test('生产服务器：关闭控制器停止接受新请求', async () => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);

  await closeServer(server, { timeoutMs: 1000 });
  assert.equal(server.listening, false);
});

test('生产服务器：正式入口从构建目录启动完整服务', async () => {
  const distDirectory = await mkdtemp(path.join(os.tmpdir(), 'anison-entry-'));
  await writeFile(path.join(distDirectory, 'index.html'), '<!doctype html><title>ANISON entry</title>');
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    distDirectory,
    appOptions: { logger: null, betaAuthUsername: '', betaAuthPassword: '' },
  });
  const { port } = server.address();

  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ANISON entry/);
  } finally {
    await closeServer(server, { timeoutMs: 1000 });
    await rm(distDirectory, { recursive: true, force: true });
  }
});

test('生产服务器：提供安全响应头、两种 CSP 模式和 HTTPS HSTS', async () => {
  await withProductionServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.ok(response.headers.get('content-security-policy-report-only'));
    assert.match(response.headers.get('content-security-policy-report-only'), /connect-src 'self'/);
    assert.match(response.headers.get('content-security-policy-report-only'), /https:\/\/\*\.music\.126\.net/);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=15552000');
  }, { nodeEnv: 'production', cspMode: 'report-only' });

  await withProductionServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/`);
    assert.ok(response.headers.get('content-security-policy'));
    assert.equal(response.headers.get('content-security-policy-report-only'), null);
    assert.equal(response.headers.get('strict-transport-security'), null);
  }, { nodeEnv: 'production', cspMode: 'enforce' });
});

test('Beta 门禁：配置必须成对出现且健康检查始终免鉴权', async () => {
  assert.throws(
    () => createApp({ betaAuthUsername: 'friend', betaAuthPassword: '' }),
    /必须同时配置/,
  );
  await withProductionServer(async baseUrl => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const protectedHome = await fetch(`${baseUrl}/`);
    assert.equal(protectedHome.status, 401);
    assert.match(protectedHome.headers.get('www-authenticate'), /Basic realm="ANISON Beta"/);
  }, { betaAuthUsername: 'friend', betaAuthPassword: 'correct horse' });
});

test('Beta 门禁：Basic 换取 12 小时 Cookie，并与 DeepSeek Bearer 共存', async () => {
  let authorization = '';
  await withProductionServer(async baseUrl => {
    const wrong = await fetch(`${baseUrl}/`, {
      headers: { Authorization: `Basic ${Buffer.from('friend:wrong').toString('base64')}` },
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${baseUrl}/`, {
      headers: { Authorization: `Basic ${Buffer.from('friend:correct horse').toString('base64')}` },
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /anison_beta_session=/);
    assert.match(setCookie, /Max-Age=43200/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';', 1)[0];

    const api = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Cookie: cookie,
        Authorization: 'Bearer user-key-only',
        'Content-Type': 'application/json',
        'X-ANISON-Request': '1',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'secret prompt' }],
        thinking: { type: 'disabled' },
        temperature: 0.3,
        max_tokens: 800,
      }),
    });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).id, 'ok');
    assert.equal(authorization, 'Bearer user-key-only');
  }, {
    nodeEnv: 'production',
    betaAuthUsername: 'friend',
    betaAuthPassword: 'correct horse',
    async deepSeekFetch(_url, options) {
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({ id: 'ok', choices: [] }), { status: 200 });
    },
  });
});

test('Beta 门禁：Cookie 到期或服务重启后失效', async () => {
  let now = 1_000;
  let oldCookie = '';
  const authOptions = {
    betaAuthUsername: 'friend',
    betaAuthPassword: 'password',
    now: () => now,
    randomToken: () => 'fixed-random-session-token',
  };
  await withProductionServer(async baseUrl => {
    const login = await fetch(`${baseUrl}/`, {
      headers: { Authorization: `Basic ${Buffer.from('friend:password').toString('base64')}` },
    });
    oldCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await fetch(`${baseUrl}/`, { headers: { Cookie: oldCookie } })).status, 200);
    now += 12 * 60 * 60 * 1000 + 1;
    assert.equal((await fetch(`${baseUrl}/`, { headers: { Cookie: oldCookie } })).status, 401);
  }, authOptions);

  now = 1_000;
  await withProductionServer(async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/`, { headers: { Cookie: oldCookie } })).status, 401);
  }, { ...authOptions, randomToken: () => 'new-service-token' });
});

test('生产日志：只保留请求元数据，不包含 Key、Prompt、歌词、IP 或 Authorization', async () => {
  const logs = [];
  await withProductionServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Authorization: 'Bearer top-secret-key',
        'Content-Type': 'application/json',
        'X-ANISON-Request': '1',
        'X-Forwarded-For': '203.0.113.44',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '绝密歌词 prompt' }],
      }),
    });
    assert.equal(response.status, 200);
  }, {
    logger: line => logs.push(line),
    async deepSeekFetch() {
      return new Response(JSON.stringify({ id: 'ok', choices: [] }), { status: 200 });
    },
  });
  const output = logs.join('\n');
  assert.match(output, /"requestId"/);
  assert.match(output, /"path":"\/api\/deepseek\/chat\/completions"/);
  assert.doesNotMatch(output, /top-secret-key|绝密歌词|203\.0\.113\.44|Authorization/i);
});
