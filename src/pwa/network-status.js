export const OFFLINE_ERROR_CODE = 'OFFLINE';

export function createOfflineError(message = '当前离线，请联网后重试') {
  const error = new Error(message);
  error.name = 'OfflineError';
  error.code = OFFLINE_ERROR_CODE;
  error.retryable = true;
  return error;
}

export function normalizeNetworkFailure(error, fallbackMessage = '网络连接中断，请检查网络后重试') {
  if (error?.code === OFFLINE_ERROR_CODE || error?.name === 'OfflineError') return error;
  if (error?.name === 'AbortError') return error;
  if (error instanceof TypeError || /fetch|network|连接|networkerror/i.test(String(error?.message || ''))) {
    const normalized = new Error(fallbackMessage, { cause: error });
    normalized.name = 'NetworkError';
    normalized.code = 'NETWORK_ERROR';
    normalized.retryable = true;
    return normalized;
  }
  return error;
}

export function createNetworkStatus({ navigator: navigatorRef = globalThis.navigator, window: windowRef = globalThis.window } = {}) {
  const listeners = new Set();
  let started = false;
  let state = createState();

  function createState() {
    return {
      online: navigatorRef?.onLine !== false,
      changedAt: Date.now(),
    };
  }

  function handleOnline() {
    update(true);
  }

  function handleOffline() {
    update(false);
  }

  function update(online) {
    if (state.online === online) return;
    state = { online, changedAt: Date.now() };
    for (const listener of listeners) listener({ ...state });
  }

  function start() {
    if (started) return;
    started = true;
    state = createState();
    windowRef?.addEventListener?.('online', handleOnline);
    windowRef?.addEventListener?.('offline', handleOffline);
  }

  function stop() {
    if (!started) return;
    started = false;
    windowRef?.removeEventListener?.('online', handleOnline);
    windowRef?.removeEventListener?.('offline', handleOffline);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
  }

  return {
    start,
    stop,
    subscribe,
    getState: () => ({ ...state }),
  };
}
