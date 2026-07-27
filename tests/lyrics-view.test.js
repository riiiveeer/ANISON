import test from 'node:test';
import assert from 'node:assert/strict';

import { renderExplainContent } from '../src/render/lyrics-view.js';

test('renderExplainContent: 应正确渲染 markdown 标题、列表和加粗', () => {
  const html = renderExplainContent({
    explain: {
      status: 'success',
      content: [
        '#### 1. 重点词汇',
        '- **自ら**：自己、自身',
        '- **音**：声音、歌声',
        '',
        '#### 2. 语法结构',
        '- 主语：省略',
      ].join('\n'),
    },
  });

  assert.match(html, /<h5>1\. 重点词汇<\/h5>/);
  assert.match(html, /<ul><li><strong>自ら<\/strong>：自己、自身<\/li><li><strong>音<\/strong>：声音、歌声<\/li><\/ul>/);
  assert.match(html, /<h5>2\. 语法结构<\/h5>/);
  assert.match(html, /<li>主语：省略<\/li>/);
});

test('renderExplainContent: 不执行 AI 返回内容中的 HTML 与事件属性', () => {
  const html = renderExplainContent({
    explain: {
      status: 'success',
      content: '#### <img src=x onerror=alert(1)>\n- <svg onload=alert(2)>',
    },
  });

  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<svg/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /onerror=alert/);
});
