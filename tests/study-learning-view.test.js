import test from 'node:test';
import assert from 'node:assert/strict';

import { annotateLearningUnits, applyLearningUnitProgress } from '../src/engine/learning-units.js';
import { __testables__ } from '../src/render/study-view.js';

function createCard(id, lyric, translation = '') {
  return {
    id,
    type: 'jp-zh',
    lyric,
    translation,
    learning: { state: 'new', favorite: false },
    explain: { status: 'idle', content: '', error: '' },
  };
}

test('study view: 双重进度只统计独立日语学习单元', () => {
  const cards = applyLearningUnitProgress(annotateLearningUnits([
    createCard('jp-1', '熱異常', '热异常'),
    createCard('en', 'PASSIONATE ANTHEM'),
    createCard('jp-2', '熱異常！', '热异常'),
    createCard('jp-3', '君の夢', '你的梦'),
  ]), {
    cardStates: {
      'jp-2': { state: 'learning', studiedAt: 100, nextReviewAt: 200 },
    },
  });

  assert.deepEqual(__testables__.summarizeCards(cards), {
    total: 2,
    studied: 1,
    mastered: 0,
    percent: 50,
  });
  assert.equal(__testables__.formatCardLearningState(cards[1]), '英文');
  assert.equal(__testables__.formatCardLearningState(cards[2]), '重复·已学');
});

test('study view: 英文和已覆盖重复句显示明确说明', () => {
  const cards = applyLearningUnitProgress(annotateLearningUnits([
    createCard('first', '熱異常', '热异常'),
    createCard('english', 'PASSIONATE ANTHEM'),
    createCard('repeat', '熱異常！', '热异常'),
  ]), {
    cardStates: {
      first: { state: 'learning', studiedAt: 100, nextReviewAt: 200 },
    },
  });

  assert.match(__testables__.getStudyCompletionMessage(cards[1]), /英文段落/);
  assert.match(__testables__.getStudyCompletionMessage(cards[2]), /合并/);
});

test('study view: 从曲库进入时选择时间轴中的第一张未学日语卡', () => {
  const cards = applyLearningUnitProgress(annotateLearningUnits([
    createCard('english', 'PASSIONATE ANTHEM'),
    createCard('learned', '既に学んだ', '已经学过'),
    createCard('first-new', '最初の未学', '第一句未学'),
    createCard('repeat-new', '最初の未学！', '第一句未学'),
    createCard('second-new', '次の未学', '下一句未学'),
  ]), {
    cardStates: {
      learned: { state: 'learning', studiedAt: 100, nextReviewAt: 200 },
    },
  });

  assert.equal(__testables__.findFirstUnlearnedCardId(cards), 'first-new');
});

test('study view: 全部学完时不伪造未学入口', () => {
  const cards = applyLearningUnitProgress(annotateLearningUnits([
    createCard('english', 'PASSIONATE ANTHEM'),
    createCard('learned', '学習済み', '已经学过'),
  ]), {
    cardStates: {
      learned: { state: 'mastered', studiedAt: 100 },
    },
  });

  assert.equal(__testables__.findFirstUnlearnedCardId(cards), '');
});
