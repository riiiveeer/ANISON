import { decomposeSong, hydrateSong } from '../db/normalized-song.js';

const SCHEMA_VERSION = 2;
const API_KEY_STORAGE_KEY = 'anison_ds_key';
const MODEL_STORAGE_KEY = 'anison_ds_model';

export function createDataBackupService(repositories) {
  async function getBackupOverview() {
    if (repositories.data?.getOverview) {
      const counts = await repositories.data.getOverview();
      return {
        songs: counts.songs,
        playlists: counts.playlists,
        progress: counts.progress,
        cards: counts.cards,
      };
    }
    const legacy = await readLegacyRepositories(repositories);
    return {
      songs: legacy.songs.length,
      playlists: legacy.playlists.length,
      progress: legacy.progress.length,
      cards: legacy.songs.reduce((sum, song) => sum + (song.cards?.length || 0), 0),
    };
  }

  async function exportData(options = {}) {
    const data = repositories.data?.exportAll
      ? await repositories.data.exportAll(options)
      : normalizeLegacyData(await readLegacyRepositories(repositories));
    return {
      app: 'ANISON',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data,
      settings: readSettings(),
    };
  }

  function validateBackup(payload) {
    if (!payload || payload.app !== 'ANISON') throw new Error('这不是 ANISON 备份文件');
    if (![1, SCHEMA_VERSION].includes(payload.schemaVersion)) {
      throw new Error(`暂不支持备份版本 ${payload.schemaVersion ?? '未知'}`);
    }
    const required = payload.schemaVersion === 1
      ? ['songs', 'playlists', 'importJobs', 'progress']
      : ['songs', 'songLyrics', 'cards', 'learningUnits', 'playlists', 'importJobs', 'progress'];
    for (const key of required) {
      if (!Array.isArray(payload.data?.[key])) throw new Error(`备份缺少 ${key} 数据`);
    }
    return {
      songs: payload.data.songs.length,
      playlists: payload.data.playlists.length,
      progress: payload.data.progress.length,
    };
  }

  async function clearAll() {
    if (repositories.data?.clearAll) {
      await repositories.data.clearAll();
      return;
    }
    await repositories.progress?.clearProgress?.();
    await repositories.playlists?.clearPlaylists?.();
    await repositories.songs.clearSongs();
  }

  async function importData(payload, options = {}) {
    validateBackup(payload);
    const normalized = payload.schemaVersion === 1
      ? normalizeLegacyData(payload.data)
      : payload.data;
    if (repositories.data?.replaceAll) {
      await repositories.data.replaceAll(normalized, options);
    } else {
      await applyToLegacyRepositories(normalized);
    }
    applySettings(payload.settings);
  }

  async function applyToLegacyRepositories(data) {
    const rollback = await readLegacyRepositories(repositories);
    try {
      await clearAll();
      const lyricsMap = new Map(data.songLyrics.map(item => [item.songId, item]));
      const progressMap = new Map(data.progress.map(item => [item.songId, item]));
      const cardsBySong = groupBy(data.cards, 'songId');
      const unitsBySong = groupBy(data.learningUnits, 'songId');
      for (const song of data.songs) {
        await repositories.songs.saveSong(hydrateSong(
          song,
          lyricsMap.get(song.id),
          cardsBySong.get(song.id) || [],
          unitsBySong.get(song.id) || [],
          progressMap.get(song.id),
        ));
      }
      for (const playlist of data.playlists) await repositories.playlists?.savePlaylist?.(playlist);
      for (const job of data.importJobs) await repositories.playlists?.saveImportJob?.(job);
      for (const item of data.progress) await repositories.progress?.saveProgress?.(item);
    } catch (error) {
      await restoreLegacyRepositories(rollback);
      throw error;
    }
  }

  async function restoreLegacyRepositories(data) {
    await clearAll();
    for (const song of data.songs) await repositories.songs.saveSong(song);
    for (const playlist of data.playlists) await repositories.playlists?.savePlaylist?.(playlist);
    for (const job of data.importJobs) await repositories.playlists?.saveImportJob?.(job);
    for (const item of data.progress) await repositories.progress?.saveProgress?.(item);
  }

  return { getBackupOverview, exportData, validateBackup, importData, clearAll };
}

function normalizeLegacyData(data) {
  const progressMap = new Map((data.progress || []).map(item => [item.songId, item]));
  const normalized = {
    songs: [],
    songLyrics: [],
    cards: [],
    learningUnits: [],
    progress: [],
    playlists: [...(data.playlists || [])],
    importJobs: [...(data.importJobs || [])],
  };
  for (const song of data.songs || []) {
    const parts = decomposeSong(song, progressMap.get(song.id));
    normalized.songs.push(parts.song);
    normalized.songLyrics.push(parts.lyrics);
    normalized.cards.push(...parts.cards);
    normalized.learningUnits.push(...parts.learningUnits);
    normalized.progress.push(parts.progress);
  }
  return normalized;
}

async function readLegacyRepositories(repositories) {
  const [songs, playlists, importJobs, progress] = await Promise.all([
    repositories.songs.listSongs(),
    repositories.playlists?.listPlaylists?.() || [],
    repositories.playlists?.listAllImportJobs?.()
      || repositories.playlists?.listImportJobs?.(1000)
      || [],
    repositories.progress?.listAllProgress?.() || [],
  ]);
  return { songs, playlists, importJobs, progress };
}

function readSettings() {
  return {
    deepseekApiKey: localStorage.getItem(API_KEY_STORAGE_KEY) || '',
    deepseekModel: localStorage.getItem(MODEL_STORAGE_KEY) || 'deepseek-v4-flash',
  };
}

function applySettings(settings = {}) {
  const apiKey = settings.deepseekApiKey || '';
  const model = ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(settings.deepseekModel)
    ? settings.deepseekModel
    : 'deepseek-v4-flash';
  if (apiKey) localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  else localStorage.removeItem(API_KEY_STORAGE_KEY);
  localStorage.setItem(MODEL_STORAGE_KEY, model);
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

export const BACKUP_SCHEMA_VERSION = SCHEMA_VERSION;
