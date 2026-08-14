import {
  annotateLearningUnits,
  groupTargetLearningUnits,
  resolveLearningUnitState,
} from '../engine/learning-units.js';

export const NORMALIZED_SONG_VERSION = 3;

const DEFAULT_LEARNING = {
  state: 'new',
  favorite: false,
  reviewCount: 0,
  lapseCount: 0,
  studiedAt: 0,
  lastReviewedAt: 0,
  nextReviewAt: 0,
};

export function createLearningUnitKey(songId, unitId) {
  return `${songId}\u0000${unitId}`;
}

export function isLegacySongRecord(song) {
  return Boolean(song && (
    song.storageVersion !== NORMALIZED_SONG_VERSION
    || Array.isArray(song.cards)
    || Object.hasOwn(song, 'rawLrc')
  ));
}

export function normalizeLookupText(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase();
}

export function decomposeSong(song, progress = null) {
  const annotatedCards = annotateLearningUnits(song?.cards || []);
  const effectiveProgress = progress || song?.progress || null;
  const learningUnits = groupTargetLearningUnits(annotatedCards).map(unitCards => {
    const first = unitCards[0];
    return createLearningUnitRecord(
      song.id,
      first,
      resolveLearningUnitState(unitCards, effectiveProgress),
    );
  });
  const cards = annotatedCards.map(card => createCardRecord(song.id, card));
  const compactProgress = createCompactProgress(song, effectiveProgress, learningUnits);
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
      learningUnitCount: learningUnits.length,
      storageVersion: NORMALIZED_SONG_VERSION,
      fileNameKey: normalizeLookupText(fileName),
      titleArtistKey: `${normalizeLookupText(title)}\u0000${normalizeLookupText(artist)}`,
      sourceKey: sourceSongId ? `${source}\u0000${sourceSongId}` : '',
    },
    lyrics: {
      songId: song.id,
      rawLrc: String(song?.rawLrc || ''),
      parsedVersion: Number(song?.parsedVersion) || 1,
    },
    cards,
    learningUnits,
    progress: compactProgress,
  };
}

export function hydrateSong(song, lyrics, cards = [], learningUnits = [], progress = null) {
  if (!song) return null;
  const unitMap = new Map(learningUnits.map(item => [item.unitId, item]));
  const hydratedCards = [...cards]
    .sort((left, right) => (Number(left?.timestamp) || 0) - (Number(right?.timestamp) || 0))
    .map(card => {
    const unit = unitMap.get(card.learningUnitId);
    return {
      ...card,
      learningUnit: {
        id: card.learningUnitId,
        role: card.learningRole,
        representativeCardId: card.representativeCardId,
        representativeIndex: card.representativeIndex,
        occurrenceIndex: card.occurrenceIndex,
        occurrenceCount: card.occurrenceCount,
      },
      learning: unit ? learningFromUnitRecord(unit) : { ...DEFAULT_LEARNING },
      explain: card.explain || { status: 'idle', content: '', error: '', updatedAt: 0 },
      ui: { expanded: false },
    };
    });

  return {
    ...song,
    rawLrc: lyrics?.rawLrc || '',
    parsedVersion: lyrics?.parsedVersion || 1,
    cards: hydratedCards,
    progress: progress || createCompactProgress(song, null, learningUnits),
  };
}

export function createProgressSummaryFromRecords(song, progress = null) {
  const totalCards = Number(progress?.totalUnits ?? song?.learningUnitCount) || 0;
  const studiedCount = Number(progress?.studiedCount) || 0;
  const masteredCount = Number(progress?.masteredCount) || 0;
  const fuzzyCount = Number(progress?.fuzzyCount) || 0;
  return {
    totalCards,
    studiedCount,
    masteredCount,
    completionRate: totalCards ? studiedCount / totalCards : 0,
    lastStudiedAt: Number(progress?.lastStudiedAt || song?.lastStudiedAt) || 0,
    currentCardId: String(progress?.currentCardId || ''),
    stateCounts: {
      new: Math.max(0, totalCards - studiedCount),
      learning: Math.max(0, studiedCount - masteredCount - fuzzyCount),
      fuzzy: fuzzyCount,
      mastered: masteredCount,
      favorite: Number(progress?.favoriteCount) || 0,
    },
  };
}

export function learningFromUnitRecord(unit) {
  return {
    state: unit?.state || 'new',
    favorite: Boolean(unit?.favoriteKey),
    reviewCount: Number(unit?.reviewCount) || 0,
    lapseCount: Number(unit?.lapseCount) || 0,
    studiedAt: Number(unit?.studiedAt) || 0,
    lastReviewedAt: Number(unit?.lastReviewedAt) || 0,
    nextReviewAt: Number(unit?.nextReviewAt) || 0,
  };
}

export function createLearningUnitRecord(songId, card, learning = DEFAULT_LEARNING) {
  const state = learning?.state || 'new';
  const activityAt = Number(learning?.lastReviewedAt || learning?.studiedAt) || 0;
  return {
    key: createLearningUnitKey(songId, card.learningUnit.id),
    songId,
    unitId: card.learningUnit.id,
    representativeCardId: card.learningUnit.representativeCardId || card.id,
    state,
    favoriteKey: learning?.favorite ? 1 : undefined,
    reviewableKey: state !== 'new' && state !== 'mastered' ? 1 : undefined,
    historyKey: state !== 'new' ? 1 : undefined,
    reviewCount: Number(learning?.reviewCount) || 0,
    lapseCount: Number(learning?.lapseCount) || 0,
    studiedAt: Number(learning?.studiedAt) || 0,
    lastReviewedAt: Number(learning?.lastReviewedAt) || 0,
    nextReviewAt: Number(learning?.nextReviewAt) || 0,
    activityAt,
  };
}

export function createCompactProgress(song, progress, learningUnits) {
  const units = Array.isArray(learningUnits) ? learningUnits : [];
  const totalUnits = units.length || Number(progress?.totalUnits) || 0;
  const studiedCount = units.length
    ? units.filter(item => item.state !== 'new').length
    : Number(progress?.studiedCount) || 0;
  const masteredCount = units.length
    ? units.filter(item => item.state === 'mastered').length
    : Number(progress?.masteredCount) || 0;
  const fuzzyCount = units.length
    ? units.filter(item => item.state === 'fuzzy').length
    : Number(progress?.fuzzyCount) || 0;
  const favoriteCount = units.length
    ? units.filter(item => item.favoriteKey).length
    : Number(progress?.favoriteCount) || 0;
  return {
    songId: song.id,
    currentCardId: String(progress?.currentCardId || ''),
    totalUnits,
    studiedCount,
    masteredCount,
    fuzzyCount,
    favoriteCount,
    completionRate: totalUnits ? studiedCount / totalUnits : 0,
    lastStudiedAt: Number(progress?.lastStudiedAt || song?.lastStudiedAt) || 0,
    storageVersion: NORMALIZED_SONG_VERSION,
  };
}

function createCardRecord(songId, card) {
  return {
    id: card.id,
    songId,
    timestamp: Number(card.timestamp) || 0,
    timeStr: String(card.timeStr || ''),
    type: String(card.type || ''),
    lyric: String(card.lyric || ''),
    translation: String(card.translation || ''),
    extra: card.extra || {},
    songContext: String(card.songContext || ''),
    explain: card.explain || { status: 'idle', content: '', error: '', updatedAt: 0 },
    learningUnitId: card.learningUnit?.id || '',
    learningRole: card.learningUnit?.role || 'passive',
    representativeCardId: card.learningUnit?.representativeCardId || card.id,
    representativeIndex: Number(card.learningUnit?.representativeIndex) || 0,
    occurrenceIndex: Number(card.learningUnit?.occurrenceIndex) || 1,
    occurrenceCount: Number(card.learningUnit?.occurrenceCount) || 1,
  };
}
