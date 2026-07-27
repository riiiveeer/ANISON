/**
 * 文件功能：应用启动编排层。
 * 结构说明：
 * 1. 初始化本地数据库；
 * 2. 创建并挂载路由；
 * 3. 同步顶部状态区与底部导航；
 * 4. 预留 PWA service worker 注册能力。
 */

import { createRouter } from './router.js';
import { initializeDatabase } from '../db/indexed-db.js';
import { createSongRepository } from '../db/song-repository.js';
import { createPlaylistRepository } from '../db/playlist-repository.js';
import { createProgressRepository } from '../db/progress-repository.js';
import { createHomeView } from '../render/home-view.js';
import { createLibraryView } from '../render/library-view.js';
import { createReviewView } from '../render/review-view.js';
import { createStudyView } from '../render/study-view.js';
import { createSettingsView } from '../render/settings-view.js';

export async function bootstrapApp() {
  const pageRoot = document.getElementById('page-root');
  const statusPill = document.getElementById('app-status-pill');
  const statusMessage = document.getElementById('app-status-message');
  const dismissStatusButton = document.getElementById('dismiss-status-button');
  const retryStatusButton = document.getElementById('retry-status-button');
  const headerLibraryButton = document.getElementById('header-library-button');
  const navButtons = Array.from(document.querySelectorAll('.nav-btn'));

  if (!pageRoot || !statusPill || !statusMessage) {
    throw new Error('应用壳层缺少必要挂载节点');
  }

  dismissStatusButton?.addEventListener('click', () => statusPill.classList.add('hidden'));
  retryStatusButton?.addEventListener('click', () => window.location.reload());

  let dbContext = null;
  try {
    dbContext = await initializeDatabase();
  } catch (error) {
    console.error(error);
    showStatus(
      statusPill,
      statusMessage,
      error?.message || '本地数据无法打开，请关闭其他 ANISON 标签页后刷新重试。',
      'error',
      retryStatusButton,
    );
  }

  const repositories = {
    songs: createSongRepository(dbContext),
    playlists: createPlaylistRepository(dbContext),
    progress: createProgressRepository(dbContext),
  };

  const routeContext = {
    repositories,
    dbReady: Boolean(dbContext),
    setStatus(message, kind = 'info') {
      if (kind === 'error') showStatus(statusPill, statusMessage, message, kind);
    },
    setRouteLabel(route) {
      document.body.dataset.route = route;
      navButtons.forEach(button => {
        button.classList.toggle('active', button.dataset.route === route);
      });
      headerLibraryButton?.classList.toggle('hidden', route !== 'study');
    },
  };

  const router = createRouter({
    root: pageRoot,
    context: routeContext,
    routes: {
      home: createHomeView,
      library: createLibraryView,
        review: createReviewView,
      study: createStudyView,
      settings: createSettingsView,
    },
  });

  navButtons.forEach(button => {
    button.addEventListener('click', () => router.navigate(button.dataset.route || 'home'));
  });
  headerLibraryButton?.addEventListener('click', () => router.navigate('library'));

  router.start();
  registerServiceWorker();
}

function showStatus(statusPill, statusMessage, message, kind = 'error', retryButton = null) {
  statusMessage.textContent = message;
  statusPill.dataset.kind = kind;
  retryButton?.classList.toggle('hidden', kind !== 'error');
  statusPill.classList.remove('hidden');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    const serviceWorkerUrl = new URL('./sw.js', document.baseURI);
    navigator.serviceWorker.register(serviceWorkerUrl, { scope: './' }).catch(error => {
      console.warn('Service worker 注册失败:', error);
    });
  });
}
