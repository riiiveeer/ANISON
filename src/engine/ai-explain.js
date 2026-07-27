/**
 * AI 歌词讲解服务 - DeepSeek API 封装
 * 功能：逐句调用 DeepSeek 生成词汇/语法讲解，结果缓存在 localStorage
 */

const CACHE_PREFIX = 'ai_exp_';
const MAX_CACHE_ENTRIES = 50;
const API_ENDPOINT = '/api/deepseek/chat/completions';
export const DEEPSEEK_MODEL_STORAGE_KEY = 'anison_ds_model';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const SUPPORTED_DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

export function normalizeDeepSeekModel(model) {
  return SUPPORTED_DEEPSEEK_MODELS.includes(model) ? model : DEFAULT_DEEPSEEK_MODEL;
}

export function getConfiguredDeepSeekModel() {
  return normalizeDeepSeekModel(localStorage.getItem(DEEPSEEK_MODEL_STORAGE_KEY) || '');
}

/**
 * 简易 hash（用于缓存键）
 */
function hash16(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 获取缓存的key列表（按LRU排序）
 */
function getCacheKeys() {
  try {
    return JSON.parse(localStorage.getItem('ai_exp_keys') || '[]');
  } catch { return []; }
}

function setCacheKeys(keys) {
  localStorage.setItem('ai_exp_keys', JSON.stringify(keys.slice(0, MAX_CACHE_ENTRIES)));
}

/**
 * 写入缓存
 */
function setCache(key, value) {
  const keys = getCacheKeys().filter(k => k !== key);
  keys.unshift(key); // 最新的放最前面
  setCacheKeys(keys);
  try {
    localStorage.setItem(CACHE_PREFIX + key, value);
  } catch (e) {
    // localStorage 满了：清理最旧的缓存
    if (keys.length > 1) {
      const oldest = keys.pop();
      localStorage.removeItem(CACHE_PREFIX + oldest);
      setCacheKeys(keys);
      try { localStorage.setItem(CACHE_PREFIX + key, value); } catch { /* 放弃 */ }
    }
  }
}

/**
 * 读取缓存
 */
function getCache(key) {
  return localStorage.getItem(CACHE_PREFIX + key);
}

/**
 * 主调用函数
 * @param {string} jpText 日语歌词原文
 * @param {string} zhText 中文翻译（可选）
 * @param {string} romajiText 罗马音（可选）
 * @param {string} songContext 整首歌词上下文（可选）
 * @param {string} apiKey DeepSeek API Key
 * @param {string} followUpQuestion 追问内容（可选）
 * @returns {Promise<string>} AI 讲解文本
 */
export async function explainLyrics(jpText, zhText, romajiText, songContext, apiKey, followUpQuestion = '') {
  if (!apiKey) throw new Error('请先设置 DeepSeek API Key');
  const model = getConfiguredDeepSeekModel();

  // 检查缓存
  const cacheKey = hash16([model, jpText, zhText || '', romajiText || '', songContext || '', followUpQuestion || ''].join('||'));
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // 构建 Prompt
  const prompt = buildPrompt(jpText, zhText, romajiText, songContext, followUpQuestion);

  // 调用 API
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      thinking: { type: 'disabled' },
      temperature: 0.3,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 401) throw new Error('API Key 无效或已过期');
    if (res.status === 429) throw new Error('请求频率过高，请稍后再试');
    const apiMessage = parseApiErrorMessage(errBody);
    if (res.status === 400 && /supported API model names|model/i.test(apiMessage)) {
      throw new Error('当前 AI 模型不可用，请在设置中选择 DeepSeek V4 Flash 或 V4 Pro');
    }
    throw new Error(`API 错误 (${res.status})：${apiMessage || '请求失败'}`);
  }

  const data = await res.json();
  const result = data.choices?.[0]?.message?.content || '';

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * 构建讲解 Prompt
 */
function buildPrompt(jpText, zhText, romajiText, songContext, followUpQuestion) {
  const baseLines = [
    '你是一位日语教师，正在帮学生分析歌词。请用简洁清晰的中文回答。',
    '请先默默结合整首歌词建立整体语境，再只输出当前句的讲解结果。',
    '你的输出必须严格使用 Markdown，并严格遵守下面的固定结构，不要新增章节，不要改标题名字。',
    '',
    songContext ? '整首歌词上下文（仅供理解整体语境，不要逐句复述）：' : '',
    songContext || '',
    '',
    '当前要讲解的句子：',
    `日语歌词：${jpText}`,
    zhText ? `中文翻译：${zhText}` : '',
    romajiText ? `罗马音：${romajiText}` : '',
    '',
    '请按以下顺序讲解：',
    '#### 1. 重点词汇',
    '- 每个词汇单独一条，统一使用 `- **词语（读音）**：含义；在本句中的作用/语感`',
    '- 只讲最关键的 2~5 个词，不要把整句所有词都拆开',
    '',
    '#### 2. 语法结构',
    '- 先概括句子主干，再说明关键修饰关系',
    '- 如果主语、谓语、省略成分存在不确定性，要明确写“可理解为”或“此处省略了”',
    '',
    '#### 3. 关键语法点',
    '- 只讲真正影响理解的 1~3 个语法点',
    '- 每个语法点单独一条，统一使用 `- **语法/表达**：作用；为什么这里这样用`',
    '',
    '要求：',
    '- 先利用整首歌词判断当前句在上下文中的含义，再开始讲解',
    '- 不要单独输出“整体理解”或“歌曲大意”小节',
    '- 标题必须原样输出为：`#### 1. 重点词汇`、`#### 2. 语法结构`、`#### 3. 关键语法点`',
    '- 除这三个标题外，正文只允许使用 `- ` 列表，不要使用编号列表、表格、代码块或额外小标题',
    '- 不要输出“下面开始讲解”“总结”“补充说明”等多余前后缀',
    '- 如果某一节内容很少，也必须保留该标题；可写 1 条最必要内容',
    '- 优先讲词汇，再讲语法结构，最后讲语法点',
    '- 不要输出文化解析或背景延伸',
    '- 直接用条目式回答，不需要开头寒暄',
  ].filter(Boolean);

  if (followUpQuestion) {
    baseLines.push(
      '',
      `学生追问：${followUpQuestion}`,
      '请仅围绕追问内容补充回答，必要时结合整首上下文、原句和罗马音进行说明。',
      '追问回答也必须继续沿用同样的三个标题和 `- ` 列表格式；如果某一节无须展开，也保留标题并写最必要的一条。',
    );
  }

  return [
    ...baseLines,
  ].join('\n');
}

/**
 * 清除所有 AI 缓存
 */
export function clearCache() {
  const keys = getCacheKeys();
  keys.forEach(k => localStorage.removeItem(CACHE_PREFIX + k));
  localStorage.removeItem('ai_exp_keys');
}

export const __testables__ = {
  buildPrompt,
  parseApiErrorMessage,
};

function parseApiErrorMessage(body) {
  try {
    return JSON.parse(body)?.error?.message || '';
  } catch {
    return String(body || '').slice(0, 200);
  }
}

export default { explainLyrics, clearCache };
