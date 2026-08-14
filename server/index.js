import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp, __testables__ as appTestables } from './app.js';
import { closeServer, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './lifecycle.js';

const HOST = '0.0.0.0';

function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值：${value}`);
  }
  return port;
}

export async function startServer(options = {}) {
  const port = options.port ?? parsePort(process.env.PORT);
  const host = options.host || HOST;
  const distDirectory = options.distDirectory || process.env.ANISON_DIST_DIR || appTestables.defaultDistDirectory;
  await access(path.join(distDirectory, 'index.html'));

  const server = await new Promise((resolve, reject) => {
    const pendingServer = createApp({ distDirectory, ...options.appOptions }).listen(port, host);
    const onError = error => reject(error);
    pendingServer.once('error', onError);
    pendingServer.once('listening', () => {
      pendingServer.off('error', onError);
      resolve(pendingServer);
    });
  });
  console.log(`[server] ANISON listening on http://${host}:${server.address().port}`);
  return server;
}

async function main() {
  const server = await startServer();

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] received ${signal}, shutting down`);

    closeServer(server, {
      timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      onTimeout: () => console.error('[server] graceful shutdown timed out'),
    }).then(
      () => process.exit(0),
      error => {
        console.error('[server] shutdown failed', error.message);
        process.exit(1);
      },
    );
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error('[server] startup failed', error?.code || error?.message || error);
    process.exitCode = 1;
  });
}

export const __testables__ = { parsePort, HOST, DEFAULT_SHUTDOWN_TIMEOUT_MS };
