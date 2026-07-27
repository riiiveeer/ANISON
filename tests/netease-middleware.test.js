import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createPreviewMiddleware } from '../server/netease/vite-plugin.js';

async function withServer(service, operation) {
  const middleware = createPreviewMiddleware(service);
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

test('网易云网关：只接受同源 JSON POST 并返回标准预览', async () => {
  await withServer({
    async preview(input) {
      return { ok: true, song: { sourceSongId: input }, tracks: {}, warnings: [] };
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
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
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ input: '123' }),
    });
    assert.equal(crossOrigin.status, 403);

    const wrongMethod = await fetch(`${baseUrl}/api/netease/preview`);
    assert.equal(wrongMethod.status, 405);

    const tooLarge = await fetch(`${baseUrl}/api/netease/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(9000) }),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal((await tooLarge.json()).error.code, 'INVALID_INPUT');
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
      headers: { 'Content-Type': 'application/json' },
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
