import {
  annotateLearningUnits,
  groupTargetLearningUnits,
  resolveLearningUnitState,
} from '../engine/learning-units.js';
import {
  createCompactProgress,
  createLearningUnitRecord,
  createProgressSummaryFromRecords,
  hydrateSong,
  learningFromUnitRecord,
  normalizeLookupText,
} from './normalized-song.js';

export const SONG_STORAGE_VERSION = 4;

export function createSongDocument(song, progress = null) {
  const annotatedCards = annotateLearningUnits(song?.cards || []);
  const effectiveProgress = progress || song?.progress || null;
  const allLearningStates = groupTargetLearningUnits(annotatedCards).map(unitCards => {
    const first = unitCards[0];
    return createLearningUnitRecord(
      song.id,
      first,
      resolveLearningUnitState(unitCards, effectiveProgress),
    );
  });
  const cards = annotatedCards.map(createContentCardRecord);
  const compactProgress = {
    ...createCompactProgress(song, effectiveProgress, allLearningStates),
    storageVersion: SONG_STORAGE_VERSION,
  };
  const title = String(song?.title || '').trim() || '未命名歌曲';
  const artist = String(song?.artist || '').trim();
  const fileName = String(song?.fileName || '').trim();
  const source = String(song?.source || 'manual');
  const sourceSongId = String(song?.sourceSongId || '');

  return {
    song: {
      id: song.id,
      title,
      artist,
      album: String(song?.album || ''),
      coverUrl: String(song?.coverUrl || ''),
      source,
      sourceSongId,
      fileName,
      contentHash: String(song?.contentHash || ''),
      createdAt: Number(song?.createdAt) || Date.now(),
      updatedAt: Number(song?.updatedAt) || Date.now(),
      lastStudiedAt: Number(compactProgress.lastStudiedAt || song?.lastStudiedAt) || 0,
      cardCount: cards.length,
      learningUnitCount: allLearningStates.length,
      storageVersion: SONG_STORAGE_VERSION,
      fileNameKey: normalizeLookupText(fileName),
      titleArtistKey: `${normalizeLookupText(title)}\u0000${normalizeLookupText(artist)}`,
      sourceKey: sourceSongId ? `${source}\u0000${sourceSongId}` : '',
    },
    content: {
      songId: song.id,
      rawLrc: String(song?.rawLrc || ''),
      parsedVersion: Number(song?.parsedVersion) || 1,
      cards,
      storageVersion: SONG_STORAGE_VERSION,
    },
    learningStates: allLearningStates.filter(shouldPersistLearningState),
    progress: compactProgress,
  };
}

export function hydrateSongDocument(song, content, learningStates = [], progress = null) {
  if (!song) return null;
  const cards = (content?.cards || []).map(card => ({ ...card, songId: song.id }));
  return hydrateSong(
    song,
    {
      songId: song.id,
      rawLrc: content?.rawLrc || '',
      parsedVersion: content?.parsedVersion || 1,
    },
    cards,
    learningStates,
    progress,
  );
}

export function createDefaultLearningState(songId, card) {
  return createLearningUnitRecord(songId, {
    ...card,
    learningUnit: {
      id: card.learningUnitId,
      role: card.learningRole,
      representativeCardId: card.representativeCardId || card.id,
      representativeIndex: Number(card.representativeIndex) || 0,
      occurrenceIndex: Number(card.occurrenceIndex) || 1,
      occurrenceCount: Number(card.occurrenceCount) || 1,
    },
  });
}

export function shouldPersistLearningState(state) {
  if (!state) return false;
  return state.state !== 'new'
    || Boolean(state.favoriteKey)
    || Number(state.reviewCount) > 0
    || Number(state.lapseCount) > 0
    || Number(state.studiedAt) > 0
    || Number(state.lastReviewedAt) > 0
    || Number(state.nextReviewAt) > 0;
}

export function createSongProgressSummary(song, progress = null) {
  return createProgressSummaryFromRecords(song, progress);
}

export function learningStateForRecord(record) {
  return learningFromUnitRecord(record);
}

function createContentCardRecord(card) {
  return {
    id: card.id,
    timestamp: Number(card.timestamp) || 0,
    timeStr: String(card.timeStr || ''),
    type: String(card.type || ''),
    lyric: String(card.lyric || ''),
    translation: String(card.translation || ''),
    extra: card.extra || {},
    songContext: String(card.songContext || ''),
    explain: card.explain || { status: 'idle', content: '', error: '', updatedAt: 0 },
    learningUnitId: card.learningUnit?.id || card.learningUnitId || '',
    learningRole: card.learningUnit?.role || card.learningRole || 'passive',
    representativeCardId:
      card.learningUnit?.representativeCardId || card.representativeCardId || card.id,
    representativeIndex:
      Number(card.learningUnit?.representativeIndex ?? card.representativeIndex) || 0,
    occurrenceIndex: Number(card.learningUnit?.occurrenceIndex ?? card.occurrenceIndex) || 1,
    occurrenceCount: Number(card.learningUnit?.occurrenceCount ?? card.occurrenceCount) || 1,
  };
}
