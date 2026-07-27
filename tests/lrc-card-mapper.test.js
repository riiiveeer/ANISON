import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseLRC, formatTimestamp } from '../src/engine/lrc-parser.js';
import { mapGroupsToCards } from '../src/engine/lrc-card-mapper.js';

const lrcText = fs.readFileSync(new URL('./fixtures/mixed-language-demo.lrc', import.meta.url), 'utf8');

test('mapGroupsToCards: 应将 group 标准化为歌词卡结构', () => {
  const { groups } = parseLRC(lrcText);
  const cards = mapGroupsToCards(groups);

  assert.ok(cards.length > 0, '应生成歌词卡');
  assert.ok(cards.every(card => card.id), '每张卡都应有 id');
  assert.ok(cards.every(card => typeof card.timeStr === 'string'));
  assert.ok(cards.every(card => card.explain.status === 'idle'));
  assert.ok(cards.every(card => card.ui.expanded === false));
  assert.ok(cards.every(card => typeof card.songContext === 'string' && card.songContext.length > 0));
});

test('mapGroupsToCards: en-zh 应映射为英文正文 + 中文翻译', () => {
  const { groups } = parseLRC(lrcText);
  const cards = mapGroupsToCards(groups);
  const card = cards.find(item => item.timeStr === formatTimestamp(13710));

  assert.ok(card, '应找到 00:13.71 对应卡片');
  assert.equal(card?.type, 'en-zh');
  assert.equal(card?.lyric, 'Open the page');
  assert.equal(card?.translation, '打开这一页');
  assert.equal(card?.extra.enText, 'Open the page');
});

test('mapGroupsToCards: jp-zh-ro 应保留翻译与罗马音扩展字段', () => {
  const { groups } = parseLRC(lrcText);
  const cards = mapGroupsToCards(groups);
  const card = cards.find(item => item.timeStr === formatTimestamp(31150));

  assert.ok(card, '应找到 00:31.15 对应卡片');
  assert.equal(card?.type, 'jp-zh-ro');
  assert.equal(card?.lyric, '光を探して歩いていく');
  assert.equal(card?.translation, '寻找光芒继续前行');
  assert.match(card?.extra.romajiText || '', /hi ka ri wo/);
  assert.match(card?.songContext || '', /00:31\.15 日文：光を探して歩いていく/);
  assert.match(card?.songContext || '', /00:13\.71 英文：Open the page ｜ 中文：打开这一页/);
});
