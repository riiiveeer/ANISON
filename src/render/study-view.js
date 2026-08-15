import { explainLyrics } from '../engine/ai-explain.js';
import { summarizeAnnotatedLearningUnits } from '../engine/learning-units.js';
import { createLibraryStore } from '../store/library-store.js';
import { songStore } from '../store/song-store.js';
import { escapeAttr, escapeHtml, formatRelativeReviewTime } from './dom-utils.js';
import { getExplainButtonText, renderExplainContent } from './lyrics-view.js';

const API_KEY_STORAGE_KEY = 'anison_ds_key';
const STUDY_MODE_STORAGE_KEY = 'anison_study_mode';
const READING_TRANSLATION_STORAGE_KEY = 'anison_reading_translation';
const STUDY_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'new', label: '只看未学' },
  { key: 'favorites', label: '只看收藏' },
];

export async function createStudyView({ context, navigate, query }) {
  const libraryStore = createLibraryStore(context.repositories, { networkStatus: context.networkStatus });
  const element = document.createElement('section');
  element.className = 'page page-study focus-study-page';
  let online = context.networkStatus?.getState?.().online !== false;

  let song = query.songId ? await libraryStore.getSongById(query.songId) : null;
  if (!song && songStore.songId) song = await libraryStore.getSongById(songStore.songId);

  if (!song) {
    element.innerHTML = `
      <div class="empty-block spacious-empty">
        <div class="empty-icon">🎧</div>
        <h2>先选择一首歌</h2>
        <p>学习页会从曲库恢复到上次停留的歌词卡。</p>
        <button class="primary-btn" type="button" data-action="library">打开曲库</button>
      </div>
    `;
    element.querySelector('[data-action="library"]')?.addEventListener('click', () => navigate('library'));
    return { element };
  }

  songStore.loadSong(song);
  songStore.setCurrentSongProgress(song.progress || null);

  let filter = STUDY_FILTERS.some(item => item.key === query.filter) ? query.filter : 'all';
  let studyMode = query.mode === 'scroll'
    ? 'scroll'
    : localStorage.getItem(STUDY_MODE_STORAGE_KEY) === 'scroll'
      ? 'scroll'
      : 'card';
  let showReadingTranslations = localStorage.getItem(READING_TRANSLATION_STORAGE_KEY) !== 'hidden';
  let currentCardId = query.cardId
    || findFirstUnlearnedCardId(songStore.cards)
    || song.progress?.currentCardId
    || getStudyCards()[0]?.id
    || '';
  let touchStartX = 0;
  let readingObserver = null;
  let readingObserverIgnoreUntil = 0;
  normalizeCurrentCard();
  await libraryStore.touchStudyEntry(song.id, currentCardId);
  render();
  const unsubscribeNetwork = context.networkStatus?.subscribe?.(nextState => {
    if (online === nextState.online) return;
    online = nextState.online;
    render();
  });

  return {
    element,
    destroy() {
      readingObserver?.disconnect();
      unsubscribeNetwork?.();
      delete document.body.dataset.studyMode;
    },
  };

  function getStudyCards() {
    const all = songStore.cards;
    if (filter === 'new') {
      return all.filter(card =>
        card.learningUnit?.role === 'target'
        && card.learningUnit?.representativeCardId === card.id
        && (card.learning?.state || 'new') === 'new');
    }
    if (filter === 'favorites') {
      return all.filter(card =>
        card.learning?.favorite
        && (card.learningUnit?.role !== 'target' || card.learningUnit?.representativeCardId === card.id));
    }
    return all;
  }

  function normalizeCurrentCard() {
    const cards = getStudyCards();
    if (!cards.some(card => card.id === currentCardId)) currentCardId = cards[0]?.id || '';
    replaceStudyUrl();
  }

  function render() {
    readingObserver?.disconnect();
    readingObserver = null;
    const cards = getStudyCards();
    const card = cards.find(item => item.id === currentCardId) || cards[0] || null;
    const currentIndex = card ? cards.findIndex(item => item.id === card.id) : -1;
    const allTimelineCards = songStore.cards;
    const allIndex = card ? allTimelineCards.findIndex(item => item.id === card.id) : -1;
    const summary = summarizeCards(allTimelineCards);
    element.className = `page page-study focus-study-page${studyMode === 'scroll' ? ' reading-mode-page' : ''}`;
    document.body.dataset.studyMode = studyMode;

    element.innerHTML = `
      <header class="study-song-header">
        <button class="icon-btn" type="button" data-action="back-library" aria-label="返回曲库">‹</button>
        <div>
          <h2>${escapeHtml(song.title || '未命名歌曲')}</h2>
          <p>${escapeHtml(song.artist || '未知歌手')}</p>
        </div>
        <span>${studyMode === 'scroll' ? `${cards.length} 句` : `${allIndex >= 0 ? allIndex + 1 : 0}/${allTimelineCards.length}`}</span>
      </header>

      <div class="study-progress-block">
        <div class="progress-track large"><i style="width:${summary.percent}%"></i></div>
        <span>日语学习 ${summary.studied}/${summary.total} · ${summary.mastered} 掌握</span>
      </div>

      <div class="study-mode-switch" role="tablist" aria-label="歌词学习方式">
        <button class="${studyMode === 'card' ? 'active' : ''}" type="button" data-study-mode="card" role="tab" aria-selected="${studyMode === 'card'}">
          <strong>单卡</strong><small>逐句学习</small>
        </button>
        <button class="${studyMode === 'scroll' ? 'active' : ''}" type="button" data-study-mode="scroll" role="tab" aria-selected="${studyMode === 'scroll'}">
          <strong>连读</strong><small>上下滚动</small>
        </button>
      </div>

      <div class="study-toolbar">
        <div class="segmented-filter">
          ${STUDY_FILTERS.map(item => `
            <button class="${filter === item.key ? 'active' : ''}" type="button" data-filter="${item.key}">${item.label}</button>
          `).join('')}
        </div>
        ${studyMode === 'card' ? `
          <details class="card-directory">
            <summary>目录</summary>
            <div class="directory-panel">
              ${cards.length ? cards.map((item, index) => `
                <button class="${item.id === card?.id ? 'active' : ''}" type="button" data-card-id="${escapeAttr(item.id)}">
                  <span>${index + 1}. ${escapeHtml(item.lyric || '空白歌词')}</span>
                  <small>${formatCardLearningState(item)}</small>
                </button>
              `).join('') : '<p class="muted small">当前筛选没有歌词卡。</p>'}
            </div>
          </details>
        ` : `
          <button class="reading-translation-toggle" type="button" data-action="toggle-reading-translation">
            ${showReadingTranslations ? '隐藏译文' : '显示译文'}
          </button>
        `}
      </div>

      ${card ? (studyMode === 'scroll'
        ? renderReadingList(cards)
        : renderFocusCard(card, currentIndex, cards.length)) : `
        <div class="empty-block study-filter-empty">
          <h3>${filter === 'favorites' ? '还没有收藏歌词卡' : '未学歌词已经完成'}</h3>
          <p>${filter === 'favorites' ? '点亮任意卡片的收藏按钮后会出现在这里。' : '切换到“全部”可以继续浏览或重新评分。'}</p>
          <button class="btn-outline" type="button" data-filter="all">查看全部</button>
        </div>
      `}
    `;
    bindEvents();
    if (studyMode === 'scroll') restoreReadingPosition();
  }

  function restoreReadingPosition() {
    const readingCardId = currentCardId;
    const target = element.querySelector(`[data-reading-id="${CSS.escape(readingCardId)}"]`);
    if (!target) {
      bindReadingObserver();
      return;
    }
    window.requestAnimationFrame(() => {
      if (studyMode !== 'scroll') return;
      readingObserverIgnoreUntil = performance.now() + 350;
      target.scrollIntoView({ block: 'center' });
      window.requestAnimationFrame(() => {
        if (studyMode === 'scroll') bindReadingObserver();
      });
    });
  }

  function renderReadingList(cards) {
    return `
      <section class="reading-list" aria-label="连续阅读歌词">
        <p class="reading-hint">上下滚动连续阅读；点任意一句可切回单卡学习。</p>
        ${cards.map((card, index) => `
          <article class="reading-lyric-card${card.id === currentCardId ? ' current' : ''}" data-reading-id="${escapeAttr(card.id)}">
            <div class="reading-card-meta">
              <span>${index + 1} · ${escapeHtml(card.timeStr || '')}</span>
              <span class="reading-state" data-state="${escapeAttr(card.learningUnit?.role === 'passive' ? 'passive' : card.learning?.state || 'new')}">${formatCardLearningState(card)}</span>
              <button class="favorite-toggle${card.learning?.favorite ? ' active' : ''}" type="button" data-reading-favorite="${escapeAttr(card.id)}" aria-label="${card.learning?.favorite ? '取消收藏' : '收藏'}">
                ${card.learning?.favorite ? '★' : '☆'}
              </button>
            </div>
            <button class="reading-card-main" type="button" data-reading-card-id="${escapeAttr(card.id)}">
              <strong>${escapeHtml(card.lyric || '')}</strong>
              ${showReadingTranslations && card.translation ? `<span>${escapeHtml(card.translation)}</span>` : ''}
              ${card.extra?.romajiText ? `
                <small class="reading-romaji">${escapeHtml(card.extra.romajiText)}</small>
              ` : ''}
            </button>
          </article>
        `).join('')}
      </section>
    `;
  }

  function renderFocusCard(card, currentIndex, total) {
    const hasKey = Boolean(localStorage.getItem(API_KEY_STORAGE_KEY));
    const romaji = card.extra?.romajiText || '';
    const expanded = Boolean(card.ui?.expanded);
    const isPassive = card.learningUnit?.role === 'passive';
    const isRepeated = (card.learningUnit?.occurrenceCount || 1) > 1;
    const isCoveredRepeat = isRepeated
      && (card.learningUnit?.occurrenceIndex || 1) > 1
      && (card.learning?.state || 'new') !== 'new';
    const canFinish = isPassive
      || (card.learning?.state || 'new') !== 'new'
      || card.explain?.status === 'success';
    const aiRequestDisabled = !online && card.explain?.status !== 'success';
    return `
      <article class="focus-lyric-card" data-focus-card>
        <div class="focus-card-meta">
          <span>${escapeHtml(card.timeStr || '')}</span>
          <button class="favorite-toggle${card.learning?.favorite ? ' active' : ''}" type="button" data-action="favorite">
            ${card.learning?.favorite ? '★ 已收藏' : '☆ 收藏'}
          </button>
        </div>
        <p class="focus-lyric">${escapeHtml(card.lyric || '')}</p>
        ${isPassive ? `
          <div class="learning-role-note passive-note">
            <strong>英文阅读段落</strong>
            <span>保留在歌词时间轴中，不计入日语学习进度，也不会安排复习。</span>
          </div>
        ` : isRepeated ? `
          <div class="learning-role-note repeat-note">
            <strong>${isCoveredRepeat ? '重复句已覆盖' : `本句在歌曲中出现 ${card.learningUnit.occurrenceCount} 次`}</strong>
            <span>${isCoveredRepeat
              ? `与第 ${card.learningUnit.representativeIndex + 1} 句属于同一学习内容，无需再次讲解。`
              : '学习任意一次即可覆盖所有重复位置，并且只安排一次复习。'}</span>
          </div>
        ` : ''}
        ${card.translation ? `
          <details class="lyric-detail" open>
            <summary>翻译</summary>
            <p>${escapeHtml(card.translation)}</p>
          </details>
        ` : ''}
        ${romaji ? `
          <details class="lyric-detail">
            <summary>罗马音</summary>
            <p>${escapeHtml(romaji)}</p>
          </details>
        ` : ''}

        <div class="focus-secondary-actions">
          ${isPassive ? '' : isCoveredRepeat ? `
            ${hasKey ? `
              <button class="text-btn" type="button" data-action="explain"${aiRequestDisabled ? ' disabled' : ''}>
                ${card.explain?.status === 'success' ? '查看已有讲解' : '按需查看讲解'}
              </button>
            ` : ''}
          ` : hasKey ? `
            <button class="explain-btn compact-explain" type="button" data-action="explain"${card.explain?.status === 'loading' || aiRequestDisabled ? ' disabled' : ''}>
              ${escapeHtml(aiRequestDisabled ? '离线时无法请求 AI 讲解' : getExplainButtonText(card))}
            </button>
          ` : `
            <button class="text-btn" type="button" data-action="ai-settings">AI 未配置，前往设置</button>
          `}
        </div>
        <p class="study-completion-note">${escapeHtml(getStudyCompletionMessage(card))}</p>
        <section class="explain-result${expanded ? '' : ' hidden'}" aria-live="polite">
          ${renderExplainContent(card)}
          ${card.explain?.status === 'success' ? `
            <form class="follow-up-row" data-follow-up-form>
              <textarea class="follow-up-input" name="question" rows="2" placeholder="继续追问这句歌词"></textarea>
              <button class="btn-outline" type="submit"${online ? '' : ' disabled'}>${online ? '发送' : '离线不可追问'}</button>
            </form>
          ` : ''}
        </section>

        <div class="card-pager">
          <button class="btn-outline" type="button" data-action="previous"${currentIndex <= 0 ? ' disabled' : ''}>上一张</button>
          <span>${currentIndex + 1} / ${total}</span>
          ${currentIndex >= total - 1
            ? `<button class="btn-outline" type="button" data-action="finish"${canFinish ? '' : ' disabled'}>
                ${isPassive || (card.learning?.state || 'new') !== 'new' ? '完成浏览' : '完成本句'}
              </button>`
            : `<button class="btn-outline" type="button" data-action="next">${card.explain?.status === 'success' && (card.learning?.state || 'new') === 'new' ? '已读，下一张' : '下一张'}</button>`}
        </div>
      </article>
    `;
  }

  function bindEvents() {
    element.querySelector('[data-action="back-library"]')?.addEventListener('click', () => navigate('library'));
    element.querySelector('[data-action="ai-settings"]')?.addEventListener('click', () => navigate('settings'));
    element.querySelectorAll('[data-study-mode]').forEach(button => {
      button.addEventListener('click', () => {
        studyMode = button.dataset.studyMode === 'scroll' ? 'scroll' : 'card';
        localStorage.setItem(STUDY_MODE_STORAGE_KEY, studyMode);
        replaceStudyUrl();
        render();
      });
    });
    element.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        filter = button.dataset.filter || 'all';
        normalizeCurrentCard();
        render();
      });
    });
    element.querySelectorAll('[data-card-id]').forEach(button => {
      button.addEventListener('click', () => {
        currentCardId = button.dataset.cardId || '';
        replaceStudyUrl();
        render();
      });
    });
    element.querySelectorAll('[data-reading-card-id]').forEach(button => {
      button.addEventListener('click', () => {
        currentCardId = button.dataset.readingCardId || '';
        studyMode = 'card';
        localStorage.setItem(STUDY_MODE_STORAGE_KEY, studyMode);
        replaceStudyUrl();
        render();
      });
    });
    element.querySelectorAll('[data-reading-favorite]').forEach(button => {
      button.addEventListener('click', () => toggleFavorite(button.dataset.readingFavorite));
    });
    element.querySelector('[data-action="toggle-reading-translation"]')?.addEventListener('click', () => {
      showReadingTranslations = !showReadingTranslations;
      localStorage.setItem(READING_TRANSLATION_STORAGE_KEY, showReadingTranslations ? 'shown' : 'hidden');
      render();
    });
    element.querySelector('[data-action="previous"]')?.addEventListener('click', () => moveCard(-1));
    element.querySelector('[data-action="next"]')?.addEventListener('click', () => moveCard(1));
    element.querySelector('[data-action="finish"]')?.addEventListener('click', finishCurrentCard);
    element.querySelector('[data-action="favorite"]')?.addEventListener('click', toggleFavorite);
    element.querySelector('[data-action="explain"]')?.addEventListener('click', handleExplain);
    element.querySelector('[data-follow-up-form]')?.addEventListener('submit', handleFollowUp);
    const focusCard = element.querySelector('[data-focus-card]');
    focusCard?.addEventListener('touchstart', event => {
      touchStartX = event.changedTouches[0]?.clientX || 0;
    }, { passive: true });
    focusCard?.addEventListener('touchend', event => {
      const delta = (event.changedTouches[0]?.clientX || 0) - touchStartX;
      if (Math.abs(delta) < 60) return;
      moveCard(delta > 0 ? -1 : 1);
    }, { passive: true });
  }

  function bindReadingObserver() {
    if (!('IntersectionObserver' in window)) return;
    readingObserver = new IntersectionObserver(entries => {
      if (performance.now() < readingObserverIgnoreUntil) return;
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const nextCardId = visible?.target?.dataset?.readingId || '';
      if (!nextCardId || nextCardId === currentCardId) return;
      currentCardId = nextCardId;
      replaceStudyUrl();
      libraryStore.touchStudyEntry(song.id, currentCardId);
      element.querySelectorAll('[data-reading-id]').forEach(node => {
        node.classList.toggle('current', node.dataset.readingId === currentCardId);
      });
    }, { threshold: [0.55, 0.8] });
    element.querySelectorAll('[data-reading-id]').forEach(node => readingObserver.observe(node));
  }

  async function toggleFavorite(cardId = currentCardId) {
    const card = songStore.getCardById(cardId);
    if (!card) return;
    const favorite = !Boolean(card.learning?.favorite);
    const progress = await libraryStore.updateCardLearning(song.id, cardId, { favorite });
    songStore.setCurrentSongProgress(progress);
    currentCardId = cardId;
    normalizeCurrentCard();
    render();
  }

  async function handleExplain() {
    const card = songStore.getCardById(currentCardId);
    if (!card) return;
    if (card.explain?.status === 'success') {
      songStore.updateCardUIState(card.id, { expanded: !card.ui?.expanded });
      render();
      return;
    }
    const apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (!apiKey) {
      navigate('settings');
      return;
    }
    if (!online) {
      songStore.updateCardExplainState(card.id, {
        status: 'error',
        content: '',
        error: '当前离线，联网后可继续使用 AI 讲解',
      });
      render();
      return;
    }
    songStore.updateCardUIState(card.id, { expanded: true });
    songStore.updateCardExplainState(card.id, { status: 'loading', content: '', error: '' });
    render();
    try {
      const result = await explainLyrics(
        card.lyric || '',
        card.translation || '',
        card.extra?.romajiText || '',
        card.songContext || songStore.songContext || '',
        apiKey,
        '',
        { isOnline: () => online },
      );
      songStore.updateCardExplainState(card.id, { status: 'success', content: result, error: '' });
    } catch (error) {
      songStore.updateCardExplainState(card.id, { status: 'error', content: '', error: error.message || 'AI 讲解失败' });
    }
    render();
  }

  async function handleFollowUp(event) {
    event.preventDefault();
    const card = songStore.getCardById(currentCardId);
    const question = new FormData(event.currentTarget).get('question')?.trim();
    const apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (!card || !question || !apiKey) return;
    if (!online) return;
    songStore.updateCardExplainState(card.id, { status: 'loading', content: '', error: '' });
    render();
    try {
      const result = await explainLyrics(
        card.lyric || '',
        card.translation || '',
        card.extra?.romajiText || '',
        card.songContext || songStore.songContext || '',
        apiKey,
        question,
        { isOnline: () => online },
      );
      songStore.updateCardExplainState(card.id, { status: 'success', content: result, error: '' });
    } catch (error) {
      songStore.updateCardExplainState(card.id, { status: 'error', content: '', error: error.message || '追问失败' });
    }
    render();
  }

  async function moveCard(delta) {
    const cards = getStudyCards();
    const currentIndex = cards.findIndex(card => card.id === currentCardId);
    const next = cards[currentIndex + delta];
    if (!next) return;
    if (delta > 0) await markCurrentAsStudiedIfExplained();
    currentCardId = next.id;
    const progress = await libraryStore.touchStudyEntry(song.id, currentCardId);
    songStore.setCurrentSongProgress(progress);
    replaceStudyUrl();
    render();
  }

  async function markCurrentAsStudiedIfExplained() {
    const card = songStore.getCardById(currentCardId);
    if (!card
      || card.learningUnit?.role !== 'target'
      || (card.learning?.state || 'new') !== 'new'
      || card.explain?.status !== 'success') {
      return false;
    }
    const progress = await libraryStore.updateCardLearning(song.id, currentCardId, { studied: true });
    songStore.setCurrentSongProgress(progress);
    return true;
  }

  async function finishCurrentCard() {
    const card = songStore.getCardById(currentCardId);
    if (!card) return;
    if (card.learningUnit?.role === 'target' && (card.learning?.state || 'new') === 'new') {
      const marked = await markCurrentAsStudiedIfExplained();
      if (!marked) return;
    }
    const progress = await libraryStore.touchStudyEntry(song.id, currentCardId);
    songStore.setCurrentSongProgress(progress);
    render();
  }

  function replaceStudyUrl() {
    if (!song?.id) return;
    const params = new URLSearchParams({ songId: song.id });
    if (currentCardId) params.set('cardId', currentCardId);
    if (filter !== 'all') params.set('filter', filter);
    if (studyMode === 'scroll') params.set('mode', 'scroll');
    window.history.replaceState(null, '', `#/study?${params.toString()}`);
  }
}

function summarizeCards(cards) {
  return summarizeAnnotatedLearningUnits(cards);
}

function findFirstUnlearnedCardId(cards = []) {
  return cards.find(card => (
    card.learningUnit?.role === 'target'
    && card.learningUnit?.representativeCardId === card.id
    && (card.learning?.state || 'new') === 'new'
  ))?.id || '';
}

function formatLearningState(state) {
  if (state === 'mastered') return '掌握';
  if (state === 'fuzzy') return '模糊';
  if (state === 'learning') return '学习中';
  return '未学';
}

function formatCardLearningState(card) {
  if (card?.learningUnit?.role === 'passive') return '英文';
  const repeated = (card?.learningUnit?.occurrenceIndex || 1) > 1;
  const state = card?.learning?.state || 'new';
  if (repeated && state !== 'new') return '重复·已学';
  if (repeated) return '重复';
  return formatLearningState(state);
}

function getStudyCompletionMessage(card) {
  if (card.learningUnit?.role === 'passive') {
    return '英文段落只用于保持歌曲阅读连贯，直接进入下一张即可。';
  }
  if ((card.learningUnit?.occurrenceIndex || 1) > 1 && (card.learning?.state || 'new') !== 'new') {
    return '这句的学习状态和复习时间已经与首次出现的位置合并。';
  }
  const state = card.learning?.state || 'new';
  if (state === 'mastered') return '这句已经掌握，不再安排后续复习。';
  if (state !== 'new') {
    return card.learning?.nextReviewAt
      ? `这句已学习，将在${formatRelativeReviewTime(card.learning.nextReviewAt)}复习。`
      : '这句已学习。';
  }
  if (card.explain?.status === 'success') return '讲解已看完，进入下一张后会记为已学，并安排明日复习。';
  return '查看 AI 讲解后进入下一张，即记为已学，并安排明日复习。';
}

export const __testables__ = {
  summarizeCards,
  findFirstUnlearnedCardId,
  formatCardLearningState,
  getStudyCompletionMessage,
};
