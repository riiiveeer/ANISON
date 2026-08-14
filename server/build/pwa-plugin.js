import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderServiceWorker } from '../../src/pwa/service-worker-template.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageMetadata = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const PUBLIC_PRECACHE_FILES = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

export function resolveBuildMetadata(options = {}) {
  return {
    version: String(options.version || packageMetadata.version || 'development'),
    commit: String(options.commit || resolveCommit(options.env || process.env)),
  };
}

export function createPwaBuildPlugin(options = {}) {
  const metadata = resolveBuildMetadata(options);
  let resolvedConfig;

  return {
    name: 'anison-pwa-build',
    enforce: 'post',
    config() {
      return {
        define: {
          __ANISON_VERSION__: JSON.stringify(metadata.version),
          __ANISON_COMMIT__: JSON.stringify(metadata.commit),
        },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    generateBundle(_outputOptions, bundle) {
      if (resolvedConfig?.command !== 'build') return;
      const publicDirectory = path.resolve(resolvedConfig.publicDir || path.join(projectRoot, 'public'));
      const resources = collectBundleResources(bundle, publicDirectory);
      const digest = createResourceDigest(resources);
      const shortCommit = metadata.commit === 'local' ? 'local' : metadata.commit.slice(0, 12);
      const buildId = `${metadata.version}+${shortCommit}+${digest.slice(0, 12)}`;
      const precacheUrls = [
        '/',
        ...resources.map(resource => `/${resource.fileName.replaceAll('\\', '/')}`),
      ].filter((value, index, values) => values.indexOf(value) === index).sort();
      const source = renderServiceWorker({ ...metadata, buildId, precacheUrls });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export function collectBundleResources(bundle, publicDirectory) {
  const resources = [];
  for (const output of Object.values(bundle)) {
    const fileName = String(output.fileName || '');
    if (!fileName || fileName === 'sw.js' || fileName.endsWith('.map')) continue;
    if (fileName !== 'index.html' && !fileName.startsWith('assets/')) continue;
    const content = output.type === 'chunk' ? output.code : output.source;
    resources.push({ fileName, content: toBuffer(content) });
  }
  for (const fileName of PUBLIC_PRECACHE_FILES) {
    resources.push({ fileName, content: readFileSync(path.join(publicDirectory, fileName)) });
  }
  return resources.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function createResourceDigest(resources) {
  const hash = createHash('sha256');
  for (const resource of [...resources].sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    hash.update(resource.fileName);
    hash.update('\0');
    hash.update(toBuffer(resource.content));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function resolveCommit(env) {
  const deployed = env.RENDER_GIT_COMMIT || env.APP_COMMIT_SHA || env.GITHUB_SHA;
  if (deployed) return deployed;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'local';
  } catch {
    return 'local';
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}

export const __testables__ = { PUBLIC_PRECACHE_FILES, resolveCommit, toBuffer };
