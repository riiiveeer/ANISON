/**
 * 文件功能：歌单导入解析抽象层。
 * 结构说明：
 * 1. 统一歌单解析入口；
 * 2. 先实现文本歌单/手动歌曲列表过渡方案；
 * 3. 为网易云链接/ID 接入保留占位解析能力。
 */

export function createPlaylistImporter() {
  return {
    parseManualTextPlaylist,
    parseNeteasePlaceholder,
  };
}

export function parseManualTextPlaylist({ playlistName = '', rawText = '' }) {
  const normalizedText = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!normalizedText) {
    throw new Error('歌单文本不能为空');
  }

  const blocks = normalizedText
    .split(/\n\s*---+\s*\n/g)
    .map(block => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    throw new Error('未识别到可导入的歌单条目');
  }

  const items = blocks.map((block, index) => parseManualBlock(block, index));
  const now = Date.now();
  const safeName = String(playlistName || '').trim() || `手动导入歌单 ${new Date(now).toLocaleDateString('zh-CN')}`;
  const playlistId = `playlist_manual_${now}`;

  return {
    playlist: {
      id: playlistId,
      source: 'manual',
      sourceId: '',
      name: safeName,
      coverUrl: '',
      songIds: [],
      createdAt: now,
      updatedAt: now,
    },
    items,
    source: 'manual-text',
  };
}

export function parseNeteasePlaceholder({ sourceId = '', rawText = '' }) {
  const value = String(sourceId || rawText || '').trim();
  return {
    playlist: {
      id: `playlist_netease_placeholder_${Date.now()}`,
      source: 'netease',
      sourceId: value,
      name: '网易云歌单（待接入）',
      coverUrl: '',
      songIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    items: [],
    source: 'netease',
    pendingMessage: '当前仅保留网易云歌单链接 / ID 输入占位，后续将通过后端代理解析',
  };
}

function parseManualBlock(block, index) {
  const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) {
    return createFallbackItem(index);
  }

  const [metaLine, ...lyricLines] = lines;
  const { title, artist } = parseSongMetaLine(metaLine, index);
  return {
    id: `manual_item_${index + 1}`,
    sourceSongId: '',
    title,
    artist,
    rawLrc: lyricLines.join('\n').trim(),
    fileName: `${title}${artist ? ` - ${artist}` : ''}.lrc`,
  };
}

function parseSongMetaLine(line, index) {
  const normalized = String(line || '').trim();
  if (!normalized) {
    return {
      title: `未命名歌曲 ${index + 1}`,
      artist: '',
    };
  }

  if (normalized.includes(' - ')) {
    const [title, ...artistParts] = normalized.split(' - ');
    return {
      title: title.trim() || `未命名歌曲 ${index + 1}`,
      artist: artistParts.join(' - ').trim(),
    };
  }

  return {
    title: normalized,
    artist: '',
  };
}

function createFallbackItem(index) {
  return {
    id: `manual_item_${index + 1}`,
    sourceSongId: '',
    title: `未命名歌曲 ${index + 1}`,
    artist: '',
    rawLrc: '',
    fileName: `未命名歌曲 ${index + 1}.lrc`,
  };
}

export const __testables__ = {
  parseManualBlock,
  parseSongMetaLine,
};
