/**
 * 文件功能：歌单仓储接口。
 * 结构说明：
 * 1. 提供实施包 1 所需的歌单存储骨架；
 * 2. 当前只提供基础读取与保存；
 * 3. 为实施包 4 的导入链路抽象保留统一入口。
 */

import { requestToPromise, runTransaction } from './indexed-db.js';

const STORE_NAME = 'playlists';
const IMPORT_JOB_STORE_NAME = 'importJobs';

export function createPlaylistRepository(dbContext) {
  return {
    async listPlaylists() {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取歌单列表失败'));
    },

    async savePlaylist(playlist) {
      if (!dbContext?.database) return null;
      const payload = {
        ...playlist,
        updatedAt: playlist.updatedAt || Date.now(),
        createdAt: playlist.createdAt || Date.now(),
      };

      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.put(payload), '保存歌单失败');
        return payload;
      });
    },

    async getPlaylistById(playlistId) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.get(playlistId), '读取歌单失败'));
    },

    async saveImportJob(importJob) {
      if (!dbContext?.database) return importJob;
      const payload = {
        ...importJob,
        updatedAt: importJob.updatedAt || Date.now(),
        createdAt: importJob.createdAt || Date.now(),
      };

      return runTransaction(dbContext, IMPORT_JOB_STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.put(payload), '保存导入任务失败');
        return payload;
      });
    },

    async getImportJobById(jobId) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, IMPORT_JOB_STORE_NAME, 'readonly', store => requestToPromise(store.get(jobId), '读取导入任务失败'));
    },

    async listImportJobs(limit = 10) {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, IMPORT_JOB_STORE_NAME, 'readonly', async store => {
        const items = await requestToPromise(store.getAll(), '读取导入任务列表失败');
        return items
          .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
          .slice(0, limit);
      });
    },

    async listAllImportJobs() {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, IMPORT_JOB_STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取导入任务列表失败'));
    },

    async removeSongFromPlaylists(songId) {
      const playlists = await this.listPlaylists();
      const changed = playlists.filter(playlist => (playlist.songIds || []).includes(songId));
      await Promise.all(changed.map(playlist => this.savePlaylist({
        ...playlist,
        songIds: (playlist.songIds || []).filter(id => id !== songId),
        updatedAt: Date.now(),
      })));
    },

    async clearPlaylists() {
      if (!dbContext?.database) return;
      await runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.clear(), '清空歌单失败');
      });
      await runTransaction(dbContext, IMPORT_JOB_STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.clear(), '清空导入任务失败');
      });
    },
  };
}
