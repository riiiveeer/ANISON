import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNetworkStatus,
  createOfflineError,
  normalizeNetworkFailure,
} from '../src/pwa/network-status.js';

class FakeWindow {
  listeners = new Map();

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener();
  }
}

test('网络状态：读取初始值、响应切换并在停止后移除监听', () => {
  const windowRef = new FakeWindow();
  const navigatorRef = { onLine: false };
  const status = createNetworkStatus({ navigator: navigatorRef, window: windowRef });
  const values = [];
  status.start();
  const unsubscribe = status.subscribe(state => values.push(state.online));
  assert.equal(status.getState().online, false);

  windowRef.emit('online');
  assert.equal(status.getState().online, true);
  status.stop();
  windowRef.emit('offline');
  assert.equal(status.getState().online, true);
  assert.deepEqual(values, [false, true]);
  unsubscribe();
});

test('网络错误：明确离线与 fetch 失败使用稳定错误码', () => {
  const offline = createOfflineError();
  assert.equal(offline.code, 'OFFLINE');
  assert.equal(offline.retryable, true);
  const network = normalizeNetworkFailure(new TypeError('fetch failed'));
  assert.equal(network.code, 'NETWORK_ERROR');
  assert.equal(network.retryable, true);
});
