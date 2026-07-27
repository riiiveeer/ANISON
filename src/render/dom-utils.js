export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function sanitizeCoverImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const trustedHost = [
      'music.126.net',
      'music.127.net',
      'music.163.com',
    ].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    return url.protocol === 'https:' && trustedHost ? url.toString() : '';
  } catch {
    return '';
  }
}

export function formatTimeLabel(timestamp, emptyLabel = '未开始') {
  if (!timestamp) return emptyLabel;
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return emptyLabel;
  return `${value.getMonth() + 1}/${value.getDate()} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function formatRelativeReviewTime(timestamp, now = Date.now()) {
  if (!timestamp) return '现在';
  const delta = timestamp - now;
  if (delta <= 0) return '现在';
  if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.ceil(delta / 60000))} 分钟后`;
  if (delta < 24 * 60 * 60 * 1000) return `${Math.ceil(delta / 3600000)} 小时后`;
  return `${Math.ceil(delta / 86400000)} 天后`;
}
