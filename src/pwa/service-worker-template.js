export function renderServiceWorker({ buildId, version, commit, precacheUrls }) {
  const constants = [
    `const BUILD_ID = ${JSON.stringify(buildId)};`,
    `const APP_VERSION = ${JSON.stringify(version)};`,
    `const APP_COMMIT = ${JSON.stringify(commit)};`,
    `const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};`,
  ].join('\n');

  return `${constants}

const SHELL_CACHE = \`anison-shell-\${BUILD_ID}\`;
const RUNTIME_CACHE = \`anison-runtime-\${BUILD_ID}\`;
const SHELL_PREFIX = 'anison-shell-';
const RUNTIME_PREFIX = 'anison-runtime-';
const PRECACHE_PATHS = new Set(PRECACHE_URLS.map(value => new URL(value, self.location.origin).pathname));

self.addEventListener('install', event => {
  event.waitUntil(precacheShell());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(cacheName => {
      const owned = cacheName.startsWith(SHELL_PREFIX) || cacheName.startsWith(RUNTIME_PREFIX);
      return owned && cacheName !== SHELL_CACHE && cacheName !== RUNTIME_CACHE
        ? caches.delete(cacheName)
        : Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'GET_VERSION') {
    const payload = { type: 'VERSION', buildId: BUILD_ID, version: APP_VERSION, commit: APP_COMMIT };
    if (event.ports?.[0]) event.ports[0].postMessage(payload);
    else event.source?.postMessage?.(payload);
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;
  if (request.headers.has('Authorization')) {
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(networkFirstManifest(request));
    return;
  }
  if (PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  for (const url of PRECACHE_URLS) {
    const request = new Request(url, {
      cache: 'reload',
      credentials: 'same-origin',
      redirect: 'error',
    });
    const response = await fetch(request);
    if (!isCacheable(response, new URL(url, self.location.origin).pathname)) {
      throw new Error(\`无法预缓存 \${url}\`);
    }
    await cache.put(url, response.clone());
  }
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response, '/index.html')) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch (error) {
    const runtime = await caches.open(RUNTIME_CACHE);
    const shell = await caches.open(SHELL_CACHE);
    return (await runtime.match('/index.html'))
      || (await shell.match('/index.html'))
      || (await shell.match('/'))
      || Promise.reject(error);
  }
}

async function networkFirstManifest(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response, '/manifest.webmanifest')) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put('/manifest.webmanifest', response.clone());
    }
    return response;
  } catch (error) {
    const runtime = await caches.open(RUNTIME_CACHE);
    const shell = await caches.open(SHELL_CACHE);
    return (await runtime.match('/manifest.webmanifest'))
      || (await shell.match('/manifest.webmanifest'))
      || Promise.reject(error);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  const pathname = new URL(request.url).pathname;
  if (PRECACHE_PATHS.has(pathname) && isCacheable(response, pathname)) {
    await cache.put(request, response.clone());
  }
  return response;
}

function isCacheable(response, pathname) {
  if (!response || response.status !== 200 || response.type === 'opaque' || response.redirected) return false;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (pathname === '/' || pathname === '/index.html') return contentType.includes('text/html');
  if (pathname.endsWith('.webmanifest')) return contentType.includes('manifest') || contentType.includes('json');
  if (pathname.endsWith('.js')) return contentType.includes('javascript');
  if (pathname.endsWith('.css')) return contentType.includes('text/css');
  if (pathname.endsWith('.png')) return contentType.includes('image/png');
  if (pathname.endsWith('.svg')) return contentType.includes('image/svg+xml');
  return true;
}
`;
}
