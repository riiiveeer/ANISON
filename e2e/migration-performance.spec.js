import { test, expect } from '@playwright/test';

test('@perf beta.1 的 1000 首/80000 卡在 30 秒内迁移到 v3', async ({ page }) => {
  test.skip(
    process.platform === 'win32',
    'Windows Chromium 的磁盘型 IndexedDB 吞吐波动较大；30 秒硬门禁在 Linux CI 执行。',
  );
  test.setTimeout(300000);
  await page.route('**/__migration_seed__', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>migration seed</title>',
  }));
  await page.goto('/__migration_seed__');
  await seedLegacyLibrary(page, 1000, 80);
  await page.unroute('**/__migration_seed__');

  const startedAt = Date.now();
  await page.goto('/#/home');
  await expect(page.locator('.page-home')).toBeVisible({ timeout: 240000 });
  const migrationMs = Date.now() - startedAt;
  const counts = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readCount = storeName => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName);
      const request = transaction.objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      songs: await readCount('songs'),
      cards: await readCount('cards'),
      learningUnits: await readCount('learningUnits'),
    };
    database.close();
    return result;
  });

  const restoreMs = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const { createDataRepository } = await import('/src/db/data-repository.js');
    const repository = createDataRepository({ database });
    const backup = await repository.exportAll();
    const startedAt = performance.now();
    await repository.replaceAll(backup);
    const duration = performance.now() - startedAt;
    database.close();
    return duration;
  });

  console.log(`ANISON migration metrics: ${JSON.stringify({ migrationMs, restoreMs, ...counts })}`);
  expect(counts).toEqual({ songs: 1000, cards: 80000, learningUnits: 80000 });
  expect(migrationMs).toBeLessThan(30000);
  expect(restoreMs).toBeLessThan(10000);
});

async function seedLegacyLibrary(page, songCount, cardsPerSong) {
  await page.evaluate(async ({ songCount, cardsPerSong }) => {
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
    for (let songIndex = 0; songIndex < songCount; songIndex += 1) {
      const songId = `legacy-stress-${songIndex}`;
      const cards = Array.from({ length: cardsPerSong }, (_, cardIndex) => ({
        id: `${songId}-card-${cardIndex}`,
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
      }));
      songs.put({
        id: songId,
        title: `Legacy ${songIndex}`,
        artist: `Artist ${songIndex % 50}`,
        fileName: `${songId}.lrc`,
        rawLrc: '',
        cards,
        createdAt: songIndex + 1,
        updatedAt: songIndex + 1,
        lastStudiedAt: 0,
      });
      progress.put({
        songId,
        currentCardId: '',
        studiedCardIds: [],
        masteredCardIds: [],
        cardStates: {},
        completionRate: 0,
        lastStudiedAt: 0,
      });
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { songCount, cardsPerSong });
}
