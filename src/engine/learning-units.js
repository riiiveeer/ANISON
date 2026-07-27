const DEFAULT_LEARNING = {
  state: 'new',
  favorite: false,
  reviewCount: 0,
  lapseCount: 0,
  studiedAt: 0,
  lastReviewedAt: 0,
  nextReviewAt: 0,
};

const STATE_PRIORITY = {
  new: 0,
  learning: 1,
  fuzzy: 2,
  mastered: 3,
};

export function classifyLearningRole(card) {
  const text = String(card?.lyric || '').trim();
  if (!text) {
    return card?.type === 'en-zh' ? 'passive' : 'target';
  }
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) {
    return 'target';
  }
  return 'passive';
}

export function normalizeLearningText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function annotateLearningUnits(cards = []) {
  const prepared = cards.map((card, index) => {
    const role = classifyLearningRole(card);
    const normalizedLyric = normalizeLearningText(card?.lyric);
    const normalizedTranslation = normalizeLearningText(card?.translation);
    const rawKey = role === 'target' && normalizedLyric
      ? `${normalizedLyric}\u0000${normalizedTranslation}`
      : `passive\u0000${card?.id || index}`;
    return {
      card,
      index,
      role,
      unitId: `${role}_${hashText(rawKey)}`,
    };
  });

  const unitMeta = new Map();
  for (const item of prepared) {
    const current = unitMeta.get(item.unitId) || {
      count: 0,
      representativeCardId: item.card?.id || '',
      representativeIndex: item.index,
    };
    current.count += 1;
    unitMeta.set(item.unitId, current);
  }

  const occurrenceIndexes = new Map();
  return prepared.map(item => {
    const occurrenceIndex = (occurrenceIndexes.get(item.unitId) || 0) + 1;
    occurrenceIndexes.set(item.unitId, occurrenceIndex);
    const meta = unitMeta.get(item.unitId);
    return {
      ...item.card,
      learningUnit: {
        id: item.unitId,
        role: item.role,
        representativeCardId: meta.representativeCardId,
        representativeIndex: meta.representativeIndex,
        occurrenceIndex,
        occurrenceCount: meta.count,
      },
    };
  });
}

export function groupTargetLearningUnits(cards = []) {
  const annotated = ensureAnnotated(cards);
  const groups = new Map();
  for (const card of annotated) {
    if (card.learningUnit?.role !== 'target') continue;
    const unitId = card.learningUnit.id;
    if (!groups.has(unitId)) groups.set(unitId, []);
    groups.get(unitId).push(card);
  }
  return Array.from(groups.values());
}

export function getLearningUnitCards(cards = [], cardId = '') {
  const annotated = ensureAnnotated(cards);
  const current = annotated.find(card => card.id === cardId);
  if (!current) return [];
  if (current.learningUnit?.role !== 'target') return [current];
  return annotated.filter(card => card.learningUnit?.id === current.learningUnit.id);
}

export function resolveLearningUnitState(unitCards = [], progress = null) {
  const cardStates = progress?.cardStates || {};
  const studiedCardIds = progress?.studiedCardIds || [];
  const masteredCardIds = progress?.masteredCardIds || [];
  const candidates = unitCards.map(card => {
    const learning = {
      ...DEFAULT_LEARNING,
      ...card?.learning,
      ...(cardStates[card.id] || {}),
    };
    if (!cardStates[card.id]) {
      if (masteredCardIds.includes(card.id)) learning.state = 'mastered';
      else if (studiedCardIds.includes(card.id)) learning.state = 'learning';
    }
    return learning;
  });
  if (!candidates.length) return { ...DEFAULT_LEARNING };

  const latest = [...candidates].sort((left, right) => {
    const leftTime = left.lastReviewedAt || left.studiedAt || 0;
    const rightTime = right.lastReviewedAt || right.studiedAt || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return (STATE_PRIORITY[right.state] || 0) - (STATE_PRIORITY[left.state] || 0);
  })[0];
  const positiveReviewTimes = candidates.map(item => item.nextReviewAt || 0).filter(Boolean);

  return {
    ...DEFAULT_LEARNING,
    ...latest,
    favorite: candidates.some(item => item.favorite),
    reviewCount: Math.max(...candidates.map(item => item.reviewCount || 0)),
    lapseCount: Math.max(...candidates.map(item => item.lapseCount || 0)),
    studiedAt: minPositive(candidates.map(item => item.studiedAt || 0)),
    lastReviewedAt: Math.max(...candidates.map(item => item.lastReviewedAt || 0)),
    nextReviewAt: latest.state === 'mastered'
      ? 0
      : positiveReviewTimes.length
        ? Math.min(...positiveReviewTimes)
        : (latest.nextReviewAt || 0),
  };
}

export function applyLearningUnitProgress(cards = [], progress = null) {
  const annotated = ensureAnnotated(cards);
  const stateByUnit = new Map();
  for (const unitCards of groupTargetLearningUnits(annotated)) {
    stateByUnit.set(unitCards[0].learningUnit.id, resolveLearningUnitState(unitCards, progress));
  }

  return annotated.map(card => {
    const learning = card.learningUnit?.role === 'target'
      ? stateByUnit.get(card.learningUnit.id)
      : {
          ...DEFAULT_LEARNING,
          ...card.learning,
          ...(progress?.cardStates?.[card.id] || {}),
          state: 'new',
        };
    return { ...card, learning };
  });
}

export function summarizeAnnotatedLearningUnits(cards = []) {
  const units = groupTargetLearningUnits(cards);
  const states = units.map(unitCards => resolveLearningUnitState(unitCards));
  const studied = states.filter(state => state.state !== 'new').length;
  const mastered = states.filter(state => state.state === 'mastered').length;
  return {
    total: units.length,
    studied,
    mastered,
    percent: units.length ? Math.round((studied / units.length) * 100) : 0,
  };
}

function ensureAnnotated(cards) {
  if (cards.every(card => card?.learningUnit?.id && card?.learningUnit?.role)) return cards;
  return annotateLearningUnits(cards);
}

function minPositive(values) {
  const positive = values.filter(Boolean);
  return positive.length ? Math.min(...positive) : 0;
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export const __testables__ = {
  DEFAULT_LEARNING,
  STATE_PRIORITY,
  hashText,
};
