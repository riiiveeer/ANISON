import { resolveNeteaseSongInput } from './input.js';
import { createNeteaseClient } from './client.js';

const SUCCESS_CACHE_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_CACHE_ENTRIES = 500;
const DEFAULT_MAX_QUEUE = 20;
const DEFAULT_QUEUE_WAIT_MS = 5000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;

export function createNeteasePreviewService(options = {}) {
  const client = options.client || createNeteaseClient(options);
  const cache = new Map();
  const inFlight = new Map();
  const now = options.now || Date.now;
  const maxCacheEntries = options.maxCacheEntries || DEFAULT_CACHE_ENTRIES;
  const semaphore = createSemaphore({
    maxConcurrency: options.maxConcurrency || 2,
    maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
    waitMs: options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS,
  });

  return {
    async preview(input) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS,
      );
      timeout.unref?.();
      try {
        const resolved = await resolveNeteaseSongInput(input, { ...options, signal: controller.signal });
        const cacheKey = resolved.songId;
        const cached = getCached(cache, cacheKey, now);
        if (cached) {
          if (cached.error) throw cached.error;
          return cached.value;
        }
        if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

        const operation = semaphore.run(async () => {
          const queuedCache = getCached(cache, cacheKey, now);
          if (queuedCache) {
            if (queuedCache.error) throw queuedCache.error;
            return queuedCache.value;
          }
          try {
            const value = await client.getSongPreview(cacheKey, { signal: controller.signal });
            setCached(cache, cacheKey, {
              value,
              expiresAt: now() + SUCCESS_CACHE_MS,
            }, maxCacheEntries, now);
            return value;
          } catch (error) {
            if (['SONG_NOT_FOUND', 'ORIGINAL_LYRIC_MISSING'].includes(error?.code)) {
              setCached(cache, cacheKey, {
                error,
                expiresAt: now() + NEGATIVE_CACHE_MS,
              }, maxCacheEntries, now);
            }
            throw error;
          }
        });
        inFlight.set(cacheKey, operation);
        try {
          return await operation;
        } finally {
          if (inFlight.get(cacheKey) === operation) inFlight.delete(cacheKey);
        }
      } finally {
        clearTimeout(timeout);
      }
    },

    clearCache() {
      cache.clear();
    },

    getStats() {
      return {
        cacheEntries: cache.size,
        inFlight: inFlight.size,
        ...semaphore.getStats(),
      };
    },
  };
}

function getCached(cache, key, now = Date.now) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCached(cache, key, value, maxEntries, now = Date.now) {
  cache.delete(key);
  cache.set(key, value);
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= now()) cache.delete(cachedKey);
  }
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function createSemaphore({
  maxConcurrency = 2,
  maxQueue = DEFAULT_MAX_QUEUE,
  waitMs = DEFAULT_QUEUE_WAIT_MS,
} = {}) {
  let active = 0;
  const queue = [];

  function acquire() {
    if (active < maxConcurrency) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= maxQueue) {
      return Promise.reject(createBusyError('网易云请求队列已满，请稍后重试'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(createBusyError('等待网易云请求超时，请稍后重试'));
      }, waitMs);
      queue.push(entry);
    }).then(() => {
      active += 1;
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const entry = queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve();
  }

  return {
    async run(operation) {
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
    getStats() {
      return { active, queued: queue.length };
    },
  };
}

function createBusyError(message) {
  const error = new Error(message);
  error.code = 'UPSTREAM_BUSY';
  error.status = 503;
  error.retryable = true;
  error.retryAfter = 5;
  return error;
}

export const __testables__ = {
  createSemaphore,
  getCached,
  setCached,
  SUCCESS_CACHE_MS,
  NEGATIVE_CACHE_MS,
  DEFAULT_CACHE_ENTRIES,
  DEFAULT_MAX_QUEUE,
  DEFAULT_QUEUE_WAIT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
};
