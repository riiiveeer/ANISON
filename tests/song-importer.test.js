import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { importSongFromLrc, __testables__ } from '../src/engine/song-importer.js';

const lrcText = fs.readFileSync(new URL('./fixtures/mixed-language-demo.lrc', import.meta.url), 'utf8');

test('importSongFromLrc: 应生成标准化 Song 结构', () => {
  const result = importSongFromLrc({
    rawLrc: lrcText,
    fileName: 'Study Light - ANISON Demo.lrc',
  });

  assert.ok(result.song.id.startsWith('song_'));
  assert.equal(result.song.title, 'Study Light');
  assert.equal(result.song.artist, 'ANISON Demo');
  assert.ok(result.song.cards.length > 0);
  assert.equal(result.song.cards[0].songId, result.song.id);
  assert.ok(result.song.contentHash);
});

test('inferSongMeta: 应从文件名推断标题与歌手', () => {
  const meta = __testables__.inferSongMeta('Hikaru Nara - Goose house.lrc', []);
  assert.equal(meta.title, 'Hikaru Nara');
  assert.equal(meta.artist, 'Goose house');
});

test('importSongFromLrc: 应优先规范化标题并填充默认名', () => {
  const result = importSongFromLrc({
    rawLrc: '[00:01.00]テスト\n[00:01.00]测试',
    title: '   ',
    artist: '  歌手  ',
  });

  assert.equal(result.song.title, 'テスト');
  assert.equal(result.song.artist, '歌手');
});
