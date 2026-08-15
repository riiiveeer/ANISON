import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const blueprintPath = new URL('../render.yaml', import.meta.url);

test('Render Blueprint：固定单一 Singapore Free Node Web Service', async () => {
  const blueprint = parse(await readFile(blueprintPath, 'utf8'));
  assert.equal(blueprint.services.length, 1);
  const service = blueprint.services[0];
  assert.deepEqual({
    type: service.type,
    name: service.name,
    runtime: service.runtime,
    plan: service.plan,
    region: service.region,
    branch: service.branch,
    buildCommand: service.buildCommand,
    startCommand: service.startCommand,
    healthCheckPath: service.healthCheckPath,
    autoDeployTrigger: service.autoDeployTrigger,
    maxShutdownDelaySeconds: service.maxShutdownDelaySeconds,
    renderSubdomainPolicy: service.renderSubdomainPolicy,
  }, {
    type: 'web',
    name: 'anison-web',
    runtime: 'node',
    plan: 'free',
    region: 'singapore',
    branch: 'main',
    buildCommand: 'npm ci && npm run build',
    startCommand: 'npm start',
    healthCheckPath: '/healthz',
    autoDeployTrigger: 'checksPass',
    maxShutdownDelaySeconds: 15,
    renderSubdomainPolicy: 'enabled',
  });
  assert.equal(service.disk, undefined);
  assert.equal(service.numInstances, undefined);
  assert.equal(blueprint.databases, undefined);
});

test('Render Blueprint：秘密仅使用 sync false 且不声明平台注入值', async () => {
  const source = await readFile(blueprintPath, 'utf8');
  const service = parse(source).services[0];
  const envVars = Object.fromEntries(service.envVars.map(entry => [entry.key, entry]));

  assert.deepEqual(envVars.NODE_ENV, { key: 'NODE_ENV', value: 'production' });
  assert.deepEqual(envVars.CSP_MODE, { key: 'CSP_MODE', value: 'report-only' });
  assert.deepEqual(envVars.BETA_AUTH_USERNAME, { key: 'BETA_AUTH_USERNAME', sync: false });
  assert.deepEqual(envVars.BETA_AUTH_PASSWORD, { key: 'BETA_AUTH_PASSWORD', sync: false });
  assert.equal(envVars.PORT, undefined);
  assert.equal(envVars.NODE_VERSION, undefined);
  assert.equal(envVars.DEEPSEEK_API_KEY, undefined);
  assert.equal(envVars.NETEASE_COOKIE, undefined);

  assert.doesNotMatch(source, /(?:password|secret|api[_-]?key)\s*:\s*[^\s]/i);
  assert.doesNotMatch(source, /(?:disk|databases?|postgres|redis|keyValue)\s*:/i);
});
