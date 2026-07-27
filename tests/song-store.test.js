import test from 'node:test';
import assert from 'node:assert/strict';

import { songStore } from '../src/store/song-store.js';

function createCard(overrides = {}) {
  return {
    id: '31150',
    timestamp: 31150,
    timeStr: '00:31.15',
    type: 'jp-zh-ro',
    lyric: '眼差しは　唯ひたすらに愚直さを込めて',
    translation: '眼神一味地注入愚直',
    extra: {
      enText: '',
      romajiText: 'ma na za shi wa',
    },
    songContext: '00:31.15 日文：眼差しは　唯ひたすらに愚直さを込めて ｜ 中文：眼神一味地注入愚直',
    explain: {
      status: 'idle',
      content: '',
      error: '',
    },
    learning: {
      state: 'new',
      favorite: false,
      reviewCount: 0,
      lastReviewedAt: 0,
      nextReviewAt: 0,
    },
    ui: {
      expanded: false,
    },
    ...overrides,
  };
}

test('songStore: setAnalysisResult 应写入原文、卡片和统计', () => {
  songStore.reset();
  const cards = [createCard(), createCard({ id: '13710', timestamp: 13710, timeStr: '00:13.71', type: 'en-zh', lyric: 'Passionate Gaze', translation: '激昂之凝视', extra: { enText: 'Passionate Gaze', romajiText: '' } })];

  songStore.setAnalysisResult({
    rawText: '[00:13.71]Passionate Gaze',
    songContext: '整首歌词上下文',
    cards,
    stats: songStore.createStats(cards),
  });

  assert.equal(songStore.rawText, '[00:13.71]Passionate Gaze');
  assert.equal(songStore.songContext, '整首歌词上下文');
  assert.equal(songStore.cards.length, 2);
  assert.equal(songStore.isAnalyzed, true);
  assert.deepEqual(songStore.stats, { total: 2, japanese: 1, english: 1 });
});

test('songStore: updateCardExplainState 应只更新目标卡 explain 状态', () => {
  songStore.reset();
  songStore.setCards([
    createCard(),
    createCard({ id: '13710', timestamp: 13710, timeStr: '00:13.71', type: 'en-zh', lyric: 'Passionate Gaze' }),
  ]);

  songStore.updateCardExplainState('31150', {
    status: 'success',
    content: '讲解完成',
    error: '',
  });

  assert.equal(songStore.getCardById('31150')?.explain.status, 'success');
  assert.equal(songStore.getCardById('31150')?.explain.content, '讲解完成');
  assert.equal(songStore.getCardById('13710')?.explain.status, 'idle');
});

test('songStore: updateCardUIState 应支持单卡展开收起', () => {
  songStore.reset();
  songStore.setCards([createCard()]);

  songStore.updateCardUIState('31150', { expanded: true });
  assert.equal(songStore.getCardById('31150')?.ui.expanded, true);

  songStore.updateCardUIState('31150', { expanded: false });
  assert.equal(songStore.getCardById('31150')?.ui.expanded, false);
});

test('songStore: updateCardLearningState 应更新学习状态与收藏', () => {
  songStore.reset();
  songStore.setCards([createCard()]);

  songStore.updateCardLearningState('31150', { state: 'mastered', favorite: true });
  assert.equal(songStore.getCardById('31150')?.learning.state, 'mastered');
  assert.equal(songStore.getCardById('31150')?.learning.favorite, true);
});

test('songStore: setCurrentSongProgress 应把进度映射到卡片', () => {
  songStore.reset();
  songStore.setCards([createCard()]);

  songStore.setCurrentSongProgress({
    cardStates: {
      '31150': {
        state: 'fuzzy',
        favorite: true,
        reviewCount: 2,
        lastReviewedAt: 100,
        nextReviewAt: 200,
      },
    },
  });

  assert.equal(songStore.getCardById('31150')?.learning.state, 'fuzzy');
  assert.equal(songStore.getCardById('31150')?.learning.favorite, true);
});

test('songStore: 重复歌词应共享同一份 AI 讲解状态', () => {
  songStore.reset();
  songStore.setCards([
    createCard({ id: 'first', lyric: '熱異常', translation: '热异常' }),
    createCard({ id: 'second', lyric: '熱異常！', translation: '热异常' }),
    createCard({ id: 'other', lyric: '君の夢', translation: '你的梦' }),
  ]);

  songStore.updateCardExplainState('first', {
    status: 'success',
    content: '共享讲解',
    error: '',
  });

  assert.equal(songStore.getCardById('second').explain.content, '共享讲解');
  assert.equal(songStore.getCardById('other').explain.status, 'idle');
});
