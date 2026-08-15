import { requestToPromise, runTransaction } from './indexed-db.js';
import { decomposeSong, isLegacySongRecord } from './normalized-song.js';

const MIGRATION_KEY = 'migration:v3';
const MIGRATION_BATCH_SIZE = 50;

export async function migrateDatabaseV3(dbContext, { onProgress } = {}) {
  if (!dbContext?.database) return { total: 0, completed: 0 };
  const songs = await runTransaction(dbContext, 'songs', 'readonly', store =>
    requestToPromise(store.getAll(), '读取待迁移歌曲失败'));
  const legacySongs = songs.filter(isLegacySongRecord);
  const progressRecords = await runTransaction(dbContext, 'progress', 'readonly', store =>
    requestToPromise(store.getAll(), '读取旧学习进度失败'));
  const progressBySongId = new Map(progressRecords.map(progress => [progress.songId, progress]));
  const total = legacySongs.length;
  let completed = 0;
  await saveMigrationState(dbContext, { status: 'running', total, completed, updatedAt: Date.now() });
  onProgress?.({ total, completed });

  try {
    for (let offset = 0; offset < legacySongs.length; offset += MIGRATION_BATCH_SIZE) {
      const batch = legacySongs.slice(offset, offset + MIGRATION_BATCH_SIZE);
      const normalizedBatch = batch.map(song =>
        decomposeSong(song, progressBySongId.get(song.id)));
      const batchCompleted = completed + batch.length;
      await runTransaction(
        dbContext,
        ['songs', 'songLyrics', 'cards', 'learningUnits', 'progress', 'meta'],
        'readwrite',
        stores => {
          for (const normalized of normalizedBatch) {
            stores.songLyrics.put(normalized.lyrics);
            normalized.cards.forEach(card => stores.cards.put(card));
            normalized.learningUnits.forEach(unit => stores.learningUnits.put(unit));
            stores.progress.put(normalized.progress);
            stores.songs.put(normalized.song);
          }
          stores.meta.put({
            key: MIGRATION_KEY,
            status: 'running',
            total,
            completed: batchCompleted,
            lastSongId: batch.at(-1).id,
            updatedAt: Date.now(),
          });
        },
      );
      completed = batchCompleted;
      onProgress?.({
        total,
        completed,
        songTitle: batch.at(-1).title || '未命名歌曲',
      });
      await yieldToBrowser();
    }
    await saveMigrationState(dbContext, {
      status: 'complete',
      total,
      completed,
      updatedAt: Date.now(),
    });
    return { total, completed };
  } catch (error) {
    await saveMigrationState(dbContext, {
      status: 'failed',
      total,
      completed,
      message: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
    throw error;
  }
}

async function saveMigrationState(dbContext, state) {
  return runTransaction(dbContext, 'meta', 'readwrite', store =>
    requestToPromise(store.put({ key: MIGRATION_KEY, ...state }), '保存迁移状态失败'));
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
