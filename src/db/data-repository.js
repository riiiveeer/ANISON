import { requestToPromise, runTransaction } from './indexed-db.js';

export const BUSINESS_STORES = [
  'songs', 'songLyrics', 'cards', 'learningUnits',
  'progress', 'playlists', 'importJobs',
];
const RESTORE_META_KEY = 'restore:active';
const BATCH_SIZE = 2000;

export function createDataRepository(dbContext) {
  return {
    async getOverview() {
      if (!dbContext?.database) return emptyOverview();
      return runTransaction(dbContext, BUSINESS_STORES, 'readonly', async stores => {
        const counts = await Promise.all(BUSINESS_STORES.map(storeName =>
          requestToPromise(stores[storeName].count(), `统计 ${storeName} 失败`)));
        return Object.fromEntries(BUSINESS_STORES.map((name, index) => [name, counts[index]]));
      });
    },

    async exportAll({ signal, onProgress } = {}) {
      if (!dbContext?.database) return emptyData();
      const result = emptyData();
      let completed = 0;
      for (const storeName of BUSINESS_STORES) {
        throwIfAborted(signal);
        result[storeName] = await runTransaction(dbContext, storeName, 'readonly', store =>
          requestToPromise(store.getAll(), `导出 ${storeName} 失败`));
        completed += 1;
        onProgress?.({ phase: 'export', completed, total: BUSINESS_STORES.length, storeName });
        await yieldToBrowser();
      }
      return result;
    },

    async replaceAll(data, { signal, onProgress } = {}) {
      if (!dbContext?.database) return;
      const sessionId = `restore_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      let currentPhase = 'staging';
      await setRestoreMeta(dbContext, {
        sessionId,
        status: 'staging',
        startedAt: Date.now(),
      });
      try {
        await stageCurrentData(dbContext, sessionId, { signal, onProgress });
        throwIfAborted(signal);
        currentPhase = 'applying';
        await setRestoreMeta(dbContext, { sessionId, status: 'applying', startedAt: Date.now() });
        await clearBusinessStores(dbContext);
        await writeBusinessData(dbContext, data, { signal, onProgress, phase: 'restore' });
        await verifyCounts(dbContext, data);
        await finishRestoreSession(dbContext, sessionId);
      } catch (error) {
        if (currentPhase === 'staging') {
          await finishRestoreSession(dbContext, sessionId);
          throw error;
        }
        await setRestoreMeta(dbContext, {
          sessionId,
          status: 'rollback-needed',
          message: error instanceof Error ? error.message : String(error),
          startedAt: Date.now(),
        });
        await rollbackSession(dbContext, sessionId, { onProgress });
        throw error;
      }
    },

    async clearAll() {
      if (!dbContext?.database) return;
      await clearBusinessStores(dbContext);
      await runTransaction(dbContext, ['recovery', 'meta'], 'readwrite', async stores => {
        await Promise.all([
          requestToPromise(stores.recovery.clear(), '清理恢复数据失败'),
          requestToPromise(stores.meta.delete(RESTORE_META_KEY), '清理恢复状态失败'),
        ]);
      });
    },

    async recoverInterruptedRestore({ onProgress } = {}) {
      return recoverInterruptedRestore(dbContext, { onProgress });
    },
  };
}

export async function recoverInterruptedRestore(dbContext, { onProgress } = {}) {
  if (!dbContext?.database) return false;
  const meta = await runTransaction(dbContext, 'meta', 'readonly', store =>
    requestToPromise(store.get(RESTORE_META_KEY), '读取恢复状态失败'));
  if (!meta?.sessionId) return false;
  if (meta.status === 'staging') {
    await finishRestoreSession(dbContext, meta.sessionId);
    return true;
  }
  await rollbackSession(dbContext, meta.sessionId, { onProgress });
  return true;
}

async function stageCurrentData(dbContext, sessionId, { signal, onProgress }) {
  let sequence = 0;
  for (let storeIndex = 0; storeIndex < BUSINESS_STORES.length; storeIndex += 1) {
    const storeName = BUSINESS_STORES[storeIndex];
    throwIfAborted(signal);
    const total = await runTransaction(dbContext, storeName, 'readonly', store =>
      requestToPromise(store.count(), `统计 ${storeName} 恢复快照失败`));
    let completed = 0;
    let afterKey;
    while (completed < total) {
      throwIfAborted(signal);
      const page = await readStorePage(dbContext, storeName, afterKey, BATCH_SIZE);
      const batch = page.values;
      if (!batch.length) break;
      await runTransaction(dbContext, 'recovery', 'readwrite', store => {
        store.put({
          sessionId,
          storeName,
          sequence: sequence++,
          values: batch,
        });
      });
      completed += batch.length;
      afterKey = page.lastKey;
      onProgress?.({
        phase: 'staging',
        completed,
        total,
        storeName,
        storeIndex,
      });
      await yieldToBrowser();
    }
  }
}

function readStorePage(dbContext, storeName, afterKey, limit) {
  return runTransaction(dbContext, storeName, 'readonly', async store => {
    const range = afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true);
    const [values, keys] = await Promise.all([
      requestToPromise(store.getAll(range, limit), `分页读取 ${storeName} 恢复快照失败`),
      requestToPromise(store.getAllKeys(range, limit), `分页读取 ${storeName} 恢复快照主键失败`),
    ]);
    if (values.length !== keys.length) {
      throw new Error(`${storeName} 恢复快照的记录与主键数量不一致`);
    }
    return { values, lastKey: keys.at(-1) };
  });
}

async function writeBusinessData(dbContext, data, { signal, onProgress, phase }) {
  for (let storeIndex = 0; storeIndex < BUSINESS_STORES.length; storeIndex += 1) {
    const storeName = BUSINESS_STORES[storeIndex];
    const items = Array.isArray(data?.[storeName]) ? data[storeName] : [];
    for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = items.slice(offset, offset + BATCH_SIZE);
      await runTransaction(dbContext, storeName, 'readwrite', store => {
        batch.forEach(value => store.put(value));
      });
      onProgress?.({
        phase,
        completed: offset + batch.length,
        total: items.length,
        storeName,
        storeIndex,
      });
      await yieldToBrowser();
    }
  }
}

async function rollbackSession(dbContext, sessionId, { onProgress } = {}) {
  const snapshots = await runTransaction(dbContext, 'recovery', 'readonly', store =>
    requestToPromise(store.index('sessionId').getAll(sessionId), '读取恢复快照失败'));
  const data = emptyData();
  snapshots
    .sort((left, right) => left.sequence - right.sequence)
    .forEach(item => {
      if (Array.isArray(item.values)) data[item.storeName]?.push(...item.values);
      else if (Object.hasOwn(item, 'value')) data[item.storeName]?.push(item.value);
    });
  await clearBusinessStores(dbContext);
  await writeBusinessData(dbContext, data, { onProgress, phase: 'rollback' });
  await finishRestoreSession(dbContext, sessionId);
}

async function verifyCounts(dbContext, data) {
  const actual = await createDataRepository(dbContext).getOverview();
  for (const storeName of BUSINESS_STORES) {
    const expected = Array.isArray(data?.[storeName]) ? data[storeName].length : 0;
    if (actual[storeName] !== expected) {
      throw new Error(`${storeName} 恢复校验失败：预期 ${expected}，实际 ${actual[storeName]}`);
    }
  }
}

async function clearBusinessStores(dbContext) {
  return runTransaction(dbContext, BUSINESS_STORES, 'readwrite', async stores => {
    await Promise.all(BUSINESS_STORES.map(storeName =>
      requestToPromise(stores[storeName].clear(), `清空 ${storeName} 失败`)));
  });
}

async function finishRestoreSession(dbContext, sessionId) {
  return runTransaction(dbContext, ['recovery', 'meta'], 'readwrite', async stores => {
    await Promise.all([
      deleteRecoveryBySession(stores.recovery, sessionId),
      requestToPromise(stores.meta.delete(RESTORE_META_KEY), '清理恢复状态失败'),
    ]);
  });
}

function deleteRecoveryBySession(store, sessionId) {
  return new Promise((resolve, reject) => {
    const request = store.index('sessionId').openKeyCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const deletion = store.delete(cursor.primaryKey);
      deletion.onsuccess = () => cursor.continue();
      deletion.onerror = () => reject(deletion.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function setRestoreMeta(dbContext, state) {
  return runTransaction(dbContext, 'meta', 'readwrite', store =>
    requestToPromise(store.put({ key: RESTORE_META_KEY, ...state }), '保存恢复状态失败'));
}

function emptyData() {
  return Object.fromEntries(BUSINESS_STORES.map(name => [name, []]));
}

function emptyOverview() {
  return Object.fromEntries(BUSINESS_STORES.map(name => [name, 0]));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  throw error;
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
