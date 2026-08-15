import test from 'node:test';
import assert from 'node:assert/strict';

import { createCriticalOperations, runCriticalOperation } from '../src/pwa/critical-operation.js';

test('关键操作锁：支持嵌套计数、幂等释放和阻塞原因', () => {
  const operations = createCriticalOperations();
  const states = [];
  const unsubscribe = operations.subscribe(state => states.push(state));
  const releaseFirst = operations.acquire('local-import');
  const releaseSecond = operations.acquire('local-import');

  assert.equal(operations.getState().count, 2);
  assert.match(operations.getState().blockedReason, /歌词正在导入/);
  releaseFirst();
  releaseFirst();
  assert.equal(operations.getState().count, 1);
  releaseSecond();
  assert.deepEqual(operations.getState(), { active: false, count: 0, reasons: [], blockedReason: '' });
  assert.ok(states.length >= 4);
  unsubscribe();
});

test('关键操作锁：异步失败仍在 finally 释放', async () => {
  const operations = createCriticalOperations();
  await assert.rejects(
    runCriticalOperation(operations, 'backup-restore', async () => {
      throw new Error('fixture failure');
    }),
    /fixture failure/,
  );
  assert.equal(operations.getState().active, false);
});
