/**
 * 文件功能：单曲导入服务。
 * 结构说明：
 * 1. 输入原始 LRC 文本与文件元信息；
 * 2. 复用 parser 与 card mapper 生成标准化 Song；
 * 3. 生成去重签名、歌曲标题与歌手等基础字段，供仓储层入库。
 */

import { parseLRC } from './lrc-parser.js';
import { mapGroupsToCards } from './lrc-card-mapper.js';

export function importSongFromLrc({ rawLrc, fileName = '', title = '', artist = '', source = 'manual', sourceSongId = '' }) {
  const normalizedText = String(rawLrc || '').trim();
  if (!normalizedText) {
    throw new Error('LRC 内容不能为空');
  }

  const { groups } = parseLRC(normalizedText);
  const cards = mapGroupsToCards(groups);
  if (!cards.length) {
    throw new Error('未解析出可学习的歌词卡片');
  }

  const inferredMeta = inferSongMeta(fileName, groups);
  const contentHash = createContentHash(normalizedText);
  const songId = `song_${contentHash}`;
  const now = Date.now();
  const normalizedInputTitle = String(title || '').trim();
  const normalizedInputArtist = String(artist || '').trim();
  const normalizedTitle = normalizedInputTitle || String(inferredMeta.title || '').trim() || '未命名歌曲';
  const normalizedArtist = normalizedInputArtist || String(inferredMeta.artist || '').trim();

  return {
    song: {
      id: songId,
      title: normalizedTitle,
      artist: normalizedArtist,
      album: '',
      coverUrl: '',
      source,
      sourceSongId,
      fileName,
      rawLrc: normalizedText,
      parsedVersion: 1,
      cards: cards.map(card => ({
        ...card,
        songId,
      })),
      contentHash,
      createdAt: now,
      updatedAt: now,
      lastStudiedAt: 0,
    },
    meta: {
      totalCards: cards.length,
      inferredTitle: normalizedTitle,
      inferredArtist: normalizedArtist,
    },
  };
}

/**
 * 按来源明确的歌词轨道生成歌曲，避免依赖文本语言猜测。
 */
export function importSongFromTrackBundle({ songMeta = {}, tracks = {} }) {
  const sourceSongId = String(songMeta.sourceSongId || '').trim();
  if (!sourceSongId || !/^\d{1,20}$/.test(sourceSongId)) {
    throw new Error('网易云歌曲 ID 无效');
  }

  const analysis = analyzeLyricTrackBundle(tracks);
  if (!analysis.groups.length) {
    throw new Error('没有解析出可学习的原文歌词');
  }

  const normalizedTitle = normalizeSingleLine(songMeta.title) || '未命名歌曲';
  const normalizedArtist = normalizeSingleLine(songMeta.artist);
  const normalizedAlbum = normalizeSingleLine(songMeta.album);
  const rawLrc = composeTrackBundleLrc({
    title: normalizedTitle,
    artist: normalizedArtist,
    album: normalizedAlbum,
    groups: analysis.groups,
  });
  const contentHash = createContentHash([
    String(tracks.original?.rawLrc || ''),
    String(tracks.translation?.rawLrc || ''),
    String(tracks.romaji?.rawLrc || ''),
  ].join('\n---track---\n'));
  const songId = `song_netease_${sourceSongId}`;
  const now = Date.now();
  const groups = analysis.groups.map(group => ({
    timestamp: group.timestamp,
    timeStr: formatTimestamp(group.timestamp),
    jpLine: createTypedLine(group.timestamp, group.original),
    zhLine: group.translation ? createTypedLine(group.timestamp, group.translation) : null,
    enLine: null,
    romajiLine: group.romaji ? createTypedLine(group.timestamp, group.romaji) : null,
    type: group.romaji ? 'jp-zh-ro' : 'jp-zh',
  }));
  const cards = mapGroupsToCards(groups).map(card => ({ ...card, songId }));

  return {
    song: {
      id: songId,
      title: normalizedTitle,
      artist: normalizedArtist,
      album: normalizedAlbum,
      coverUrl: sanitizeNeteaseCoverUrl(songMeta.coverUrl),
      source: 'netease',
      sourceSongId,
      fileName: `netease-${sourceSongId}.lrc`,
      rawLrc,
      parsedVersion: 2,
      cards,
      contentHash,
      createdAt: now,
      updatedAt: now,
      lastStudiedAt: 0,
    },
    meta: {
      totalCards: cards.length,
      inferredTitle: normalizedTitle,
      inferredArtist: normalizedArtist,
      warnings: analysis.warnings,
      unmatchedTranslationCount: analysis.unmatchedTranslationCount,
      unmatchedRomajiCount: analysis.unmatchedRomajiCount,
    },
  };
}

export function analyzeLyricTrackBundle(tracks = {}) {
  const originalLines = parseTypedTrack(tracks.original?.rawLrc || '');
  if (!originalLines.length) {
    return {
      groups: [],
      warnings: [{ code: 'ORIGINAL_LYRIC_MISSING', message: '没有解析出带时间戳的原文歌词' }],
      unmatchedTranslationCount: 0,
      unmatchedRomajiCount: 0,
    };
  }

  const translation = alignAuxiliaryTrack(originalLines, parseTypedTrack(tracks.translation?.rawLrc || ''));
  const romaji = alignAuxiliaryTrack(originalLines, parseTypedTrack(tracks.romaji?.rawLrc || ''));
  const warnings = [];
  if (!translation.inputCount) {
    warnings.push({ code: 'TRANSLATION_MISSING', message: '该歌曲没有提供中文翻译' });
  } else if (translation.unmatchedCount) {
    warnings.push({
      code: 'TRANSLATION_UNMATCHED',
      message: `${translation.unmatchedCount} 行翻译因时间差过大未匹配`,
    });
  }
  if (!romaji.inputCount) {
    warnings.push({ code: 'ROMAJI_MISSING', message: '该歌曲没有提供罗马音' });
  } else if (romaji.unmatchedCount) {
    warnings.push({
      code: 'ROMAJI_UNMATCHED',
      message: `${romaji.unmatchedCount} 行罗马音因时间差过大未匹配`,
    });
  }

  return {
    groups: originalLines.map((line, index) => ({
      timestamp: line.timestamp,
      original: line.text,
      translation: translation.values[index] || '',
      romaji: romaji.values[index] || '',
    })),
    warnings,
    unmatchedTranslationCount: translation.unmatchedCount,
    unmatchedRomajiCount: romaji.unmatchedCount,
  };
}

export function parseTypedTrack(rawLrc) {
  const offsetMatch = String(rawLrc || '').match(/^\[offset:\s*([+-]?\d+)\s*\]$/im);
  const offset = Number(offsetMatch?.[1] || 0);
  const entries = [];
  let order = 0;

  for (const rawLine of String(rawLrc || '').split(/\r?\n/)) {
    const timestampRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const matches = Array.from(rawLine.matchAll(timestampRegex));
    if (!matches.length) continue;
    const text = rawLine.replace(timestampRegex, '').trim();
    if (!text || isTrackMetadata(text)) continue;

    for (const match of matches) {
      const timestamp = Math.max(0, parseTrackTimestamp(match) + offset);
      entries.push({ timestamp, text, order: order++ });
    }
  }

  entries.sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);
  const grouped = [];
  for (const entry of entries) {
    const previous = grouped[grouped.length - 1];
    if (previous?.timestamp === entry.timestamp) {
      if (!previous.parts.includes(entry.text)) previous.parts.push(entry.text);
    } else {
      grouped.push({ timestamp: entry.timestamp, parts: [entry.text] });
    }
  }
  return grouped.map(group => ({
    timestamp: group.timestamp,
    text: group.parts.join('\n'),
  }));
}

function isTrackMetadata(text) {
  return [
    /^(作词|作詞|作曲|编曲|編曲|填词|填詞|歌词|歌詞|翻译|翻譯|制作人|製作人|监制|監製|演唱|歌手|主唱|推广策划|推廣策劃|企划监制|企劃監製|联合推广|聯合推廣|制作公司|製作公司|出品公司|发行|發行|录音|錄音|混音|母带|母帶|和声|和聲|统筹|統籌|封面|设计|設計)\s*[:：]/iu,
    /^(lyricist|lyrics|composer|arranger|producer|written by)\s*[:：]/iu,
    /^(music|vocal|mix|mastering|illustration|movie)\s*[:：]/iu,
  ].some(pattern => pattern.test(String(text || '').trim()));
}

function alignAuxiliaryTrack(originalLines, auxiliaryLines, toleranceMs = 500) {
  const values = Array(originalLines.length).fill('');
  const usedOriginalIndexes = new Set();
  let unmatchedCount = 0;

  for (const line of auxiliaryLines) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < originalLines.length; index += 1) {
      if (usedOriginalIndexes.has(index)) continue;
      const distance = Math.abs(originalLines[index].timestamp - line.timestamp);
      if (distance < bestDistance && distance <= toleranceMs) {
        bestDistance = distance;
        bestIndex = index;
        if (distance === 0) break;
      }
    }

    if (bestIndex < 0) {
      unmatchedCount += 1;
      continue;
    }
    usedOriginalIndexes.add(bestIndex);
    values[bestIndex] = line.text;
  }

  return {
    values,
    inputCount: auxiliaryLines.length,
    unmatchedCount,
  };
}

function composeTrackBundleLrc({ title, artist, album, groups }) {
  const lines = [
    `[ti:${title}]`,
    artist ? `[ar:${artist}]` : '',
    album ? `[al:${album}]` : '',
  ].filter(Boolean);
  for (const group of groups) {
    const timestamp = formatTimestamp(group.timestamp);
    for (const text of [group.original, group.translation, group.romaji]) {
      for (const part of String(text || '').split('\n').filter(Boolean)) {
        lines.push(`[${timestamp}]${part}`);
      }
    }
  }
  return lines.join('\n');
}

function createTypedLine(timestamp, text) {
  return {
    timestamp,
    timeStr: formatTimestamp(timestamp),
    text,
  };
}

function parseTrackTimestamp(match) {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = String(match[3] || '');
  const milliseconds = fraction
    ? Number(fraction.padEnd(3, '0').slice(0, 3))
    : 0;
  return minutes * 60000 + seconds * 1000 + milliseconds;
}

function formatTimestamp(milliseconds) {
  const safe = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const centiseconds = Math.floor((safe % 1000) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function normalizeSingleLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeNeteaseCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host.endsWith('.music.126.net')
      || host.endsWith('.music.127.net')
      || host.endsWith('.music.163.com')
    ) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function createImportFailureResult(fileName, error) {
  return {
    status: 'failed',
    fileName,
    song: null,
    meta: null,
    message: error instanceof Error ? error.message : '导入失败',
  };
}

function inferSongMeta(fileName, groups) {
  const normalizedFileName = String(fileName || '').replace(/\.(lrc|txt)$/i, '').trim();
  if (normalizedFileName.includes(' - ')) {
    const [title, ...artistParts] = normalizedFileName.split(' - ');
    return {
      title: title.trim() || pickFallbackTitle(groups),
      artist: artistParts.join(' - ').trim(),
    };
  }

  return {
    title: normalizedFileName || pickFallbackTitle(groups),
    artist: '',
  };
}

function pickFallbackTitle(groups) {
  const firstGroup = groups.find(group => group.type !== 'meta');
  return firstGroup?.jpLine?.text || firstGroup?.enLine?.text || '未命名歌曲';
}

export function createContentHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export const __testables__ = {
  inferSongMeta,
  createContentHash,
  alignAuxiliaryTrack,
  composeTrackBundleLrc,
  sanitizeNeteaseCoverUrl,
  isTrackMetadata,
};
