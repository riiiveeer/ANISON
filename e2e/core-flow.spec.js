import { test, expect } from '@playwright/test';

test('导入、学习、复习、刷新、备份、清空和恢复主链路', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('anison_ds_key', 'test-key');
  });
  await page.route('**/api/deepseek/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      choices: [{ message: { content: '## 句意\n测试讲解\n\n## 词汇与语法\n- テスト\n\n## 语感\n测试' } }],
    }),
  }));
  await page.goto('/#/home');
  await page.getByRole('button', { name: '导入第一首歌' }).click();
  await page.getByRole('button', { name: '粘贴歌词' }).click();
  await page.locator('input[name="title"]').fill('E2E Song');
  await page.locator('textarea[name="rawLrc"]').fill([
    '[00:01.00]君と歌う',
    '[00:01.00]与你歌唱',
    '[00:02.00]明日へ行こう',
    '[00:02.00]向明天出发',
  ].join('\n'));
  await page.getByRole('button', { name: '导入并开始学习' }).click();
  await expect(page.locator('.page-study')).toBeVisible();
  await page.getByRole('button', { name: /AI 讲解/ }).click();
  await expect(page.getByText('测试讲解')).toBeVisible();
  await page.getByRole('button', { name: '已读，下一张' }).click();

  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anison-study-db', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('learningStates', 'readwrite');
    const index = transaction.objectStore('learningStates').index('history');
    const cursorRequest = index.openCursor();
    await new Promise((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve();
        cursor.update({
          ...cursor.value,
          reviewableKey: 1,
          nextReviewAt: Date.now() - 1,
        });
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });

  await page.goto('/#/review');
  await expect(page.locator('.review-count')).toHaveText('1');
  await page.getByRole('button', { name: '开始复习' }).click();
  await page.getByRole('button', { name: /掌握/ }).click();
  await expect(page.getByText('完成 1 张')).toBeVisible();
  await page.reload();
  await page.goto('/#/library');
  await expect(page.getByText('E2E Song')).toBeVisible();

  await page.goto('/#/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出完整备份/ }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('anison-e2e-backup.json');
  await download.saveAs(backupPath);

  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /清空全部本地数据/ }).click();
  await expect(page.getByRole('button', { name: '导入第一首歌' })).toBeVisible();

  await page.goto('/#/settings');
  await page.locator('#backup-file-input').setInputFiles(backupPath);
  await expect(page.locator('.page-home')).toBeVisible();
  await page.goto('/#/library');
  await expect(page.getByText('E2E Song')).toBeVisible();
});
