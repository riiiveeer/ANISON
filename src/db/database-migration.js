import { requestToPromise, runTransaction } from './indexed-db.js';
import { decomposeSong, isLegacySongRecord } from './normalized-song.js';

const MIGRATION_KEY = 'migration:v3';

export async function migrateDatabaseV3(dbContext, { onProgress } = {}) {
  if (!dbContext?.database) return { total: 0, completed: 0 };
  const songs = await runTransaction(dbContext, 'songs', 'readonly', store =>
    requestToPromise(store.getAll(), '读取待迁移歌曲失败'));
  const legacySongs = songs.filter(isLegacySongRecord);
  const total = legacySongs.length;
  let completed = 0;
  await saveMigrationState(dbContext, { status: 'running', total, completed, updatedAt: Date.now() });
  onProgress?.({ total, completed });

  try {
    for (const song of legacySongs) {
      const progress = await runTransaction(dbContext, 'progress', 'readonly', store =>
        requestToPromise(store.get(song.id), '读取旧学习进度失败'));
      const normalized = decomposeSong(song, progress);
      await runTransaction(
        dbContext,
        ['songs', 'songLyrics', 'cards', 'learningUnits', 'progress', 'meta'],
        'readwrite',
        stores => {
          stores.songLyrics.put(normalized.lyrics);
          normalized.cards.forEach(card => stores.cards.put(card));
          normalized.learningUnits.forEach(unit => stores.learningUnits.put(unit));
          stores.progress.put(normalized.progress);
          stores.songs.put(normalized.song);
          stores.meta.put({
            key: MIGRATION_KEY,
            status: 'running',
            total,
            completed: completed + 1,
            lastSongId: song.id,
            updatedAt: Date.now(),
          });
        },
      );
      completed += 1;
      onProgress?.({ total, completed, songTitle: song.title || '未命名歌曲' });
      if (completed % 10 === 0) await yieldToBrowser();
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
