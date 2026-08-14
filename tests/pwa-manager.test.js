import test from 'node:test';
import assert from 'node:assert/strict';

import { createCriticalOperations } from '../src/pwa/critical-operation.js';
import { createPwaManager } from '../src/pwa/pwa-manager.js';

class FakeEvents {
  listeners = new Map();

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

test('PWA Manager：waiting、稍后、关键操作阻塞和单次刷新闭环', async () => {
  const workerMessages = [];
  const worker = {
    state: 'installed',
    addEventListener() {},
    postMessage(message, ports = []) {
      workerMessages.push(message);
      if (message.type === 'GET_VERSION') {
        ports[0]?.postMessage({
          type: 'VERSION',
          buildId: '1.0.0-beta.3+local+fixture',
          version: '1.0.0-beta.3',
          commit: 'local',
        });
      }
    },
  };
  const registration = new FakeEvents();
  registration.waiting = worker;
  registration.active = worker;
  registration.update = async () => {};
  const serviceWorker = new FakeEvents();
  serviceWorker.controller = worker;
  serviceWorker.register = async () => registration;
  let reloads = 0;
  const documentRef = new FakeEvents();
  documentRef.readyState = 'complete';
  documentRef.visibilityState = 'visible';
  documentRef.baseURI = 'https://anison.example/';
  const windowRef = new FakeEvents();
  windowRef.document = documentRef;
  windowRef.location = { reload: () => { reloads += 1; } };
  windowRef.matchMedia = () => ({ matches: false });
  windowRef.MessageChannel = MessageChannel;
  windowRef.setTimeout = setTimeout;
  windowRef.clearTimeout = clearTimeout;
  const navigatorRef = { serviceWorker, userAgent: 'Chrome', onLine: true };
  const criticalOperations = createCriticalOperations();
  const manager = createPwaManager({
    navigator: navigatorRef,
    window: windowRef,
    buildInfo: { version: '1.0.0-beta.3', commit: 'local' },
    criticalOperations,
    enabled: true,
  });

  await manager.start();
  assert.equal(manager.getState().updateAvailable, true);
  assert.match(manager.getState().buildId, /fixture/);
  manager.dismissUpdate();
  assert.equal(manager.getState().updateDismissed, true);

  const release = criticalOperations.acquire('backup-restore');
  assert.equal(await manager.applyUpdate(), false);
  assert.match(manager.getState().blockedReason, /备份/);
  release();
  assert.equal(await manager.applyUpdate(), true);
  assert.ok(workerMessages.some(message => message.type === 'SKIP_WAITING'));
  serviceWorker.emit('controllerchange');
  serviceWorker.emit('controllerchange');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reloads, 1);
  manager.destroy();
});

test('PWA Manager：捕获安装提示且不自动弹出', async () => {
  const windowRef = new FakeEvents();
  const documentRef = new FakeEvents();
  documentRef.readyState = 'complete';
  documentRef.visibilityState = 'visible';
  documentRef.baseURI = 'https://anison.example/';
  windowRef.document = documentRef;
  windowRef.matchMedia = () => ({ matches: false });
  const manager = createPwaManager({
    navigator: { userAgent: 'Chrome' },
    window: windowRef,
    enabled: false,
  });
  manager.start();
  let promptCalls = 0;
  windowRef.emit('beforeinstallprompt', {
    preventDefault() {},
    prompt: async () => { promptCalls += 1; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });
  assert.equal(promptCalls, 0);
  assert.equal(manager.getState().installAvailable, true);
  assert.equal(await manager.requestInstall(), true);
  assert.equal(promptCalls, 1);
  manager.destroy();
});
