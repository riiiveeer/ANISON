import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import {
  ANISON_DB_NAME,
  initializeDatabase,
  requestToPromise,
  runTransaction,
} from '../src/db/indexed-db.js';
import { createSongRepository } from '../src/db/song-repository.js';
import { createLearningRepository } from '../src/db/learning-repository.js';
import {
  createDataRepository,
  recoverInterruptedRestore,
} from '../src/db/data-repository.js';
import { createLibraryStore } from '../src/store/library-store.js';
import { decomposeSong } from '../src/db/normalized-song.js';

globalThis.window = { indexedDB: globalThis.indexedDB };

test('IndexedDB v4: v2 旧歌曲原子迁移、稀疏状态和归档完整', async () => {
  await resetDatabase();
  const legacy = await openLegacyDatabase();
  const transaction = legacy.transaction(['songs', 'progress'], 'readwrite');
  transaction.objectStore('songs').put({
    id: 'legacy_song',
    title: 'Legacy',
    artist: 'Artist',
    rawLrc: '[00:01.00]君\n[00:01.00]你',
    parsedVersion: 1,
    cards: [
      createCard('c1', '熱異常', '热异常'),
      createCard('c2', '熱異常！', '热异常'),
    ],
    contentHash: 'legacy-hash',
    createdAt: 1,
    updatedAt: 2,
  });
  transaction.objectStore('progress').put({
    songId: 'legacy_song',
    currentCardId: 'c1',
    studiedCardIds: ['c1', 'c2'],
    masteredCardIds: [],
    cardStates: {
      c1: { state: 'learning', nextReviewAt: 1, studiedAt: 1 },
      c2: { state: 'learning', nextReviewAt: 1, studiedAt: 1 },
    },
    lastStudiedAt: 2,
  });
  await transactionDone(transaction);
  legacy.close();

  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const raw = await runTransaction(context, 'songs', 'readonly', store =>
    requestToPromise(store.get('legacy_song')));
  assert.equal(raw.storageVersion, 4);
  assert.equal(Object.hasOwn(raw, 'cards'), false);
  assert.equal(Object.hasOwn(raw, 'rawLrc'), false);

  const hydrated = await songs.getSongById('legacy_song');
  assert.equal(hydrated.rawLrc.includes('君'), true);
  assert.equal(hydrated.cards.length, 2);
  assert.equal(hydrated.cards[0].learning.state, 'learning');
  assert.equal(hydrated.cards[1].learning.state, 'learning');
  assert.equal(hydrated.progress.totalUnits, 1);
  const physical = await runTransaction(
    context,
    ['learningStates', 'migrationArchive'],
    'readonly',
    async stores => Promise.all([
      requestToPromise(stores.learningStates.count()),
      requestToPromise(stores.migrationArchive.count()),
    ]),
  );
  assert.deepEqual(physical, [1, 1]);
  assert.equal(context.database.objectStoreNames.contains('cards'), false);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 大型旧曲库报告原子升级进度且默认状态不落盘', async () => {
  await resetDatabase();
  const legacy = await openLegacyDatabase();
  const transaction = legacy.transaction(['songs', 'progress'], 'readwrite');
  const songs = transaction.objectStore('songs');
  const progress = transaction.objectStore('progress');
  for (let index = 0; index < 101; index += 1) {
    const songId = `legacy-batch-${String(index).padStart(3, '0')}`;
    const cardId = `${songId}-card`;
    songs.put({
      id: songId,
      title: `Legacy Batch ${index}`,
      rawLrc: `[00:01.00]歌詞 ${index}`,
      cards: [createCard(cardId, `歌詞 ${index}`, `歌词 ${index}`)],
      createdAt: index + 1,
      updatedAt: index + 1,
    });
    progress.put({
      songId,
      currentCardId: cardId,
      studiedCardIds: [],
      masteredCardIds: [],
      cardStates: {},
      lastStudiedAt: 0,
    });
  }
  await transactionDone(transaction);
  legacy.close();

  const progressEvents = [];
  const context = await initializeDatabase({
    onUpgradeProgress(event) {
      progressEvents.push({ phase: event.phase, completed: event.completedSongs });
    },
  });
  const result = context.upgradeReport;
  const overview = await createDataRepository(context).getOverview();
  const migrationState = await runTransaction(context, 'meta', 'readonly', store =>
    requestToPromise(store.get('migration:v4')));

  assert.equal(result.totalSongs, 101);
  assert.equal(result.completedSongs, 101);
  assert.equal(result.logicalCards, 101);
  assert.equal(result.logicalLearningUnits, 101);
  assert.equal(result.persistedLearningStates, 0);
  assert.equal(progressEvents.at(-1).phase, 'complete');
  assert.equal(overview.songs, 101);
  assert.equal(overview.cards, 101);
  assert.equal(overview.learningUnits, 101);
  assert.equal(overview.learningStates, 0);
  assert.equal(migrationState.status, 'complete');
  assert.equal(migrationState.totalSongs, 101);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 完整 v3 规范化曲库升级为聚合文档并保留学习状态', async () => {
  await resetDatabase();
  const database = await openV3Database();
  const progress = {
    songId: 'normalized-v3',
    currentCardId: 'v3-card',
    cardStates: {
      'v3-card': { state: 'learning', studiedAt: 10, nextReviewAt: 20 },
    },
    lastStudiedAt: 10,
  };
  const normalized = decomposeSong({
    id: 'normalized-v3',
    title: 'Normalized v3',
    rawLrc: '[00:01.00]歌う',
    cards: [createCard('v3-card', '歌う', '歌唱')],
  }, progress);
  await writeNormalizedV3(database, normalized);
  database.close();

  const context = await initializeDatabase();
  const hydrated = await createSongRepository(context).getSongById('normalized-v3');
  const overview = await createDataRepository(context).getOverview();
  assert.equal(hydrated.cards[0].learning.state, 'learning');
  assert.equal(hydrated.storageVersion, 4);
  assert.equal(overview.songContents, 1);
  assert.equal(overview.learningStates, 1);
  assert.equal(context.database.objectStoreNames.contains('learningUnits'), false);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 部分迁移 v3 按歌曲识别规范化与嵌入式来源', async () => {
  await resetDatabase();
  const database = await openV3Database();
  const normalized = decomposeSong({
    id: 'mixed-normalized',
    title: 'Mixed normalized',
    rawLrc: '[00:01.00]明日',
    cards: [createCard('mixed-card', '明日', '明天')],
  });
  await writeNormalizedV3(database, normalized);
  const transaction = database.transaction(['songs', 'progress'], 'readwrite');
  transaction.objectStore('songs').put({
    id: 'mixed-legacy',
    title: 'Mixed legacy',
    rawLrc: '[00:01.00]未来',
    cards: [createCard('legacy-card', '未来', '未来')],
  });
  transaction.objectStore('progress').put({
    songId: 'mixed-legacy',
    cardStates: { 'legacy-card': { state: 'mastered', studiedAt: 1 } },
  });
  await transactionDone(transaction);
  database.close();

  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const [first, second] = await Promise.all([
    songs.getSongById('mixed-normalized'),
    songs.getSongById('mixed-legacy'),
  ]);
  assert.equal(first.cards[0].lyric, '明日');
  assert.equal(second.cards[0].learning.state, 'mastered');
  assert.equal(context.upgradeReport.totalSongs, 2);
  assert.equal(context.upgradeReport.persistedLearningStates, 1);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 升级写入失败会保留可重新打开的 v2 数据库', async () => {
  await resetDatabase();
  const legacy = await openLegacyDatabase();
  const transaction = legacy.transaction(['songs', 'progress'], 'readwrite');
  transaction.objectStore('songs').put({
    id: 'quota-safe',
    title: 'Quota safe',
    rawLrc: '[00:01.00]君',
    cards: [createCard('quota-card', '君', '你')],
  });
  transaction.objectStore('progress').put({ songId: 'quota-safe', cardStates: {} });
  await transactionDone(transaction);
  legacy.close();

  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function failSongContent(value, key) {
    if (this.name === 'songContents') throw new DOMException('模拟容量不足', 'QuotaExceededError');
    return originalPut.call(this, value, key);
  };
  try {
    await assert.rejects(initializeDatabase());
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  const reopened = await openDatabaseAtVersion(2);
  const read = reopened.transaction('songs').objectStore('songs').get('quota-safe');
  const song = await requestToPromise(read);
  assert.equal(song.cards[0].id, 'quota-card');
  reopened.close();
  await resetDatabase();
});

test('IndexedDB v4: 保存、稀疏状态、复习索引更新和删除保持一致', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const learning = createLearningRepository(context);
  await songs.saveSong({
    id: 'song_1',
    title: 'Song',
    artist: 'Artist',
    rawLrc: '[00:01.00]君',
    cards: [
      createCard('c1', '君と歌う', '与你歌唱'),
      createCard('c2', '君と歌う！', '与你歌唱'),
      { ...createCard('en', 'PASSIONATE ANTHEM', ''), type: 'en-zh' },
    ],
    createdAt: 1,
    updatedAt: 1,
  });

  const summaries = await songs.listSongSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].cardCount, 3);
  assert.equal(summaries[0].learningUnitCount, 1);
  assert.equal((await createDataRepository(context).getOverview()).learningStates, 0);

  await learning.updateLearningUnit('song_1', 'c2', { studied: true });
  assert.equal(await learning.countReviewItems({ filter: 'due', dueBefore: Date.now() + 86400001 }), 1);
  const home = await songs.getHomeOverview();
  assert.equal(home.songCount, 1);
  assert.equal(home.studiedSongs, 1);
  assert.equal(home.recentSongs[0].id, 'song_1');
  const hydrated = await songs.getSongById('song_1');
  assert.equal(hydrated.cards[0].learning.state, 'learning');
  assert.equal(hydrated.cards[1].learning.state, 'learning');
  assert.equal(hydrated.cards[2].learning.state, 'new');
  await runTransaction(context, 'playlists', 'readwrite', store =>
    requestToPromise(store.put({
      id: 'playlist-1',
      name: 'Playlist',
      songIds: ['song_1', 'keep-song'],
      updatedAt: 1,
    })));

  await songs.deleteSong('song_1');
  const counts = await createDataRepository(context).getOverview();
  assert.equal(counts.songs, 0);
  assert.equal(counts.cards, 0);
  assert.equal(counts.learningUnits, 0);
  assert.equal(counts.progress, 0);
  const playlist = await runTransaction(context, 'playlists', 'readonly', store =>
    requestToPromise(store.get('playlist-1')));
  assert.deepEqual(playlist.songIds, ['keep-song']);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 读取聚合歌词卡时按数值时间戳排序', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  await songs.saveSong({
    id: 'netease-timeline-order',
    title: '熱異常',
    source: 'netease',
    sourceSongId: '2702706957',
    rawLrc: '[00:00.609]第一句\n[00:05.992]第二句\n[00:10.966]第三句',
    cards: [
      { ...createCard('609', '第一句', '一'), timestamp: 609, timeStr: '00:00.60' },
      { ...createCard('5992', '第二句', '二'), timestamp: 5992, timeStr: '00:05.99' },
      { ...createCard('10966', '第三句', '三'), timestamp: 10966, timeStr: '00:10.96' },
    ],
  });

  const hydrated = await songs.getSongById('netease-timeline-order');
  assert.deepEqual(hydrated.cards.map(card => card.id), ['609', '5992', '10966']);
  assert.deepEqual(hydrated.cards.map(card => card.lyric), ['第一句', '第二句', '第三句']);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 恢复取消后从持久化恢复点回滚', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const dataRepository = createDataRepository(context);
  await songs.saveSong({
    id: 'original',
    title: 'Original',
    rawLrc: '[00:01.00]君',
    cards: [createCard('c1', '君', '你')],
  });
  const replacement = await dataRepository.exportAll();
  replacement.songs[0] = { ...replacement.songs[0], id: 'replacement', title: 'Replacement' };
  replacement.songContents[0] = { ...replacement.songContents[0], songId: 'replacement' };
  replacement.learningStates = replacement.learningStates.map(unit => ({
    ...unit,
    key: unit.key.replace('original', 'replacement'),
    songId: 'replacement',
  }));
  replacement.progress[0] = { ...replacement.progress[0], songId: 'replacement' };

  const controller = new AbortController();
  await assert.rejects(
    dataRepository.replaceAll(replacement, {
      signal: controller.signal,
      onProgress(event) {
        if (event.phase === 'staging') controller.abort();
      },
    }),
    error => error.name === 'AbortError',
  );
  assert.equal((await songs.listSongSummaries())[0].id, 'original');
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 恢复快照原生分页完整覆盖多批次聚合记录', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const itemCount = 4101;
  await runTransaction(context, ['songContents', 'learningStates'], 'readwrite', stores => {
    for (let index = 0; index < itemCount; index += 1) {
      const id = `card-${String(index).padStart(5, '0')}`;
      const unitId = `unit-${String(index).padStart(5, '0')}`;
      const songId = `paged-restore-${String(index).padStart(5, '0')}`;
      stores.songContents.put({
        songId,
        cards: [{ id, timestamp: index, lyric: `歌词 ${index}`, learningUnitId: unitId }],
      });
      stores.learningStates.put({
        key: `${songId}\u0000${unitId}`,
        songId,
        unitId,
        state: 'new',
      });
    }
  });

  const repository = createDataRepository(context);
  const backup = await repository.exportAll();
  backup.songContents[0] = {
    ...backup.songContents[0],
    cards: [{ ...backup.songContents[0].cards[0], lyric: '恢复后的第一句' }],
  };
  await repository.replaceAll(backup);
  const restored = await repository.exportAll();

  assert.equal(restored.songContents.length, itemCount);
  assert.equal(restored.learningStates.length, itemCount);
  assert.equal(restored.songContents[0].cards[0].lyric, '恢复后的第一句');
  assert.equal(
    restored.songContents.at(-1).cards[0].id,
    `card-${String(itemCount - 1).padStart(5, '0')}`,
  );
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 歌词替换保留未变化学习单元的状态', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const learning = createLearningRepository(context);
  const library = createLibraryStore({ songs, learning });
  const imported = await library.importSingleSong({
    rawLrc: '[00:01.00]君と歌う\n[00:01.00]与你歌唱',
    fileName: 'replace-state.lrc',
  });
  const originalCard = imported.song.cards[0];
  await learning.updateLearningUnit(imported.song.id, originalCard.id, { studied: true });

  const replaced = await library.replaceSongLyrics(imported.song.id, {
    rawLrc: [
      '[00:01.00]君と歌う',
      '[00:01.00]与你歌唱',
      '[00:02.00]明日へ',
      '[00:02.00]走向明天',
    ].join('\n'),
  });

  const preserved = replaced.cards.find(card => card.id === originalCard.id);
  assert.equal(preserved.learning.state, 'learning');
  assert.ok(preserved.learning.studiedAt > 0);
  assert.equal(replaced.progress.studiedCount, 1);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 执行器失败会中止跨存储事务', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  await songs.saveSong({
    id: 'atomic-song',
    title: 'Before',
    rawLrc: '[00:01.00]君',
    cards: [createCard('atomic-card', '君', '你')],
  });

  await assert.rejects(runTransaction(
    context,
    ['songs', 'songContents'],
    'readwrite',
    async stores => {
      const current = await requestToPromise(stores.songs.get('atomic-song'));
      await requestToPromise(stores.songs.put({ ...current, title: 'After' }));
      throw new Error('模拟容量或业务失败');
    },
  ));

  assert.equal((await songs.getSongById('atomic-song')).title, 'Before');
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 重启遇到未完成暂存时丢弃快照且不覆盖现有数据', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  await songs.saveSong({
    id: 'safe-song',
    title: 'Safe',
    rawLrc: '[00:01.00]君',
    cards: [createCard('safe-card', '君', '你')],
  });
  await runTransaction(context, ['meta', 'recovery'], 'readwrite', async stores => {
    await Promise.all([
      requestToPromise(stores.meta.put({
        key: 'restore:active',
        sessionId: 'staging-session',
        status: 'staging',
      })),
      requestToPromise(stores.recovery.put({
        sessionId: 'staging-session',
        storeName: 'songs',
        sequence: 0,
        value: { id: 'incomplete-snapshot', title: 'Incomplete' },
      })),
    ]);
  });

  assert.equal(await recoverInterruptedRestore(context), true);
  assert.equal((await songs.listSongSummaries())[0].id, 'safe-song');
  const leftovers = await runTransaction(context, ['meta', 'recovery'], 'readonly', async stores =>
    Promise.all([
      requestToPromise(stores.meta.get('restore:active')),
      requestToPromise(stores.recovery.count()),
    ]));
  assert.deepEqual(leftovers, [undefined, 0]);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v4: 复习游标每页最多返回五十条且不重复', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  const songs = createSongRepository(context);
  const learning = createLearningRepository(context);
  const cards = Array.from({ length: 60 }, (_, index) =>
    createCard(`page-${index}`, `歌う${index}`, `歌唱${index}`));
  await songs.saveSong({
    id: 'page-song',
    title: 'Page',
    rawLrc: '',
    cards,
  });
  for (const card of cards) {
    await learning.updateLearningUnit('page-song', card.id, { studied: true });
  }

  const first = await learning.listReviewPage({
    filter: 'due',
    dueBefore: Date.now() + 2 * 86400000,
    limit: 100,
  });
  const second = await learning.listReviewPage({
    filter: 'due',
    dueBefore: Date.now() + 2 * 86400000,
    limit: 50,
    cursor: first.nextCursor,
  });
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 10);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.reviewKey)).size, 60);
  context.database.close();
  await resetDatabase();
});

function createCard(id, lyric, translation) {
  return {
    id,
    timestamp: 1000,
    timeStr: '00:01.00',
    type: 'jp-zh',
    lyric,
    translation,
    extra: {},
    explain: { status: 'idle', content: '', error: '', updatedAt: 0 },
    learning: { state: 'new', favorite: false, nextReviewAt: 0 },
    ui: { expanded: false },
  };
}

function openLegacyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ANISON_DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const songs = db.createObjectStore('songs', { keyPath: 'id' });
      ['title', 'artist', 'updatedAt', 'lastStudiedAt'].forEach(name =>
        songs.createIndex(name, name));
      const progress = db.createObjectStore('progress', { keyPath: 'songId' });
      ['lastStudiedAt', 'completionRate'].forEach(name => progress.createIndex(name, name));
      const playlists = db.createObjectStore('playlists', { keyPath: 'id' });
      ['source', 'updatedAt'].forEach(name => playlists.createIndex(name, name));
      const jobs = db.createObjectStore('importJobs', { keyPath: 'id' });
      ['status', 'source', 'updatedAt', 'createdAt'].forEach(name => jobs.createIndex(name, name));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openV3Database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ANISON_DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      const songs = db.createObjectStore('songs', { keyPath: 'id' });
      [
        'title', 'artist', 'updatedAt', 'lastStudiedAt',
        'contentHash', 'fileNameKey', 'titleArtistKey', 'sourceKey',
      ].forEach(name => songs.createIndex(name, name));
      db.createObjectStore('songLyrics', { keyPath: 'songId' });
      const cards = db.createObjectStore('cards', { keyPath: ['songId', 'id'] });
      cards.createIndex('songId', 'songId');
      cards.createIndex('songLearningUnit', ['songId', 'learningUnitId']);
      const units = db.createObjectStore('learningUnits', { keyPath: 'key' });
      units.createIndex('songId', 'songId');
      units.createIndex('state', ['state', 'activityAt', 'key']);
      units.createIndex('due', ['reviewableKey', 'nextReviewAt', 'key']);
      units.createIndex('history', ['historyKey', 'activityAt', 'key']);
      units.createIndex('favorites', ['favoriteKey', 'activityAt', 'key']);
      const progress = db.createObjectStore('progress', { keyPath: 'songId' });
      ['lastStudiedAt', 'completionRate'].forEach(name => progress.createIndex(name, name));
      const playlists = db.createObjectStore('playlists', { keyPath: 'id' });
      ['source', 'updatedAt'].forEach(name => playlists.createIndex(name, name));
      const jobs = db.createObjectStore('importJobs', { keyPath: 'id' });
      ['status', 'source', 'updatedAt', 'createdAt'].forEach(name => jobs.createIndex(name, name));
      db.createObjectStore('meta', { keyPath: 'key' });
      const recovery = db.createObjectStore('recovery', {
        keyPath: ['sessionId', 'storeName', 'sequence'],
      });
      recovery.createIndex('sessionId', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeNormalizedV3(database, normalized) {
  const transaction = database.transaction(
    ['songs', 'songLyrics', 'cards', 'learningUnits', 'progress'],
    'readwrite',
  );
  transaction.objectStore('songs').put(normalized.song);
  transaction.objectStore('songLyrics').put(normalized.lyrics);
  transaction.objectStore('progress').put(normalized.progress);
  normalized.cards.forEach(card => transaction.objectStore('cards').put(card));
  normalized.learningUnits.forEach(unit => transaction.objectStore('learningUnits').put(unit));
  return transactionDone(transaction);
}

function openDatabaseAtVersion(version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ANISON_DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function resetDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ANISON_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('测试数据库被占用'));
  });
}
