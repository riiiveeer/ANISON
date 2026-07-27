import test from 'node:test';
import assert from 'node:assert/strict';

import { parseManualTextPlaylist } from '../src/engine/playlist-importer.js';

test('playlistImporter: 应解析文本歌单区块', () => {
  const result = parseManualTextPlaylist({
    playlistName: '测试歌单',
    rawText: `Song A - Artist A
[00:01.00]あいうえお
[00:01.00]测试
---
Song B - Artist B
[00:02.00]かきくけこ
[00:02.00]第二首`,
  });

  assert.equal(result.playlist.name, '测试歌单');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'Song A');
  assert.equal(result.items[0].artist, 'Artist A');
  assert.match(result.items[0].rawLrc, /\[00:01\.00\]/);
});
