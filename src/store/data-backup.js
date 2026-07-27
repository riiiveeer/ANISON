const SCHEMA_VERSION = 1;
const API_KEY_STORAGE_KEY = 'anison_ds_key';
const MODEL_STORAGE_KEY = 'anison_ds_model';

export function createDataBackupService(repositories) {
  async function exportData() {
    const [songs, playlists, importJobs, progress] = await Promise.all([
      repositories.songs.listSongs(),
      repositories.playlists?.listPlaylists?.() || [],
      repositories.playlists?.listAllImportJobs?.() || repositories.playlists?.listImportJobs?.(1000) || [],
      repositories.progress?.listAllProgress?.() || [],
    ]);

    return {
      app: 'ANISON',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data: { songs, playlists, importJobs, progress },
      settings: {
        deepseekApiKey: localStorage.getItem(API_KEY_STORAGE_KEY) || '',
        deepseekModel: localStorage.getItem(MODEL_STORAGE_KEY) || 'deepseek-v4-flash',
      },
    };
  }

  function validateBackup(payload) {
    if (!payload || payload.app !== 'ANISON') throw new Error('这不是 ANISON 备份文件');
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new Error(`暂不支持备份版本 ${payload.schemaVersion ?? '未知'}`);
    for (const key of ['songs', 'playlists', 'importJobs', 'progress']) {
      if (!Array.isArray(payload.data?.[key])) throw new Error(`备份缺少 ${key} 数据`);
    }
    return {
      songs: payload.data.songs.length,
      playlists: payload.data.playlists.length,
      progress: payload.data.progress.length,
    };
  }

  async function clearAll() {
    await repositories.progress?.clearProgress?.();
    await repositories.playlists?.clearPlaylists?.();
    await repositories.songs.clearSongs();
  }

  async function applyBackup(payload) {
    await clearAll();
    for (const song of payload.data.songs) await repositories.songs.saveSong(song);
    for (const playlist of payload.data.playlists) await repositories.playlists?.savePlaylist?.(playlist);
    for (const job of payload.data.importJobs) await repositories.playlists?.saveImportJob?.(job);
    for (const item of payload.data.progress) await repositories.progress?.saveProgress?.(item);
    const apiKey = payload.settings?.deepseekApiKey || '';
    const model = ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(payload.settings?.deepseekModel)
      ? payload.settings.deepseekModel
      : 'deepseek-v4-flash';
    if (apiKey) localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  }

  async function importData(payload) {
    validateBackup(payload);
    const rollback = await exportData();
    try {
      await applyBackup(payload);
    } catch (error) {
      try {
        await applyBackup(rollback);
      } catch {
        throw new Error(`恢复失败，且无法自动回滚：${error.message}`);
      }
      throw error;
    }
  }

  return { exportData, validateBackup, importData, clearAll };
}

export const BACKUP_SCHEMA_VERSION = SCHEMA_VERSION;
