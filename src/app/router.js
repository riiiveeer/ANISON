/**
 * 文件功能：移动端单页应用的轻量路由器。
 * 结构说明：
 * 1. 使用 hash 管理首页 / 曲库 / 学习 / 设置切换；
 * 2. 每次切换时重新创建页面视图；
 * 3. 路由器只负责导航，不处理业务状态。
 */

const DEFAULT_ROUTE = 'home';

export function createRouter({ root, routes, context }) {
  let currentCleanup = null;

  function getLocationFromHash() {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    const [routePart, queryString = ''] = raw.split('?');
    const route = routePart && routes[routePart] ? routePart : DEFAULT_ROUTE;
    return {
      route,
      query: Object.fromEntries(new URLSearchParams(queryString)),
    };
  }

  async function renderRoute(route, query = {}) {
    const factory = routes[route] || routes[DEFAULT_ROUTE];
    if (!factory) {
      throw new Error(`未找到路由 ${route} 对应的页面工厂`);
    }

    if (typeof currentCleanup === 'function') {
      currentCleanup();
      currentCleanup = null;
    }

    context.setRouteLabel(route);
    root.innerHTML = '';

    try {
      const view = await factory({ route, query, root, context, navigate });
      if (view?.element) {
        root.appendChild(view.element);
      }
      currentCleanup = typeof view?.destroy === 'function' ? view.destroy : null;
    } catch (error) {
      console.error(error);
      const wrapper = document.createElement('section');
      wrapper.className = 'page';
      const card = document.createElement('article');
      card.className = 'section-card error-card';
      const title = document.createElement('h2');
      title.textContent = '页面暂时无法打开';
      const message = document.createElement('p');
      message.className = 'muted';
      message.textContent = error instanceof Error ? error.message : '发生未知错误';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'primary-btn';
      retry.textContent = '重试';
      retry.addEventListener('click', () => renderRoute(route, query));
      card.append(title, message, retry);
      wrapper.appendChild(card);
      root.appendChild(wrapper);
      context.setStatus('页面加载失败，请重试', 'error');
    }
  }

  function navigate(route, query = {}) {
    const target = routes[route] ? route : DEFAULT_ROUTE;
    const queryString = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== '' && value !== null && value !== undefined),
    ).toString();
    const nextHash = `#/${target}${queryString ? `?${queryString}` : ''}`;
    if (window.location.hash === nextHash) {
      renderRoute(target, query);
      return;
    }
    window.location.hash = nextHash;
  }

  function handleHashChange() {
    const location = getLocationFromHash();
    renderRoute(location.route, location.query);
  }

  function start() {
    window.addEventListener('hashchange', handleHashChange);
    if (!window.location.hash) {
      navigate(DEFAULT_ROUTE);
      return;
    }
    handleHashChange();
  }

  return {
    navigate,
    start,
    getLocationFromHash,
  };
}
