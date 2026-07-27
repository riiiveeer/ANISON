import { createLibraryStore } from '../store/library-store.js';
import { escapeAttr, escapeHtml, formatTimeLabel, sanitizeCoverImageUrl } from './dom-utils.js';

export async function createLibraryView({ context, navigate, query }) {
  if (!context.dbReady) {
    const unavailable = document.createElement('section');
    unavailable.className = 'page page-library';
    unavailable.innerHTML = `
      <div class="empty-block spacious-empty">
        <div class="empty-icon">⚠️</div>
        <h2>本地数据暂时无法打开</h2>
        <p>请关闭其他已打开的 ANISON 标签页，然后刷新当前页面。歌曲文件本身没有问题。</p>
        <button class="primary-btn" type="button" data-action="reload">刷新重试</button>
      </div>
    `;
    unavailable.querySelector('[data-action="reload"]')?.addEventListener('click', () => window.location.reload());
    return { element: unavailable };
  }

  const libraryStore = createLibraryStore(context.repositories);
  let currentSort = 'recent-imported';
  let songs = await libraryStore.listSongs(currentSort);
  let searchTerm = '';
  let importOpen = query.import === '1';
  let importTab = 'netease';
  let importMessage = '';
  let importState = 'default';
  let lastImportDetails = [];
  let lastImportJob = null;
  let neteaseInput = '';
  let neteasePreview = null;
  let existingNeteaseSong = null;
  let editingSongId = '';
  let busy = false;
  let activeImportController = null;

  const element = document.createElement('section');
  element.className = 'page page-library';
  render();

  return { element };

  function render() {
    element.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">你的歌词收藏</p>
          <h2>歌曲库</h2>
        </div>
        <span class="count-badge">${songs.length} 首</span>
      </div>

      <div class="library-tools">
        <label class="search-field">
          <span aria-hidden="true">⌕</span>
          <input id="song-search" type="search" value="${escapeAttr(searchTerm)}" placeholder="搜索歌名或歌手" aria-label="搜索歌曲" />
        </label>
        <select id="song-sort" aria-label="歌曲排序">
          <option value="recent-imported"${currentSort === 'recent-imported' ? ' selected' : ''}>最近导入</option>
          <option value="recent-studied"${currentSort === 'recent-studied' ? ' selected' : ''}>最近学习</option>
        </select>
      </div>

      <section class="library-list-section">
        ${songs.length ? `
          <ul class="song-list clean-song-list">
            ${songs.map(renderSongRow).join('')}
          </ul>
          <div id="search-empty" class="empty-block hidden">没有找到匹配的歌曲。</div>
        ` : `
          <div class="empty-block spacious-empty">
            <div class="empty-icon">🎵</div>
            <h3>曲库还是空的</h3>
            <p>导入 LRC 文件或粘贴歌词，下一步会直接开始学习。</p>
            <button class="primary-btn" type="button" data-action="open-import">导入第一首歌</button>
          </div>
        `}
      </section>

      ${songs.length ? '<button class="floating-import-btn" type="button" data-action="open-import" aria-label="导入歌曲">＋</button>' : ''}
      ${importOpen ? renderImportSheet() : ''}
    `;
    bindEvents();
    applySearch();
  }

  function renderSongRow(song) {
    const editing = editingSongId === song.id;
    const searchable = `${song.title || ''} ${song.artist || ''}`.toLocaleLowerCase();
    const coverUrl = sanitizeCoverImageUrl(song.coverUrl);
    const coverFallback = escapeHtml((song.title || '歌').slice(0, 1));
    return `
      <li class="song-library-row" data-song-row data-searchable="${escapeAttr(searchable)}">
        <button class="song-row-main" type="button" data-action="open-song" data-song-id="${escapeAttr(song.id)}">
          <span class="song-cover-placeholder">
            <span aria-hidden="true">${coverFallback}</span>
            ${coverUrl ? `<img src="${escapeAttr(coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-song-cover />` : ''}
          </span>
          <span class="song-row-copy">
            <strong>${escapeHtml(song.title || '未命名歌曲')}</strong>
            <small>${escapeHtml(song.artist || '未知歌手')} · ${song.progressSummary?.totalCards || 0} 张</small>
            <span class="progress-track"><i style="width:${Math.round((song.progressSummary?.completionRate || 0) * 100)}%"></i></span>
          </span>
          <span class="song-row-progress">${Math.round((song.progressSummary?.completionRate || 0) * 100)}%</span>
        </button>
        <details class="song-more">
          <summary aria-label="${escapeAttr(song.title || '歌曲')}更多操作">•••</summary>
          <div class="song-menu-panel">
            <button type="button" data-action="edit-song" data-song-id="${escapeAttr(song.id)}">编辑信息</button>
            <label>
              重新导入歌词
              <input type="file" accept=".lrc,.txt" hidden data-reimport-file="${escapeAttr(song.id)}" />
            </label>
            <button class="danger-text" type="button" data-action="delete-song" data-song-id="${escapeAttr(song.id)}">删除歌曲</button>
          </div>
        </details>
        ${editing ? `
          <form class="inline-edit-form" data-edit-form="${escapeAttr(song.id)}">
            <label>歌名<input name="title" value="${escapeAttr(song.title || '')}" required /></label>
            <label>歌手<input name="artist" value="${escapeAttr(song.artist || '')}" /></label>
            <div class="button-row">
              <button class="primary-btn compact-button" type="submit">保存</button>
              <button class="btn-outline" type="button" data-action="cancel-edit">取消</button>
            </div>
          </form>
        ` : ''}
        <div class="song-row-meta">上次学习：${escapeHtml(formatTimeLabel(song.progressSummary?.lastStudiedAt))}</div>
      </li>
    `;
  }

  function renderImportSheet() {
    return `
      <div class="sheet-backdrop" data-action="close-import">
        <section class="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <div class="sheet-handle"></div>
          <div class="section-title-row">
            <div>
              <h2 id="import-title">导入歌曲</h2>
              <p class="muted small">导入成功后会直接打开第一首歌。</p>
            </div>
            <button class="icon-btn" type="button" data-action="close-import" aria-label="关闭">×</button>
          </div>
          <div class="input-tabs" role="tablist">
            <button class="tab-btn${importTab === 'netease' ? ' active' : ''}" type="button" data-import-tab="netease">网易云链接</button>
            <button class="tab-btn${importTab === 'files' ? ' active' : ''}" type="button" data-import-tab="files">LRC 文件</button>
            <button class="tab-btn${importTab === 'paste' ? ' active' : ''}" type="button" data-import-tab="paste">粘贴歌词</button>
            <button class="tab-btn${importTab === 'playlist' ? ' active' : ''}" type="button" data-import-tab="playlist">高级</button>
          </div>
          ${renderImportPanel()}
          <div id="library-import-result" class="import-feedback" data-state="${escapeAttr(importState)}" aria-live="polite">${escapeHtml(importMessage)}</div>
          ${renderImportDetails()}
          ${busy ? '<button class="btn-outline full-width" type="button" data-action="cancel-import">取消导入</button>' : ''}
        </section>
      </div>
    `;
  }

  function renderImportPanel() {
    if (importTab === 'netease') {
      return renderNeteaseImportPanel();
    }
    if (importTab === 'paste') {
      return `
        <form id="paste-import-form" class="import-panel">
          <div class="form-grid">
            <label>歌名（可选）<input name="title" placeholder="未填写时从歌词或文件名推断" /></label>
            <label>歌手（可选）<input name="artist" placeholder="歌手名" /></label>
          </div>
          <label>LRC 歌词<textarea name="rawLrc" class="playlist-import-textarea" required placeholder="[00:01.00]日文歌词&#10;[00:01.00]中文翻译"></textarea></label>
          <button class="primary-btn" type="submit"${busy ? ' disabled' : ''}>${busy ? '正在导入…' : '导入并开始学习'}</button>
        </form>
      `;
    }
    if (importTab === 'playlist') {
      return `
        <form id="playlist-import-form" class="import-panel">
          <details class="advanced-help">
            <summary>查看文本歌单格式</summary>
            <p>每首歌首行填写“歌名 - 歌手”，后面粘贴 LRC；歌曲之间用 --- 分隔。</p>
          </details>
          <label>歌单名称<input name="playlistName" placeholder="例如：Roselia 每日练习" /></label>
          <label>文本歌单<textarea name="rawText" class="playlist-import-textarea" required placeholder="Song - Artist&#10;[00:01.00]日文歌词&#10;[00:01.00]中文翻译&#10;---"></textarea></label>
          <button class="primary-btn" type="submit"${busy ? ' disabled' : ''}>${busy ? '正在导入…' : '导入文本歌单'}</button>
        </form>
      `;
    }
    return `
      <div class="import-panel file-import-panel">
        <div class="file-picker-card">
          <div class="empty-icon">📄</div>
          <strong>选择一个或多个 LRC 文件</strong>
          <p class="muted small">支持 .lrc 和包含时间标签的 .txt</p>
          <label class="primary-btn file-picker-button">
            选择文件
            <input id="lrc-file-input" type="file" accept=".lrc,.txt" multiple hidden />
          </label>
        </div>
      </div>
    `;
  }

  function renderNeteaseImportPanel() {
    if (!neteasePreview) {
      return `
        <form id="netease-preview-form" class="import-panel netease-import-panel">
          <label>
            网易云公开单曲链接或分享文本
            <textarea name="input" class="netease-link-input" required placeholder="粘贴网易云歌曲链接、完整分享文本，或输入歌曲 ID">${escapeHtml(neteaseInput)}</textarea>
          </label>
          <p class="muted small">仅支持公开单曲，不需要登录网易云。解析完成前不会写入曲库。</p>
          <button class="primary-btn full-width" type="submit"${busy ? ' disabled' : ''}>
            ${busy ? '正在解析歌词…' : '解析歌词'}
          </button>
        </form>
      `;
    }

    const song = neteasePreview.song || {};
    const warnings = Array.isArray(neteasePreview.warnings) ? neteasePreview.warnings : [];
    return `
      <div class="import-panel netease-preview-card">
        <div class="netease-song-preview">
          <span class="netease-cover">
            ${song.coverUrl
              ? `<img src="${escapeAttr(song.coverUrl)}" alt="" referrerpolicy="no-referrer" data-netease-cover />`
              : escapeHtml((song.title || '歌').slice(0, 1))}
          </span>
          <span class="netease-song-copy">
            <strong>${escapeHtml(song.title || '未命名歌曲')}</strong>
            <span>${escapeHtml(song.artist || '未知歌手')}</span>
            ${song.album ? `<small>${escapeHtml(song.album)}</small>` : ''}
          </span>
        </div>
        <div class="netease-track-status" aria-label="歌词轨道状态">
          ${renderTrackStatus('原文', neteasePreview.tracks?.original?.available, true)}
          ${renderTrackStatus('中文翻译', neteasePreview.tracks?.translation?.available)}
          ${renderTrackStatus('罗马音', neteasePreview.tracks?.romaji?.available)}
        </div>
        <p class="netease-card-count">预计生成 ${Number(neteasePreview.analysis?.cardCount || 0)} 张学习卡</p>
        ${warnings.length ? `
          <ul class="netease-warning-list">
            ${warnings.map(warning => `<li>${escapeHtml(warning.message || '部分歌词内容不可用')}</li>`).join('')}
          </ul>
        ` : ''}
        ${existingNeteaseSong ? `
          <div class="netease-existing-note">这首歌已经在曲库中，已有歌词和学习进度不会被覆盖。</div>
          <div class="netease-actions">
            <button class="primary-btn full-width" type="button" data-action="continue-existing-netease">继续学习</button>
            <button class="btn-outline full-width" type="button" data-action="reset-netease"${busy ? ' disabled' : ''}>重新输入</button>
          </div>
        ` : `
          <div class="netease-actions">
            <button class="primary-btn full-width" type="button" data-action="confirm-netease-import"${busy ? ' disabled' : ''}>
              ${busy ? '正在导入…' : '导入并开始学习'}
            </button>
            <button class="btn-outline full-width" type="button" data-action="reset-netease"${busy ? ' disabled' : ''}>重新输入</button>
          </div>
        `}
      </div>
    `;
  }

  function renderImportDetails() {
    if (!lastImportDetails.length) return '';
    return `
      <details class="import-failure-details" open>
        <summary>${lastImportDetails.length} 个失败项</summary>
        <ul>
          ${lastImportDetails.map(item => `
            <li><strong>${escapeHtml(item.fileName || item.title || '未命名歌曲')}</strong><span>${escapeHtml(item.message || '导入失败')}</span></li>
          `).join('')}
        </ul>
        ${lastImportJob ? '<button class="btn-outline full-width" type="button" data-action="retry-import-job">重试失败项</button>' : '<p class="muted small">修正文件后可重新选择导入。</p>'}
      </details>
    `;
  }

  function bindEvents() {
    element.querySelectorAll('[data-action="open-import"]').forEach(button => {
      button.addEventListener('click', () => {
        importOpen = true;
        render();
      });
    });
    element.querySelectorAll('[data-action="close-import"]').forEach(node => {
      node.addEventListener('click', event => {
        if (event.target.closest('.bottom-sheet') && !event.target.closest('.icon-btn')) return;
        activeImportController?.abort();
        activeImportController = null;
        busy = false;
        importOpen = false;
        render();
      });
    });
    element.querySelectorAll('[data-import-tab]').forEach(button => {
      button.addEventListener('click', () => {
        activeImportController?.abort();
        activeImportController = null;
        busy = false;
        importTab = button.dataset.importTab || 'files';
        importMessage = '';
        lastImportDetails = [];
        lastImportJob = null;
        render();
      });
    });
    element.querySelector('[data-action="cancel-import"]')?.addEventListener('click', () => {
      activeImportController?.abort();
      importMessage = '正在停止导入…';
      const feedback = element.querySelector('#library-import-result');
      if (feedback) feedback.textContent = importMessage;
    });
    element.querySelector('[data-action="retry-import-job"]')?.addEventListener('click', retryImportJob);
    element.querySelector('#song-search')?.addEventListener('input', event => {
      searchTerm = event.target.value;
      applySearch();
    });
    element.querySelector('#song-sort')?.addEventListener('change', async event => {
      currentSort = event.target.value;
      songs = await libraryStore.listSongs(currentSort);
      render();
    });
    element.querySelectorAll('[data-action="open-song"]').forEach(button => {
      button.addEventListener('click', () => openSong(button.dataset.songId));
    });
    element.querySelectorAll('[data-action="edit-song"]').forEach(button => {
      button.addEventListener('click', () => {
        editingSongId = button.dataset.songId || '';
        render();
      });
    });
    element.querySelectorAll('[data-action="cancel-edit"]').forEach(button => {
      button.addEventListener('click', () => {
        editingSongId = '';
        render();
      });
    });
    element.querySelectorAll('[data-edit-form]').forEach(form => {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = new FormData(form);
        await libraryStore.updateSongMeta(form.dataset.editForm, {
          title: data.get('title'),
          artist: data.get('artist'),
        });
        editingSongId = '';
        songs = await libraryStore.listSongs(currentSort);
        render();
      });
    });
    element.querySelectorAll('[data-action="delete-song"]').forEach(button => {
      button.addEventListener('click', async () => {
        const song = songs.find(item => item.id === button.dataset.songId);
        if (!song) return;
        const confirmed = window.confirm(`删除《${song.title || '未命名歌曲'}》？\n\n歌词、学习进度和复习记录会一起删除，此操作无法撤销。`);
        if (!confirmed) return;
        await libraryStore.deleteSong(song.id);
        songs = await libraryStore.listSongs(currentSort);
        render();
      });
    });
    element.querySelectorAll('[data-reimport-file]').forEach(input => {
      input.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          await libraryStore.replaceSongLyrics(input.dataset.reimportFile, {
            rawLrc: await file.text(),
            fileName: file.name,
          });
          importMessage = '歌词已更新，原有时间点对应的学习进度会继续保留。';
          songs = await libraryStore.listSongs(currentSort);
          render();
        } catch (error) {
          window.alert(error.message || '重新导入失败');
        }
      });
    });
    element.querySelector('#lrc-file-input')?.addEventListener('change', importFiles);
    element.querySelector('#netease-preview-form')?.addEventListener('submit', previewNeteaseSong);
    element.querySelector('[data-action="confirm-netease-import"]')?.addEventListener('click', importNeteasePreview);
    element.querySelector('[data-action="continue-existing-netease"]')?.addEventListener('click', () => {
      if (existingNeteaseSong) openImportedSong(existingNeteaseSong);
    });
    element.querySelector('[data-action="reset-netease"]')?.addEventListener('click', resetNeteasePreview);
    element.querySelector('[data-netease-cover]')?.addEventListener('error', event => {
      event.currentTarget.remove();
    });
    element.querySelectorAll('[data-song-cover]').forEach(image => {
      image.addEventListener('error', () => image.remove());
    });
    element.querySelector('#paste-import-form')?.addEventListener('submit', importPastedLrc);
    element.querySelector('#playlist-import-form')?.addEventListener('submit', importPlaylist);
  }

  async function previewNeteaseSong(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    neteaseInput = String(data.get('input') || '').trim();
    neteasePreview = null;
    existingNeteaseSong = null;
    activeImportController = new AbortController();
    setImportBusy('正在连接网易云并解析歌词…');

    try {
      const preview = await libraryStore.previewNeteaseSong(neteaseInput, {
        signal: activeImportController.signal,
      });
      neteasePreview = preview;
      existingNeteaseSong = await libraryStore.findSongBySource(
        preview.song.source,
        preview.song.sourceSongId,
      );
      importMessage = existingNeteaseSong
        ? '这首歌已经在曲库中，可直接继续学习。'
        : '歌词解析完成，请确认后导入。';
      importState = existingNeteaseSong ? 'warning' : 'success';
    } catch (error) {
      if (error?.name === 'AbortError') return;
      importMessage = error instanceof Error ? error.message : '解析网易云歌曲失败';
      importState = 'danger';
    } finally {
      busy = false;
      activeImportController = null;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  async function importNeteasePreview() {
    if (!neteasePreview || busy) return;
    setImportBusy('正在保存歌曲和学习卡…');
    try {
      const result = await libraryStore.importNeteasePreview(neteasePreview);
      songs = await libraryStore.listSongs(currentSort);
      if (result.song) {
        openImportedSong(result.song);
        return;
      }
      importMessage = result.message || '导入失败';
      importState = mapImportState(result.status);
    } catch (error) {
      importMessage = error instanceof Error ? error.message : '导入网易云歌曲失败';
      importState = 'danger';
    } finally {
      busy = false;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  function resetNeteasePreview() {
    neteasePreview = null;
    existingNeteaseSong = null;
    importMessage = '';
    importState = 'default';
    render();
  }

  function applySearch() {
    const normalized = searchTerm.trim().toLocaleLowerCase();
    let visibleCount = 0;
    element.querySelectorAll('[data-song-row]').forEach(row => {
      const visible = !normalized || (row.dataset.searchable || '').includes(normalized);
      row.classList.toggle('hidden', !visible);
      if (visible) visibleCount += 1;
    });
    element.querySelector('#search-empty')?.classList.toggle('hidden', visibleCount > 0);
  }

  async function importFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    activeImportController = new AbortController();
    setImportBusy(`正在读取并导入 ${files.length} 个文件…`);
    try {
      const inputs = await Promise.all(files.map(async file => ({
        rawLrc: await file.text(),
        fileName: file.name,
      })));
      const result = await libraryStore.importSongs(inputs, {
        signal: activeImportController.signal,
        onProgress({ completed, total, latest }) {
          const feedback = element.querySelector('#library-import-result');
          if (feedback) {
            feedback.textContent = `正在导入 ${completed}/${total}：${latest?.fileName || latest?.song?.title || '歌词文件'}`;
          }
        },
      });
      importMessage = result.message;
      importState = mapImportState(result.status);
      lastImportDetails = result.results.filter(item => item.status === 'failed');
      const first = result.results.find(item => item.song)?.song;
      songs = await libraryStore.listSongs(currentSort);
      if (first && result.status !== 'cancelled') {
        openSong(first.id);
        return;
      }
    } catch (error) {
      importMessage = error.message || '导入失败';
      importState = 'danger';
      lastImportDetails = [{ title: '粘贴的歌词', message: importMessage }];
    } finally {
      busy = false;
      activeImportController = null;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  async function importPastedLrc(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setImportBusy('正在分析并导入歌词…');
    try {
      const result = await libraryStore.importSingleSong({
        rawLrc: data.get('rawLrc'),
        title: data.get('title'),
        artist: data.get('artist'),
        fileName: data.get('title') ? `${data.get('title')}.lrc` : '',
      });
      if (result.song) {
        openSong(result.song.id);
        return;
      }
      importMessage = result.message;
      importState = mapImportState(result.status);
    } catch (error) {
      importMessage = error.message || '导入失败';
      importState = 'danger';
    } finally {
      busy = false;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  async function importPlaylist(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setImportBusy('正在导入文本歌单…');
    try {
      const result = await libraryStore.importPlaylistFromText({
        playlistName: data.get('playlistName'),
        rawText: data.get('rawText'),
      });
      importMessage = `导入完成：成功 ${result.successCount || 0}，重复 ${result.duplicateCount || 0}，失败 ${result.failedCount || 0}`;
      importState = mapImportState(result.status);
      lastImportJob = result;
      lastImportDetails = (result.results || []).filter(item => item.status === 'failed');
      const first = (result.results || []).find(item => item.song)?.song;
      songs = await libraryStore.listSongs(currentSort);
      if (first) {
        openSong(first.id);
        return;
      }
    } catch (error) {
      importMessage = error.message || '歌单导入失败';
      importState = 'danger';
      lastImportDetails = [{ title: '文本歌单', message: importMessage }];
    } finally {
      busy = false;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  function setImportBusy(message) {
    busy = true;
    importMessage = message;
    importState = 'default';
    render();
  }

  async function retryImportJob() {
    if (!lastImportJob?.id) return;
    setImportBusy('正在重试失败项…');
    try {
      const result = await libraryStore.retryImportJob(lastImportJob.id);
      lastImportJob = result;
      lastImportDetails = (result.results || []).filter(item => item.status === 'failed');
      importMessage = `重试完成：成功 ${result.successCount || 0}，失败 ${result.failedCount || 0}`;
      importState = mapImportState(result.status);
      songs = await libraryStore.listSongs(currentSort);
      const first = (result.results || []).find(item => item.song)?.song;
      if (first) {
        openSong(first.id);
        return;
      }
    } catch (error) {
      importMessage = error.message || '重试失败';
      importState = 'danger';
    } finally {
      busy = false;
      if (window.location.hash.startsWith('#/library')) render();
    }
  }

  function openSong(songId) {
    const song = songs.find(item => item.id === songId);
    navigate('study', {
      songId,
      cardId: song?.progressSummary?.currentCardId || '',
    });
  }

  function openImportedSong(song) {
    navigate('study', {
      songId: song.id,
      cardId: song.progressSummary?.currentCardId || song.cards?.[0]?.id || '',
    });
  }
}

function renderTrackStatus(label, available, required = false) {
  const state = available ? 'available' : required ? 'required-missing' : 'missing';
  const suffix = available ? '可用' : required ? '缺失' : '未提供';
  return `<span data-track-state="${state}">${escapeHtml(label)} · ${escapeHtml(suffix)}</span>`;
}

function mapImportState(status) {
  if (status === 'success') return 'success';
  if (status === 'partial' || status === 'duplicate') return 'warning';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'warning';
  return 'default';
}
