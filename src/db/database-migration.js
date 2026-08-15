import { hydrateSong, isLegacySongRecord } from './normalized-song.js';
import { createSongDocument, SONG_STORAGE_VERSION } from './song-document.js';

const MIGRATION_KEY = 'migration:v4';
const OBSOLETE_STORES = ['songLyrics', 'cards', 'learningUnits'];

export function migrateDatabaseV4(database, transaction, {
  oldVersion,
  onProgress,
  createLearningStateIndexes,
} = {}) {
  const startedAt = now();
  const report = {
    fromVersion: Number(oldVersion) || 0,
    toVersion: SONG_STORAGE_VERSION,
    phase: 'scan',
    totalSongs: 0,
    completedSongs: 0,
    logicalCards: 0,
    logicalLearningUnits: 0,
    persistedLearningStates: 0,
    durationMs: 0,
    phaseDurations: {},
  };
  let phaseStartedAt = startedAt;
  const sourceStores = new Set(Array.from(database.objectStoreNames));
  const songs = transaction.objectStore('songs');
  const progress = transaction.objectStore('progress');
  const contents = transaction.objectStore('songContents');
  const learningStates = transaction.objectStore('learningStates');
  const archive = transaction.objectStore('migrationArchive');
  const meta = transaction.objectStore('meta');
  const songIds = new Set();

  transaction.addEventListener('complete', () => {
    finishPhase();
    report.phase = 'complete';
    report.durationMs = Math.round(now() - startedAt);
    notify(onProgress, report);
  });
  transaction.addEventListener('abort', () => {
    finishPhase();
    report.phase = 'failed';
    report.durationMs = Math.round(now() - startedAt);
    notify(onProgress, report);
  });

  const countRequest = songs.count();
  countRequest.onsuccess = () => {
    report.totalSongs = countRequest.result;
    notify(onProgress, report);
    scanSongs();
  };

  function scanSongs() {
    const cursorRequest = songs.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        removeOrphanProgress();
        return;
      }
      readSourceSong(cursor.value, sourceStores, transaction, source => {
        const fullSong = source.song;
        const parts = createSongDocument(fullSong, source.progress);
        const { progress: _embeddedProgress, ...archiveSong } = fullSong;

        songIds.add(parts.song.id);
        cursor.update(parts.song);
        contents.put(parts.content);
        progress.put(parts.progress);
        for (const state of parts.learningStates) learningStates.put(state);
        archive.put({
          songId: parts.song.id,
          sourceVersion: Number(oldVersion) || 0,
          song: archiveSong,
          progress: source.progress || null,
          archivedAt: Date.now(),
        });

        setPhase('write');
        report.completedSongs += 1;
        report.logicalCards += parts.song.cardCount;
        report.logicalLearningUnits += parts.song.learningUnitCount;
        report.persistedLearningStates += parts.learningStates.length;
        if (report.completedSongs % 25 === 0 || report.completedSongs === report.totalSongs) {
          notify(onProgress, report);
        }
        cursor.continue();
      });
    };
  }

  function removeOrphanProgress() {
    const request = progress.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        buildIndexesAndVerify();
        return;
      }
      if (!songIds.has(cursor.primaryKey)) cursor.delete();
      cursor.continue();
    };
  }

  function buildIndexesAndVerify() {
    setPhase('index');
    notify(onProgress, report);
    createLearningStateIndexes(learningStates);

    const stores = { songs, songContents: contents, learningStates, progress, migrationArchive: archive };
    const results = {};
    let remaining = Object.keys(stores).length;
    for (const [storeName, store] of Object.entries(stores)) {
      const request = store.count();
      request.onsuccess = () => {
        results[storeName] = request.result;
        remaining -= 1;
        if (remaining === 0) verifyAndFinish(results);
      };
    }
  }

  function verifyAndFinish(counts) {
    setPhase('verify');
    notify(onProgress, report);
    const expectedSongs = report.totalSongs;
    const valid = counts.songs === expectedSongs
      && counts.songContents === expectedSongs
      && counts.progress === expectedSongs
      && counts.migrationArchive === expectedSongs
      && counts.learningStates === report.persistedLearningStates;
    if (!valid) {
      report.message = `v4 迁移校验失败：${JSON.stringify(counts)}`;
      transaction.abort();
      return;
    }

    for (const storeName of OBSOLETE_STORES) {
      if (database.objectStoreNames.contains(storeName)) database.deleteObjectStore(storeName);
    }
    meta.put({
      key: MIGRATION_KEY,
      status: 'complete',
      fromVersion: Number(oldVersion) || 0,
      toVersion: SONG_STORAGE_VERSION,
      totalSongs: report.totalSongs,
      logicalCards: report.logicalCards,
      logicalLearningUnits: report.logicalLearningUnits,
      persistedLearningStates: report.persistedLearningStates,
      archiveAvailable: true,
      updatedAt: Date.now(),
    });
  }

  function setPhase(phase) {
    if (report.phase === phase) return;
    finishPhase();
    report.phase = phase;
    phaseStartedAt = now();
  }

  function finishPhase() {
    const elapsed = Math.max(0, Math.round(now() - phaseStartedAt));
    report.phaseDurations[report.phase] =
      Number(report.phaseDurations[report.phase] || 0) + elapsed;
  }

  return report;
}

function readSourceSong(song, sourceStores, transaction, onReady) {
  const progressRequest = transaction.objectStore('progress').get(song.id);
  if (isLegacySongRecord(song) || !hasNormalizedV3Stores(sourceStores)) {
    progressRequest.onsuccess = () => onReady({
      song: { ...song, progress: progressRequest.result || song.progress || null },
      progress: progressRequest.result || song.progress || null,
    });
    return;
  }

  const lyricsRequest = transaction.objectStore('songLyrics').get(song.id);
  const cardsRequest = transaction.objectStore('cards').index('songId').getAll(song.id);
  const statesRequest = transaction.objectStore('learningUnits').index('songId').getAll(song.id);
  const requests = [progressRequest, lyricsRequest, cardsRequest, statesRequest];
  let remaining = requests.length;
  for (const request of requests) {
    request.onsuccess = () => {
      remaining -= 1;
      if (remaining !== 0) return;
      const fullSong = hydrateSong(
        song,
        lyricsRequest.result,
        cardsRequest.result,
        statesRequest.result,
        progressRequest.result,
      );
      onReady({ song: fullSong, progress: progressRequest.result || null });
    };
  }
}

function hasNormalizedV3Stores(stores) {
  return OBSOLETE_STORES.every(storeName => stores.has(storeName));
}

function notify(callback, report) {
  if (typeof callback !== 'function') return;
  try {
    callback({ ...report });
  } catch {
    // 进度 UI 不得中止数据库升级。
  }
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
