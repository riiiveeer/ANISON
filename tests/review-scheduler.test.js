import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewItems, createTodayOverview, filterReviewItems, scheduleNextReview, summarizeProgress } from '../src/engine/review-scheduler.js';

test('reviewScheduler: summarizeProgress 应统计学习状态', () => {
  const cards = [
    { id: 'c1', type: 'jp-zh', learning: { state: 'new', favorite: false } },
    { id: 'c2', type: 'jp-zh-ro', learning: { state: 'new', favorite: false } },
    { id: 'c3', type: 'en-zh', learning: { state: 'new', favorite: false } },
  ];
  const summary = summarizeProgress(cards, {
    cardStates: {
      c1: { state: 'learning', favorite: true },
      c2: { state: 'mastered', favorite: false },
      c3: { state: 'learning', favorite: false },
    },
  });

  assert.equal(summary.studiedCount, 2);
  assert.equal(summary.totalCards, 2);
  assert.equal(summary.masteredCount, 1);
  assert.equal(summary.stateCounts.favorite, 1);
  assert.equal(summary.completionRate, 1);
});

test('reviewScheduler: buildReviewItems 应返回到期待复习卡片', () => {
  const now = 1000;
  const items = buildReviewItems({
    id: 'song_1',
    title: 'Song',
    artist: 'Artist',
    cards: [{ id: 'c1', type: 'jp-zh', lyric: '君' }, { id: 'c2', type: 'en-zh', lyric: 'Passionate' }],
  }, {
    cardStates: {
      c1: { state: 'fuzzy', nextReviewAt: 500, favorite: false },
      c2: { state: 'mastered', nextReviewAt: 2000, favorite: true },
    },
  }, now);

  assert.deepEqual(items.map(item => item.id), ['c1']);
});

test('reviewScheduler: 重复歌词只生成一个复习项目', () => {
  const items = buildReviewItems({
    id: 'song_repeat',
    cards: [
      { id: 'first', type: 'jp-zh', lyric: '熱異常', translation: '热异常' },
      { id: 'second', type: 'jp-zh', lyric: '熱異常！', translation: '热异常' },
      { id: 'english', type: 'jp-zh', lyric: 'PASSIONATE ANTHEM' },
    ],
  }, {
    cardStates: {
      second: { state: 'learning', studiedAt: 100, nextReviewAt: 500 },
    },
  }, 1000);

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'first');
  assert.equal(items[0].learning.state, 'learning');
});

test('reviewScheduler: buildReviewItems 应保留未到期卡供历史筛选', () => {
  const items = buildReviewItems({
    id: 'song_1',
    cards: [
      { id: 'due', type: 'jp-zh' },
      { id: 'later', type: 'jp-zh' },
      { id: 'favorite-new', type: 'jp-zh' },
    ],
  }, {
    cardStates: {
      due: { state: 'fuzzy', nextReviewAt: 500 },
      later: { state: 'mastered', nextReviewAt: 2000 },
      'favorite-new': { state: 'new', favorite: true, nextReviewAt: 0 },
    },
  }, 1000);

  assert.deepEqual(items.map(item => item.id), ['due', 'later', 'favorite-new']);
  assert.deepEqual(filterReviewItems(items, 'due', 1000).map(item => item.id), ['due']);
  assert.deepEqual(filterReviewItems(items, 'all', 1000).map(item => item.id), ['due', 'later']);
  assert.deepEqual(filterReviewItems(items, 'favorites', 1000).map(item => item.id), ['favorite-new']);
});

test('reviewScheduler: filterReviewItems 应支持收藏筛选', () => {
  const filtered = filterReviewItems([
    { id: '1', due: true, learning: { favorite: false, state: 'fuzzy' } },
    { id: '2', due: false, learning: { favorite: true, state: 'mastered' } },
  ], 'favorites');

  assert.deepEqual(filtered.map(item => item.id), ['2']);
});

test('reviewScheduler: filterReviewItems 应支持全部列表', () => {
  const filtered = filterReviewItems([
    { id: '1', due: true, learning: { favorite: false, state: 'learning' } },
    { id: '2', due: false, learning: { favorite: true, state: 'mastered' } },
  ], 'all');

  assert.deepEqual(filtered.map(item => item.id), ['1', '2']);
});

test('reviewScheduler: createTodayOverview 应返回继续学习歌曲与统计', () => {
  const overview = createTodayOverview([
    { id: 'song_1', title: 'A', progressSummary: { studiedCount: 2, lastStudiedAt: 10, completionRate: 0.5 } },
    { id: 'song_2', title: 'B', progressSummary: { studiedCount: 1, lastStudiedAt: 20, completionRate: 0.3 } },
  ], [{ id: 'r1' }, { id: 'r2' }]);

  assert.equal(overview.songCount, 2);
  assert.equal(overview.studiedSongs, 2);
  assert.equal(overview.reviewCount, 2);
  assert.equal(overview.continueSong.id, 'song_2');
});

test('reviewScheduler: scheduleNextReview 应按状态给出下次时间', () => {
  assert.equal(scheduleNextReview('new', 100), 100);
  assert.equal(scheduleNextReview('learning', 100), 100 + 24 * 60 * 60 * 1000);
});

test('reviewScheduler: 首次学习次日复习，忘记或模糊七日后复习，掌握后停止', () => {
  const minute = 60 * 1000;
  const day = 24 * 60 * minute;
  assert.equal(scheduleNextReview('studied', 100), 100 + day);
  assert.equal(scheduleNextReview('again', 100, 1), 100 + 7 * day);
  assert.equal(scheduleNextReview('hard', 100, 1), 100 + 7 * day);
  assert.equal(scheduleNextReview('good', 100, 1), 0);
  assert.equal(scheduleNextReview('good', 100, 8), 0);
});

test('reviewScheduler: 已掌握卡片不再进入到期队列', () => {
  const items = buildReviewItems({
    id: 'song_1',
    cards: [{ id: 'mastered', type: 'jp-zh' }],
  }, {
    cardStates: {
      mastered: { state: 'mastered', nextReviewAt: 0 },
    },
  }, 1000);

  assert.deepEqual(filterReviewItems(items, 'due', 1000), []);
});
