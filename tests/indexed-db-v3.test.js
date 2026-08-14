import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import {
  ANISON_DB_NAME,
  initializeDatabase,
  requestToPromise,
  runTransaction,
} from '../src/db/indexed-db.js';
import { migrateDatabaseV3 } from '../src/db/database-migration.js';
import { createSongRepository } from '../src/db/song-repository.js';
import { createLearningRepository } from '../src/db/learning-repository.js';
import {
  createDataRepository,
  recoverInterruptedRestore,
} from '../src/db/data-repository.js';
import { createLibraryStore } from '../src/store/library-store.js';

globalThis.window = { indexedDB: globalThis.indexedDB };

test('IndexedDB v3: 旧歌曲按歌曲原子迁移并可完整读取', async () => {
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
  await migrateDatabaseV3(context);
  const songs = createSongRepository(context);
  const raw = await runTransaction(context, 'songs', 'readonly', store =>
    requestToPromise(store.get('legacy_song')));
  assert.equal(raw.storageVersion, 3);
  assert.equal(Object.hasOwn(raw, 'cards'), false);
  assert.equal(Object.hasOwn(raw, 'rawLrc'), false);

  const hydrated = await songs.getSongById('legacy_song');
  assert.equal(hydrated.rawLrc.includes('君'), true);
  assert.equal(hydrated.cards.length, 2);
  assert.equal(hydrated.cards[0].learning.state, 'learning');
  assert.equal(hydrated.cards[1].learning.state, 'learning');
  assert.equal(hydrated.progress.totalUnits, 1);
  context.database.close();
  await resetDatabase();
});

test('IndexedDB v3: 保存、复习索引更新和删除保持一致', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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

test('IndexedDB v3: 读取歌词卡时按数值时间戳而不是字符串主键排序', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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

test('IndexedDB v3: 恢复取消后从持久化恢复点回滚', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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
  replacement.songLyrics[0] = { ...replacement.songLyrics[0], songId: 'replacement' };
  replacement.cards = replacement.cards.map(card => ({ ...card, songId: 'replacement' }));
  replacement.learningUnits = replacement.learningUnits.map(unit => ({
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

test('IndexedDB v3: 歌词替换保留未变化学习单元的状态', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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

test('IndexedDB v3: 执行器失败会中止跨存储事务', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
  const songs = createSongRepository(context);
  await songs.saveSong({
    id: 'atomic-song',
    title: 'Before',
    rawLrc: '[00:01.00]君',
    cards: [createCard('atomic-card', '君', '你')],
  });

  await assert.rejects(runTransaction(
    context,
    ['songs', 'songLyrics'],
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

test('IndexedDB v3: 重启遇到未完成暂存时丢弃快照且不覆盖现有数据', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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

test('IndexedDB v3: 复习游标每页最多返回五十条且不重复', async () => {
  await resetDatabase();
  const context = await initializeDatabase();
  await migrateDatabaseV3(context);
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
