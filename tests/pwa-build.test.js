import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  collectBundleResources,
  createResourceDigest,
  resolveBuildMetadata,
} from '../server/build/pwa-plugin.js';
import { renderServiceWorker } from '../src/pwa/service-worker-template.js';

const publicDirectory = path.resolve('public');

function fixtureBundle(js = 'console.log("v1")') {
  return {
    'index.html': { type: 'asset', fileName: 'index.html', source: '<!doctype html><main>ANISON</main>' },
    'assets/app.js': { type: 'chunk', fileName: 'assets/app-123.js', code: js },
    'assets/app.css': { type: 'asset', fileName: 'assets/app-123.css', source: 'body{}' },
    'ignored.map': { type: 'asset', fileName: 'assets/app.js.map', source: '{}' },
  };
}

test('PWA 构建：资源摘要稳定且内容变化会更换摘要', () => {
  const first = collectBundleResources(fixtureBundle(), publicDirectory);
  const second = collectBundleResources(fixtureBundle(), publicDirectory);
  const changed = collectBundleResources(fixtureBundle('console.log("v2")'), publicDirectory);
  assert.equal(createResourceDigest(first), createResourceDigest(second));
  assert.notEqual(createResourceDigest(first), createResourceDigest(changed));
  assert.ok(first.some(resource => resource.fileName === 'icons/icon-maskable-512.png'));
  assert.ok(first.every(resource => !resource.fileName.startsWith('api/')));
});

test('PWA worker：只包含允许的缓存和显式更新消息', () => {
  const source = renderServiceWorker({
    buildId: '1.0.0-beta.3+local+fixture',
    version: '1.0.0-beta.3',
    commit: 'local',
    precacheUrls: ['/', '/index.html', '/assets/app-123.js', '/manifest.webmanifest'],
  });
  assert.match(source, /anison-shell-/);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /request\.headers\.has\('Authorization'\)/);
  assert.match(source, /type === 'SKIP_WAITING'/);
  assert.match(source, /type === 'GET_VERSION'/);
  assert.doesNotMatch(source, /install[\s\S]{0,160}skipWaiting\(\)/);
  assert.doesNotMatch(source, /__ANISON_|\{\{.+\}\}/);
});

test('PWA 元数据：显式版本和部署提交优先', () => {
  assert.deepEqual(resolveBuildMetadata({ version: 'test', env: { APP_COMMIT_SHA: 'abc123' } }), {
    version: 'test',
    commit: 'abc123',
  });
});
