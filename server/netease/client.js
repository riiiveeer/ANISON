import crypto from 'node:crypto';

const PUBLIC_DETAIL_URL = 'https://music.163.com/api/song/detail/';
const PUBLIC_LYRIC_URL = 'https://music.163.com/api/song/lyric';
const WEAPI_DETAIL_URL = 'https://music.163.com/weapi/v3/song/detail';
const WEAPI_LYRIC_URL = 'https://music.163.com/weapi/song/lyric?csrf_token=';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const WEAPI_NONCE = '0CoJUm6Qyw8W8jud';
const WEAPI_IV = '0102030405060708';
const WEAPI_PUBLIC_KEY = '010001';
const WEAPI_MODULUS = [
  '00e0b509f6259df8642dbc35662901477df22677ec152b5',
  'ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417',
  '629ec4ee341f56135fccf695280104e0312ecbda92557c',
  '93870114af6c9d05c4f7f0c3685b7a46bee255932575cc',
  'e10b424d813cfe4875d3e82047b97ddef52741d546b8e2',
  '89dc6935b3ece0462db0a22b8e7',
].join('');

const REQUEST_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ANISON/1.0',
};

export class NeteaseUpstreamError extends Error {
  constructor(code, message, status = 502, retryable = false) {
    super(message);
    this.name = 'NeteaseUpstreamError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function createNeteaseClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 15000;

  return {
    async getSongPreview(songId, requestOptions = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      const signal = requestOptions.signal
        ? AbortSignal.any([controller.signal, requestOptions.signal])
        : controller.signal;
      let detailPayload;
      let lyricPayload;
      try {
        try {
          [detailPayload, lyricPayload] = await Promise.all([
            fetchPublicDetail(fetchImpl, songId, signal),
            fetchPublicLyrics(fetchImpl, songId, signal),
          ]);
          validatePublicPayloads(detailPayload, lyricPayload);
        } catch (publicError) {
          if (['UPSTREAM_RATE_LIMITED', 'UPSTREAM_TIMEOUT'].includes(publicError?.code)) throw publicError;
          [detailPayload, lyricPayload] = await Promise.all([
            fetchWeapiDetail(fetchImpl, songId, signal),
            fetchWeapiLyrics(fetchImpl, songId, signal),
          ]);
        }

        return normalizePreview(songId, detailPayload, lyricPayload);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function fetchPublicDetail(fetchImpl, songId, signal) {
  const url = new URL(PUBLIC_DETAIL_URL);
  url.searchParams.set('id', songId);
  url.searchParams.set('ids', JSON.stringify([songId]));
  return requestJsonWithRetry(fetchImpl, url, { signal });
}

async function fetchPublicLyrics(fetchImpl, songId, signal) {
  const url = new URL(PUBLIC_LYRIC_URL);
  url.searchParams.set('id', songId);
  for (const key of ['lv', 'tv', 'rv', 'kv', 'yv', 'yrv']) url.searchParams.set(key, '-1');
  return requestJsonWithRetry(fetchImpl, url, { signal });
}

async function fetchWeapiDetail(fetchImpl, songId, signal) {
  return requestWeapi(fetchImpl, WEAPI_DETAIL_URL, {
    c: JSON.stringify([{ id: Number(songId) }]),
    ids: JSON.stringify([Number(songId)]),
  }, signal);
}

async function fetchWeapiLyrics(fetchImpl, songId, signal) {
  return requestWeapi(fetchImpl, WEAPI_LYRIC_URL, {
    id: songId,
    os: 'pc',
    lv: -1,
    kv: -1,
    tv: -1,
    rv: -1,
    yv: -1,
    yrv: -1,
  }, signal);
}

async function requestWeapi(fetchImpl, url, payload, signal) {
  const encrypted = encryptWeapiPayload(payload);
  return requestJsonWithRetry(fetchImpl, url, {
    signal,
    method: 'POST',
    headers: {
      ...REQUEST_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `NMTID=${crypto.randomBytes(16).toString('hex')}`,
    },
    body: new URLSearchParams(encrypted).toString(),
  });
}

async function requestJsonWithRetry(fetchImpl, url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestJson(fetchImpl, url, options);
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt > 0) throw error;
      await waitForRetry(250, options.signal);
    }
  }
  throw lastError;
}

async function requestJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: options.headers || REQUEST_HEADERS,
      body: options.body,
      redirect: 'error',
      signal: options.signal,
    });

    if (response.status === 429) {
      throw new NeteaseUpstreamError('UPSTREAM_RATE_LIMITED', '网易云请求过于频繁，请稍后重试', 429, false);
    }
    if (!response.ok) {
      const retryable = [502, 503, 504].includes(response.status);
      throw new NeteaseUpstreamError(
        'UPSTREAM_INVALID_RESPONSE',
        `网易云服务返回了 HTTP ${response.status}`,
        502,
        retryable,
      );
    }

    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new NeteaseUpstreamError('UPSTREAM_INVALID_RESPONSE', '网易云返回了无法解析的数据');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new NeteaseUpstreamError('UPSTREAM_TIMEOUT', '连接网易云超时，请检查网络后重试', 504, true);
    }
    if (error instanceof NeteaseUpstreamError) throw error;
    throw new NeteaseUpstreamError('UPSTREAM_INVALID_RESPONSE', '连接网易云失败，请稍后重试', 502, true);
  }
}

function waitForRetry(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new NeteaseUpstreamError('UPSTREAM_TIMEOUT', '连接网易云超时，请检查网络后重试', 504, true));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new NeteaseUpstreamError('UPSTREAM_TIMEOUT', '连接网易云超时，请检查网络后重试', 504, true));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout.unref?.();
  });
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new NeteaseUpstreamError('UPSTREAM_INVALID_RESPONSE', '网易云响应内容过大');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new NeteaseUpstreamError('UPSTREAM_INVALID_RESPONSE', '网易云响应内容过大');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatUint8Arrays(chunks, total));
}

function normalizePreview(songId, detailPayload, lyricPayload) {
  const song = pickSong(detailPayload);
  if (!song) {
    throw new NeteaseUpstreamError('SONG_NOT_FOUND', '没有找到这首公开歌曲', 404, false);
  }

  const original = pickLyric(lyricPayload?.lrc) || convertYrcToLrc(pickLyric(lyricPayload?.yrc));
  if (!hasTimedLyric(original)) {
    throw new NeteaseUpstreamError('ORIGINAL_LYRIC_MISSING', '没有找到可导入的原文歌词', 422, false);
  }
  const enhancedTranslation = pickLyric(lyricPayload?.ytlrc);
  const translation = pickLyric(lyricPayload?.tlyric)
    || (hasTimedLyric(enhancedTranslation) ? enhancedTranslation : convertYrcToLrc(enhancedTranslation));
  const romaji = pickLyric(lyricPayload?.romalrc);
  const warnings = [];
  if (!hasTimedLyric(translation)) {
    warnings.push({ code: 'TRANSLATION_MISSING', message: '该歌曲没有提供中文翻译' });
  }
  if (!hasTimedLyric(romaji)) {
    warnings.push({ code: 'ROMAJI_MISSING', message: '该歌曲没有提供罗马音' });
  }

  return {
    ok: true,
    song: {
      source: 'netease',
      sourceSongId: String(songId),
      title: String(song.name || '').trim() || '未命名歌曲',
      artist: normalizeArtists(song),
      album: String(song.al?.name || song.album?.name || '').trim(),
      coverUrl: sanitizeCoverUrl(song.al?.picUrl || song.album?.picUrl || ''),
    },
    tracks: {
      original: createTrack(original, pickLyric(lyricPayload?.lrc) ? 'lrc' : 'yrc-converted'),
      translation: createTrack(translation, 'lrc'),
      romaji: createTrack(romaji, 'lrc'),
    },
    warnings,
  };
}

function validatePublicPayloads(detailPayload, lyricPayload) {
  const publicOriginal = pickLyric(lyricPayload?.lrc) || convertYrcToLrc(pickLyric(lyricPayload?.yrc));
  if (!pickSong(detailPayload) || !lyricPayload || typeof lyricPayload !== 'object' || !hasTimedLyric(publicOriginal)) {
    throw new NeteaseUpstreamError('UPSTREAM_INVALID_RESPONSE', '公开接口响应结构不完整');
  }
}

function pickSong(payload) {
  if (Array.isArray(payload?.songs) && payload.songs.length) return payload.songs[0];
  if (Array.isArray(payload?.data) && payload.data.length) return payload.data[0];
  return null;
}

function normalizeArtists(song) {
  const artists = Array.isArray(song.ar) ? song.ar : Array.isArray(song.artists) ? song.artists : [];
  return artists.map(artist => String(artist?.name || '').trim()).filter(Boolean).join(' / ');
}

function pickLyric(value) {
  return typeof value?.lyric === 'string' ? value.lyric.trim() : '';
}

function createTrack(rawLrc, format) {
  const normalized = String(rawLrc || '').trim();
  return {
    available: hasTimedLyric(normalized),
    format,
    rawLrc: hasTimedLyric(normalized) ? normalized : '',
  };
}

export function convertYrcToLrc(rawYrc) {
  const output = [];
  for (const rawLine of String(rawYrc || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^\[(\d+),\d+\](.*)$/);
    if (!match) continue;
    const text = match[2].replace(/\(\d+,\d+(?:,\d+)?\)/g, '').trim();
    if (!text) continue;
    output.push(`[${formatMilliseconds(Number(match[1]))}]${text}`);
  }
  return output.join('\n');
}

export function sanitizeCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === 'https:' && (
      host.endsWith('.music.126.net')
      || host.endsWith('.music.127.net')
      || host.endsWith('.music.163.com')
    );
    return allowed ? url.toString() : '';
  } catch {
    return '';
  }
}

function hasTimedLyric(value) {
  return /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(String(value || ''));
}

function formatMilliseconds(milliseconds) {
  const safe = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const centiseconds = Math.floor((safe % 1000) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

export function encryptWeapiPayload(payload, secretKey = createSecretKey()) {
  const firstPass = aesEncrypt(JSON.stringify(payload), WEAPI_NONCE);
  const params = aesEncrypt(firstPass, secretKey);
  const reversedHex = Buffer.from(secretKey).reverse().toString('hex');
  const encrypted = modPow(BigInt(`0x${reversedHex}`), BigInt(`0x${WEAPI_PUBLIC_KEY}`), BigInt(`0x${WEAPI_MODULUS}`));
  return {
    params,
    encSecKey: encrypted.toString(16).padStart(256, '0'),
  };
}

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(WEAPI_IV));
  return Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64');
}

function createSecretKey() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let nextBase = base % modulus;
  let nextExponent = exponent;
  while (nextExponent > 0n) {
    if (nextExponent & 1n) result = (result * nextBase) % modulus;
    nextExponent >>= 1n;
    nextBase = (nextBase * nextBase) % modulus;
  }
  return result;
}

function concatUint8Arrays(chunks, total) {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export const __testables__ = {
  normalizePreview,
  hasTimedLyric,
  formatMilliseconds,
  MAX_RESPONSE_BYTES,
};
