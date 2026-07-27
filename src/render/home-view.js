import { createLibraryStore } from '../store/library-store.js';
import { escapeAttr, escapeHtml } from './dom-utils.js';

export async function createHomeView({ context, navigate }) {
  const libraryStore = createLibraryStore(context.repositories);
  const dashboard = await libraryStore.getHomeDashboard();
  const primary = getPrimaryAction(dashboard);
  const continueSong = dashboard.continueSong;

  const element = document.createElement('section');
  element.className = 'page page-home';
  element.innerHTML = `
    <section class="home-focus-card">
      <p class="eyebrow">${escapeHtml(primary.eyebrow)}</p>
      <h2>${escapeHtml(primary.title)}</h2>
      <p>${escapeHtml(primary.description)}</p>
      <button class="primary-btn home-primary" type="button" data-primary-action="${escapeAttr(primary.action)}">
        ${escapeHtml(primary.button)}
      </button>
    </section>

    <section class="compact-overview" aria-label="学习概览">
      <div><strong>${dashboard.songCount}</strong><span>首歌曲</span></div>
      <div><strong>${dashboard.studiedSongs}</strong><span>首已开始</span></div>
      <div><strong>${dashboard.reviewCount}</strong><span>张待复习</span></div>
    </section>

    ${continueSong && primary.action !== 'continue' ? `
      <button class="continue-row" type="button" data-action="continue">
        <span>
          <small>继续学习</small>
          <strong>${escapeHtml(continueSong.title || '未命名歌曲')}</strong>
        </span>
        <span>${Math.round((continueSong.progressSummary?.completionRate || 0) * 100)}% ›</span>
      </button>
    ` : ''}

    <section class="section-card recent-section">
      <div class="section-title-row">
        <h3>最近学习</h3>
        <button class="text-btn" type="button" data-action="library">查看曲库</button>
      </div>
      ${dashboard.recentSongs.some(song => (song.progressSummary?.lastStudiedAt || 0) > 0) ? `
        <ul class="home-song-list">
          ${dashboard.recentSongs
            .filter(song => (song.progressSummary?.lastStudiedAt || 0) > 0)
            .map(song => `
              <li>
                <button type="button" data-song-id="${escapeAttr(song.id)}">
                  <span>${escapeHtml(song.title || '未命名歌曲')}</span>
                  <small>${Math.round((song.progressSummary?.completionRate || 0) * 100)}%</small>
                </button>
              </li>
            `).join('')}
        </ul>
      ` : '<div class="empty-inline">第一次学习会从这里继续。</div>'}
    </section>
  `;

  element.querySelector('[data-primary-action]')?.addEventListener('click', () => runPrimaryAction(primary.action));
  element.querySelector('[data-action="continue"]')?.addEventListener('click', () => openSong(continueSong));
  element.querySelector('[data-action="library"]')?.addEventListener('click', () => navigate('library'));
  element.querySelectorAll('[data-song-id]').forEach(button => {
    button.addEventListener('click', () => {
      const song = dashboard.recentSongs.find(item => item.id === button.dataset.songId);
      openSong(song);
    });
  });

  return { element };

  function runPrimaryAction(action) {
    if (action === 'import') navigate('library', { import: '1' });
    else if (action === 'library') navigate('library');
    else if (action === 'review') navigate('review', { session: 'due' });
    else openSong(continueSong);
  }

  function openSong(song) {
    if (!song) return;
    navigate('study', {
      songId: song.id,
      cardId: song.progressSummary?.currentCardId || '',
    });
  }
}

function getPrimaryAction(dashboard) {
  if (!dashboard.songCount) {
    return {
      action: 'import',
      eyebrow: '从一首喜欢的歌开始',
      title: '导入第一首歌词',
      description: '选择 LRC 文件或粘贴歌词，导入后立即开始学习。',
      button: '导入第一首歌',
    };
  }
  if (dashboard.reviewCount) {
    return {
      action: 'review',
      eyebrow: '今天的任务',
      title: `${dashboard.reviewCount} 张歌词卡待复习`,
      description: `预计 ${Math.max(1, Math.ceil(dashboard.reviewCount / 4))} 分钟，完成后再继续新内容。`,
      button: `开始今日复习（${dashboard.reviewCount}）`,
    };
  }
  if (dashboard.continueSong) {
    return {
      action: 'continue',
      eyebrow: '今天没有到期任务',
      title: `继续《${dashboard.continueSong.title || '未命名歌曲'}》`,
      description: `上次完成到 ${Math.round((dashboard.continueSong.progressSummary?.completionRate || 0) * 100)}%。`,
      button: '继续学习',
    };
  }
  return {
    action: 'library',
    eyebrow: '曲库已准备好',
    title: '选择一首歌开始学习',
    description: '从曲库打开歌曲，或继续导入新的歌词。',
    button: '打开曲库',
  };
}
