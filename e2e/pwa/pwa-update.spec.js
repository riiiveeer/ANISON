import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workerPath = path.resolve('dist/sw.js');

test('waiting worker 由用户激活，关键操作阻止刷新且 IndexedDB 数据保留', async ({ page }, testInfo) => {
  const originalWorker = await readFile(workerPath, 'utf8');
  await seedNormalizedV3Song(page);
  await page.addInitScript(() => {
    const originalText = File.prototype.text;
    File.prototype.text = function delayedFixtureText() {
      if (this.name !== 'delayed-backup.json') return originalText.call(this);
      return new Promise(resolve => {
        window.__releaseDelayedBackup = async () => resolve(await originalText.call(this));
      });
    };
  });

  try {
    await page.goto('/#/home');
    await expect(page.locator('.page-home')).toBeVisible();
    const upgradeReport = await page.evaluate(() => window.__ANISON_UPGRADE_REPORT__);
    expect(upgradeReport).toMatchObject({
      fromVersion: 3,
      toVersion: 4,
      totalSongs: 1,
      persistedLearningStates: 1,
      phase: 'complete',
    });
    await waitForServiceWorkerControl(page);
    await importFixtureSong(page);
    await page.goto('/#/settings');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /导出完整备份/ }).click();
    const download = await downloadPromise;
    const backupPath = testInfo.outputPath('delayed-backup.json');
    await download.saveAs(backupPath);
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    expect(backup.schemaVersion).toBe(3);
    expect(backup.manifest).toMatchObject({
      songs: 2,
      songContents: 2,
      learningStates: 1,
    });

    const fixtureWorker = originalWorker
      .replace(/const BUILD_ID = "[^"]+";/, 'const BUILD_ID = "1.0.0-beta.3+e2e+waiting";')
      .concat('\n// pwa-update-e2e-fixture\n');
    await writeFile(workerPath, fixtureWorker, 'utf8');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect(page.getByText('发现新版本，可在方便时更新')).toBeVisible();
    await page.locator('#pwa-status-region').getByRole('button', { name: '稍后' }).click();
    await expect(page.getByText('发现新版本，可在方便时更新')).toBeHidden();

    page.on('dialog', dialog => dialog.dismiss());
    await page.locator('#backup-file-input').setInputFiles(backupPath);
    await expect(page.locator('.page-settings').getByText(/备份正在恢复或回滚/)).toBeVisible();
    await expect(page.locator('.page-settings').getByRole('button', { name: '立即更新' })).toBeDisabled();
    await page.evaluate(() => window.__releaseDelayedBackup());
    await expect(page.locator('.page-settings').getByRole('button', { name: '立即更新' })).toBeEnabled();

    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('.page-settings').getByRole('button', { name: '立即更新' }).click();
    await navigation;
    await expect(page.locator('.page-settings')).toBeVisible();
    await page.goto('/#/library');
    await expect(page.getByText('PWA Update Song')).toBeVisible();
    await expect(page.getByText('Legacy v3 Song')).toBeVisible();
    const dataState = await readV4DataState(page);
    expect(dataState).toEqual({
      version: 4,
      songs: 2,
      songContents: 2,
      learningStates: 1,
      progress: 2,
      migrationArchive: 1,
      legacyState: 'mastered',
    });
    const buildId = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return requestVersion(registration.active);

      function requestVersion(worker) {
        return new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = event => resolve(event.data.buildId);
          worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
        });
      }
    });
    expect(buildId).toBe('1.0.0-beta.3+e2e+waiting');
  } finally {
    await writeFile(workerPath, originalWorker, 'utf8');
  }
});

async function seedNormalizedV3Song(page) {
  await page.route('**/__pwa_v3_seed__', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>v3 seed</title>',
  }));
  await page.goto('/__pwa_v3_seed__');
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        const songs = db.createObjectStore('songs', { keyPath: 'id' });
        ['title', 'artist', 'updatedAt', 'lastStudiedAt', 'contentHash', 'fileNameKey', 'titleArtistKey', 'sourceKey']
          .forEach(name => songs.createIndex(name, name));
        db.createObjectStore('songLyrics', { keyPath: 'songId' });
        const cards = db.createObjectStore('cards', { keyPath: ['songId', 'id'] });
        cards.createIndex('songId', 'songId');
        cards.createIndex('id', 'id');
        cards.createIndex('timestamp', ['songId', 'timestamp']);
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
    const transaction = database.transaction(
      ['songs', 'songLyrics', 'cards', 'learningUnits', 'progress'],
      'readwrite',
    );
    const songId = 'legacy-v3-song';
    const cardId = 'legacy-v3-card';
    const unitId = 'target_legacy_v3';
    transaction.objectStore('songs').put({
      id: songId,
      title: 'Legacy v3 Song',
      artist: 'ANISON Fixture',
      source: 'manual',
      fileName: 'legacy-v3.lrc',
      contentHash: 'legacy-v3-hash',
      createdAt: 1,
      updatedAt: 2,
      lastStudiedAt: 3,
      cardCount: 1,
      learningUnitCount: 1,
      storageVersion: 3,
      fileNameKey: 'legacy-v3.lrc',
      titleArtistKey: 'legacy v3 song\u0000anison fixture',
      sourceKey: '',
    });
    transaction.objectStore('songLyrics').put({
      songId,
      rawLrc: '[00:01.00]古い歌\n[00:01.00]旧歌曲',
      parsedVersion: 1,
    });
    transaction.objectStore('cards').put({
      songId,
      id: cardId,
      timestamp: 1000,
      timeStr: '00:01.00',
      type: 'jp-zh',
      lyric: '古い歌',
      translation: '旧歌曲',
      extra: {},
      songContext: '',
      learningUnitId: unitId,
      learningRole: 'target',
      representativeCardId: cardId,
      representativeIndex: 0,
      occurrenceIndex: 1,
      occurrenceCount: 1,
    });
    transaction.objectStore('learningUnits').put({
      key: `${songId}\u0000${unitId}`,
      songId,
      unitId,
      representativeCardId: cardId,
      state: 'mastered',
      favoriteKey: 1,
      historyKey: 1,
      reviewCount: 2,
      lapseCount: 0,
      studiedAt: 2,
      lastReviewedAt: 3,
      nextReviewAt: 0,
      activityAt: 3,
    });
    transaction.objectStore('progress').put({
      songId,
      currentCardId: cardId,
      totalUnits: 1,
      studiedCount: 1,
      masteredCount: 1,
      fuzzyCount: 0,
      favoriteCount: 1,
      completionRate: 1,
      lastStudiedAt: 3,
      storageVersion: 3,
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.unroute('**/__pwa_v3_seed__');
}

async function readV4DataState(page) {
  return page.evaluate(async () => {
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
    const legacyState = await new Promise((resolve, reject) => {
      const request = database.transaction('learningStates')
        .objectStore('learningStates')
        .index('songId')
        .getAll('legacy-v3-song');
      request.onsuccess = () => resolve(request.result[0]?.state || '');
      request.onerror = () => reject(request.error);
    });
    const state = {
      version: database.version,
      songs: await count('songs'),
      songContents: await count('songContents'),
      learningStates: await count('learningStates'),
      progress: await count('progress'),
      migrationArchive: await count('migrationArchive'),
      legacyState,
    };
    database.close();
    return state;
  });
}

async function importFixtureSong(page) {
  const firstImport = page.getByRole('button', { name: '导入第一首歌' });
  if (await firstImport.count()) {
    await firstImport.click();
  } else {
    await page.goto('/#/library');
    await page.getByRole('button', { name: '导入歌曲' }).click();
  }
  await page.getByRole('button', { name: '粘贴歌词' }).click();
  await page.locator('input[name="title"]').fill('PWA Update Song');
  await page.locator('textarea[name="rawLrc"]').fill('[00:01.00]更新しても消えない\n[00:01.00]更新后仍保留');
  await page.getByRole('button', { name: '导入并开始学习' }).click();
  await expect(page.locator('.page-study')).toBeVisible();
}

async function waitForServiceWorkerControl(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
}
