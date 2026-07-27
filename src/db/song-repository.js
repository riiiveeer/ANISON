/**
 * 文件功能：歌曲仓储接口。
 * 结构说明：
 * 1. 屏蔽 songs object store 的底层事务；
 * 2. 提供歌曲列表、详情、保存等最小能力；
 * 3. 为后续曲库页与导入链路复用同一数据访问接口。
 */

import { requestToPromise, runTransaction } from './indexed-db.js';

const STORE_NAME = 'songs';

export function createSongRepository(dbContext) {
  return {
    async listSongs() {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, STORE_NAME, 'readonly', async store => {
        const request = store.getAll();
        const items = await requestToPromise(request, '读取歌曲列表失败');
        return items.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      });
    },

    async getSongById(songId) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.get(songId), '读取歌曲失败'));
    },

    async findSongByContentHash(contentHash) {
      if (!dbContext?.database) return null;
      const songs = await runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取歌曲列表失败'));
      return songs.find(song => song.contentHash === contentHash) || null;
    },

    async findSongByFileName(fileName) {
      if (!dbContext?.database || !fileName) return null;
      const songs = await runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取歌曲列表失败'));
      return songs.find(song => song.fileName && song.fileName.toLowerCase() === String(fileName).toLowerCase()) || null;
    },

    async findSongByTitleArtist(title, artist) {
      if (!dbContext?.database || !title) return null;
      const normalizedTitle = String(title).trim().toLowerCase();
      const normalizedArtist = String(artist || '').trim().toLowerCase();
      const songs = await runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取歌曲列表失败'));
      return songs.find(song => {
        const songTitle = String(song.title || '').trim().toLowerCase();
        const songArtist = String(song.artist || '').trim().toLowerCase();
        return songTitle === normalizedTitle && songArtist === normalizedArtist;
      }) || null;
    },

    async findSongBySource(source, sourceSongId) {
      if (!dbContext?.database || !source || !sourceSongId) return null;
      const songs = await runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取歌曲列表失败'));
      return songs.find(song =>
        String(song.source || '') === String(source)
        && String(song.sourceSongId || '') === String(sourceSongId)) || null;
    },

    async saveSong(song) {
      if (!dbContext?.database) return null;
      const payload = {
        ...song,
        updatedAt: song.updatedAt || Date.now(),
        createdAt: song.createdAt || Date.now(),
      };

      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.put(payload), '保存歌曲失败');
        return payload;
      });
    },

    async deleteSong(songId) {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.delete(songId), '删除歌曲失败');
      });
    },

    async clearSongs() {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.clear(), '清空歌曲失败');
      });
    },

    async touchSongStudyTime(songId, timestamp = Date.now()) {
      if (!dbContext?.database) return null;
      const song = await this.getSongById(songId);
      if (!song) return null;

      const nextSong = {
        ...song,
        lastStudiedAt: timestamp,
        updatedAt: timestamp,
      };
      return this.saveSong(nextSong);
    },
  };
}
