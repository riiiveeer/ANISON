/**
 * 文件功能：歌词提供器抽象层。
 * 结构说明：
 * 1. 统一不同歌词来源的获取契约；
 * 2. 支持手动文本内嵌 LRC；
 * 3. 通过同源本地网关预览网易云公开单曲歌词。
 */

import { analyzeLyricTrackBundle } from './song-importer.js';

export function createLyricProviderRegistry() {
  const providers = {
    'manual-text': createManualTextLyricProvider(),
    netease: createNeteaseLyricProvider(),
  };

  return {
    getProvider(source = 'manual-text') {
      return providers[source] || providers['manual-text'];
    },
    listSources() {
      return Object.keys(providers);
    },
  };
}

export function createManualTextLyricProvider() {
  return {
    source: 'manual-text',
    async getLyrics(entry) {
      const rawLrc = String(entry?.rawLrc || '').trim();
      if (!rawLrc) {
        return {
          status: 'missing',
          source: 'manual-text',
          sourceSongId: entry?.sourceSongId || '',
          title: entry?.title || '',
          artist: entry?.artist || '',
          rawLrc: '',
          error: '该条目缺少 LRC 内容，请补充后重试',
        };
      }

      return {
        status: 'success',
        source: 'manual-text',
        sourceSongId: entry?.sourceSongId || '',
        title: entry?.title || '',
        artist: entry?.artist || '',
        rawLrc,
        error: '',
      };
    },
  };
}

export function createNeteaseLyricProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return {
    source: 'netease',
    async previewSong(input, requestOptions = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('当前浏览器无法连接本地歌词服务');
      }

      let response;
      try {
        response = await fetchImpl('/api/netease/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: String(input || '') }),
          signal: requestOptions.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error('无法连接本地歌词服务，请确认 ANISON 是通过 npm 启动的');
      }

      const payload = await readJsonResponse(response);
      if (!response.ok || !payload?.ok) {
        const error = new Error(payload?.error?.message || `歌词服务返回 HTTP ${response.status}`);
        error.code = payload?.error?.code || 'NETEASE_PREVIEW_FAILED';
        error.retryable = Boolean(payload?.error?.retryable);
        throw error;
      }

      const analysis = analyzeLyricTrackBundle(payload.tracks);
      if (!analysis.groups.length) {
        const error = new Error('没有解析出可学习的原文歌词');
        error.code = 'ORIGINAL_LYRIC_MISSING';
        error.retryable = false;
        throw error;
      }

      return {
        ...payload,
        warnings: mergeWarnings(payload.warnings, analysis.warnings),
        analysis: {
          cardCount: analysis.groups.length,
          unmatchedTranslationCount: analysis.unmatchedTranslationCount,
          unmatchedRomajiCount: analysis.unmatchedRomajiCount,
        },
      };
    },
    async getLyrics(entry) {
      try {
        const preview = await this.previewSong(entry?.url || entry?.sourceSongId || '');
        return {
          status: 'success',
          source: 'netease',
          sourceSongId: preview.song.sourceSongId,
          title: preview.song.title,
          artist: preview.song.artist,
          rawLrc: preview.tracks.original.rawLrc,
          error: '',
        };
      } catch (error) {
        return {
          status: 'unavailable',
          source: 'netease',
          sourceSongId: entry?.sourceSongId || '',
          title: entry?.title || '',
          artist: entry?.artist || '',
          rawLrc: '',
          error: error instanceof Error ? error.message : '网易云歌词获取失败',
        };
      }
    },
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('本地歌词服务返回了无法解析的数据');
  }
}

function mergeWarnings(...warningLists) {
  const seen = new Set();
  return warningLists.flat().filter(warning => {
    if (!warning?.code || seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}

// 兼容旧调用名。
export const createNeteasePlaceholderProvider = createNeteaseLyricProvider;
