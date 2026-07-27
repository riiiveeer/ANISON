import test from 'node:test';
import assert from 'node:assert/strict';

import { createLibraryStore, __testables__ } from '../src/store/library-store.js';

function createRepositories(existingSong = null) {
  const saved = [];
  const progressMap = new Map();
  return {
    saved,
    repositories: {
      songs: {
        async findSongByContentHash() {
          return existingSong;
        },
        async findSongByFileName() {
          return null;
        },
        async findSongByTitleArtist() {
          return null;
        },
        async saveSong(song) {
          saved.push(song);
          return song;
        },
        async listSongs() {
          return saved;
        },
        async getSongById(songId) {
          return saved.find(song => song.id === songId) || null;
        },
        async touchSongStudyTime(songId, timestamp) {
          const song = saved.find(item => item.id === songId);
          if (!song) return null;
          song.lastStudiedAt = timestamp;
          return song;
        },
      },
      progress: {
        async listRecentProgress() {
          return Array.from(progressMap.values());
        },
        async listAllProgress() {
          return Array.from(progressMap.values());
        },
        async getProgressBySongId(songId) {
          return progressMap.get(songId) || null;
        },
        async saveProgress(progress) {
          progressMap.set(progress.songId, progress);
          return progress;
        },
      },
    },
  };
}

test('libraryStore: 导入重复歌曲时应返回 duplicate', async () => {
  const { repositories } = createRepositories({ id: 'song_dup', title: '已存在歌曲' });
  const store = createLibraryStore(repositories);
  const result = await store.importSingleSong({
    rawLrc: '[00:01.00]テスト\n[00:01.00]测试',
    fileName: 'Test - Artist.lrc',
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(result.song.id, 'song_dup');
});

test('sortSongs: 应支持最近学习排序', () => {
  const sorted = __testables__.sortSongs([
    { id: '1', lastStudiedAt: 100 },
    { id: '2', lastStudiedAt: 300 },
    { id: '3', lastStudiedAt: 200 },
  ], 'recent-studied');

  assert.deepEqual(sorted.map(song => song.id), ['2', '3', '1']);
});

test('libraryStore: 批量导入应汇总成功与失败结果', async () => {
  const { repositories } = createRepositories();
  const store = createLibraryStore(repositories);

  const result = await store.importSongs([
    { rawLrc: '[00:01.00]テスト\n[00:01.00]测试', fileName: 'A - Artist.lrc' },
    { rawLrc: '', fileName: 'broken.lrc' },
  ]);

  assert.equal(result.status, 'partial');
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
});

test('libraryStore: 获取歌曲详情时应补充进度摘要', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_1',
    title: 'Song',
    artist: 'Artist',
    cards: [{ id: 'c1', type: 'jp-zh' }, { id: 'c2', type: 'en-zh' }],
    lastStudiedAt: 0,
  });
  await repositories.progress.saveProgress({
    songId: 'song_1',
    studiedCardIds: ['c1'],
    masteredCardIds: [],
    completionRate: 0.5,
    lastStudiedAt: 123,
  });

  const song = await store.getSongById('song_1');
  assert.equal(song.progressSummary.totalCards, 1);
  assert.equal(song.progressSummary.studiedCount, 1);
  assert.equal(song.progressSummary.completionRate, 1);
});

test('libraryStore: updateCardLearning 应写入卡片学习状态', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_1',
    title: 'Song',
    artist: 'Artist',
    cards: [{ id: 'c1', type: 'jp-zh' }, { id: 'c2', type: 'en-zh' }],
  });

  const progress = await store.updateCardLearning('song_1', 'c1', { state: 'mastered', favorite: true });
  assert.equal(progress.cardStates.c1.state, 'mastered');
  assert.equal(progress.cardStates.c1.favorite, true);
  assert.equal(progress.masteredCardIds.includes('c1'), true);
});

test('libraryStore: 网易云重复导入应按来源 ID 去重且不覆盖已有歌曲', async () => {
  const existing = {
    id: 'song_existing',
    title: '已学习歌曲',
    source: 'netease',
    sourceSongId: '123',
    cards: [{ id: '1000', lyric: '旧歌词' }],
  };
  const { repositories, saved } = createRepositories();
  saved.push(existing);
  repositories.songs.findSongBySource = async (source, sourceSongId) => (
    source === 'netease' && sourceSongId === '123' ? existing : null
  );
  const store = createLibraryStore(repositories);

  const result = await store.importNeteasePreview({
    song: { source: 'netease', sourceSongId: '123', title: '新标题' },
    tracks: {
      original: { rawLrc: '[00:01.00]新歌词' },
      translation: { rawLrc: '' },
      romaji: { rawLrc: '' },
    },
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(result.duplicateBy, 'source-song-id');
  assert.equal(result.song.cards[0].lyric, '旧歌词');
  assert.equal(saved.length, 1);
});

test('libraryStore: 首次学完卡片应安排次日复习且重复浏览不重置时间', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_1',
    cards: [{ id: 'c1', type: 'jp-zh' }],
  });

  const before = Date.now();
  const first = await store.updateCardLearning('song_1', 'c1', { studied: true });
  const after = Date.now();
  const firstReviewAt = first.cardStates.c1.nextReviewAt;
  const day = 24 * 60 * 60 * 1000;

  assert.equal(first.cardStates.c1.state, 'learning');
  assert.equal(first.cardStates.c1.reviewCount, 0);
  assert.ok(firstReviewAt >= before + day);
  assert.ok(firstReviewAt <= after + day);

  const second = await store.updateCardLearning('song_1', 'c1', { studied: true });
  assert.equal(second.cardStates.c1.nextReviewAt, firstReviewAt);
});

test('libraryStore: listReviewCards 应返回到期待复习卡片', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_1',
    title: 'Song',
    artist: 'Artist',
    cards: [{ id: 'c1', type: 'jp-zh', lyric: '君' }],
  });
  await repositories.progress.saveProgress({
    songId: 'song_1',
    currentCardId: 'c1',
    completionRate: 1,
    studiedCardIds: ['c1'],
    masteredCardIds: [],
    cardStates: {
      c1: { state: 'fuzzy', favorite: false, nextReviewAt: 0 },
    },
    lastStudiedAt: 123,
  });

  const items = await store.listReviewCards('due');
  assert.equal(items.length, 1);
  assert.equal(items[0].songId, 'song_1');
});

test('libraryStore: 应支持文本歌单导入并生成导入任务', async () => {
  const playlistMap = new Map();
  const jobMap = new Map();
  const { repositories, saved } = createRepositories();
  repositories.playlists = {
    async savePlaylist(playlist) {
      playlistMap.set(playlist.id, playlist);
      return playlist;
    },
    async listPlaylists() {
      return Array.from(playlistMap.values());
    },
    async saveImportJob(job) {
      jobMap.set(job.id, job);
      return job;
    },
    async getImportJobById(jobId) {
      return jobMap.get(jobId) || null;
    },
    async listImportJobs() {
      return Array.from(jobMap.values());
    },
  };

  const store = createLibraryStore(repositories);
  const job = await store.importPlaylistFromText({
    playlistName: '测试歌单',
    rawText: `Song A - Artist A
[00:01.00]テスト
[00:01.00]测试
---
Song B - Artist B`,
  });

  assert.equal(job.playlistName, '测试歌单');
  assert.equal(job.total, 2);
  assert.equal(job.successCount, 1);
  assert.equal(job.failedCount, 1);
  assert.equal(saved.length, 1);
  assert.equal(playlistMap.size, 1);
});

test('libraryStore: 学习重复歌词时应同步整组状态且只计一个进度', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_repeat',
    cards: [
      { id: 'c1', type: 'jp-zh', lyric: '熱異常', translation: '热异常' },
      { id: 'c2', type: 'jp-zh', lyric: '熱異常！', translation: '热异常' },
      { id: 'en', type: 'jp-zh', lyric: 'PASSIONATE ANTHEM' },
    ],
  });

  const progress = await store.updateCardLearning('song_repeat', 'c2', { studied: true });
  assert.equal(progress.cardStates.c1.state, 'learning');
  assert.equal(progress.cardStates.c2.state, 'learning');
  assert.equal(progress.cardStates.en, undefined);
  assert.equal(progress.completionRate, 1);

  const reviews = await store.listReviewCards({ filter: 'all', songId: 'song_repeat' });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, 'c1');
});

test('libraryStore: 数据库不可用时应返回可操作提示而不是空值错误', async () => {
  const { repositories } = createRepositories();
  repositories.songs.saveSong = async () => null;
  const store = createLibraryStore(repositories);

  await assert.rejects(
    store.importSingleSong({
      rawLrc: '[00:01.00]テスト\n[00:01.00]测试',
      fileName: 'Test - Artist.lrc',
    }),
    /本地数据暂不可用/,
  );
});

test('libraryStore: 三档评分应更新状态、次数与到期时间', async () => {
  const { repositories, saved } = createRepositories();
  const store = createLibraryStore(repositories);
  saved.push({
    id: 'song_1',
    cards: [{ id: 'c1', type: 'jp-zh' }],
  });

  const first = await store.updateCardLearning('song_1', 'c1', { grade: 'again' });
  assert.equal(first.cardStates.c1.state, 'learning');
  assert.equal(first.cardStates.c1.reviewCount, 1);
  assert.equal(first.cardStates.c1.lapseCount, 1);

  const second = await store.updateCardLearning('song_1', 'c1', { grade: 'good' });
  assert.equal(second.cardStates.c1.state, 'mastered');
  assert.equal(second.cardStates.c1.reviewCount, 2);
  assert.equal(second.cardStates.c1.nextReviewAt, 0);
  assert.equal(second.masteredCardIds.includes('c1'), true);
});

test('libraryStore: 删除歌曲应同步删除进度并移出歌单', async () => {
  const { repositories, saved } = createRepositories();
  const calls = [];
  saved.push({ id: 'song_1', cards: [] });
  repositories.songs.deleteSong = async songId => {
    calls.push(`song:${songId}`);
  };
  repositories.progress.deleteProgress = async songId => {
    calls.push(`progress:${songId}`);
  };
  repositories.playlists = {
    async removeSongFromPlaylists(songId) {
      calls.push(`playlist:${songId}`);
    },
  };

  const store = createLibraryStore(repositories);
  await store.deleteSong('song_1');
  assert.deepEqual(calls, ['progress:song_1', 'playlist:song_1', 'song:song_1']);
});
