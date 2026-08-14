import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workerPath = path.resolve('dist/sw.js');

test('waiting worker 由用户激活，关键操作阻止刷新且 IndexedDB 数据保留', async ({ page }, testInfo) => {
  const originalWorker = await readFile(workerPath, 'utf8');
  await page.addInitScript(() => {
    const originalText = File.prototype.text;
    File.prototype.text = function delayedFixtureText() {
      if (this.name !== 'delayed-backup.json') return originalText.call(this);
      return new Promise(resolve => {
        window.__releaseDelayedBackup = async () => resolve(await originalText.call(this));
      });
    };
  });

  try {
    await page.goto('/#/home');
    await waitForServiceWorkerControl(page);
    await importFixtureSong(page);
    await page.goto('/#/settings');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /导出完整备份/ }).click();
    const download = await downloadPromise;
    const backupPath = testInfo.outputPath('delayed-backup.json');
    await download.saveAs(backupPath);

    const fixtureWorker = originalWorker
      .replace(/const BUILD_ID = "[^"]+";/, 'const BUILD_ID = "1.0.0-beta.3+e2e+waiting";')
      .concat('\n// pwa-update-e2e-fixture\n');
    await writeFile(workerPath, fixtureWorker, 'utf8');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect(page.getByText('发现新版本，可在方便时更新')).toBeVisible();

    page.on('dialog', dialog => dialog.dismiss());
    await page.locator('#backup-file-input').setInputFiles(backupPath);
    await expect(page.locator('#pwa-status-region').getByText(/备份正在恢复或回滚/)).toBeVisible();
    await expect(page.locator('#pwa-status-region').getByRole('button', { name: '立即更新' })).toBeDisabled();
    await page.evaluate(() => window.__releaseDelayedBackup());
    await expect(page.locator('#pwa-status-region').getByRole('button', { name: '立即更新' })).toBeEnabled();

    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('#pwa-status-region').getByRole('button', { name: '立即更新' }).click();
    await navigation;
    await expect(page.locator('.page-settings')).toBeVisible();
    await page.goto('/#/library');
    await expect(page.getByText('PWA Update Song')).toBeVisible();
    const buildId = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return requestVersion(registration.active);

      function requestVersion(worker) {
        return new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = event => resolve(event.data.buildId);
          worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
        });
      }
    });
    expect(buildId).toBe('1.0.0-beta.3+e2e+waiting');
  } finally {
    await writeFile(workerPath, originalWorker, 'utf8');
  }
});

async function importFixtureSong(page) {
  await page.getByRole('button', { name: '导入第一首歌' }).click();
  await page.getByRole('button', { name: '粘贴歌词' }).click();
  await page.locator('input[name="title"]').fill('PWA Update Song');
  await page.locator('textarea[name="rawLrc"]').fill('[00:01.00]更新しても消えない\n[00:01.00]更新后仍保留');
  await page.getByRole('button', { name: '导入并开始学习' }).click();
  await expect(page.locator('.page-study')).toBeVisible();
}

async function waitForServiceWorkerControl(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
}
