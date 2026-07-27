import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convertYrcToLrc,
  createNeteaseClient,
  encryptWeapiPayload,
  sanitizeCoverUrl,
} from '../server/netease/client.js';
import { createNeteasePreviewService } from '../server/netease/service.js';
import { createNeteaseLyricProvider } from '../src/engine/lyric-provider.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('网易云客户端：规范化歌曲信息和三轨歌词', async () => {
  const responses = [
    jsonResponse({
      songs: [{
        name: 'Test Song',
        ar: [{ name: 'A' }, { name: 'B' }],
        al: { name: 'Album', picUrl: 'https://p1.music.126.net/a.jpg' },
      }],
    }),
    jsonResponse({
      lrc: { lyric: '[00:01.00]原文' },
      tlyric: { lyric: '[00:01.00]翻译' },
      romalrc: { lyric: '[00:01.00]romaji' },
    }),
  ];
  const client = createNeteaseClient({
    fetchImpl: async () => responses.shift(),
  });

  const preview = await client.getSongPreview('123');
  assert.equal(preview.song.artist, 'A / B');
  assert.equal(preview.song.album, 'Album');
  assert.equal(preview.tracks.original.available, true);
  assert.equal(preview.tracks.translation.available, true);
  assert.equal(preview.tracks.romaji.available, true);
  assert.deepEqual(preview.warnings, []);
});

test('网易云客户端：普通接口结构异常时回退 weapi', async () => {
  let call = 0;
  const client = createNeteaseClient({
    fetchImpl: async () => {
      call += 1;
      if (call <= 2) return jsonResponse({});
      if (call === 3) {
        return jsonResponse({
          songs: [{ name: 'Fallback', artists: [{ name: 'Artist' }], album: {} }],
        });
      }
      return jsonResponse({ lrc: { lyric: '[00:01.00]歌词' } });
    },
  });

  const preview = await client.getSongPreview('456');
  assert.equal(preview.song.title, 'Fallback');
  assert.equal(preview.tracks.original.available, true);
  assert.equal(call, 4);
});

test('网易云客户端：YRC 可压平为行级 LRC，封面只允许可信 HTTPS 域名', () => {
  const lrc = convertYrcToLrc('[1200,3000](1200,500,0)君(1700,500,0)の名');
  assert.equal(lrc, '[00:01.20]君の名');
  assert.equal(sanitizeCoverUrl('https://p2.music.126.net/a.jpg').startsWith('https://'), true);
  assert.equal(sanitizeCoverUrl('http://p2.music.126.net/a.jpg'), '');
  assert.equal(sanitizeCoverUrl('https://example.com/a.jpg'), '');
});

test('网易云客户端：weapi 参数生成稳定形状且不暴露明文', () => {
  const encrypted = encryptWeapiPayload({ id: '123', lv: -1 }, 'abcdefghijklmnop');
  assert.ok(encrypted.params.length > 20);
  assert.equal(encrypted.encSecKey.length, 256);
  assert.equal(encrypted.params.includes('"id"'), false);
});

test('网易云预览服务：相同歌曲命中缓存', async () => {
  let calls = 0;
  const service = createNeteasePreviewService({
    client: {
      async getSongPreview(songId) {
        calls += 1;
        return { ok: true, song: { sourceSongId: songId }, tracks: {} };
      },
    },
  });

  await service.preview('123');
  await service.preview('123');
  assert.equal(calls, 1);
});

test('浏览器歌词提供器：合并轨道分析并转换结构化错误', async () => {
  const provider = createNeteaseLyricProvider({
    fetchImpl: async () => jsonResponse({
      ok: true,
      song: { source: 'netease', sourceSongId: '1', title: 'Song' },
      tracks: {
        original: { available: true, rawLrc: '[00:01.00]君' },
        translation: { available: false, rawLrc: '' },
        romaji: { available: false, rawLrc: '' },
      },
      warnings: [],
    }),
  });
  const preview = await provider.previewSong('1');
  assert.equal(preview.analysis.cardCount, 1);
  assert.ok(preview.warnings.some(item => item.code === 'TRANSLATION_MISSING'));

  const failingProvider = createNeteaseLyricProvider({
    fetchImpl: async () => jsonResponse({
      ok: false,
      error: { code: 'SONG_NOT_FOUND', message: '没有找到歌曲', retryable: false },
    }, 404),
  });
  await assert.rejects(
    failingProvider.previewSong('2'),
    error => error.code === 'SONG_NOT_FOUND' && error.message === '没有找到歌曲',
  );
});
