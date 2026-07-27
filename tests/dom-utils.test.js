import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttr, escapeHtml, sanitizeCoverImageUrl } from '../src/render/dom-utils.js';

test('dom utils: 转义歌词与元信息中的 HTML 注入字符', () => {
  const payload = `<script>alert(1)</script><img src=x onerror="alert(2)"><svg onload='alert(3)'>`;
  const escaped = escapeHtml(payload);
  assert.doesNotMatch(escaped, /<script|<img|<svg/i);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(escaped, /&quot;alert\(2\)&quot;/);
  assert.match(escapeAttr(`javascript:alert(1)" onfocus="x`), /&quot; onfocus=&quot;/);
});

test('dom utils: 专辑封面只接受可信网易云 HTTPS 图片地址', () => {
  assert.equal(
    sanitizeCoverImageUrl('https://p2.music.126.net/cover.jpg'),
    'https://p2.music.126.net/cover.jpg',
  );
  assert.equal(sanitizeCoverImageUrl('http://p2.music.126.net/cover.jpg'), '');
  assert.equal(sanitizeCoverImageUrl('https://example.com/cover.jpg'), '');
  assert.equal(sanitizeCoverImageUrl('javascript:alert(1)'), '');
});
