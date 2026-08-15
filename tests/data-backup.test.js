import test from 'node:test';
import assert from 'node:assert/strict';

import { createDataBackupService } from '../src/store/data-backup.js';
import { decomposeSong } from '../src/db/normalized-song.js';

function createMemoryRepositories() {
  const data = {
    songs: [{
      id: 'song_1',
      title: 'Song',
      source: 'netease',
      sourceSongId: '123',
      parsedVersion: 2,
      album: 'Album',
      coverUrl: 'https://p1.music.126.net/test.jpg',
    }],
    playlists: [{ id: 'playlist_1', songIds: ['song_1'] }],
    importJobs: [{ id: 'job_1', status: 'success' }],
    progress: [{ songId: 'song_1', cardStates: {} }],
  };
  return {
    data,
    repositories: {
      songs: {
        async listSongs() { return [...data.songs]; },
        async saveSong(item) { data.songs.push(item); },
        async clearSongs() { data.songs = []; },
      },
      playlists: {
        async listPlaylists() { return [...data.playlists]; },
        async listAllImportJobs() { return [...data.importJobs]; },
        async savePlaylist(item) { data.playlists.push(item); },
        async saveImportJob(item) { data.importJobs.push(item); },
        async clearPlaylists() {
          data.playlists = [];
          data.importJobs = [];
        },
      },
      progress: {
        async listAllProgress() { return [...data.progress]; },
        async saveProgress(item) { data.progress.push(item); },
        async clearProgress() { data.progress = []; },
      },
    },
  };
}

test('data backup: 完整导出后可清空并恢复', async () => {
  const settings = new Map([['anison_ds_key', 'secret']]);
  globalThis.localStorage = {
    getItem(key) { return settings.get(key) || null; },
    setItem(key, value) { settings.set(key, value); },
    removeItem(key) { settings.delete(key); },
  };
  const { data, repositories } = createMemoryRepositories();
  const service = createDataBackupService(repositories);
  const backup = await service.exportData();
  assert.equal(backup.schemaVersion, 3);
  assert.ok(Array.isArray(backup.data.songContents));
  assert.ok(Array.isArray(backup.data.learningStates));
  assert.deepEqual(service.validateBackup(backup), {
    songs: 1,
    playlists: 1,
    progress: 1,
    cards: 0,
    learningUnits: 0,
    learningStates: 0,
  });

  await service.clearAll();
  assert.equal(data.songs.length, 0);
  await service.importData(backup);
  assert.equal(data.songs[0].id, 'song_1');
  assert.equal(data.songs[0].sourceSongId, '123');
  assert.equal(data.songs[0].parsedVersion, 2);
  assert.equal(data.progress[0].songId, 'song_1');
  assert.equal(localStorage.getItem('anison_ds_key'), 'secret');
});

test('data backup: 拒绝未知版本与非法文件', () => {
  const { repositories } = createMemoryRepositories();
  const service = createDataBackupService(repositories);
  assert.throws(() => service.validateBackup({}), /不是 ANISON/);
  assert.throws(() => service.validateBackup({ app: 'ANISON', schemaVersion: 99, data: {} }), /不支持备份版本/);
});

test('data backup: v1 重复歌词转换为共享学习单元', async () => {
  let restored = null;
  const repositories = {
    data: {
      async replaceAll(data) {
        restored = data;
      },
    },
  };
  const service = createDataBackupService(repositories);
  const learned = {
    state: 'mastered',
    favorite: true,
    reviewCount: 3,
    studiedAt: 100,
    lastReviewedAt: 200,
  };
  const backup = {
    app: 'ANISON',
    schemaVersion: 1,
    data: {
      songs: [{
        id: 'duplicate-song',
        title: '重复歌词',
        rawLrc: '[00:01.00]君と歌う\n[00:02.00]君と歌う',
        cards: [
          { id: 'card-1', lyric: '君と歌う', translation: '与你歌唱', learning: learned },
          { id: 'card-2', lyric: '君と歌う', translation: '与你歌唱' },
        ],
      }],
      playlists: [],
      importJobs: [],
      progress: [{
        songId: 'duplicate-song',
        cardStates: { 'card-1': learned },
      }],
    },
    settings: {},
  };

  await service.importData(backup);

  assert.equal(restored.songs.length, 1);
  assert.equal(restored.songContents[0].rawLrc, backup.data.songs[0].rawLrc);
  assert.equal(restored.songContents[0].cards.length, 2);
  assert.equal(restored.learningStates.length, 1);
  assert.equal(restored.learningStates[0].state, 'mastered');
  assert.equal(restored.learningStates[0].favoriteKey, 1);
  assert.equal(restored.progress[0].studiedCount, 1);
});

test('data backup: v2 规范化数组转换为 v4 聚合内容和稀疏状态', async () => {
  let restored = null;
  const service = createDataBackupService({
    data: {
      async replaceAll(data) { restored = data; },
    },
  });
  const normalized = decomposeSong({
    id: 'backup-v2',
    title: 'Backup v2',
    rawLrc: '[00:01.00]君',
    cards: [{
      id: 'backup-card',
      lyric: '君',
      translation: '你',
      type: 'jp-zh',
      learning: { state: 'learning', studiedAt: 1, nextReviewAt: 2 },
    }],
  });
  await service.importData({
    app: 'ANISON',
    schemaVersion: 2,
    data: {
      songs: [normalized.song],
      songLyrics: [normalized.lyrics],
      cards: normalized.cards,
      learningUnits: normalized.learningUnits,
      progress: [normalized.progress],
      playlists: [],
      importJobs: [],
    },
  });

  assert.equal(restored.songContents.length, 1);
  assert.equal(restored.songContents[0].cards.length, 1);
  assert.equal(restored.learningStates.length, 1);
  assert.equal(restored.learningStates[0].state, 'learning');
});

test('data backup: v3 在覆盖前拒绝重复主键、孤立状态和清单篡改', async () => {
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  const { repositories } = createMemoryRepositories();
  const service = createDataBackupService(repositories);
  const valid = await service.exportData();

  const duplicate = structuredClone(valid);
  duplicate.data.songContents.push(duplicate.data.songContents[0]);
  assert.throws(() => service.validateBackup(duplicate), /主键重复/);

  const orphan = structuredClone(valid);
  orphan.data.learningStates.push({
    key: 'missing\u0000unit',
    songId: 'missing',
    unitId: 'unit',
    state: 'learning',
  });
  assert.throws(() => service.validateBackup(orphan), /不存在的学习单元/);

  const alteredManifest = structuredClone(valid);
  alteredManifest.manifest.songs = 2;
  assert.throws(() => service.validateBackup(alteredManifest), /统计 songs 不一致/);
});
