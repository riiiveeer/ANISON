export function createPwaStatusView({ root, pwaManager, networkStatus, window: windowRef = window }) {
  let pwaState = pwaManager.getState();
  let networkState = networkStatus.getState();
  let previousOnline = networkState.online;
  let restored = false;
  let restoreTimer = null;

  const unsubscribePwa = pwaManager.subscribe(nextState => {
    pwaState = nextState;
    render();
  });
  const unsubscribeNetwork = networkStatus.subscribe(nextState => {
    if (!previousOnline && nextState.online) {
      restored = true;
      windowRef.clearTimeout(restoreTimer);
      restoreTimer = windowRef.setTimeout(() => {
        restored = false;
        render();
      }, 4000);
    }
    previousOnline = nextState.online;
    networkState = nextState;
    render();
  });

  render();
  return {
    destroy() {
      unsubscribePwa();
      unsubscribeNetwork();
      windowRef.clearTimeout(restoreTimer);
      root.replaceChildren();
    },
  };

  function render() {
    const fragments = [];
    if (!networkState.online) {
      fragments.push(createBanner('offline', '当前离线，本地学习仍可使用'));
    } else if (restored) {
      fragments.push(createBanner('success', '网络已恢复，可主动重试在线功能'));
    }
    if (pwaState.updateAvailable && !pwaState.updateDismissed) {
      fragments.push(createUpdateBanner());
    }
    if (pwaState.error) {
      fragments.push(createBanner('warning', pwaState.error));
    }
    root.replaceChildren(...fragments);
    root.classList.toggle('hidden', fragments.length === 0);
  }

  function createBanner(kind, message) {
    const banner = document.createElement('div');
    banner.className = 'pwa-banner';
    banner.dataset.kind = kind;
    const text = document.createElement('span');
    text.textContent = message;
    banner.appendChild(text);
    return banner;
  }

  function createUpdateBanner() {
    const banner = createBanner(
      'update',
      pwaState.blockedReason ? `发现新版本；${pwaState.blockedReason}` : '发现新版本，可在方便时更新',
    );
    const actions = document.createElement('span');
    actions.className = 'pwa-banner-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = pwaState.applying ? '正在更新…' : '立即更新';
    apply.disabled = Boolean(pwaState.applying || pwaState.blockedReason);
    apply.addEventListener('click', () => pwaManager.applyUpdate());
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = '稍后';
    later.addEventListener('click', () => pwaManager.dismissUpdate());
    actions.append(apply, later);
    banner.appendChild(actions);
    return banner;
  }
}
