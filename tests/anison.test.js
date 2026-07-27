import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseLRC, formatTimestamp } from '../src/engine/lrc-parser.js';

const lrcText = fs.readFileSync(new URL('./fixtures/mixed-language-demo.lrc', import.meta.url), 'utf8');

function findGroupByTime(groups, timeStr) {
  return groups.find(g => g.timeStr === timeStr);
}

test('parseLRC: 应提取元数据并保留有效歌词分组', () => {
  const { groups, metaLines } = parseLRC(lrcText);

  assert.ok(metaLines.length >= 4, '应识别出多条元数据');
  assert.ok(metaLines.some(line => line.includes('作词')));
  assert.ok(metaLines.some(line => line.includes('[by:ANISON]')));
  assert.ok(groups.length > 0, '应解析出有效歌词组');
});

test('parseLRC: 英文 + 中文应识别为 en-zh', () => {
  const { groups } = parseLRC(lrcText);
  const group = findGroupByTime(groups, formatTimestamp(13710));

  assert.ok(group, '应找到 00:13.71 对应分组');
  assert.equal(group.type, 'en-zh');
  assert.equal(group.enLine?.text, 'Open the page');
  assert.equal(group.zhLine?.text, '打开这一页');
  assert.equal(group.romajiLine, null);
});

test('parseLRC: 日文 + 中文 + 罗马音应识别为 jp-zh-ro', () => {
  const { groups } = parseLRC(lrcText);
  const group = findGroupByTime(groups, formatTimestamp(31150));

  assert.ok(group, '应找到 00:31.15 对应分组');
  assert.equal(group.type, 'jp-zh-ro');
  assert.equal(group.jpLine?.text, '光を探して歩いていく');
  assert.equal(group.zhLine?.text, '寻找光芒继续前行');
  assert.match(group.romajiLine?.text || '', /hi ka ri wo/);
});

test('parseLRC: 混合英文 + 日文行应优先保留为日文句', () => {
  const { groups } = parseLRC(lrcText);
  const group = findGroupByTime(groups, formatTimestamp(188060));

  assert.ok(group, '应找到 03:08.06 对应分组');
  assert.ok(group.jpLine, '应识别出日文行');
  assert.equal(group.jpLine?.text, 'Are you ready?　前へ進もう');
});
