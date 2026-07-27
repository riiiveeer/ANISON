/**
 * 文件功能：IndexedDB 底座封装。
 * 结构说明：
 * 1. 统一数据库名、版本号与 object store 划分；
 * 2. 提供初始化、升级与事务执行工具；
 * 3. 抽象本地读写错误，避免上层直接接触原始 IDB 异常。
 */

export const ANISON_DB_NAME = 'anison-study-db';
export const ANISON_DB_VERSION = 2;

const STORE_DEFINITIONS = {
  songs: {
    keyPath: 'id',
    indexes: ['title', 'artist', 'updatedAt', 'lastStudiedAt'],
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

function upgradeDatabase(database) {
  Object.entries(STORE_DEFINITIONS).forEach(([storeName, definition]) => {
    if (!database.objectStoreNames.contains(storeName)) {
      const store = database.createObjectStore(storeName, { keyPath: definition.keyPath });
      definition.indexes.forEach(indexName => {
        store.createIndex(indexName, indexName, { unique: false });
      });
      return;
    }

    const transactionStore = database.transaction.objectStore(storeName);
    definition.indexes.forEach(indexName => {
      if (!transactionStore.indexNames.contains(indexName)) {
        transactionStore.createIndex(indexName, indexName, { unique: false });
      }
    });
  });
}

function openDatabase(name, version, onUpgradeNeeded) {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(name, version);

    request.onupgradeneeded = event => {
      const database = event.target.result;
      onUpgradeNeeded(database, event.oldVersion, event.newVersion || version);
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
    const transaction = dbContext.database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let executorResult;

    Promise.resolve()
      .then(() => executor(store, transaction))
      .then(result => {
        executorResult = result;
      })
      .catch(error => {
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

export function createStorageError(message, cause = null) {
  const error = new Error(message);
  error.name = 'AnisonStorageError';
  if (cause) {
    error.cause = cause;
  }
  return error;
}
