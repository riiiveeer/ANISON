import { requestToPromise, runTransaction } from './indexed-db.js';
import {
  createLearningUnitKey,
  learningFromUnitRecord,
} from './normalized-song.js';
import {
  learningStateForGrade,
  scheduleNextReview,
} from '../engine/review-scheduler.js';

const MAX_TIME = Number.MAX_SAFE_INTEGER;
const MAX_KEY = '\uffff';

export function createLearningRepository(dbContext) {
  return {
    async getReviewOverview(now = Date.now()) {
      const [dueCount, history] = await Promise.all([
        this.countReviewItems({ filter: 'due', dueBefore: now }),
        this.listReviewPage({ filter: 'all', limit: 20 }),
      ]);
      return { dueCount, historyItems: history.items };
    },

    async countReviewItems({ filter = 'due', dueBefore = Date.now() } = {}) {
      if (!dbContext?.database) return 0;
      return runTransaction(dbContext, 'learningUnits', 'readonly', store => {
        const { indexName, range } = createReviewQuery(filter, dueBefore, null);
        return requestToPromise(store.index(indexName).count(range), '统计复习项目失败');
      });
    },

    async listReviewPage({
      filter = 'due',
      dueBefore = Date.now(),
      limit = 50,
      cursor = null,
    } = {}) {
      if (!dbContext?.database) return { items: [], nextCursor: null };
      const pageSize = Math.max(1, Math.min(50, Number(limit) || 50));
      const records = await runTransaction(dbContext, 'learningUnits', 'readonly', store => {
        const query = createReviewQuery(filter, dueBefore, cursor);
        return readCursorPage(store.index(query.indexName), query.range, query.direction, pageSize);
      });
      const items = await hydrateReviewItems(dbContext, records.items);
      return { items, nextCursor: records.nextCursor };
    },

    async updateLearningUnit(songId, cardId, patch = {}) {
      if (!dbContext?.database) return null;
      const timestamp = Date.now();
      return runTransaction(
        dbContext,
        ['cards', 'learningUnits', 'progress', 'songs'],
        'readwrite',
        async stores => {
          const card = await requestToPromise(
            stores.cards.get([songId, cardId]),
            '读取歌词卡失败',
          );
          if (!card?.learningUnitId || card.learningRole !== 'target') return null;
          const unitKey = createLearningUnitKey(songId, card.learningUnitId);
          const [unit, song, currentProgress] = await Promise.all([
            requestToPromise(stores.learningUnits.get(unitKey), '读取学习单元失败'),
            requestToPromise(stores.songs.get(songId), '读取歌曲失败'),
            requestToPromise(stores.progress.get(songId), '读取学习进度失败'),
          ]);
          if (!unit || !song) return null;

          const previous = learningFromUnitRecord(unit);
          const grade = patch.grade || legacyGradeForState(patch.state);
          const firstStudied = Boolean(patch.studied) && previous.state === 'new';
          const nextState = firstStudied
            ? 'learning'
            : grade
              ? learningStateForGrade(grade)
              : (patch.state || previous.state || 'new');
          const reviewCount = grade ? previous.reviewCount + 1 : previous.reviewCount;
          const nextLearning = {
            state: nextState,
            favorite: typeof patch.favorite === 'boolean' ? patch.favorite : previous.favorite,
            reviewCount,
            lapseCount: grade === 'again' ? previous.lapseCount + 1 : previous.lapseCount,
            studiedAt: firstStudied ? timestamp : previous.studiedAt,
            lastReviewedAt: grade ? timestamp : previous.lastReviewedAt,
            nextReviewAt: firstStudied
              ? scheduleNextReview('studied', timestamp)
              : grade
                ? scheduleNextReview(grade, timestamp, reviewCount)
                : previous.nextReviewAt,
          };
          const nextUnit = {
            ...unit,
            state: nextLearning.state,
            favoriteKey: nextLearning.favorite ? 1 : undefined,
            reviewableKey: !['new', 'mastered'].includes(nextLearning.state) ? 1 : undefined,
            historyKey: nextLearning.state !== 'new' ? 1 : undefined,
            reviewCount: nextLearning.reviewCount,
            lapseCount: nextLearning.lapseCount,
            studiedAt: nextLearning.studiedAt,
            lastReviewedAt: nextLearning.lastReviewedAt,
            nextReviewAt: nextLearning.nextReviewAt,
            activityAt: nextLearning.lastReviewedAt || nextLearning.studiedAt || 0,
          };
          const progress = updateProgressCounts(song, currentProgress, previous, nextLearning, cardId, timestamp);
          const nextSong = { ...song, lastStudiedAt: timestamp, updatedAt: timestamp };
          await Promise.all([
            requestToPromise(stores.learningUnits.put(nextUnit), '保存学习单元失败'),
            requestToPromise(stores.progress.put(progress), '保存学习进度失败'),
            requestToPromise(stores.songs.put(nextSong), '更新歌曲学习时间失败'),
          ]);
          return {
            ...progress,
            changedUnit: { unitId: card.learningUnitId, learning: nextLearning },
          };
        },
      );
    },
  };
}

function updateProgressCounts(song, progress, previous, next, cardId, timestamp) {
  const totalUnits = Number(progress?.totalUnits ?? song.learningUnitCount) || 0;
  const wasStudied = previous.state !== 'new';
  const isStudied = next.state !== 'new';
  const wasMastered = previous.state === 'mastered';
  const isMastered = next.state === 'mastered';
  const wasFuzzy = previous.state === 'fuzzy';
  const isFuzzy = next.state === 'fuzzy';
  const studiedCount = Math.max(0, (Number(progress?.studiedCount) || 0) + Number(isStudied) - Number(wasStudied));
  const masteredCount = Math.max(0, (Number(progress?.masteredCount) || 0) + Number(isMastered) - Number(wasMastered));
  const fuzzyCount = Math.max(0, (Number(progress?.fuzzyCount) || 0) + Number(isFuzzy) - Number(wasFuzzy));
  const favoriteCount = Math.max(0, (Number(progress?.favoriteCount) || 0) + Number(next.favorite) - Number(previous.favorite));
  return {
    songId: song.id,
    currentCardId: cardId,
    totalUnits,
    studiedCount,
    masteredCount,
    fuzzyCount,
    favoriteCount,
    completionRate: totalUnits ? studiedCount / totalUnits : 0,
    lastStudiedAt: timestamp,
    storageVersion: 3,
  };
}

async function hydrateReviewItems(dbContext, units) {
  if (!units.length) return [];
  return runTransaction(dbContext, ['cards', 'songs'], 'readonly', async stores => {
    const songCache = new Map();
    return Promise.all(units.map(async unit => {
      let song = songCache.get(unit.songId);
      if (!song) {
        song = await requestToPromise(stores.songs.get(unit.songId), '读取复习歌曲失败');
        songCache.set(unit.songId, song);
      }
      const card = await requestToPromise(
        stores.cards.get([unit.songId, unit.representativeCardId]),
        '读取复习歌词卡失败',
      );
      return {
        ...card,
        id: card?.id || unit.representativeCardId,
        songId: unit.songId,
        songTitle: song?.title || '未命名歌曲',
        songArtist: song?.artist || '未知歌手',
        learning: learningFromUnitRecord(unit),
        due: Boolean(unit.reviewableKey) && (unit.nextReviewAt || 0) <= Date.now(),
        reviewKey: unit.key,
      };
    }));
  });
}

function createReviewQuery(filter, dueBefore, cursor) {
  if (filter === 'due') {
    const lower = cursor || [1, 0, ''];
    return {
      indexName: 'due',
      range: IDBKeyRange.bound(lower, [1, dueBefore, MAX_KEY], Boolean(cursor), false),
      direction: 'next',
    };
  }
  if (filter === 'favorites') {
    return descendingQuery('favorites', 1, cursor);
  }
  if (['learning', 'fuzzy', 'mastered'].includes(filter)) {
    return descendingQuery('state', filter, cursor);
  }
  return descendingQuery('history', 1, cursor);
}

function descendingQuery(indexName, prefix, cursor) {
  return {
    indexName,
    range: IDBKeyRange.bound(
      [prefix, 0, ''],
      cursor || [prefix, MAX_TIME, MAX_KEY],
      false,
      Boolean(cursor),
    ),
    direction: 'prev',
  };
}

function readCursorPage(index, range, direction, limit) {
  return new Promise((resolve, reject) => {
    const items = [];
    let nextCursor = null;
    const request = index.openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || items.length >= limit) {
        resolve({ items, nextCursor });
        return;
      }
      items.push(cursor.value);
      nextCursor = cursor.key;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function legacyGradeForState(state) {
  if (state === 'mastered') return 'good';
  if (state === 'fuzzy') return 'hard';
  if (state === 'learning') return 'again';
  return '';
}
