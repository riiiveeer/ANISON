import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createPreviewMiddleware } from '../server/netease/vite-plugin.js';

async function withServer(service, operation, options = {}) {
  const middleware = createPreviewMiddleware(service, { logger: null, ...options });
  const server = http.createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function apiHeaders(baseUrl, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-ANISON-Request': '1',
    Origin: baseUrl,
    ...extra,
  };
}

test('网易云网关：只接受同源 JSON POST 并返回标准预览', async () => {
  await withServer({
    async preview(input) {
      return { ok: true, song: { sourceSongId: input }, tracks: {}, warnings: [] };
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ input: '123' }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.song.sourceSongId, '123');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('网易云网关：拒绝跨源请求、错误方法和过大请求体', async () => {
  await withServer({ async preview() { return { ok: true }; } }, async baseUrl => {
    const crossOrigin = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ANISON-Request': '1',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ input: '123' }),
    });
    assert.equal(crossOrigin.status, 403);

    const wrongMethod = await fetch(`${baseUrl}/api/netease/preview`);
    assert.equal(wrongMethod.status, 405);

    const tooLarge = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ input: 'x'.repeat(9000) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error.code, 'REQUEST_TOO_LARGE');
  });
});

test('网易云网关：将上游错误转换为固定错误结构', async () => {
  await withServer({
    async preview() {
      const error = new Error('网易云暂时不可用');
      error.code = 'UPSTREAM_TIMEOUT';
      error.status = 504;
      error.retryable = true;
      throw error;
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ input: '123' }),
    });
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.deepEqual(payload.error, {
      code: 'UPSTREAM_TIMEOUT',
      message: '网易云暂时不可用',
      retryable: true,
    });
  });
});

test('网易云网关：队列满时返回 UPSTREAM_BUSY 与 Retry-After', async () => {
  await withServer({
    async preview() {
      const error = new Error('网易云请求繁忙');
      error.code = 'UPSTREAM_BUSY';
      error.status = 503;
      error.retryable = true;
      error.retryAfter = 5;
      throw error;
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ input: '123' }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal((await response.json()).error.code, 'UPSTREAM_BUSY');
  });
});

test('网易云网关：按 socket IP 限流并忽略 X-Forwarded-For', async () => {
  await withServer({
    async preview(input) {
      return { ok: true, song: { sourceSongId: input } };
    },
  }, async baseUrl => {
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${baseUrl}/api/netease/preview`, {
        method: 'POST',
        headers: apiHeaders(baseUrl, {
          'X-Forwarded-For': `203.0.113.${index}`,
        }),
        body: JSON.stringify({ input: String(100 + index) }),
      });
      assert.equal(response.status, 200);
    }
    const limited = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: apiHeaders(baseUrl, {
        'X-Forwarded-For': '198.51.100.250',
      }),
      body: JSON.stringify({ input: '999' }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});
