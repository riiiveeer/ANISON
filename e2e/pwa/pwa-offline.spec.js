import { test, expect } from '@playwright/test';

test('生产 PWA 在线初始化后可离线重启并完成本地学习', async ({ page, context }) => {
  let deepSeekRequests = 0;
  let neteaseRequests = 0;
  await page.addInitScript(() => localStorage.setItem('anison_ds_key', 'offline-fixture-key'));
  await page.route('**/api/deepseek/**', route => {
    deepSeekRequests += 1;
    return route.abort();
  });
  await page.route('**/api/netease/**', route => {
    neteaseRequests += 1;
    return route.abort();
  });

  await page.goto('/#/home');
  await waitForServiceWorkerControl(page);
  await page.getByRole('button', { name: '导入第一首歌' }).click();
  await page.getByRole('button', { name: '粘贴歌词' }).click();
  await page.locator('input[name="title"]').fill('PWA Offline Song');
  await page.locator('textarea[name="rawLrc"]').fill([
    '[00:01.00]君と歌う',
    '[00:01.00]与你歌唱',
    '[00:02.00]明日へ行こう',
    '[00:02.00]向明天出发',
  ].join('\n'));
  await page.getByRole('button', { name: '导入并开始学习' }).click();
  await expect(page.locator('.page-study')).toBeVisible();
  await page.locator('[data-action="favorite"]').click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('当前离线，本地学习仍可使用')).toBeVisible();
  await page.goto('/#/library');
  await expect(page.getByText('PWA Offline Song')).toBeVisible();
  await page.getByText('PWA Offline Song').click();
  await expect(page.locator('.page-study')).toBeVisible();
  await expect(page.getByRole('button', { name: /离线时无法请求 AI 讲解/ })).toBeDisabled();

  await page.goto('/#/library?import=1');
  await expect(page.getByRole('button', { name: '联网后解析' })).toBeDisabled();
  expect(deepSeekRequests).toBe(0);
  expect(neteaseRequests).toBe(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('网络已恢复，可主动重试在线功能')).toBeVisible();
  await expect(page.getByRole('button', { name: '解析歌词' })).toBeEnabled();
});

async function waitForServiceWorkerControl(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
}
