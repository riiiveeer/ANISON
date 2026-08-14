import { test, expect } from '@playwright/test';

test('@perf 1000 首/80000 卡保持分页和索引查询预算', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/#/home');
  await seedNormalizedLibrary(page, 1000, 80);
  await page.reload();
  await expect(page.locator('.page-home')).toBeVisible();

  const metrics = await page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async predicate => {
      const started = performance.now();
      while (!predicate()) {
        if (performance.now() - started > 10000) throw new Error('页面渲染超时');
        await sleep(16);
      }
    };
    const measure = async (hash, ready) => {
      const longTasks = [];
      const observer = new PerformanceObserver(list => {
        longTasks.push(...list.getEntries().map(item => item.duration));
      });
      observer.observe({ type: 'longtask' });
      const started = performance.now();
      location.hash = hash;
      await waitFor(ready);
      await sleep(50);
      observer.disconnect();
      return {
        duration: performance.now() - started,
        longestTask: Math.max(0, ...longTasks),
        domNodes: document.getElementsByTagName('*').length,
      };
    };
    const home = await measure('#/home', () => document.querySelector('.page-home'));
    const library = await measure(
      '#/library',
      () => document.querySelectorAll('.song-library-row').length === 50,
    );
    const input = document.querySelector('#song-search');
    const searchStart = performance.now();
    input.value = '0999';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.song-library-row').length === 1);
    const search = performance.now() - searchStart;
    const review = await measure('#/review', () => document.querySelector('.page-review'));
    return { home, library, review, search };
  });

  console.log(`ANISON performance metrics: ${JSON.stringify(metrics)}`);
  expect(metrics.home.duration).toBeLessThan(750);
  expect(metrics.library.duration).toBeLessThan(750);
  expect(metrics.review.duration).toBeLessThan(750);
  expect(metrics.search).toBeLessThan(200);
  expect(metrics.library.domNodes).toBeLessThan(1500);
  expect(metrics.library.longestTask).toBeLessThan(250);
  expect(metrics.review.longestTask).toBeLessThan(250);
});

async function seedNormalizedLibrary(page, songCount, cardsPerSong) {
  await page.evaluate(async ({ songCount, cardsPerSong }) => {
    const request = value => new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result);
      value.onerror = () => reject(value.error);
    });
    const transactionDone = transaction => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open('anison-study-db', 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const now = Date.now();
    for (let songOffset = 0; songOffset < songCount; songOffset += 100) {
      const transaction = database.transaction(
        ['songs', 'songLyrics', 'cards', 'learningUnits', 'progress'],
        'readwrite',
      );
      for (let index = songOffset; index < Math.min(songCount, songOffset + 100); index += 1) {
        const songId = `stress-${index}`;
        transaction.objectStore('songs').put({
          id: songId,
          title: `压力歌曲 ${String(index).padStart(4, '0')}`,
          artist: `歌手 ${index % 50}`,
          album: '',
          coverUrl: '',
          source: 'manual',
          sourceSongId: '',
          fileName: `${songId}.lrc`,
          contentHash: `hash-${index}`,
          createdAt: now - index,
          updatedAt: now - index,
          lastStudiedAt: now - index,
          cardCount: cardsPerSong,
          learningUnitCount: cardsPerSong,
          storageVersion: 3,
          fileNameKey: `${songId}.lrc`,
          titleArtistKey: `压力歌曲 ${String(index).padStart(4, '0')}\u0000歌手 ${index % 50}`,
          sourceKey: '',
        });
        transaction.objectStore('songLyrics').put({
          songId,
          rawLrc: '[00:01.00]テスト',
          parsedVersion: 1,
        });
        transaction.objectStore('progress').put({
          songId,
          currentCardId: `${songId}-c0`,
          totalUnits: cardsPerSong,
          studiedCount: 1,
          masteredCount: 0,
          fuzzyCount: 0,
          favoriteCount: 0,
          completionRate: 1 / cardsPerSong,
          lastStudiedAt: now - index,
          storageVersion: 3,
        });
        for (let cardIndex = 0; cardIndex < cardsPerSong; cardIndex += 1) {
          const cardId = `${songId}-c${cardIndex}`;
          const unitId = `target_${index}_${cardIndex}`;
          transaction.objectStore('cards').put({
            songId,
            id: cardId,
            timestamp: cardIndex * 1000,
            timeStr: '00:01.00',
            type: 'jp-zh',
            lyric: `君と歌う ${index}-${cardIndex}`,
            translation: `与你歌唱 ${index}-${cardIndex}`,
            extra: {},
            songContext: '',
            learningUnitId: unitId,
            learningRole: 'target',
            representativeCardId: cardId,
            representativeIndex: cardIndex,
            occurrenceIndex: 1,
            occurrenceCount: 1,
          });
          if (cardIndex === 0) {
            transaction.objectStore('learningUnits').put({
              key: `${songId}\u0000${unitId}`,
              songId,
              unitId,
              representativeCardId: cardId,
              state: 'learning',
              favoriteKey: 0,
              reviewableKey: 1,
              historyKey: 1,
              reviewCount: 0,
              lapseCount: 0,
              studiedAt: now - 1000,
              lastReviewedAt: 0,
              nextReviewAt: now - 1,
              activityAt: now - 1000,
            });
          }
        }
      }
      await transactionDone(transaction);
    }
    await request(database.transaction('songs').objectStore('songs').count());
    database.close();
  }, { songCount, cardsPerSong });
}
