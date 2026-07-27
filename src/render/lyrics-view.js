/**
 * 歌词卡视图层：只负责基于 cards 渲染 DOM，不持有业务状态。
 */

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderExplainMarkdown(content) {
  const lines = (content || '').split('\n');
  const htmlParts = [];
  let paragraphLines = [];
  let listItems = [];

  function flushParagraph() {
    if (!paragraphLines.length) return;
    htmlParts.push(`<p>${paragraphLines.join('<br>')}</p>`);
    paragraphLines = [];
  }

  function flushList() {
    if (!listItems.length) return;
    htmlParts.push(`<ul>${listItems.map(item => `<li>${item}</li>`).join('')}</ul>`);
    listItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(6, headingMatch[1].length + 1);
      htmlParts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(renderInlineMarkdown(listMatch[1]));
      continue;
    }

    flushList();
    paragraphLines.push(renderInlineMarkdown(trimmed));
  }

  flushParagraph();
  flushList();

  return htmlParts.join('');
}

export function getExplainButtonText(card) {
  if (card.explain.status === 'loading') return '⏳ 分析中...';
  if (card.explain.status === 'error') return '📖 AI 讲解 (重试)';
  if (card.explain.status === 'success' && card.ui.expanded) return '📖 收起讲解';
  return '📖 AI 讲解';
}

export function renderExplainContent(card) {
  if (card.explain.status === 'loading') {
    return '<div class="explain-loading">⏳ AI 正在分析...</div>';
  }

  if (card.explain.status === 'error') {
    return `<div class="explain-error">❌ ${escapeHtml(card.explain.error || '')}</div>`;
  }

  if (card.explain.status === 'success') {
    const html = renderExplainMarkdown(card.explain.content || '');

    return `<div class="explain-content">${html}</div>`;
  }

  return '';
}

export const __testables__ = {
  renderExplainMarkdown,
};

function createFollowUpSection(card, onFollowUpSubmit) {
  const wrapper = document.createElement('div');
  wrapper.className = 'follow-up-panel';

  const label = document.createElement('label');
  label.className = 'follow-up-label';
  label.textContent = '继续追问这句歌词';
  wrapper.appendChild(label);

  const row = document.createElement('div');
  row.className = 'follow-up-row';

  const input = document.createElement('textarea');
  input.className = 'follow-up-input';
  input.placeholder = '例如：这句话为什么这样翻译？';
  input.rows = 2;

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'follow-up-btn';
  submitBtn.textContent = '发送追问';

  const onSubmit = async () => {
    const question = input.value.trim();
    if (!question) return;
    submitBtn.disabled = true;
    try {
      await onFollowUpSubmit?.(card.id, question);
      input.value = '';
    } finally {
      submitBtn.disabled = false;
    }
  };

  submitBtn.addEventListener('click', onSubmit);
  input.addEventListener('keydown', async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      await onSubmit();
    }
  });

  row.appendChild(input);
  row.appendChild(submitBtn);
  wrapper.appendChild(row);

  const hint = document.createElement('div');
  hint.className = 'follow-up-hint';
  hint.textContent = '按 Ctrl/Cmd + Enter 也可以发送';
  wrapper.appendChild(hint);

  return wrapper;
}

export function createLyricCard(card, handlers = {}) {
  const { onExplainClick, onFollowUpSubmit, onLearningAction } = handlers;

  const container = document.createElement('div');
  container.className = 'lrc-card';
  container.dataset.cardId = card.id;

  const timeLabel = document.createElement('div');
  timeLabel.className = 'lrc-time';
  timeLabel.textContent = `⏱ ${card.timeStr}`;
  container.appendChild(timeLabel);

  const body = document.createElement('div');
  body.className = 'lrc-body';

  const learningState = card.learning?.state || 'new';
  const metaRow = document.createElement('div');
  metaRow.className = 'card-meta-row';
  metaRow.innerHTML = `
    <span class="learning-badge" data-state="${learningState}">${getLearningStateLabel(learningState)}</span>
    <button class="favorite-toggle${card.learning?.favorite ? ' active' : ''}" type="button">${card.learning?.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
  `;
  metaRow.querySelector('.favorite-toggle')?.addEventListener('click', async event => {
    event.stopPropagation();
    await onLearningAction?.(card.id, 'favorite');
  });
  body.appendChild(metaRow);

  if (card.type === 'en-zh') {
    if (card.extra.enText) {
      const enDiv = document.createElement('div');
      enDiv.className = 'lrc-en';
      enDiv.textContent = card.extra.enText;
      body.appendChild(enDiv);
    }

    if (card.translation) {
      const zhDiv = document.createElement('div');
      zhDiv.className = 'lrc-zh';
      zhDiv.textContent = card.translation;
      body.appendChild(zhDiv);
    }
  } else {
    const jaDiv = document.createElement('div');
    jaDiv.className = 'line-text';
    jaDiv.textContent = card.lyric;
    body.appendChild(jaDiv);

    if (card.translation) {
      const zhDiv = document.createElement('div');
      zhDiv.className = 'line-translation';
      zhDiv.textContent = card.translation;
      body.appendChild(zhDiv);
    }

    const explainBtn = document.createElement('button');
    explainBtn.className = 'explain-btn';
    explainBtn.textContent = getExplainButtonText(card);
    explainBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await onExplainClick?.(card.id);
    });
    body.appendChild(explainBtn);

    const explainResult = document.createElement('div');
    explainResult.className = `explain-result${card.ui.expanded ? '' : ' hidden'}`;
    explainResult.innerHTML = renderExplainContent(card);
    body.appendChild(explainResult);

    const actions = document.createElement('div');
    actions.className = 'learning-actions';
    actions.innerHTML = `
      <button class="btn-outline" type="button" data-learning-action="learning">开始学习</button>
      <button class="btn-outline" type="button" data-learning-action="fuzzy">有点模糊</button>
      <button class="btn-outline" type="button" data-learning-action="mastered">已掌握</button>
      <button class="btn-outline" type="button" data-learning-action="reset">标记未学</button>
    `;
    actions.querySelectorAll('[data-learning-action]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await onLearningAction?.(card.id, button.dataset.learningAction || 'learning');
      });
    });
    body.appendChild(actions);

    const followUpSection = createFollowUpSection(card, onFollowUpSubmit);
    followUpSection.classList.toggle('hidden', card.explain.status !== 'success' && card.explain.status !== 'loading');
    body.appendChild(followUpSection);
  }

  container.appendChild(body);
  return container;
}

export function renderEmptyState(container) {
  container.innerHTML = `
    <div id="empty-state">
      <div class="empty-icon">🎤</div>
      <p>上传 LRC 歌词文件并点击「分析歌词」开始学习</p>
      <p class="muted small">按时间戳生成歌词卡 · 单卡 AI 讲解</p>
    </div>
  `;
}

export function renderLyricCards(container, cards, handlers = {}) {
  container.innerHTML = '';

  if (!cards.length) {
    renderEmptyState(container);
    return;
  }

  for (const card of cards) {
    container.appendChild(createLyricCard(card, handlers));
  }
}

function getLearningStateLabel(state) {
  if (state === 'mastered') return '已掌握';
  if (state === 'fuzzy') return '待复习';
  if (state === 'learning') return '学习中';
  return '未学';
}
