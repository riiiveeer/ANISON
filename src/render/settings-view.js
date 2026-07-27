import {
  clearCache,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_STORAGE_KEY,
  normalizeDeepSeekModel,
} from '../engine/ai-explain.js';
import { createDataBackupService } from '../store/data-backup.js';
import { escapeHtml } from './dom-utils.js';

const API_KEY_STORAGE_KEY = 'anison_ds_key';

export async function createSettingsView({ context, navigate }) {
  const backupService = createDataBackupService(context.repositories);
  const backupOverview = await backupService.exportData();
  let hasSavedKey = Boolean(localStorage.getItem(API_KEY_STORAGE_KEY));
  let selectedModel = normalizeDeepSeekModel(localStorage.getItem(DEEPSEEK_MODEL_STORAGE_KEY) || DEFAULT_DEEPSEEK_MODEL);
  let statusMessage = '';
  let statusState = 'default';

  const element = document.createElement('section');
  element.className = 'page page-settings';
  render();
  return { element };

  function render() {
    element.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">偏好与安全</p>
          <h2>设置</h2>
        </div>
      </div>

      <section class="section-card">
        <h3>AI 歌词讲解</h3>
        <p class="muted small">Key 仅保存在当前设备，请勿在共享设备上保存。</p>
        <label class="settings-field">
          DeepSeek API Key
          <input type="password" id="settings-api-key-input" value="${hasSavedKey ? '••••••••••••' : ''}" placeholder="粘贴 DeepSeek API Key" autocomplete="off" />
        </label>
        <label class="settings-field">
          讲解模型
          <select id="settings-model-select">
            <option value="deepseek-v4-flash"${selectedModel === 'deepseek-v4-flash' ? ' selected' : ''}>DeepSeek V4 Flash（推荐，更快）</option>
            <option value="deepseek-v4-pro"${selectedModel === 'deepseek-v4-pro' ? ' selected' : ''}>DeepSeek V4 Pro（更强，费用更高）</option>
          </select>
        </label>
        <div class="button-row">
          <button class="primary-btn compact-button" type="button" data-action="save-key">保存 AI 设置</button>
          <button class="btn-outline" type="button" data-action="clear-key">清除 Key</button>
          <button class="text-btn" type="button" data-action="clear-ai-cache">清除讲解缓存</button>
        </div>
      </section>

      <section class="section-card">
        <h3>本地数据</h3>
        <div class="data-overview">
          <div><strong>${backupOverview.data.songs.length}</strong><span>首歌曲</span></div>
          <div><strong>${backupOverview.data.playlists.length}</strong><span>个歌单</span></div>
          <div><strong>${backupOverview.data.progress.length}</strong><span>条进度</span></div>
        </div>
        <p class="muted small">备份包含歌曲、歌词、学习进度、歌单、导入记录和当前设置。文件中可能包含 API Key，请妥善保管。</p>
        <div class="settings-action-list">
          <button type="button" data-action="export-data"><span>导出完整备份</span><small>保存为 JSON 文件</small></button>
          <label><span>从备份恢复</span><small>导入前会预览数据范围</small><input id="backup-file-input" type="file" accept=".json,application/json" hidden /></label>
          <button class="danger-row" type="button" data-action="clear-data"><span>清空全部本地数据</span><small>歌曲和学习记录会一起删除</small></button>
        </div>
      </section>

      <div class="settings-feedback" data-state="${statusState}" aria-live="polite">${escapeHtml(statusMessage)}</div>
    `;
    bindEvents();
  }

  function bindEvents() {
    element.querySelector('[data-action="save-key"]')?.addEventListener('click', () => {
      const input = element.querySelector('#settings-api-key-input');
      const value = input?.value.trim() || '';
      selectedModel = normalizeDeepSeekModel(element.querySelector('#settings-model-select')?.value || '');
      localStorage.setItem(DEEPSEEK_MODEL_STORAGE_KEY, selectedModel);
      if ((!value || value === '••••••••••••') && !hasSavedKey) {
        setStatus('请先粘贴 API Key。', 'warning');
        return;
      }
      if (value && value !== '••••••••••••') localStorage.setItem(API_KEY_STORAGE_KEY, value);
      hasSavedKey = true;
      setStatus(`AI 设置已保存，当前模型为 ${selectedModel === 'deepseek-v4-pro' ? 'V4 Pro' : 'V4 Flash'}。`, 'success');
    });
    element.querySelector('[data-action="clear-key"]')?.addEventListener('click', () => {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      hasSavedKey = false;
      setStatus('API Key 已清除。', 'success');
    });
    element.querySelector('[data-action="clear-ai-cache"]')?.addEventListener('click', () => {
      clearCache();
      setStatus('AI 讲解缓存已清除。', 'success');
    });
    element.querySelector('[data-action="export-data"]')?.addEventListener('click', exportBackup);
    element.querySelector('#backup-file-input')?.addEventListener('change', importBackup);
    element.querySelector('[data-action="clear-data"]')?.addEventListener('click', clearAllData);
  }

  async function exportBackup() {
    try {
      const payload = await backupService.exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `anison-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus('完整备份已导出。', 'success');
    } catch (error) {
      setStatus(error.message || '导出失败', 'danger');
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const overview = backupService.validateBackup(payload);
      const confirmed = window.confirm(
        `恢复这份备份？\n\n歌曲 ${overview.songs} 首\n歌单 ${overview.playlists} 个\n学习进度 ${overview.progress} 条\n\n当前数据会被替换；失败时会自动回滚。`,
      );
      if (!confirmed) return;
      await backupService.importData(payload);
      window.alert('备份恢复完成，应用将重新加载。');
      window.location.hash = '#/home';
      window.location.reload();
    } catch (error) {
      setStatus(error.message || '备份恢复失败', 'danger');
    }
  }

  async function clearAllData() {
    const confirmed = window.confirm('清空全部本地数据？\n\n所有歌曲、歌单、学习进度和复习记录都会删除，此操作无法撤销。');
    if (!confirmed) return;
    await backupService.clearAll();
    clearCache();
    window.location.hash = '#/home';
    window.location.reload();
  }

  function setStatus(message, state = 'default') {
    statusMessage = message;
    statusState = state;
    render();
  }
}
