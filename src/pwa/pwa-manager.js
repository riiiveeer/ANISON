function detectInstalled(windowRef, navigatorRef) {
  return Boolean(
    windowRef?.matchMedia?.('(display-mode: standalone)')?.matches
    || navigatorRef?.standalone,
  );
}

function detectIosSafari(navigatorRef) {
  const userAgent = String(navigatorRef?.userAgent || '');
  const isIos = /iPad|iPhone|iPod/.test(userAgent)
    || (navigatorRef?.platform === 'MacIntel' && Number(navigatorRef?.maxTouchPoints) > 1);
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  return isIos && /Safari/.test(userAgent) && !otherIosBrowser;
}

export function createPwaManager({
  navigator: navigatorRef = globalThis.navigator,
  window: windowRef = globalThis.window,
  buildInfo = {},
  criticalOperations,
  enabled = true,
  updateTimeoutMs = 10000,
} = {}) {
  const listeners = new Set();
  const supported = Boolean(enabled && navigatorRef?.serviceWorker);
  let registration = null;
  let deferredInstallPrompt = null;
  let started = false;
  let destroyed = false;
  let registrationPromise = null;
  let applyRequested = false;
  let reloaded = false;
  let applyTimer = null;
  let criticalUnsubscribe = null;
  let criticalState = criticalOperations?.getState?.() || { blockedReason: '' };
  const installed = detectInstalled(windowRef, navigatorRef);
  let state = {
    supported,
    installed,
    installAvailable: false,
    installKind: installed ? 'installed' : (detectIosSafari(navigatorRef) ? 'ios-manual' : 'unavailable'),
    updateAvailable: false,
    updateDismissed: false,
    checking: false,
    applying: false,
    blockedReason: '',
    currentVersion: String(buildInfo.version || 'development'),
    commit: String(buildInfo.commit || 'local'),
    buildId: '',
    error: '',
  };

  const handleBeforeInstallPrompt = event => {
    event.preventDefault?.();
    deferredInstallPrompt = event;
    setState({ installAvailable: true, installKind: 'prompt', error: '' });
  };
  const handleInstalled = () => {
    deferredInstallPrompt = null;
    setState({ installed: true, installAvailable: false, installKind: 'installed' });
  };
  const handleControllerChange = async () => {
    windowRef?.clearTimeout?.(applyTimer);
    applyTimer = null;
    await refreshWorkerVersion(navigatorRef.serviceWorker.controller || registration?.active);
    if (!applyRequested || reloaded) return;
    reloaded = true;
    windowRef?.location?.reload?.();
  };
  const handleVisibilityChange = () => {
    if (windowRef?.document?.visibilityState === 'visible') checkForUpdate();
  };

  function setState(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  }

  function start() {
    if (started) return registrationPromise;
    started = true;
    windowRef?.addEventListener?.('beforeinstallprompt', handleBeforeInstallPrompt);
    windowRef?.addEventListener?.('appinstalled', handleInstalled);
    windowRef?.document?.addEventListener?.('visibilitychange', handleVisibilityChange);
    if (supported) navigatorRef.serviceWorker.addEventListener?.('controllerchange', handleControllerChange);
    criticalUnsubscribe = criticalOperations?.subscribe?.(nextState => {
      criticalState = nextState;
      setState({ blockedReason: state.updateAvailable ? nextState.blockedReason : '' });
    });
    if (!supported) return null;

    registrationPromise = new Promise(resolve => {
      const register = () => resolve(registerWorker());
      if (windowRef?.document?.readyState === 'complete') register();
      else windowRef?.addEventListener?.('load', register, { once: true });
    }).then(value => value).catch(error => {
      setState({ error: error?.message || 'Service Worker 注册失败' });
      return null;
    });
    return registrationPromise;
  }

  async function registerWorker() {
    if (destroyed) return null;
    const serviceWorkerUrl = new URL('./sw.js', windowRef.document.baseURI);
    registration = await navigatorRef.serviceWorker.register(serviceWorkerUrl, { scope: '/' });
    wireRegistration(registration);
    await refreshWorkerVersion(registration.active || navigatorRef.serviceWorker.controller);
    if (registration.waiting) await markWaiting(registration.waiting);
    await registration.update();
    return registration;
  }

  function wireRegistration(nextRegistration) {
    nextRegistration.addEventListener?.('updatefound', () => {
      const installing = nextRegistration.installing;
      installing?.addEventListener?.('statechange', () => {
        if (installing.state === 'installed' && nextRegistration.waiting) {
          markWaiting(nextRegistration.waiting);
        }
      });
    });
  }

  async function markWaiting(worker) {
    await refreshWorkerVersion(worker, true);
    setState({
      updateAvailable: true,
      updateDismissed: false,
      blockedReason: criticalState.blockedReason || '',
      error: '',
    });
  }

  async function refreshWorkerVersion(worker, waiting = false) {
    if (!worker) return;
    try {
      const versionInfo = await requestWorkerVersion(worker, windowRef);
      if (!waiting) {
        setState({
          currentVersion: versionInfo.version || state.currentVersion,
          commit: versionInfo.commit || state.commit,
          buildId: versionInfo.buildId || state.buildId,
        });
      }
    } catch {
      // 旧 worker 可能还不支持版本消息；不影响页面继续工作。
    }
  }

  async function requestInstall() {
    if (!deferredInstallPrompt) return false;
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setState({ installAvailable: false, installKind: choice?.outcome === 'accepted' ? 'installed' : 'unavailable' });
      return choice?.outcome === 'accepted';
    } catch (error) {
      setState({ error: error?.message || '无法打开安装提示', installAvailable: false });
      return false;
    }
  }

  async function checkForUpdate() {
    if (!registration) await registrationPromise;
    if (!registration || state.checking) return false;
    setState({ checking: true, error: '' });
    try {
      await registration.update();
      if (registration.waiting) await markWaiting(registration.waiting);
      return Boolean(registration.waiting);
    } catch (error) {
      setState({ error: error?.message || '检查更新失败' });
      return false;
    } finally {
      setState({ checking: false });
    }
  }

  async function applyUpdate() {
    const waiting = registration?.waiting;
    const blockedReason = criticalOperations?.getState?.().blockedReason || '';
    if (!waiting) return false;
    if (blockedReason) {
      setState({ blockedReason });
      return false;
    }
    applyRequested = true;
    setState({ applying: true, error: '', blockedReason: '' });
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      windowRef?.clearTimeout?.(applyTimer);
      applyTimer = windowRef?.setTimeout?.(() => {
        if (reloaded) return;
        applyRequested = false;
        setState({ applying: false, error: '更新未能完成，旧版本仍可使用，请重试' });
      }, updateTimeoutMs);
      return true;
    } catch (error) {
      applyRequested = false;
      setState({ applying: false, error: error?.message || '更新失败，旧版本仍可使用' });
      return false;
    }
  }

  function dismissUpdate() {
    setState({ updateDismissed: true });
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
  }

  function destroy() {
    destroyed = true;
    windowRef?.removeEventListener?.('beforeinstallprompt', handleBeforeInstallPrompt);
    windowRef?.removeEventListener?.('appinstalled', handleInstalled);
    windowRef?.document?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    navigatorRef?.serviceWorker?.removeEventListener?.('controllerchange', handleControllerChange);
    criticalUnsubscribe?.();
    windowRef?.clearTimeout?.(applyTimer);
    listeners.clear();
  }

  return {
    start,
    subscribe,
    requestInstall,
    checkForUpdate,
    applyUpdate,
    dismissUpdate,
    getState: () => ({ ...state }),
    destroy,
  };
}

function requestWorkerVersion(worker, windowRef) {
  return new Promise((resolve, reject) => {
    const MessageChannelCtor = windowRef?.MessageChannel || globalThis.MessageChannel;
    if (!MessageChannelCtor) {
      reject(new Error('MessageChannel 不可用'));
      return;
    }
    const channel = new MessageChannelCtor();
    const close = () => {
      channel.port1.close?.();
      channel.port2.close?.();
    };
    const timeout = windowRef?.setTimeout?.(() => {
      close();
      reject(new Error('读取 worker 版本超时'));
    }, 1500);
    channel.port1.onmessage = event => {
      windowRef?.clearTimeout?.(timeout);
      close();
      resolve(event.data || {});
    };
    worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  });
}

export const __testables__ = { detectInstalled, detectIosSafari, requestWorkerVersion };
