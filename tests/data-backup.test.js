import test from 'node:test';
import assert from 'node:assert/strict';

import { createDataBackupService } from '../src/store/data-backup.js';

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
  assert.deepEqual(service.validateBackup(backup), { songs: 1, playlists: 1, progress: 1 });

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
