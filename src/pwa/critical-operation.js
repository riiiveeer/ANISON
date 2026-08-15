const REASON_LABELS = Object.freeze({
  'startup-data': '本地数据正在恢复或升级',
  'netease-import': '网易云歌曲正在解析或导入',
  'local-import': '本地歌词正在导入',
  'song-edit': '歌曲信息或歌词正在保存',
  'song-delete': '歌曲及关联数据正在删除',
  'backup-restore': '备份正在恢复或回滚',
  'clear-data': '本地数据正在清空',
});

export function createCriticalOperations() {
  const counts = new Map();
  const listeners = new Set();

  function acquire(reason = 'critical-operation') {
    const key = String(reason || 'critical-operation');
    counts.set(key, (counts.get(key) || 0) + 1);
    notify();
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      const nextCount = (counts.get(key) || 1) - 1;
      if (nextCount > 0) counts.set(key, nextCount);
      else counts.delete(key);
      notify();
    };
  }

  function getState() {
    const reasons = [...counts.keys()];
    const count = [...counts.values()].reduce((total, value) => total + value, 0);
    return {
      active: count > 0,
      count,
      reasons,
      blockedReason: reasons.length ? (REASON_LABELS[reasons[0]] || '关键操作正在进行') : '',
    };
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  function notify() {
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  return { acquire, getState, subscribe };
}

export async function runCriticalOperation(criticalOperations, reason, operation) {
  const release = criticalOperations?.acquire?.(reason) || (() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

export const __testables__ = { REASON_LABELS };
