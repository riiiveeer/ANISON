const injectedVersion = typeof __ANISON_VERSION__ !== 'undefined' ? __ANISON_VERSION__ : 'development';
const injectedCommit = typeof __ANISON_COMMIT__ !== 'undefined' ? __ANISON_COMMIT__ : 'local';

export const APP_VERSION = String(injectedVersion || 'development');
export const APP_COMMIT = String(injectedCommit || 'local');

export const BUILD_INFO = Object.freeze({
  version: APP_VERSION,
  commit: APP_COMMIT,
});

export function shortBuildLabel({ version = APP_VERSION, commit = APP_COMMIT, buildId = '' } = {}) {
  const shortCommit = commit === 'local' ? 'local' : commit.slice(0, 8);
  const digest = String(buildId).split('+').at(-1) || '';
  return `${version} · ${shortCommit}${digest ? ` · ${digest.slice(0, 8)}` : ''}`;
}
