/**
 * LRC 歌词解析器
 * 解析 [mm:ss.xx] 格式的歌词文件，按时间戳分组
 */

/**
 * 检测语言类型
 */
function detectLanguage(text) {
  // 日语：含假名（平假名或片假名）——优先判断
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
    return 'ja';
  }
  // 中文：含汉字但无假名
  if (/[\u4e00-\u9fff]/.test(text)) {
    return 'zh';
  }
  // 纯英文字符：假设为英文歌词或罗马音
  // 后续按上下文区分 en vs ro
  if (/^[a-zA-Z0-9\s!?()',.\-]+$/.test(text.trim())) {
    return 'en_ro';
  }
  return 'other';
}

/**
 * 判断 en_ro 类型是英文歌词还是罗马音
 * 规则：在同组内，如果存在日语行，则为罗马音；否则为英文
 */
function resolveEnRo(linesInGroup) {
  const hasJa = linesInGroup.some(l => l.lang === 'ja');
  return linesInGroup.map(l => {
    if (l.lang === 'en_ro') {
      return { ...l, lang: hasJa ? 'ro' : 'en' };
    }
    return l;
  });
}

/**
 * 判断是否为元数据行（作词/作曲/by等）
 */
function isMetaContent(text) {
  const metaPatterns = [
    /^作词\s*[:：]/, /^作曲\s*[:：]/, /^编曲\s*[:：]/,
    /^\[by[:：]/, /\[ti[:：]/, /\[ar[:：]/, /\[al[:：]/,
    /^歌\s*[:：]/, /^翻譯\s*[:：]/, /^翻译\s*[:：]/,
    /^歌詞[:：]/, /^LRC\s/, /^\[offset:/,
  ];
  return metaPatterns.some(p => p.test(text));
}

/**
 * 解析时间戳字符串
 * @param {string} ts "[00:31.150]" → 31150
 */
function parseTimestamp(ts) {
  const match = ts.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
  if (!match) return null;
  const min = parseInt(match[1], 10);
  const sec = parseInt(match[2], 10);
  let ms = parseInt(match[3], 10);
  if (match[3].length === 2) ms *= 10; // "15" → 150
  return min * 60000 + sec * 1000 + ms;
}

/**
 * 格式化时间戳为可读字符串
 */
export function formatTimestamp(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const centi = Math.floor((ms % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(centi).padStart(2, '0')}`;
}

/**
 * 主解析函数
 * @param {string} lrcText LRC 文件内容
 * @returns {{ groups: Array, metaLines: Array }}
 */
export function parseLRC(lrcText) {
  const lines = lrcText.split('\n');
  const timeRegex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  // 暂存所有原始行
  const rawLines = [];
  const metaLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 检查是否有时间标签
    const timeMatch = trimmed.match(timeRegex);
    if (!timeMatch) {
      // 无时间标签 → 可能是元数据
      if (trimmed.length > 0 && trimmed !== '') {
        metaLines.push(trimmed);
      }
      continue;
    }

    // 提取时间戳和歌词文本
    const ts = timeMatch[0];
    const timestamp = parseTimestamp(ts);
    if (timestamp === null) continue;

    // 文本 = 去掉时间标签后的部分
    let text = trimmed.slice(timeMatch[0].length).trim();

    // 去掉可能的尾随时间标签
    text = text.replace(/\[\d{2}:\d{2}\.\d{2,3}\]$/, '').trim();

    if (!text) continue;

    // 元数据行（时间标签之后的文本匹配元数据模式）
    if (isMetaContent(text)) {
      metaLines.push(trimmed);
      continue;
    }

    rawLines.push({
      timestamp,
      timeStr: formatTimestamp(timestamp),
      text,
      lang: detectLanguage(text),
    });
  }

  // 按时间戳分组
  const groupMap = new Map();
  for (const l of rawLines) {
    const key = l.timestamp;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(l);
  }

  // 处理每组：区分 en/ro，分类 jp/zh/en/ro
  const groups = [];
  for (const [ts, items] of groupMap) {
    const resolved = resolveEnRo(items);

    const jpLine = resolved.find(l => l.lang === 'ja') || null;
    const zhLine = resolved.find(l => l.lang === 'zh') || null;
    const enLine = resolved.find(l => l.lang === 'en') || null;
    const romajiLine = resolved.find(l => l.lang === 'ro') || null;

    // 确定组类型
    let type = 'meta';
    if (jpLine) {
      type = romajiLine ? 'jp-zh-ro' : 'jp-zh';
    } else if (enLine) {
      type = 'en-zh';
    }

    groups.push({
      timestamp: ts,
      timeStr: formatTimestamp(ts),
      jpLine,
      zhLine,
      enLine,
      romajiLine,
      type,
    });
  }

  // 按时间戳排序
  groups.sort((a, b) => a.timestamp - b.timestamp);

  return { groups, metaLines };
}

export default { parseLRC, formatTimestamp };