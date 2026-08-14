import { createLibraryStore } from '../store/library-store.js';
import { escapeHtml, formatRelativeReviewTime } from './dom-utils.js';

const HISTORY_FILTERS = [
  { key: 'all', label: '全部已学习' },
  { key: 'learning', label: '学习中' },
  { key: 'fuzzy', label: '模糊' },
  { key: 'mastered', label: '已掌握' },
  { key: 'favorites', label: '收藏' },
];
const SESSION_PAGE_SIZE = 50;

export async function createReviewView({ context, navigate, query }) {
  const libraryStore = createLibraryStore(context.repositories);
  const overview = await libraryStore.getReviewOverview(Date.now());
  let dueCount = overview.dueCount;
  let historyFilter = 'all';
  let historyItems = overview.historyItems;
  let sessionMode = query.session === 'favorites' ? 'favorites' : query.session === 'due' ? 'due' : '';
  let sessionItems = [];
  let sessionCursor = null;
  let sessionRemaining = 0;
  let completed = 0;
  let forgotten = 0;
  let finished = false;

  if (sessionMode) await loadSession(sessionMode);

  const element = document.createElement('section');
  element.className = 'page page-review';
  render();
  return { element };

  function render() {
    if (finished) renderSummary();
    else if (sessionMode) renderSession();
    else renderOverview();
  }

  function renderOverview() {
    element.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">今日巩固</p><h2>复习</h2></div></div>
      <section class="review-hero-card">
        <span class="review-count">${dueCount}</span>
        <h3>${dueCount ? '张歌词卡等待复习' : '今天的复习已完成'}</h3>
        <p>${dueCount ? `预计 ${Math.max(1, Math.ceil(dueCount / 4))} 分钟` : '可以继续学习新歌词，或浏览收藏卡。'}</p>
        ${dueCount ? '<button class="primary-btn" type="button" data-action="start-due">开始复习</button>' : ''}
      </section>
      <div class="review-secondary-row">
        <button class="btn-outline" type="button" data-action="start-favorites">复习收藏</button>
      </div>
      <details class="section-card history-panel">
        <summary>历史与筛选</summary>
        <label class="history-filter-label">查看
          <select id="history-filter">
            ${HISTORY_FILTERS.map(item => `<option value="${item.key}"${historyFilter === item.key ? ' selected' : ''}>${item.label}</option>`).join('')}
          </select>
        </label>
        <div id="history-results">${renderHistoryItems()}</div>
      </details>
    `;
    bindEvents();
  }

  function renderHistoryItems() {
    if (!historyItems.length) return '<p class="muted small">没有符合条件的学习记录。</p>';
    return `<ul class="review-history-list">${historyItems.slice(0, 20).map(item => `
      <li><div><strong>${escapeHtml(item.lyric || '空白歌词')}</strong>
      <small>${escapeHtml(item.songTitle)} · ${escapeHtml(formatState(item.learning.state))}</small></div>
      <span>${escapeHtml(formatRelativeReviewTime(item.learning.nextReviewAt))}</span></li>
    `).join('')}</ul>`;
  }

  function renderSession() {
    const item = sessionItems[0] || null;
    if (!item) {
      finished = true;
      renderSummary();
      return;
    }
    element.innerHTML = `
      <header class="review-session-header">
        <button class="icon-btn" type="button" data-action="exit-session" aria-label="退出复习">×</button>
        <div><strong>${sessionMode === 'favorites' ? '收藏复习' : '今日复习'}</strong>
        <span>已完成 ${completed} · 剩余 ${sessionRemaining}</span></div>
      </header>
      <div class="progress-track large"><i style="width:${completed + sessionRemaining ? Math.round((completed / (completed + sessionRemaining)) * 100) : 100}%"></i></div>
      <article class="review-focus-card">
        <div class="focus-card-meta"><span>${escapeHtml(item.songTitle)}</span><span>${escapeHtml(item.timeStr || '')}</span></div>
        <p class="focus-lyric">${escapeHtml(item.lyric || '')}</p>
        ${item.translation ? `<details class="lyric-detail"><summary>显示翻译</summary><p>${escapeHtml(item.translation)}</p></details>` : ''}
      </article>
      <div class="review-rating-dock"><p>这句记得怎么样？</p><div>
        <button type="button" data-grade="again"><strong>忘记</strong><small>7 天后</small></button>
        <button type="button" data-grade="hard"><strong>模糊</strong><small>7 天后</small></button>
        <button type="button" data-grade="good"><strong>掌握</strong><small>不再复习</small></button>
      </div></div>
    `;
    bindEvents();
  }

  function renderSummary() {
    element.innerHTML = `
      <section class="review-complete-card">
        <div class="completion-mark">✓</div><p class="eyebrow">本次复习完成</p>
        <h2>完成 ${completed} 张</h2><p>其中忘记 ${forgotten} 张。</p>
        <button class="primary-btn" type="button" data-action="home">回到首页</button>
        <button class="btn-outline full-width" type="button" data-action="start-favorites">继续复习收藏</button>
      </section>
    `;
    bindEvents();
  }

  function bindEvents() {
    element.querySelector('[data-action="start-due"]')?.addEventListener('click', () => startSession('due'));
    element.querySelectorAll('[data-action="start-favorites"]').forEach(button => {
      button.addEventListener('click', () => startSession('favorites'));
    });
    element.querySelector('[data-action="exit-session"]')?.addEventListener('click', () => navigate('review'));
    element.querySelector('[data-action="home"]')?.addEventListener('click', () => navigate('home'));
    element.querySelectorAll('[data-grade]').forEach(button => {
      button.addEventListener('click', () => gradeCurrent(button.dataset.grade));
    });
    element.querySelector('#history-filter')?.addEventListener('change', async event => {
      historyFilter = event.target.value;
      const page = await libraryStore.listReviewPage({ filter: historyFilter, limit: 20 });
      historyItems = page.items;
      const target = element.querySelector('#history-results');
      if (target) target.innerHTML = renderHistoryItems();
    });
  }

  async function startSession(mode) {
    sessionMode = mode;
    completed = 0;
    forgotten = 0;
    finished = false;
    await loadSession(mode);
    window.history.replaceState(null, '', `#/review?session=${mode}`);
    render();
  }

  async function loadSession(mode) {
    const filter = mode === 'favorites' ? 'favorites' : 'due';
    sessionRemaining = await libraryStore.countReviewItems({ filter, dueBefore: Date.now() });
    const page = await libraryStore.listReviewPage({
      filter,
      dueBefore: Date.now(),
      limit: SESSION_PAGE_SIZE,
    });
    sessionItems = page.items;
    sessionCursor = page.nextCursor;
    finished = sessionRemaining === 0;
  }

  async function gradeCurrent(grade) {
    const current = sessionItems[0];
    if (!current) return;
    await libraryStore.updateCardLearning(current.songId, current.id, { grade });
    if (grade === 'again') forgotten += 1;
    completed += 1;
    sessionRemaining = Math.max(0, sessionRemaining - 1);
    sessionItems = sessionItems.slice(1);
    if (sessionItems.length < 10 && sessionCursor) {
      const page = await libraryStore.listReviewPage({
        filter: sessionMode === 'favorites' ? 'favorites' : 'due',
        dueBefore: Date.now(),
        limit: SESSION_PAGE_SIZE,
        cursor: sessionCursor,
      });
      sessionItems.push(...page.items);
      sessionCursor = page.nextCursor;
    }
    if (!sessionRemaining || !sessionItems.length) finished = true;
    render();
  }
}

function formatState(state) {
  if (state === 'mastered') return '已掌握';
  if (state === 'fuzzy') return '模糊';
  if (state === 'learning') return '学习中';
  return '未学';
}
