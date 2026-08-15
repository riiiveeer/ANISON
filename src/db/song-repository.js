import {
  deleteByIndex,
  requestToPromise,
  runTransaction,
} from './indexed-db.js';
import {
  createProgressSummaryFromRecords,
  normalizeLookupText,
} from './normalized-song.js';
import {
  createSongDocument,
  hydrateSongDocument,
  SONG_STORAGE_VERSION,
} from './song-document.js';

const SONG_STORES = ['songs', 'songContents', 'learningStates', 'progress'];

export function createSongRepository(dbContext) {
  return {
    supportsAtomicCascade: true,

    async listSongs() {
      return this.listSongSummaries();
    },

    async listSongSummaries() {
      if (!dbContext?.database) return [];
      const [songs, progress] = await Promise.all([
        runTransaction(dbContext, 'songs', 'readonly', store =>
          requestToPromise(store.getAll(), '读取歌曲列表失败')),
        runTransaction(dbContext, 'progress', 'readonly', store =>
          requestToPromise(store.getAll(), '读取学习进度列表失败')),
      ]);
      const progressMap = new Map(progress.map(item => [item.songId, item]));
      return songs
        .map(song => ({
          ...song,
          progress: progressMap.get(song.id) || null,
          progressSummary: createProgressSummaryFromRecords(song, progressMap.get(song.id)),
        }))
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    },

    async getHomeOverview(limit = 3) {
      if (!dbContext?.database) {
        return { songCount: 0, studiedSongs: 0, recentSongs: [] };
      }
      const recentLimit = Math.max(1, Math.min(10, Number(limit) || 3));
      const [songCount, studiedSongs, recentRecords] = await Promise.all([
        runTransaction(dbContext, 'songs', 'readonly', store =>
          requestToPromise(store.count(), '统计歌曲失败')),
        runTransaction(dbContext, 'progress', 'readonly', store =>
          requestToPromise(
            store.index('completionRate').count(IDBKeyRange.lowerBound(0, true)),
            '统计已学习歌曲失败',
          )),
        runTransaction(dbContext, 'songs', 'readonly', store =>
          readIndexValues(store.index('lastStudiedAt'), recentLimit)),
      ]);
      const progress = await runTransaction(dbContext, 'progress', 'readonly', store =>
        Promise.all(recentRecords.map(song =>
          requestToPromise(store.get(song.id), '读取最近学习进度失败'))));
      return {
        songCount,
        studiedSongs,
        recentSongs: recentRecords.map((song, index) => ({
          ...song,
          progress: progress[index] || null,
          progressSummary: createProgressSummaryFromRecords(song, progress[index]),
        })),
      };
    },

    async getSongById(songId) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, SONG_STORES, 'readonly', async stores => {
        const [song, content, learningStates, progress] = await Promise.all([
          requestToPromise(stores.songs.get(songId), '读取歌曲失败'),
          requestToPromise(stores.songContents.get(songId), '读取歌曲内容失败'),
          requestToPromise(
            stores.learningStates.index('songId').getAll(songId),
            '读取学习状态失败',
          ),
          requestToPromise(stores.progress.get(songId), '读取学习进度失败'),
        ]);
        return hydrateSongDocument(song, content, learningStates, progress);
      });
    },

    async findSongByContentHash(contentHash) {
      return findByIndex(dbContext, 'contentHash', String(contentHash || ''));
    },

    async findSongByFileName(fileName) {
      const key = normalizeLookupText(fileName);
      return key ? findByIndex(dbContext, 'fileNameKey', key) : null;
    },

    async findSongByTitleArtist(title, artist) {
      if (!title) return null;
      const key = `${normalizeLookupText(title)}\u0000${normalizeLookupText(artist)}`;
      return findByIndex(dbContext, 'titleArtistKey', key);
    },

    async findSongBySource(source, sourceSongId) {
      if (!source || !sourceSongId) return null;
      return findByIndex(dbContext, 'sourceKey', `${source}\u0000${sourceSongId}`);
    },

    async saveSong(song) {
      if (!dbContext?.database) return null;
      const payload = {
        ...song,
        updatedAt: song.updatedAt || Date.now(),
        createdAt: song.createdAt || Date.now(),
      };
      const document = createSongDocument(payload, payload.progress);

      await runTransaction(dbContext, SONG_STORES, 'readwrite', async stores => {
        await deleteByIndex(stores.learningStates, 'songId', song.id, '替换学习状态失败');
        await Promise.all([
          requestToPromise(stores.songs.put(document.song), '保存歌曲失败'),
          requestToPromise(stores.songContents.put(document.content), '保存歌曲内容失败'),
          requestToPromise(stores.progress.put(document.progress), '保存学习进度失败'),
          ...document.learningStates.map(state =>
            requestToPromise(stores.learningStates.put(state), '保存学习状态失败')),
        ]);
      });
      return hydrateSongDocument(
        document.song,
        document.content,
        document.learningStates,
        document.progress,
      );
    },

    async updateSongMeta(songId, { title = '', artist = '' } = {}) {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, 'songs', 'readwrite', async store => {
        const song = await requestToPromise(store.get(songId), '读取歌曲失败');
        if (!song) return null;
        const next = {
          ...song,
          title: String(title || '').trim() || '未命名歌曲',
          artist: String(artist || '').trim(),
          updatedAt: Date.now(),
        };
        next.titleArtistKey = `${normalizeLookupText(next.title)}\u0000${normalizeLookupText(next.artist)}`;
        await requestToPromise(store.put(next), '更新歌曲信息失败');
        return next;
      });
    },

    async deleteSong(songId) {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, [...SONG_STORES, 'playlists'], 'readwrite', async stores => {
        await Promise.all([
          requestToPromise(stores.songs.delete(songId), '删除歌曲失败'),
          requestToPromise(stores.songContents.delete(songId), '删除歌曲内容失败'),
          requestToPromise(stores.progress.delete(songId), '删除学习进度失败'),
          deleteByIndex(stores.learningStates, 'songId', songId, '删除学习状态失败'),
          removeSongFromPlaylists(stores.playlists, songId),
        ]);
      });
    },

    async clearSongs() {
      if (!dbContext?.database) return;
      return runTransaction(dbContext, SONG_STORES, 'readwrite', async stores => {
        await Promise.all(SONG_STORES.map(storeName =>
          requestToPromise(stores[storeName].clear(), `清空 ${storeName} 失败`)));
      });
    },

    async touchSongStudyTime(songId, timestamp = Date.now(), currentCardId = '') {
      if (!dbContext?.database) return null;
      return runTransaction(dbContext, ['songs', 'progress'], 'readwrite', async stores => {
        const [song, progress] = await Promise.all([
          requestToPromise(stores.songs.get(songId), '读取歌曲失败'),
          requestToPromise(stores.progress.get(songId), '读取学习进度失败'),
        ]);
        if (!song) return null;
        const nextSong = { ...song, lastStudiedAt: timestamp, updatedAt: timestamp };
        const nextProgress = {
          songId,
          totalUnits: song.learningUnitCount || 0,
          studiedCount: 0,
          masteredCount: 0,
          fuzzyCount: 0,
          favoriteCount: 0,
          completionRate: 0,
          ...progress,
          currentCardId: currentCardId || progress?.currentCardId || '',
          lastStudiedAt: timestamp,
          storageVersion: SONG_STORAGE_VERSION,
        };
        await Promise.all([
          requestToPromise(stores.songs.put(nextSong), '更新歌曲时间失败'),
          requestToPromise(stores.progress.put(nextProgress), '更新学习进度失败'),
        ]);
        return nextProgress;
      });
    },

    async exportNormalizedData() {
      if (!dbContext?.database) {
        return { songs: [], songContents: [], learningStates: [] };
      }
      return runTransaction(
        dbContext,
        ['songs', 'songContents', 'learningStates'],
        'readonly',
        async stores => {
          const [songs, songContents, learningStates] = await Promise.all([
            requestToPromise(stores.songs.getAll(), '导出歌曲失败'),
            requestToPromise(stores.songContents.getAll(), '导出歌曲内容失败'),
            requestToPromise(stores.learningStates.getAll(), '导出学习状态失败'),
          ]);
          return { songs, songContents, learningStates };
        },
      );
    },
  };
}

async function findByIndex(dbContext, indexName, key) {
  if (!dbContext?.database || !key) return null;
  return runTransaction(dbContext, 'songs', 'readonly', store =>
    requestToPromise(store.index(indexName).get(key), '查找歌曲失败'));
}

function removeSongFromPlaylists(store, songId) {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const songIds = Array.isArray(cursor.value.songIds) ? cursor.value.songIds : [];
      if (!songIds.includes(songId)) {
        cursor.continue();
        return;
      }
      const update = cursor.update({
        ...cursor.value,
        songIds: songIds.filter(id => id !== songId),
        updatedAt: Date.now(),
      });
      update.onsuccess = () => cursor.continue();
      update.onerror = () => reject(update.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function readIndexValues(index, limit) {
  return new Promise((resolve, reject) => {
    const values = [];
    const range = IDBKeyRange.lowerBound(1);
    const request = index.openCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || values.length >= limit) {
        resolve(values);
        return;
      }
      values.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
