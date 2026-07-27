/**
 * 文件功能：生成简版复习队列与学习概览。
 * 结构说明：
 * 1. 基于歌词卡学习状态生成今日待复习列表；
 * 2. 提供继续学习、最近学习与状态统计所需的聚合结果；
 * 3. 当前为简版规则，后续可平滑升级到更复杂的 SRS。
 */

import {
  annotateLearningUnits,
  classifyLearningRole,
  groupTargetLearningUnits,
  resolveLearningUnitState,
} from './learning-units.js';

const DAY = 24 * 60 * 60 * 1000;

function isStudyCard(card) {
  return classifyLearningRole(card) === 'target';
}

export function scheduleNextReview(grade, now = Date.now(), reviewCount = 0) {
  if (grade === 'learning' || grade === 'studied') return now + DAY;
  if (grade === 'again' || grade === 'hard' || grade === 'fuzzy') return now + DAY * 7;
  if (grade === 'good' || grade === 'mastered') return 0;
  return now;
}

export function learningStateForGrade(grade) {
  if (grade === 'good') return 'mastered';
  if (grade === 'hard') return 'fuzzy';
  if (grade === 'again') return 'learning';
  return grade || 'new';
}

export function summarizeProgress(cards = [], progress = null) {
  const units = groupTargetLearningUnits(annotateLearningUnits(cards));
  const totalCards = units.length;
  const stateCounts = {
    new: 0,
    learning: 0,
    fuzzy: 0,
    mastered: 0,
    favorite: 0,
  };

  units.forEach(unitCards => {
    const learning = resolveLearningUnitState(unitCards, progress);
    stateCounts[learning.state] = (stateCounts[learning.state] || 0) + 1;
    if (learning.favorite) stateCounts.favorite += 1;
  });

  const studiedCount = totalCards - stateCounts.new;
  const completionRate = totalCards ? studiedCount / totalCards : 0;

  return {
    totalCards,
    studiedCount,
    masteredCount: stateCounts.mastered,
    completionRate,
    lastStudiedAt: progress?.lastStudiedAt || 0,
    currentCardId: progress?.currentCardId || '',
    stateCounts,
  };
}

export function buildReviewItems(song, progress, now = Date.now()) {
  const units = groupTargetLearningUnits(annotateLearningUnits(song.cards || []));
  return units
    .map(unitCards => {
      const card = unitCards[0];
      const learning = resolveLearningUnitState(unitCards, progress);
      return {
        ...card,
        learning,
        songId: song.id,
        songTitle: song.title || '未命名歌曲',
        songArtist: song.artist || '未知歌手',
        due: learning.state !== 'new'
          && learning.state !== 'mastered'
          && (learning.nextReviewAt || 0) <= now,
      };
    })
    .filter(card => card.learning.state !== 'new' || card.learning.favorite);
}

export function filterReviewItems(items, filter = 'due', dueBefore = Date.now()) {
  if (filter === 'all') {
    return items.filter(item => item.learning.state !== 'new');
  }
  if (filter === 'favorites') {
    return items.filter(item => item.learning.favorite);
  }
  if (filter === 'mastered') {
    return items.filter(item => item.learning.state === 'mastered');
  }
  if (filter === 'fuzzy') {
    return items.filter(item => item.learning.state === 'fuzzy');
  }
  if (filter === 'learning') {
    return items.filter(item => item.learning.state === 'learning');
  }
  return items.filter(item => item.due && (item.learning.nextReviewAt || 0) <= dueBefore);
}

export function pickContinueSong(songs = []) {
  return [...songs]
    .filter(song => (song.progressSummary?.lastStudiedAt || 0) > 0)
    .sort((left, right) => (right.progressSummary?.lastStudiedAt || 0) - (left.progressSummary?.lastStudiedAt || 0))[0] || null;
}

export function createTodayOverview(songs = [], reviewItems = []) {
  const continueSong = pickContinueSong(songs);
  const studiedSongs = songs.filter(song => (song.progressSummary?.studiedCount || 0) > 0).length;

  return {
    songCount: songs.length,
    studiedSongs,
    reviewCount: reviewItems.length,
    continueSong,
  };
}

export const __testables__ = {
  DAY,
  isStudyCard,
};
