import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateLearningUnits,
  applyLearningUnitProgress,
  classifyLearningRole,
  groupTargetLearningUnits,
  normalizeLearningText,
  summarizeAnnotatedLearningUnits,
} from '../src/engine/learning-units.js';

function card(id, lyric, translation = '', type = 'jp-zh') {
  return {
    id,
    type,
    lyric,
    translation,
    learning: { state: 'new', favorite: false },
    explain: { status: 'idle', content: '', error: '' },
  };
}

test('learning units: 纯英文为连读卡，日文和日英混合句为学习卡', () => {
  assert.equal(classifyLearningRole(card('en', 'PASSIONATE ANTHEM')), 'passive');
  assert.equal(classifyLearningRole(card('jp', '君の夢')), 'target');
  assert.equal(classifyLearningRole(card('mixed', 'もっと Shout!')), 'target');
  assert.equal(classifyLearningRole(card('kanji', '熱異常')), 'target');
});

test('learning units: 忽略空格、大小写和标点，但不同翻译不合并', () => {
  assert.equal(normalizeLearningText(' Passionate,  GAZE! '), 'passionategaze');
  const annotated = annotateLearningUnits([
    card('1', '君 の 夢！', '你的梦'),
    card('2', '君の夢', '你的梦'),
    card('3', '君の夢', '他的梦'),
  ]);
  assert.equal(annotated[0].learningUnit.id, annotated[1].learningUnit.id);
  assert.notEqual(annotated[0].learningUnit.id, annotated[2].learningUnit.id);
  assert.equal(annotated[1].learningUnit.occurrenceIndex, 2);
  assert.equal(annotated[0].learningUnit.occurrenceCount, 2);
});

test('learning units: 重复日语句只计一个学习单元，英文不进入分母', () => {
  const annotated = annotateLearningUnits([
    card('1', '熱異常', '热异常'),
    card('2', 'PASSIONATE ANTHEM', '', 'jp-zh'),
    card('3', '熱異常！', '热异常'),
    card('4', '君の夢', '你的梦'),
  ]);
  assert.equal(groupTargetLearningUnits(annotated).length, 2);

  const hydrated = applyLearningUnitProgress(annotated, {
    cardStates: {
      3: { state: 'learning', studiedAt: 100, nextReviewAt: 200 },
    },
  });
  assert.equal(hydrated.find(item => item.id === '1').learning.state, 'learning');
  assert.equal(hydrated.find(item => item.id === '3').learning.state, 'learning');

  const summary = summarizeAnnotatedLearningUnits(hydrated);
  assert.deepEqual(summary, { total: 2, studied: 1, mastered: 0, percent: 50 });
});
