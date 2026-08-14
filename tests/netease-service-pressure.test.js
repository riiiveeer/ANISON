import test from 'node:test';
import assert from 'node:assert/strict';

import { createNeteasePreviewService } from '../server/netease/service.js';
import { createFixedWindowRateLimiter } from '../server/netease/vite-plugin.js';

test('网易云服务：冷缓存同歌并发只访问一次上游', async () => {
  let calls = 0;
  const service = createNeteasePreviewService({
    client: {
      async getSongPreview(songId) {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { ok: true, song: { sourceSongId: songId } };
      },
    },
  });
  const results = await Promise.all(Array.from({ length: 100 }, () => service.preview('123')));
  assert.equal(results.length, 100);
  assert.equal(calls, 1);
  assert.equal(service.getStats().inFlight, 0);
});

test('网易云服务：两万个不同成功结果仍限制为五百条缓存', async () => {
  const service = createNeteasePreviewService({
    maxConcurrency: 20000,
    maxQueue: 20000,
    client: {
      async getSongPreview(songId) {
        return { ok: true, song: { sourceSongId: songId } };
      },
    },
  });
  await Promise.all(Array.from({ length: 20000 }, (_, index) =>
    service.preview(String(100000 + index))));
  assert.equal(service.getStats().cacheEntries, 500);
});

test('网易云服务：成功缓存 24 小时到期后重新请求', async () => {
  let now = 1;
  let calls = 0;
  const service = createNeteasePreviewService({
    now: () => now,
    client: {
      async getSongPreview(songId) {
        calls += 1;
        return { ok: true, song: { sourceSongId: songId } };
      },
    },
  });
  await service.preview('123');
  await service.preview('123');
  assert.equal(calls, 1);
  now += 24 * 60 * 60 * 1000 + 1;
  await service.preview('123');
  assert.equal(calls, 2);
});

test('网易云服务：未找到歌曲负缓存两分钟', async () => {
  let now = 1;
  let calls = 0;
  const service = createNeteasePreviewService({
    now: () => now,
    client: {
      async getSongPreview() {
        calls += 1;
        const error = new Error('歌曲不存在');
        error.code = 'SONG_NOT_FOUND';
        error.status = 404;
        throw error;
      },
    },
  });
  await assert.rejects(service.preview('123'), error => error.code === 'SONG_NOT_FOUND');
  await assert.rejects(service.preview('123'), error => error.code === 'SONG_NOT_FOUND');
  assert.equal(calls, 1);
  now += 2 * 60 * 1000 + 1;
  await assert.rejects(service.preview('123'), error => error.code === 'SONG_NOT_FOUND');
  assert.equal(calls, 2);
});

test('网易云服务：队列已满和等待超时返回可重试 UPSTREAM_BUSY', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const service = createNeteasePreviewService({
    maxConcurrency: 1,
    maxQueue: 1,
    queueWaitMs: 10,
    client: {
      async getSongPreview(songId) {
        if (songId === '1') await firstGate;
        return { ok: true, song: { sourceSongId: songId } };
      },
    },
  });
  const first = service.preview('1');
  const second = service.preview('2');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    service.preview('3'),
    error => error.code === 'UPSTREAM_BUSY' && error.status === 503 && error.retryable && error.retryAfter === 5,
  );
  await assert.rejects(
    second,
    error => error.code === 'UPSTREAM_BUSY' && /超时/.test(error.message),
  );
  releaseFirst();
  await first;
});

test('网易云网关限流：十分钟窗口最多二十次且窗口结束后恢复', () => {
  let now = 0;
  const limiter = createFixedWindowRateLimiter({ limit: 20, windowMs: 600000, now: () => now });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(limiter.consume('127.0.0.1').allowed, true);
  }
  const rejected = limiter.consume('127.0.0.1');
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfter, 600);
  now += 600000;
  assert.equal(limiter.consume('127.0.0.1').allowed, true);
});

test('共享限流器：客户端桶数量始终不超过一千', () => {
  const limiter = createFixedWindowRateLimiter({ limit: 1, maxClients: 1000 });
  for (let index = 0; index < 2000; index += 1) limiter.consume(`client-${index}`);
  assert.equal(limiter.size, 1000);
});

test('网易云服务：15 秒整体预算也会取消短链接解析', async () => {
  let aborted = false;
  const service = createNeteasePreviewService({
    timeoutMs: 10,
    fetchImpl(_url, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
    client: { async getSongPreview() { throw new Error('不应调用'); } },
  });
  await assert.rejects(
    service.preview('https://163cn.tv/timeout'),
    error => error.code === 'UPSTREAM_TIMEOUT' && error.status === 504,
  );
  assert.equal(aborted, true);
});
