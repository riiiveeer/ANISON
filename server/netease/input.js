const ALLOWED_HOSTS = new Set([
  'music.163.com',
  'y.music.163.com',
  '163cn.tv',
]);

const SHORT_LINK_HOST = '163cn.tv';
const MAX_INPUT_LENGTH = 4096;
const MAX_REDIRECTS = 3;

export class NeteaseInputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'NeteaseInputError';
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}

export async function resolveNeteaseSongInput(input, options = {}) {
  const normalized = String(input || '').trim();
  if (!normalized || normalized.length > MAX_INPUT_LENGTH) {
    throw new NeteaseInputError(
      'INVALID_INPUT',
      normalized.length > MAX_INPUT_LENGTH ? '分享内容过长，请只保留歌曲链接' : '请输入网易云歌曲链接、分享文本或歌曲 ID',
    );
  }

  if (/^\d{1,20}$/.test(normalized)) {
    return { songId: normalized, normalizedUrl: '', resolvedShortLink: false };
  }

  const candidates = extractHttpUrls(normalized);
  if (!candidates.length) {
    throw new NeteaseInputError('INVALID_INPUT', '没有在输入内容中找到有效的网易云歌曲链接');
  }

  let sawUnsupportedHost = false;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = normalizeKnownHttpUrl(candidate);
    } catch {
      continue;
    }

    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      sawUnsupportedHost = true;
      continue;
    }

    if (parsed.hostname.toLowerCase() === SHORT_LINK_HOST) {
      const finalUrl = await resolveAllowedShortLink(parsed, options);
      const songId = extractSongIdFromUrl(finalUrl);
      if (songId) {
        return {
          songId,
          normalizedUrl: finalUrl.toString(),
          resolvedShortLink: true,
        };
      }
      continue;
    }

    const songId = extractSongIdFromUrl(parsed);
    if (songId) {
      return {
        songId,
        normalizedUrl: parsed.toString(),
        resolvedShortLink: false,
      };
    }
  }

  if (sawUnsupportedHost) {
    throw new NeteaseInputError('UNSUPPORTED_HOST', '仅支持网易云音乐的公开单曲链接');
  }
  throw new NeteaseInputError('INVALID_INPUT', '链接中没有找到有效的网易云歌曲 ID');
}

export function extractSongIdFromUrl(url) {
  const parsed = url instanceof URL ? url : normalizeKnownHttpUrl(String(url || ''));
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase() === SHORT_LINK_HOST) {
    return '';
  }

  const directId = parsed.searchParams.get('id');
  if (/^\d{1,20}$/.test(directId || '')) return directId;

  const hashQueryIndex = parsed.hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    const hashParams = new URLSearchParams(parsed.hash.slice(hashQueryIndex + 1));
    const hashId = hashParams.get('id');
    if (/^\d{1,20}$/.test(hashId || '')) return hashId;
  }

  const pathMatch = parsed.pathname.match(/\/song\/(\d{1,20})(?:\/|$)/);
  return pathMatch?.[1] || '';
}

export function extractHttpUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [])
    .map(url => url.replace(/[，。！？、；：）】》」』)\]}]+$/u, ''));
}

async function resolveAllowedShortLink(initialUrl, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new NeteaseInputError('INVALID_INPUT', '当前运行环境无法解析网易云短链接');
  }

  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedUrl(currentUrl);
    const response = await fetchWithTimeout(fetchImpl, currentUrl, options.shortLinkTimeoutMs || 5000);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) {
        throw new NeteaseInputError('INVALID_INPUT', '网易云短链接跳转次数过多或响应无效');
      }
      currentUrl = normalizeKnownHttpUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new NeteaseInputError('INVALID_INPUT', '网易云短链接暂时无法访问');
    }

    assertAllowedUrl(currentUrl);
    return currentUrl;
  }

  throw new NeteaseInputError('INVALID_INPUT', '无法解析网易云短链接');
}

function normalizeKnownHttpUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol === 'http:' && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    parsed.protocol = 'https:';
  }
  if (parsed.protocol !== 'https:') {
    throw new NeteaseInputError('UNSUPPORTED_HOST', '仅支持 HTTPS 网易云链接');
  }
  return parsed;
}

function assertAllowedUrl(url) {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new NeteaseInputError('UNSUPPORTED_HOST', '短链接跳转到了不受支持的地址');
  }
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 ANISON-Lyric-Importer',
        Referer: 'https://music.163.com/',
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new NeteaseInputError('INVALID_INPUT', '解析网易云短链接超时');
    }
    throw new NeteaseInputError('INVALID_INPUT', '解析网易云短链接失败');
  } finally {
    clearTimeout(timeout);
  }
}

export const __testables__ = {
  ALLOWED_HOSTS,
  MAX_INPUT_LENGTH,
  MAX_REDIRECTS,
};
