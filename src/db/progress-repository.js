/**
 * 文件功能：学习进度仓储接口。
 * 结构说明：
 * 1. 持久化歌曲级学习进度；
 * 2. 提供读取、保存与最近学习查询；
 * 3. 为后续继续学习和复习任务生成提供数据底座。
 */

import { requestToPromise, runTransaction } from './indexed-db.js';

const STORE_NAME = 'progress';

export function createProgressRepository(dbContext) {
  return {
    async getProgressBySongId(songId) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.get(songId), '读取学习进度失败'));
    },

    async saveProgress(progress) {
      if (!dbContext?.database) return null;
      const payload = {
        ...progress,
        lastStudiedAt: progress.lastStudiedAt || Date.now(),
      };

      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.put(payload), '保存学习进度失败');
        return payload;
      });
    },

    async listRecentProgress(limit = 5) {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, STORE_NAME, 'readonly', async store => {
        const items = await requestToPromise(store.getAll(), '读取最近学习记录失败');
        return items
          .sort((left, right) => (right.lastStudiedAt || 0) - (left.lastStudiedAt || 0))
          .slice(0, limit);
      });
    },

    async listAllProgress() {
      if (!dbContext?.database) return [];
      return runTransaction(dbContext, STORE_NAME, 'readonly', store => requestToPromise(store.getAll(), '读取学习进度列表失败'));
    },

    async deleteProgress(songId) {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.delete(songId), '删除学习进度失败');
      });
    },

    async clearProgress() {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, STORE_NAME, 'readwrite', async store => {
        await requestToPromise(store.clear(), '清空学习进度失败');
      });
    },
  };
}
