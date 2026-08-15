import { test, expect } from '@playwright/test';

const SONG_COUNT = 1000;
const CARDS_PER_SONG = 80;
const LOGICAL_UNIT_COUNT = SONG_COUNT * CARDS_PER_SONG;

test('@perf v2 全默认状态的 1000 首/80000 卡在 30 秒内原子迁移到 v4', async ({ page }) => {
  skipLinuxOnlyMigrationBudget();
  test.setTimeout(300000);
  await openSeedPage(page);
  await seedLegacyLibrary(page, SONG_COUNT, CARDS_PER_SONG, 0);

  const metrics = await migrateAndMeasure(page);

  console.log(`ANISON v4 default-state migration metrics: ${JSON.stringify(metrics)}`);
  expect(metrics.counts).toEqual({
    songs: SONG_COUNT,
    songContents: SONG_COUNT,
    logicalCards: LOGICAL_UNIT_COUNT,
    logicalLearningUnits: LOGICAL_UNIT_COUNT,
    learningStates: 0,
    dueStates: 0,
    historyStates: 0,
    migrationArchive: SONG_COUNT,
  });
  expect(metrics.report.fromVersion).toBe(2);
  expect(metrics.report.persistedLearningStates).toBe(0);
  expect(metrics.migrationMs).toBeLessThan(30000);
});

test('@perf v2 的 10% 非默认状态在 30 秒内迁移为 8000 条稀疏状态', async ({ page }) => {
  skipLinuxOnlyMigrationBudget();
  test.setTimeout(300000);
  await openSeedPage(page);
  await seedLegacyLibrary(page, SONG_COUNT, CARDS_PER_SONG, 0.1);

  const metrics = await migrateAndMeasure(page);

  console.log(`ANISON v4 sparse-state migration metrics: ${JSON.stringify(metrics)}`);
  expect(metrics.counts).toEqual({
    songs: SONG_COUNT,
    songContents: SONG_COUNT,
    logicalCards: LOGICAL_UNIT_COUNT,
    logicalLearningUnits: LOGICAL_UNIT_COUNT,
    learningStates: LOGICAL_UNIT_COUNT * 0.1,
    dueStates: LOGICAL_UNIT_COUNT * 0.1,
    historyStates: LOGICAL_UNIT_COUNT * 0.1,
    migrationArchive: SONG_COUNT,
  });
  expect(metrics.report.persistedLearningStates).toBe(LOGICAL_UNIT_COUNT * 0.1);
  expect(metrics.migrationMs).toBeLessThan(30000);
});

test('@perf v4 聚合备份的 1000 首/80000 逻辑卡与 10% 状态在 10 秒内恢复', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('/#/home');
  await expect(page.locator('.page-home')).toBeVisible();

  const metrics = await page.evaluate(async ({ songCount, cardsPerSong }) => {
    const database = await openDatabase(4);
    const data = createV4Fixture(songCount, cardsPerSong, 0.1);
    const { createDataRepository } = await import('/src/db/data-repository.js');
    const { createDataBackupService } = await import('/src/store/data-backup.js');
    const repository = createDataRepository({ database });
    const backupService = createDataBackupService({ data: repository });
    const backup = {
      app: 'ANISON',
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      manifest: {
        songs: songCount,
        songContents: songCount,
        cards: songCount * cardsPerSong,
        learningUnits: songCount * cardsPerSong,
        learningStates: data.learningStates.length,
        progress: songCount,
        playlists: 0,
        importJobs: 0,
      },
      data,
      settings: {},
    };
    const startedAt = performance.now();
    await backupService.importData(backup);
    const restoreMs = performance.now() - startedAt;
    const overview = await repository.getOverview();
    database.close();
    return { restoreMs, overview };

    function openDatabase(version) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('anison-study-db', version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function createV4Fixture(totalSongs, totalCards, stateRatio) {
      const data = {
        songs: [],
        songContents: [],
        learningStates: [],
        progress: [],
        playlists: [],
        importJobs: [],
      };
      const statesPerSong = Math.floor(totalCards * stateRatio);
      for (let songIndex = 0; songIndex < totalSongs; songIndex += 1) {
        const songId = `restore-stress-${songIndex}`;
        const cards = [];
        for (let cardIndex = 0; cardIndex < totalCards; cardIndex += 1) {
          const cardId = `${songId}-card-${cardIndex}`;
          const unitId = `target_${songIndex}_${cardIndex}`;
          cards.push({
            id: cardId,
            timestamp: cardIndex * 1000,
            timeStr: '00:01.00',
            type: 'jp-zh',
            lyric: `歌う言葉 ${songIndex}-${cardIndex}`,
            translation: `歌唱文字 ${songIndex}-${cardIndex}`,
            extra: {},
            songContext: '',
            explain: { status: 'idle', content: '', error: '', updatedAt: 0 },
            learningUnitId: unitId,
            learningRole: 'target',
            representativeCardId: cardId,
            representativeIndex: cardIndex,
            occurrenceIndex: 1,
            occurrenceCount: 1,
          });
          if (cardIndex < statesPerSong) {
            data.learningStates.push({
              key: `${songId}\u0000${unitId}`,
              songId,
              unitId,
              representativeCardId: cardId,
              state: 'learning',
              reviewableKey: 1,
              historyKey: 1,
              reviewCount: 1,
              lapseCount: 0,
              studiedAt: 100,
              lastReviewedAt: 100,
              nextReviewAt: 1,
              activityAt: 100,
            });
          }
        }
        data.songs.push({
          id: songId,
          title: `Restore ${songIndex}`,
          artist: `Artist ${songIndex % 50}`,
          source: 'manual',
          fileName: `${songId}.lrc`,
          createdAt: songIndex + 1,
          updatedAt: songIndex + 1,
          lastStudiedAt: 100,
          cardCount: totalCards,
          learningUnitCount: totalCards,
          storageVersion: 4,
        });
        data.songContents.push({
          songId,
          rawLrc: '',
          parsedVersion: 1,
          cards,
          storageVersion: 4,
        });
        data.progress.push({
          songId,
          currentCardId: `${songId}-card-0`,
          totalUnits: totalCards,
          studiedCount: statesPerSong,
          masteredCount: 0,
          fuzzyCount: 0,
          favoriteCount: 0,
          completionRate: statesPerSong / totalCards,
          lastStudiedAt: 100,
          storageVersion: 4,
        });
      }
      return data;
    }
  }, { songCount: SONG_COUNT, cardsPerSong: CARDS_PER_SONG });

  console.log(`ANISON v4 restore metrics: ${JSON.stringify(metrics)}`);
  expect(metrics.overview).toMatchObject({
    songs: SONG_COUNT,
    songContents: SONG_COUNT,
    cards: LOGICAL_UNIT_COUNT,
    learningUnits: LOGICAL_UNIT_COUNT,
    learningStates: LOGICAL_UNIT_COUNT * 0.1,
    progress: SONG_COUNT,
  });
  expect(metrics.restoreMs).toBeLessThan(10000);
});

function skipLinuxOnlyMigrationBudget() {
  test.skip(
    process.platform === 'win32' && process.env.ANISON_RUN_MIGRATION_GATE !== '1',
    'Windows Chromium 的磁盘型 IndexedDB 吞吐波动较大；30 秒完整迁移硬门禁在 Linux CI 执行。',
  );
}

async function openSeedPage(page) {
  await page.route('**/__migration_seed__', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>migration seed</title>',
  }));
  await page.goto('/__migration_seed__');
}

async function migrateAndMeasure(page) {
  await page.unroute('**/__migration_seed__');
  const startedAt = Date.now();
  await page.goto('/#/home');
  await expect(page.locator('.page-home')).toBeVisible({ timeout: 240000 });
  const migrationMs = Date.now() - startedAt;
  return page.evaluate(async elapsed => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = storeName => new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const indexCount = (storeName, indexName) => new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).index(indexName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const contents = await new Promise((resolve, reject) => {
      const request = database.transaction('songContents').objectStore('songContents').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const counts = {
      songs: await count('songs'),
      songContents: await count('songContents'),
      logicalCards: contents.reduce((sum, item) => sum + item.cards.length, 0),
      logicalLearningUnits: contents.reduce((sum, item) => sum + new Set(
        item.cards.filter(card => card.learningRole === 'target').map(card => card.learningUnitId),
      ).size, 0),
      learningStates: await count('learningStates'),
      dueStates: await indexCount('learningStates', 'due'),
      historyStates: await indexCount('learningStates', 'history'),
      migrationArchive: await count('migrationArchive'),
    };
    database.close();
    return { migrationMs: elapsed, counts, report: window.__ANISON_UPGRADE_REPORT__ };
  }, migrationMs);
}

async function seedLegacyLibrary(page, songCount, cardsPerSong, stateRatio) {
  await page.evaluate(async ({ songCount, cardsPerSong, stateRatio }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 2);
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
        ['status', 'source', 'updatedAt', 'createdAt'].forEach(name =>
          jobs.createIndex(name, name));
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['songs', 'progress'], 'readwrite');
    const songs = transaction.objectStore('songs');
    const progress = transaction.objectStore('progress');
    const stateCount = Math.floor(cardsPerSong * stateRatio);
    for (let songIndex = 0; songIndex < songCount; songIndex += 1) {
      const songId = `legacy-stress-${songIndex}`;
      const cardStates = {};
      const cards = Array.from({ length: cardsPerSong }, (_, cardIndex) => {
        const cardId = `${songId}-card-${cardIndex}`;
        if (cardIndex < stateCount) {
          cardStates[cardId] = {
            state: 'learning',
            favorite: false,
            reviewCount: 1,
            lapseCount: 0,
            studiedAt: 100,
            lastReviewedAt: 100,
            nextReviewAt: 1,
          };
        }
        return {
          id: cardId,
          timestamp: cardIndex * 1000,
          timeStr: '00:01.00',
          type: 'jp-zh',
          lyric: `歌う言葉 ${songIndex}-${cardIndex}`,
          translation: `歌唱文字 ${songIndex}-${cardIndex}`,
          extra: {},
          learning: {
            state: 'new',
            favorite: false,
            reviewCount: 0,
            lapseCount: 0,
            studiedAt: 0,
            lastReviewedAt: 0,
            nextReviewAt: 0,
          },
        };
      });
      songs.put({
        id: songId,
        title: `Legacy ${songIndex}`,
        artist: `Artist ${songIndex % 50}`,
        fileName: `${songId}.lrc`,
        rawLrc: '',
        cards,
        createdAt: songIndex + 1,
        updatedAt: songIndex + 1,
        lastStudiedAt: stateCount ? 100 : 0,
      });
      progress.put({
        songId,
        currentCardId: stateCount ? `${songId}-card-0` : '',
        studiedCardIds: Object.keys(cardStates),
        masteredCardIds: [],
        cardStates,
        completionRate: stateCount / cardsPerSong,
        lastStudiedAt: stateCount ? 100 : 0,
      });
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { songCount, cardsPerSong, stateRatio });
}
