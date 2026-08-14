/**
 * 文件功能：IndexedDB 底座封装。
 * 结构说明：
 * 1. 统一数据库名、版本号与 object store 划分；
 * 2. 提供初始化、升级与事务执行工具；
 * 3. 抽象本地读写错误，避免上层直接接触原始 IDB 异常。
 */

export const ANISON_DB_NAME = 'anison-study-db';
export const ANISON_DB_VERSION = 3;

const STORE_DEFINITIONS = {
  songs: {
    keyPath: 'id',
    indexes: [
      'title', 'artist', 'updatedAt', 'lastStudiedAt',
      'contentHash', 'fileNameKey', 'titleArtistKey', 'sourceKey',
    ],
  },
  songLyrics: {
    keyPath: 'songId',
    indexes: [],
  },
  cards: {
    keyPath: ['songId', 'id'],
    indexes: [
      { name: 'songId', keyPath: 'songId' },
      { name: 'songLearningUnit', keyPath: ['songId', 'learningUnitId'] },
    ],
  },
  learningUnits: {
    keyPath: 'key',
    indexes: [
      'songId',
      { name: 'state', keyPath: ['state', 'activityAt', 'key'] },
      { name: 'due', keyPath: ['reviewableKey', 'nextReviewAt', 'key'] },
      { name: 'history', keyPath: ['historyKey', 'activityAt', 'key'] },
      { name: 'favorites', keyPath: ['favoriteKey', 'activityAt', 'key'] },
    ],
  },
  playlists: {
    keyPath: 'id',
    indexes: ['source', 'updatedAt'],
  },
  importJobs: {
    keyPath: 'id',
    indexes: ['status', 'source', 'updatedAt', 'createdAt'],
  },
  progress: {
    keyPath: 'songId',
    indexes: ['lastStudiedAt', 'completionRate'],
  },
  meta: {
    keyPath: 'key',
    indexes: [],
  },
  recovery: {
    keyPath: ['sessionId', 'storeName', 'sequence'],
    indexes: ['sessionId'],
  },
};

export async function initializeDatabase() {
  if (!window.indexedDB) {
    throw createStorageError('当前浏览器不支持 IndexedDB');
  }

  const database = await openDatabase(ANISON_DB_NAME, ANISON_DB_VERSION, upgradeDatabase);
  return {
    name: database.name,
    version: database.version,
    database,
  };
}

function upgradeDatabase(database, oldVersion, newVersion, upgradeTransaction) {
  Object.entries(STORE_DEFINITIONS).forEach(([storeName, definition]) => {
    if (!database.objectStoreNames.contains(storeName)) {
      const store = database.createObjectStore(storeName, { keyPath: definition.keyPath });
      definition.indexes.forEach(index => {
        const normalized = normalizeIndexDefinition(index);
        store.createIndex(normalized.name, normalized.keyPath, { unique: normalized.unique });
      });
      return;
    }

    const transactionStore = upgradeTransaction.objectStore(storeName);
    definition.indexes.forEach(index => {
      const normalized = normalizeIndexDefinition(index);
      if (!transactionStore.indexNames.contains(normalized.name)) {
        transactionStore.createIndex(normalized.name, normalized.keyPath, { unique: normalized.unique });
      }
    });
  });
}

function openDatabase(name, version, onUpgradeNeeded) {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(name, version);

    request.onupgradeneeded = event => {
      const database = event.target.result;
      onUpgradeNeeded(
        database,
        event.oldVersion,
        event.newVersion || version,
        event.target.transaction,
      );
    };

    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(createStorageError(request.error?.message || '数据库打开失败', request.error));
    request.onblocked = () => reject(createStorageError('本地数据升级被旧页面阻塞，请关闭其他 ANISON 标签页后刷新重试'));
  });
}

export async function runTransaction(dbContext, storeName, mode, executor) {
  if (!dbContext?.database) {
    throw createStorageError(`数据库未初始化，无法访问 ${storeName}`);
  }

  return new Promise((resolve, reject) => {
    const storeNames = Array.isArray(storeName) ? storeName : [storeName];
    const transaction = dbContext.database.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(name => [name, transaction.objectStore(name)]));
    const store = storeNames.length === 1 ? stores[storeNames[0]] : stores;
    let executorResult;

    Promise.resolve()
      .then(() => executor(store, transaction))
      .then(result => {
        executorResult = result;
      })
      .catch(error => {
        try {
          transaction.abort();
        } catch {
          // 事务可能已经因底层请求失败而自动中止。
        }
        reject(createStorageError(`执行 ${storeName} 事务失败`, error));
      });

    transaction.oncomplete = () => resolve(executorResult);
    transaction.onerror = () => reject(createStorageError(`提交 ${storeName} 事务失败`, transaction.error));
    transaction.onabort = () => reject(createStorageError(`中止 ${storeName} 事务`, transaction.error));
  });
}

export function requestToPromise(request, message = '数据库请求失败') {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(createStorageError(message, request.error));
  });
}

export function deleteByIndex(store, indexName, key, message = '删除关联数据失败') {
  return new Promise((resolve, reject) => {
    const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(key));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const deleteRequest = store.delete(cursor.primaryKey);
      deleteRequest.onsuccess = () => cursor.continue();
      deleteRequest.onerror = () => reject(createStorageError(message, deleteRequest.error));
    };
    request.onerror = () => reject(createStorageError(message, request.error));
  });
}

export function createStorageError(message, cause = null) {
  const error = new Error(message);
  error.name = 'AnisonStorageError';
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function normalizeIndexDefinition(index) {
  if (typeof index === 'string') {
    return { name: index, keyPath: index, unique: false };
  }
  return {
    name: index.name,
    keyPath: index.keyPath || index.name,
    unique: Boolean(index.unique),
  };
}
