import { createLearningUnitKey, hydrateSong } from '../db/normalized-song.js';
import { createSongDocument, hydrateSongDocument } from '../db/song-document.js';

const SCHEMA_VERSION = 3;
const API_KEY_STORAGE_KEY = 'anison_ds_key';
const MODEL_STORAGE_KEY = 'anison_ds_model';
const CANONICAL_KEYS = [
  'songs', 'songContents', 'learningStates', 'progress', 'playlists', 'importJobs',
];

export function createDataBackupService(repositories) {
  async function getBackupOverview() {
    if (repositories.data?.getOverview) {
      const counts = await repositories.data.getOverview();
      return {
        songs: counts.songs,
        playlists: counts.playlists,
        progress: counts.progress,
        cards: counts.cards,
        learningUnits: counts.learningUnits,
        learningStates: counts.learningStates,
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
      : convertV1Data(await readLegacyRepositories(repositories));
    const canonical = normalizeCanonicalData(data);
    return {
      app: 'ANISON',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      manifest: buildManifest(canonical),
      data: canonical,
      settings: readSettings(),
    };
  }

  function validateBackup(payload) {
    const prepared = prepareBackup(payload);
    return {
      songs: prepared.manifest.songs,
      playlists: prepared.manifest.playlists,
      progress: prepared.manifest.progress,
      cards: prepared.manifest.cards,
      learningUnits: prepared.manifest.learningUnits,
      learningStates: prepared.manifest.learningStates,
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
    const prepared = prepareBackup(payload);
    if (repositories.data?.replaceAll) {
      await repositories.data.replaceAll(prepared.data, options);
    } else {
      await applyToLegacyRepositories(prepared.data);
    }
    applySettings(payload.settings);
  }

  async function applyToLegacyRepositories(data) {
    const rollback = await readLegacyRepositories(repositories);
    try {
      await clearAll();
      const contentMap = new Map(data.songContents.map(item => [item.songId, item]));
      const progressMap = new Map(data.progress.map(item => [item.songId, item]));
      const statesBySong = groupBy(data.learningStates, 'songId');
      for (const song of data.songs) {
        await repositories.songs.saveSong(hydrateSongDocument(
          song,
          contentMap.get(song.id),
          statesBySong.get(song.id) || [],
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

function prepareBackup(payload) {
  if (!payload || payload.app !== 'ANISON') throw new Error('这不是 ANISON 备份文件');
  if (![1, 2, SCHEMA_VERSION].includes(payload.schemaVersion)) {
    throw new Error(`暂不支持备份版本 ${payload.schemaVersion ?? '未知'}`);
  }
  const data = payload.schemaVersion === 1
    ? convertV1Data(payload.data)
    : payload.schemaVersion === 2
      ? convertV2Data(payload.data)
      : normalizeCanonicalData(payload.data);
  validateCanonicalData(data);
  const manifest = buildManifest(data);
  if (payload.schemaVersion === SCHEMA_VERSION) validateManifest(payload.manifest, manifest);
  return { data, manifest };
}

function convertV1Data(data = {}) {
  requireArrays(data, ['songs', 'playlists', 'importJobs', 'progress']);
  const progressMap = new Map(data.progress.map(item => [item.songId, item]));
  return buildCanonicalData(
    data.songs.map(song => createSongDocument(song, progressMap.get(song.id))),
    data,
  );
}

function convertV2Data(data = {}) {
  requireArrays(data, [
    'songs', 'songLyrics', 'cards', 'learningUnits', 'playlists', 'importJobs', 'progress',
  ]);
  const lyricsMap = new Map(data.songLyrics.map(item => [item.songId, item]));
  const progressMap = new Map(data.progress.map(item => [item.songId, item]));
  const cardsBySong = groupBy(data.cards, 'songId');
  const statesBySong = groupBy(data.learningUnits, 'songId');
  const documents = data.songs.map(song => createSongDocument(hydrateSong(
    song,
    lyricsMap.get(song.id),
    cardsBySong.get(song.id) || [],
    statesBySong.get(song.id) || [],
    progressMap.get(song.id),
  ), progressMap.get(song.id)));
  return buildCanonicalData(documents, data);
}

function buildCanonicalData(documents, extras = {}) {
  return {
    songs: documents.map(item => item.song),
    songContents: documents.map(item => item.content),
    learningStates: documents.flatMap(item => item.learningStates),
    progress: documents.map(item => item.progress),
    playlists: [...(extras.playlists || [])],
    importJobs: [...(extras.importJobs || [])],
  };
}

function normalizeCanonicalData(data = {}) {
  requireArrays(data, CANONICAL_KEYS);
  return Object.fromEntries(CANONICAL_KEYS.map(key => [key, [...data[key]]]));
}

function validateCanonicalData(data) {
  const songs = uniqueMap(data.songs, item => item.id, '歌曲');
  const contents = uniqueMap(data.songContents, item => item.songId, '歌曲内容');
  const progress = uniqueMap(data.progress, item => item.songId, '学习进度');
  uniqueMap(data.learningStates, item => item.key, '学习状态');
  if (songs.size !== contents.size || songs.size !== progress.size) {
    throw new Error('备份中的歌曲、内容和进度数量不一致');
  }

  const unitsBySong = new Map();
  for (const [songId, song] of songs) {
    const content = contents.get(songId);
    if (!content || !progress.has(songId)) throw new Error(`歌曲 ${songId} 缺少内容或进度`);
    const unitIds = new Set(
      (content.cards || [])
        .filter(card => card.learningRole === 'target' && card.learningUnitId)
        .map(card => card.learningUnitId),
    );
    if (Number(song.cardCount) !== (content.cards || []).length
      || Number(song.learningUnitCount) !== unitIds.size) {
      throw new Error(`歌曲 ${songId} 的逻辑数量不一致`);
    }
    unitsBySong.set(songId, unitIds);
  }
  for (const state of data.learningStates) {
    const expectedKey = createLearningUnitKey(state.songId, state.unitId);
    if (state.key !== expectedKey || !unitsBySong.get(state.songId)?.has(state.unitId)) {
      throw new Error(`学习状态 ${state.key || '未知'} 引用了不存在的学习单元`);
    }
  }
}

function buildManifest(data) {
  const cards = data.songContents.reduce(
    (sum, content) => sum + (content.cards?.length || 0),
    0,
  );
  const learningUnits = data.songContents.reduce((sum, content) => sum + new Set(
    (content.cards || [])
      .filter(card => card.learningRole === 'target' && card.learningUnitId)
      .map(card => card.learningUnitId),
  ).size, 0);
  return {
    songs: data.songs.length,
    songContents: data.songContents.length,
    cards,
    learningUnits,
    learningStates: data.learningStates.length,
    progress: data.progress.length,
    playlists: data.playlists.length,
    importJobs: data.importJobs.length,
  };
}

function validateManifest(actual, expected) {
  if (!actual || typeof actual !== 'object') throw new Error('备份缺少统计清单');
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`备份统计 ${key} 不一致`);
  }
}

function requireArrays(data, keys) {
  for (const key of keys) {
    if (!Array.isArray(data?.[key])) throw new Error(`备份缺少 ${key} 数据`);
  }
}

function uniqueMap(items, getKey, label) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) throw new Error(`${label}缺少主键`);
    if (map.has(key)) throw new Error(`${label}主键重复：${key}`);
    map.set(key, item);
  }
  return map;
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
  for (const item of items || []) {
    const value = item[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

export const BACKUP_SCHEMA_VERSION = SCHEMA_VERSION;
