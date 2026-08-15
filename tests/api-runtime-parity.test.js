import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../server/app.js';
import { createDeepSeekVitePlugin } from '../server/deepseek/vite-plugin.js';
import { createNeteaseVitePlugin } from '../server/netease/vite-plugin.js';

const neteaseService = {
  async preview(input) {
    return {
      ok: true,
      song: { source: 'netease', sourceSongId: input, title: 'fixture' },
      tracks: {},
      warnings: [],
    };
  },
};

async function deepSeekFetch() {
  return new Response(JSON.stringify({ id: 'fixture-chat', choices: [] }), { status: 200 });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function createViteHandler() {
  const middlewares = [];
  const viteServer = { middlewares: { use(handler) { middlewares.push(handler); } } };
  createNeteaseVitePlugin({ service: neteaseService, logger: null }).configureServer(viteServer);
  createDeepSeekVitePlugin({ fetchImpl: deepSeekFetch, logger: null }).configureServer(viteServer);
  return (request, response) => {
    let index = 0;
    const next = () => {
      const middleware = middlewares[index++];
      if (middleware) middleware(request, response, next);
      else {
        response.statusCode = 404;
        response.end('not found');
      }
    };
    next();
  };
}

async function callFixture(baseUrl, fixture) {
  const response = await fetch(`${baseUrl}${fixture.path}`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'X-ANISON-Request': '1',
      ...(fixture.authorization ? { Authorization: fixture.authorization } : {}),
    },
    body: JSON.stringify(fixture.body),
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: {
      cacheControl: response.headers.get('cache-control'),
      contentTypeOptions: response.headers.get('x-content-type-options'),
      hasRequestId: Boolean(response.headers.get('x-request-id')),
    },
  };
}

test('Vite 与 Express：两条 API 对同一固定夹具返回一致结果', async () => {
  const vite = await listen(createViteHandler());
  const express = await listen(createApp({
    neteaseService,
    deepSeekFetch,
    logger: null,
    betaAuthUsername: '',
    betaAuthPassword: '',
  }));
  const fixtures = [
    {
      path: '/api/netease/preview',
      body: { input: '2702706957' },
    },
    {
      path: '/api/deepseek/chat/completions',
      authorization: 'Bearer fixture-user-key',
      body: {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'fixture prompt' }],
        thinking: { type: 'disabled' },
        temperature: 0.3,
        max_tokens: 800,
      },
    },
  ];

  try {
    for (const fixture of fixtures) {
      const viteResult = await callFixture(vite.baseUrl, fixture);
      const expressResult = await callFixture(express.baseUrl, fixture);
      assert.deepEqual(expressResult, viteResult);
    }
  } finally {
    await vite.close();
    await express.close();
  }
});
