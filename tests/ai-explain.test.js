import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __testables__,
  explainLyrics,
  normalizeDeepSeekModel,
} from '../src/engine/ai-explain.js';

test('buildPrompt: 应强约束固定 markdown 输出结构', () => {
  const prompt = __testables__.buildPrompt(
    '自らの音を　信じているからと　高らかに',
    '正因为相信自己的声音，才如此高声地歌唱',
    'mizukara no oto o shinjite iru kara to takaraka ni',
    '00:10.00 日文：前句｜中文：前句翻译',
    '',
  );

  assert.match(prompt, /严格使用 Markdown/);
  assert.match(prompt, /#### 1\. 重点词汇/);
  assert.match(prompt, /#### 2\. 语法结构/);
  assert.match(prompt, /#### 3\. 关键语法点/);
  assert.match(prompt, /正文只允许使用 `- ` 列表/);
  assert.match(prompt, /不要使用编号列表、表格、代码块或额外小标题/);
});

test('buildPrompt: 追问模式也应继续沿用固定结构', () => {
  const prompt = __testables__.buildPrompt(
    '自らの音を　信じているからと　高らかに',
    '正因为相信自己的声音，才如此高声地歌唱',
    '',
    '00:10.00 日文：前句｜中文：前句翻译',
    '这里的からと怎么理解？',
  );

  assert.match(prompt, /学生追问：这里的からと怎么理解？/);
  assert.match(prompt, /追问回答也必须继续沿用同样的三个标题和 `- ` 列表格式/);
});

test('DeepSeek 模型配置: 旧模型名应回退到 V4 Flash', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-chat'), 'deepseek-v4-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('explainLyrics: 应发送受支持的 V4 模型并关闭思考模式', async () => {
  const storage = new Map([['anison_ds_model', 'deepseek-v4-flash']]);
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  let requestBody = null;
  let requestHeaders = null;
  globalThis.localStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '测试讲解' } }] };
      },
    };
  };

  try {
    const result = await explainLyrics('テスト', '测试', '', '', 'test-key');
    assert.equal(result, '测试讲解');
    assert.equal(requestBody.model, 'deepseek-v4-flash');
    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.equal(requestHeaders['X-ANISON-Request'], '1');
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('API 错误解析: 应提取结构化错误消息', () => {
  assert.equal(
    __testables__.parseApiErrorMessage('{"error":{"message":"invalid model"}}'),
    'invalid model',
  );
});

test('explainLyrics: 明确离线时不发起请求并返回 OFFLINE', async () => {
  const previousStorage = globalThis.localStorage;
  let fetchCalls = 0;
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  try {
    await assert.rejects(
      explainLyrics('離線テスト', '', '', '', 'test-key', '', {
        isOnline: () => false,
        fetchImpl: async () => { fetchCalls += 1; },
      }),
      error => error.code === 'OFFLINE' && error.retryable,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
