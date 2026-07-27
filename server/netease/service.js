import { resolveNeteaseSongInput } from './input.js';
import { createNeteaseClient } from './client.js';

const SUCCESS_CACHE_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 2 * 60 * 1000;

export function createNeteasePreviewService(options = {}) {
  const client = options.client || createNeteaseClient(options);
  const cache = new Map();
  const semaphore = createSemaphore(options.maxConcurrency || 2);

  return {
    async preview(input) {
      const resolved = await resolveNeteaseSongInput(input, options);
      const cacheKey = resolved.songId;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.error) throw cached.error;
        return cached.value;
      }
      if (cached) cache.delete(cacheKey);

      return semaphore.run(async () => {
        try {
          const value = await client.getSongPreview(resolved.songId);
          cache.set(cacheKey, { value, expiresAt: Date.now() + SUCCESS_CACHE_MS });
          return value;
        } catch (error) {
          if (['SONG_NOT_FOUND', 'ORIGINAL_LYRIC_MISSING'].includes(error?.code)) {
            cache.set(cacheKey, { error, expiresAt: Date.now() + NEGATIVE_CACHE_MS });
          }
          throw error;
        }
      });
    },
    clearCache() {
      cache.clear();
    },
  };
}

function createSemaphore(maxConcurrency) {
  let active = 0;
  const queue = [];

  async function acquire() {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    await new Promise(resolve => queue.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    queue.shift()?.();
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
  };
}

export const __testables__ = {
  createSemaphore,
  SUCCESS_CACHE_MS,
  NEGATIVE_CACHE_MS,
};
