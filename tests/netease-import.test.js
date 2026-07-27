import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSongIdFromUrl,
  resolveNeteaseSongInput,
} from '../server/netease/input.js';
import {
  analyzeLyricTrackBundle,
  importSongFromTrackBundle,
  parseTypedTrack,
} from '../src/engine/song-importer.js';

test('网易云输入：支持歌曲 ID、公开链接、Hash 链接与分享文本', async () => {
  assert.equal((await resolveNeteaseSongInput('123456')).songId, '123456');
  assert.equal(
    (await resolveNeteaseSongInput('分享歌曲 https://music.163.com/song?id=654321 欢迎收听')).songId,
    '654321',
  );
  assert.equal(
    extractSongIdFromUrl('https://music.163.com/#/song?id=777888'),
    '777888',
  );
  assert.equal(
    extractSongIdFromUrl('https://y.music.163.com/song/998877'),
    '998877',
  );
});

test('网易云输入：短链接逐跳校验并解析最终歌曲 ID', async () => {
  const calls = [];
  const result = await resolveNeteaseSongInput('https://163cn.tv/abc', {
    fetchImpl: async url => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://music.163.com/song?id=112233' },
        });
      }
      return new Response('', { status: 200 });
    },
  });

  assert.equal(result.songId, '112233');
  assert.equal(result.resolvedShortLink, true);
  assert.equal(calls.length, 2);
});

test('网易云输入：拒绝非网易云域名与超长输入', async () => {
  await assert.rejects(
    resolveNeteaseSongInput('https://example.com/song?id=123'),
    error => error.code === 'UNSUPPORTED_HOST',
  );
  await assert.rejects(
    resolveNeteaseSongInput('x'.repeat(4097)),
    error => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    resolveNeteaseSongInput('https://163cn.tv/unsafe', {
      fetchImpl: async () => new Response('', {
        status: 302,
        headers: { location: 'https://evil.example/song?id=123' },
      }),
    }),
    error => error.code === 'UNSUPPORTED_HOST',
  );
});

test('多轨歌词：应用 offset、展开多时间标签并合并相同时间', () => {
  const lines = parseTypedTrack([
    '[offset:+100]',
    '[00:01.00][00:02.00]君',
    '[00:01.00]の名',
  ].join('\n'));

  assert.deepEqual(lines, [
    { timestamp: 1100, text: '君\nの名' },
    { timestamp: 2100, text: '君' },
  ]);
});

test('多轨歌词：过滤带时间戳的作词、作曲等署名行', () => {
  const lines = parseTypedTrack([
    '[00:00.00]作词 : Someone',
    '[00:00.50]Composer: Someone',
    '[00:00.70]演唱：Someone',
    '[00:00.80]推广策划：Someone',
    '[00:01.00]君の夢',
  ].join('\n'));
  assert.deepEqual(lines, [{ timestamp: 1000, text: '君の夢' }]);
});

test('多轨歌词：精确匹配优先，500ms 内吸附，超出范围给出警告', () => {
  const analysis = analyzeLyricTrackBundle({
    original: { rawLrc: '[00:01.00]君\n[00:02.00]夢' },
    translation: { rawLrc: '[00:01.00]你\n[00:02.49]梦\n[00:05.00]多余' },
    romaji: { rawLrc: '[00:01.20]kimi' },
  });

  assert.equal(analysis.groups[0].original, '君');
  assert.equal(analysis.groups[0].translation, '你');
  assert.equal(analysis.groups[0].romaji, 'kimi');
  assert.equal(analysis.groups[1].translation, '梦');
  assert.equal(analysis.unmatchedTranslationCount, 1);
  assert.ok(analysis.warnings.some(item => item.code === 'TRANSLATION_UNMATCHED'));
});

test('多轨歌词：纯汉字日文始终保存为主歌词并生成稳定歌曲 ID', () => {
  const result = importSongFromTrackBundle({
    songMeta: {
      sourceSongId: '123456',
      title: '夢',
      artist: '歌手',
      album: '专辑',
      coverUrl: 'javascript:alert(1)',
    },
    tracks: {
      original: { rawLrc: '[00:01.00]君の夢' },
      translation: { rawLrc: '[00:01.00]你的梦' },
      romaji: { rawLrc: '' },
    },
  });

  assert.equal(result.song.id, 'song_netease_123456');
  assert.equal(result.song.cards[0].lyric, '君の夢');
  assert.equal(result.song.cards[0].translation, '你的梦');
  assert.equal(result.song.coverUrl, '');
  assert.equal(result.song.parsedVersion, 2);
  assert.equal(result.song.sourceSongId, '123456');
});

test('多轨歌词：缺少翻译和罗马音仍允许导入，缺少原文则拒绝', () => {
  const imported = importSongFromTrackBundle({
    songMeta: { sourceSongId: '100', title: 'Only Original' },
    tracks: { original: { rawLrc: '[00:01.00]歌詞' } },
  });
  assert.equal(imported.song.cards.length, 1);
  assert.ok(imported.meta.warnings.some(item => item.code === 'TRANSLATION_MISSING'));

  assert.throws(() => importSongFromTrackBundle({
    songMeta: { sourceSongId: '101' },
    tracks: {},
  }), /原文歌词/);
});
