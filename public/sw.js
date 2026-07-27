/* ANISON service worker 占位文件：当前仅提供安装壳层挂载点，后续再补离线缓存策略。 */

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});