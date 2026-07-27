/**
 * 将 LRC parser 输出的 groups 映射为页面渲染所需的歌词卡片结构。
 */

function buildSongContext(groups) {
  return groups
    .filter(group => group.type !== 'meta')
    .map(group => {
      const parts = [];

      if (group.jpLine?.text) parts.push(`日文：${group.jpLine.text}`);
      if (group.enLine?.text) parts.push(`英文：${group.enLine.text}`);
      if (group.zhLine?.text) parts.push(`中文：${group.zhLine.text}`);
      if (group.romajiLine?.text) parts.push(`罗马音：${group.romajiLine.text}`);

      return `${group.timeStr} ${parts.join(' ｜ ')}`;
    })
    .join('\n');
}

/**
 * @typedef {'idle' | 'loading' | 'success' | 'error'} ExplainStatus
 */

/**
 * @typedef {Object} LyricCard
 * @property {string} id
 * @property {number} timestamp
 * @property {string} timeStr
 * @property {string} type
 * @property {string} lyric
 * @property {string} translation
 * @property {{ enText: string, romajiText: string }} extra
 * @property {string} songContext
 * @property {{ status: ExplainStatus, content: string, error: string }} explain
 * @property {{ state: 'new' | 'learning' | 'fuzzy' | 'mastered', favorite: boolean, reviewCount: number, lastReviewedAt: number, nextReviewAt: number }} learning
 * @property {{ expanded: boolean }} ui
 */

function createCardId(group) {
  return String(group.timestamp);
}

function pickLyric(group) {
  if (group.jpLine?.text) return group.jpLine.text;
  if (group.enLine?.text) return group.enLine.text;
  return '';
}

/**
 * @param {Array} groups
 * @returns {LyricCard[]}
 */
export function mapGroupsToCards(groups) {
  const songContext = buildSongContext(groups);

  return groups
    .filter(group => group.type !== 'meta')
    .map(group => ({
      id: createCardId(group),
      timestamp: group.timestamp,
      timeStr: group.timeStr,
      type: group.type,
      lyric: pickLyric(group),
      translation: group.zhLine?.text || '',
      extra: {
        enText: group.enLine?.text || '',
        romajiText: group.romajiLine?.text || '',
      },
      songContext,
      explain: {
        status: 'idle',
        content: '',
        error: '',
      },
      learning: {
        state: 'new',
        favorite: false,
        reviewCount: 0,
        lastReviewedAt: 0,
        nextReviewAt: 0,
      },
      ui: {
        expanded: false,
      },
    }));
}

export default { mapGroupsToCards };