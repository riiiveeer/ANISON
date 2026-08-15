export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function closeServer(server, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onTimeout = options.onTimeout || (() => {});

  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      onTimeout();
      server.closeAllConnections?.();
      reject(new Error('graceful shutdown timed out'));
    }, timeoutMs);
    forceTimer.unref();

    server.close(error => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
