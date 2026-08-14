import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import {
  DeploymentVerificationError,
  normalizeBaseUrl,
  verifyDeployment,
} from '../scripts/verify-deployment.mjs';

const VERSION = '1.0.0-test.1';
const COMMIT = '1234567890abcdef1234567890abcdef12345678';
const BUILD_ID = `${VERSION}+${COMMIT.slice(0, 12)}+abcdef123456`;

async function withDeployment(operation, appOverrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anison-deployment-verifier-'));
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(directory, 'icons'));
  await writeFile(path.join(directory, 'index.html'), [
    '<!doctype html><html><head>',
    '<title>ANISON</title>',
    '<link rel="stylesheet" href="/assets/index-test.css">',
    '</head><body><script type="module" src="/assets/index-test.js"></script></body></html>',
  ].join(''));
  await writeFile(path.join(directory, 'manifest.webmanifest'), JSON.stringify({ name: 'ANISON' }));
  await writeFile(path.join(directory, 'sw.js'), [
    `const BUILD_ID = ${JSON.stringify(BUILD_ID)};`,
    `const APP_VERSION = ${JSON.stringify(VERSION)};`,
    `const APP_COMMIT = ${JSON.stringify(COMMIT)};`,
  ].join('\n'));
  await writeFile(path.join(directory, 'assets', 'index-test.js'), `const version=${JSON.stringify(VERSION)};const commit=${JSON.stringify(COMMIT)};`);
  await writeFile(path.join(directory, 'assets', 'index-test.css'), 'body{color:#fff}');
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    await writeFile(path.join(directory, 'icons', name), Buffer.from('89504e470d0a1a0a', 'hex'));
  }

  const logs = [];
  const app = createApp({
    distDirectory: directory,
    version: VERSION,
    commit: COMMIT,
    logger: line => logs.push(line),
    nodeEnv: 'production',
    cspMode: 'report-only',
    betaAuthUsername: 'deployment-user',
    betaAuthPassword: 'deployment-password-not-for-logs',
    ...appOverrides,
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await operation(`http://127.0.0.1:${port}`, logs);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('部署验证器：拒绝带路径、凭据或远程 HTTP 的基址', () => {
  assert.throws(() => normalizeBaseUrl('http://example.com'), /必须使用 HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://example.com/app'), /只能包含协议/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com'), /只能包含协议/);
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000').origin, 'http://127.0.0.1:3000');
});

test('部署验证器：无凭据时只验证健康检查和未认证 401', async () => {
  await withDeployment(async baseUrl => {
    const output = [];
    const report = await verifyDeployment({ baseUrl, log: line => output.push(line) });
    assert.equal(report.scope, 'public-only');
    assert.equal(report.health.version, VERSION);
    assert.match(output.join('\n'), /未提供 Beta 凭据/);
  });
});

test('部署验证器：完整验证认证、缓存、安全头、PWA 元数据和 API 边界', async () => {
  await withDeployment(async (baseUrl, serverLogs) => {
    const output = [];
    const report = await verifyDeployment({
      baseUrl,
      username: 'deployment-user',
      password: 'deployment-password-not-for-logs',
      expectedVersion: VERSION,
      expectedCommit: COMMIT,
      expectedCsp: 'report-only',
      log: line => output.push(line),
    });
    assert.equal(report.scope, 'full');
    assert.equal(report.buildId, BUILD_ID);
    assert.equal(report.csp, 'report-only');
    const combinedOutput = `${output.join('\n')}\n${serverLogs.join('\n')}`;
    assert.doesNotMatch(combinedOutput, /deployment-password-not-for-logs|anison_beta_session=|Authorization/i);
  });
});

test('部署验证器：错误凭据失败且错误消息不泄露凭据', async () => {
  await withDeployment(async baseUrl => {
    await assert.rejects(
      verifyDeployment({
        baseUrl,
        username: 'deployment-user',
        password: 'wrong-secret-value',
      }),
      error => {
        assert.ok(error instanceof DeploymentVerificationError);
        assert.match(error.message, /状态码应为 200/);
        assert.doesNotMatch(error.message, /wrong-secret-value/);
        return true;
      },
    );
  });
});

test('部署验证器：CSP Enforce 模式必须只有强制响应头', async () => {
  await withDeployment(async baseUrl => {
    const report = await verifyDeployment({
      baseUrl,
      username: 'deployment-user',
      password: 'deployment-password-not-for-logs',
      expectedCsp: 'enforce',
    });
    assert.equal(report.csp, 'enforce');
  }, { cspMode: 'enforce' });
});
