import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createDeepSeekMiddleware,
  validateDeepSeekBody,
} from '../server/deepseek/middleware.js';

const VALID_BODY = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '请解释这句歌词' }],
  thinking: { type: 'disabled' },
  temperature: 0.3,
  max_tokens: 800,
};

async function withServer(options, operation) {
  const middleware = createDeepSeekMiddleware({ logger: null, ...options });
  const server = http.createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await operation(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function apiHeaders(baseUrl, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-ANISON-Request': '1',
    Origin: baseUrl,
    Authorization: 'Bearer user-secret-key',
    ...extra,
  };
}

test('DeepSeek 网关：转发用户 Bearer 并保持成功响应结构', async () => {
  let upstreamRequest;
  await withServer({
    async fetchImpl(url, options) {
      upstreamRequest = { url, options };
      return new Response(JSON.stringify({ id: 'chat-1', choices: [{ message: { content: '讲解' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'chat-1');
    assert.equal(upstreamRequest.options.headers.Authorization, 'Bearer user-secret-key');
    assert.deepEqual(JSON.parse(upstreamRequest.options.body), VALID_BODY);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('x-request-id'));
  });
});

test('DeepSeek 校验：拒绝未知字段、角色、模型和越界参数', () => {
  const invalidBodies = [
    [{ ...VALID_BODY, stream: true }, 'UNKNOWN_FIELD'],
    [{ ...VALID_BODY, model: 'deepseek-chat' }, 'INVALID_MODEL'],
    [{ ...VALID_BODY, messages: [{ role: 'system', content: 'x' }] }, 'INVALID_MESSAGES'],
    [{ ...VALID_BODY, messages: [{ role: 'user', content: '' }] }, 'INVALID_MESSAGES'],
    [{ ...VALID_BODY, thinking: { type: 'enabled' } }, 'INVALID_THINKING'],
    [{ ...VALID_BODY, temperature: 2.1 }, 'INVALID_TEMPERATURE'],
    [{ ...VALID_BODY, max_tokens: 801 }, 'INVALID_MAX_TOKENS'],
    [{ ...VALID_BODY, max_tokens: 1.5 }, 'INVALID_MAX_TOKENS'],
  ];
  for (const [body, code] of invalidBodies) {
    assert.throws(() => validateDeepSeekBody(body), error => error.code === code);
  }
});

test('DeepSeek 网关：缺少 Bearer、跨源和超大请求返回固定错误', async () => {
  let upstreamCalls = 0;
  await withServer({
    async fetchImpl() {
      upstreamCalls += 1;
      return new Response('{}');
    },
  }, async baseUrl => {
    const missingBearer = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl, { Authorization: '' }),
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(missingBearer.status, 401);
    assert.equal((await missingBearer.json()).error.code, 'DEEPSEEK_AUTH_REQUIRED');

    const crossOrigin = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl, { Origin: 'https://evil.example' }),
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(crossOrigin.status, 403);

    const tooLarge = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ ...VALID_BODY, messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error.code, 'REQUEST_TOO_LARGE');
    assert.equal(upstreamCalls, 0);
  });
});

test('DeepSeek 网关：稳定转换 401、429、5xx 与过大成功响应', async t => {
  const fixtures = [
    [401, 'DEEPSEEK_UNAUTHORIZED', 401],
    [429, 'DEEPSEEK_RATE_LIMITED', 429],
    [503, 'UPSTREAM_UNAVAILABLE', 502],
  ];
  for (const [upstreamStatus, code, expectedStatus] of fixtures) {
    await t.test(`上游 ${upstreamStatus}`, async () => {
      await withServer({
        async fetchImpl() {
          return new Response('private upstream detail', {
            status: upstreamStatus,
            headers: upstreamStatus === 429 ? { 'Retry-After': '7' } : {},
          });
        },
      }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
          method: 'POST',
          headers: apiHeaders(baseUrl),
          body: JSON.stringify(VALID_BODY),
        });
        const payload = await response.json();
        assert.equal(response.status, expectedStatus);
        assert.equal(payload.error.code, code);
        assert.doesNotMatch(JSON.stringify(payload), /private upstream detail/);
        if (upstreamStatus === 429) assert.equal(response.headers.get('retry-after'), '7');
      });
    });
  }

  await t.test('成功响应超过 2 MiB', async () => {
    await withServer({
      async fetchImpl() {
        return new Response(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }), { status: 200 });
      },
    }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
        method: 'POST',
        headers: apiHeaders(baseUrl),
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'UPSTREAM_RESPONSE_TOO_LARGE');
    });
  });
});

test('DeepSeek 网关：45 秒预算可配置测试且超时会取消上游', async () => {
  let aborted = false;
  await withServer({
    timeoutMs: 10,
    fetchImpl(_url, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(aborted, true);
  });
});

test('DeepSeek 网关：浏览器断开时取消上游请求', async () => {
  let markStarted;
  let markAborted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const aborted = new Promise(resolve => { markAborted = resolve; });

  await withServer({
    fetchImpl(_url, options) {
      markStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          markAborted();
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
  }, async (baseUrl, port) => {
    const body = JSON.stringify(VALID_BODY);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/deepseek/chat/completions',
      method: 'POST',
      headers: {
        ...apiHeaders(baseUrl),
        'Content-Length': Buffer.byteLength(body),
      },
    });
    request.on('error', () => {});
    request.end(body);
    await started;
    request.destroy();
    await aborted;
  });
});

test('DeepSeek 网关：每个客户端十分钟最多六十次', async () => {
  await withServer({
    async fetchImpl() {
      return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
    },
  }, async baseUrl => {
    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
        method: 'POST',
        headers: apiHeaders(baseUrl),
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 200);
    }
    const limited = await fetch(`${baseUrl}/api/deepseek/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(baseUrl),
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});
