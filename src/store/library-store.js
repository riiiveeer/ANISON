/**
 * 文件功能：曲库领域协调层。
 * 结构说明：
 * 1. 串联 song-importer 与 songs repository；
 * 2. 统一处理重复歌曲、导入结果和排序逻辑；
 * 3. 为 Study / Library 页面提供稳定的业务接口。
 */

import { importSongFromLrc, importSongFromTrackBundle } from '../engine/song-importer.js';
import { annotateLearningUnits, getLearningUnitCards, resolveLearningUnitState } from '../engine/learning-units.js';
import { buildReviewItems, createTodayOverview, filterReviewItems, learningStateForGrade, scheduleNextReview, summarizeProgress } from '../engine/review-scheduler.js';
import { createPlaylistImporter } from '../engine/playlist-importer.js';
import { createLyricProviderRegistry } from '../engine/lyric-provider.js';

export function createLibraryStore(repositories, options = {}) {
  const playlistImporter = createPlaylistImporter();
  const lyricProviderRegistry = createLyricProviderRegistry({
    isOnline: options.isOnline || (() => options.networkStatus?.getState?.().online !== false),
  });

  return {
    async importSingleSong({ rawLrc, fileName = '', title = '', artist = '', source = 'manual', sourceSongId = '' }) {
      const { song, meta } = importSongFromLrc({ rawLrc, fileName, title, artist, source, sourceSongId });
      const duplicateResult = await findDuplicateSong(repositories.songs, song);

      if (duplicateResult.song) {
        return {
          status: 'duplicate',
          duplicateBy: duplicateResult.reason,
          song: duplicateResult.song,
          meta,
          message: buildDuplicateMessage(duplicateResult.song, duplicateResult.reason),
        };
      }

      const savedSong = await repositories.songs.saveSong(song);
      if (!savedSong) {
        throw new Error('本地数据暂不可用，请关闭其他 ANISON 标签页并刷新后重试');
      }
      return {
        status: 'success',
        song: savedSong,
        meta,
        message: `已导入 ${savedSong.title || '未命名歌曲'}`,
      };
    },

    async importPlaylistFromText({ playlistName = '', rawText = '' }) {
      const parsed = playlistImporter.parseManualTextPlaylist({ playlistName, rawText });
      const importJob = createImportJob({
        type: 'playlist',
        source: 'manual',
        playlistId: parsed.playlist.id,
        playlistName: parsed.playlist.name,
        sourceId: '',
        entries: parsed.items,
      });

      await repositories.playlists?.saveImportJob?.(importJob);
      return this.runImportJob(importJob);
    },

    async runImportJob(importJob) {
      const entries = Array.isArray(importJob?.items) ? importJob.items : [];
      const provider = lyricProviderRegistry.getProvider(importJob?.lyricSource || 'manual-text');
      const results = [];
      const songIds = [];

      await repositories.playlists?.saveImportJob?.({
        ...importJob,
        status: 'running',
        updatedAt: Date.now(),
      });

      for (const entry of entries) {
        try {
          const lyricResult = await provider.getLyrics(entry);
          if (lyricResult.status !== 'success') {
            results.push(createPlaylistImportFailure(entry, lyricResult.error || '歌词获取失败'));
            continue;
          }

          const result = await this.importSingleSong({
            rawLrc: lyricResult.rawLrc,
            fileName: entry.fileName || `${entry.title || '未命名歌曲'}.lrc`,
            title: lyricResult.title || entry.title || '',
            artist: lyricResult.artist || entry.artist || '',
            source: importJob.source || 'manual',
            sourceSongId: lyricResult.sourceSongId || entry.sourceSongId || '',
          });

          const normalizedResult = {
            ...result,
            fileName: entry.fileName || result.song?.fileName || '',
            itemId: entry.id,
            title: entry.title || result.song?.title || '',
            artist: entry.artist || result.song?.artist || '',
          };
          results.push(normalizedResult);
          if (result.song?.id) {
            songIds.push(result.song.id);
          }
        } catch (error) {
          results.push(createPlaylistImportFailure(entry, error instanceof Error ? error.message : '导入失败'));
        }
      }

      const summary = summarizeImportResults(results);
      const completedJob = {
        ...importJob,
        status: summary.status === 'success' ? 'success' : summary.status === 'failed' ? 'failed' : 'partial',
        total: entries.length,
        successCount: summary.successCount,
        failedCount: summary.failedCount,
        duplicateCount: summary.duplicateCount,
        results,
        errors: results.filter(item => item.status === 'failed').map(item => ({
          itemId: item.itemId,
          title: item.title || '',
          artist: item.artist || '',
          message: item.message,
        })),
        updatedAt: Date.now(),
      };

      await repositories.playlists?.saveImportJob?.(completedJob);
      await repositories.playlists?.savePlaylist?.({
        id: importJob.playlistId,
        source: importJob.source || 'manual',
        sourceId: importJob.sourceId || '',
        name: importJob.playlistName || '未命名歌单',
        coverUrl: importJob.coverUrl || '',
        songIds: Array.from(new Set(songIds)),
        createdAt: importJob.createdAt || Date.now(),
        updatedAt: Date.now(),
      });

      return completedJob;
    },

    async retryImportJob(jobId) {
      const existingJob = await repositories.playlists?.getImportJobById?.(jobId);
      if (!existingJob) {
        throw new Error('未找到可重试的导入任务');
      }

      const failedItems = (existingJob.items || []).filter(entry =>
        (existingJob.results || []).some(result => result.itemId === entry.id && result.status === 'failed'));

      if (!failedItems.length) {
        return existingJob;
      }

      const retryJob = {
        ...existingJob,
        id: `import_retry_${Date.now()}`,
        status: 'pending',
        items: failedItems,
        results: [],
        errors: [],
        total: failedItems.length,
        successCount: 0,
        failedCount: 0,
        duplicateCount: 0,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };

      await repositories.playlists?.saveImportJob?.(retryJob);
      return this.runImportJob(retryJob);
    },

    async listImportJobs(limit = 10) {
      return repositories.playlists?.listImportJobs?.(limit) || [];
    },

    async getPlaylistImportOverview() {
      const playlists = await repositories.playlists?.listPlaylists?.() || [];
      const importJobs = await this.listImportJobs(5);
      return {
        playlists,
        importJobs,
      };
    },

    async importSongs(files = [], options = {}) {
      const results = [];
      let cancelled = false;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        try {
          const result = await this.importSingleSong(file);
          results.push({
            ...result,
            fileName: file.fileName || result.song?.fileName || '',
          });
        } catch (error) {
          results.push({
            status: 'failed',
            fileName: file.fileName || '',
            song: null,
            meta: null,
            message: error instanceof Error ? error.message : '导入失败',
          });
        }
        options.onProgress?.({
          completed: index + 1,
          total: files.length,
          latest: results[results.length - 1],
        });
      }

      const summary = summarizeImportResults(results);
      if (cancelled) {
        return {
          status: 'cancelled',
          total: files.length,
          completed: results.length,
          successCount: summary.successCount,
          duplicateCount: summary.duplicateCount,
          failedCount: summary.failedCount,
          results,
          message: `已取消：完成 ${results.length}/${files.length} 首`,
        };
      }
      return {
        status: summary.status,
        total: results.length,
        successCount: summary.successCount,
        duplicateCount: summary.duplicateCount,
        failedCount: summary.failedCount,
        results,
        message: summary.message,
      };
    },

    async listSongs(sortBy = 'recent-imported') {
      const songs = await (repositories.songs.listSongSummaries?.()
        || repositories.songs.listSongs());
      if (songs.every(song => song.progressSummary)) return sortSongs(songs, sortBy);
      const progressList = await repositories.progress?.listAllProgress?.()
        || await repositories.progress?.listRecentProgress?.(1000)
        || [];
      const progressMap = new Map(progressList.map(progress => [progress.songId, progress]));
      return sortSongs(songs, sortBy).map(song => {
        const progress = progressMap.get(song.id);
        return { ...song, progress, progressSummary: createProgressSummary(song, progress) };
      });
    },

    async getSongById(songId) {
      const song = await repositories.songs.getSongById(songId);
      if (!song) return null;
      const progress = song.progress
        || await repositories.progress?.getProgressBySongId?.(songId)
        || null;
      const hydratedSong = song.storageVersion === 3 ? song : hydrateSongCards(song, progress);
      return {
        ...hydratedSong,
        progress,
        progressSummary: createProgressSummary(hydratedSong, progress),
      };
    },

    async updateSongMeta(songId, { title = '', artist = '' }) {
      const song = await repositories.songs.getSongById(songId);
      if (!song) throw new Error('未找到要编辑的歌曲');
      const nextSong = {
        ...song,
        title: String(title || '').trim() || '未命名歌曲',
        artist: String(artist || '').trim(),
        updatedAt: Date.now(),
      };
      return repositories.songs.saveSong(nextSong);
    },

    async replaceSongLyrics(songId, { rawLrc, fileName = '' }) {
      const current = await repositories.songs.getSongById(songId);
      if (!current) throw new Error('未找到要更新的歌曲');
      const { song: parsed } = importSongFromLrc({
        rawLrc,
        fileName: fileName || current.fileName,
        title: current.title,
        artist: current.artist,
        source: current.source,
        sourceSongId: current.sourceSongId,
      });
      const learningByCardId = new Map(
        (current.cards || []).map(card => [card.id, card.learning]),
      );
      const nextSong = {
        ...parsed,
        id: current.id,
        cards: parsed.cards.map(card => ({
          ...card,
          songId: current.id,
          learning: learningByCardId.get(card.id) || card.learning,
        })),
        progress: current.progress,
        createdAt: current.createdAt,
        lastStudiedAt: current.lastStudiedAt || 0,
        updatedAt: Date.now(),
      };
      await repositories.songs.saveSong(nextSong);
      return this.getSongById(songId);
    },

    async deleteSong(songId) {
      if (!repositories.songs.supportsAtomicCascade) {
        await repositories.progress?.deleteProgress?.(songId);
        await repositories.playlists?.removeSongFromPlaylists?.(songId);
      }
      await repositories.songs.deleteSong(songId);
    },

    async touchStudyEntry(songId, currentCardId = '') {
      const timestamp = Date.now();
      const atomicProgress = await repositories.songs.touchSongStudyTime(
        songId,
        timestamp,
        currentCardId,
      );
      if (atomicProgress) return atomicProgress;

      if (!repositories.progress?.getProgressBySongId || !repositories.progress?.saveProgress) {
        return null;
      }

      const current = await repositories.progress.getProgressBySongId(songId);
      const nextProgress = {
        songId,
        currentCardId: currentCardId || current?.currentCardId || '',
        completionRate: current?.completionRate || 0,
        studiedCardIds: current?.studiedCardIds || [],
        masteredCardIds: current?.masteredCardIds || [],
        cardStates: current?.cardStates || {},
        lastStudiedAt: timestamp,
      };
      return repositories.progress.saveProgress(nextProgress);
    },

    async updateCardLearning(songId, cardId, patch = {}) {
      if (repositories.learning?.updateLearningUnit) {
        return repositories.learning.updateLearningUnit(songId, cardId, patch);
      }
      const song = await repositories.songs.getSongById(songId);
      if (!song) return null;

      const current = await repositories.progress?.getProgressBySongId?.(songId) || null;
      const timestamp = Date.now();
      const annotatedCards = annotateLearningUnits(song.cards || []);
      const unitCards = getLearningUnitCards(annotatedCards, cardId);
      if (!unitCards.length) return current;
      const previousState = resolveLearningUnitState(unitCards, current);
      const legacyGrade = patch.state === 'mastered'
        ? 'good'
        : patch.state === 'fuzzy'
          ? 'hard'
          : patch.state === 'learning'
            ? 'again'
            : '';
      const grade = patch.grade || legacyGrade;
      const wasRated = Boolean(grade);
      const wasFirstStudied = Boolean(patch.studied)
        && (!previousState.state || previousState.state === 'new');
      const reviewCount = wasRated ? (previousState.reviewCount || 0) + 1 : (previousState.reviewCount || 0);
      const nextState = {
        state: wasFirstStudied
          ? 'learning'
          : grade
            ? learningStateForGrade(grade)
            : (patch.state || previousState.state || 'new'),
        favorite: typeof patch.favorite === 'boolean' ? patch.favorite : Boolean(previousState.favorite),
        reviewCount,
        lapseCount: grade === 'again' ? (previousState.lapseCount || 0) + 1 : (previousState.lapseCount || 0),
        studiedAt: wasFirstStudied ? timestamp : (previousState.studiedAt || 0),
        lastReviewedAt: wasRated ? timestamp : (previousState.lastReviewedAt || 0),
        nextReviewAt: wasFirstStudied
          ? scheduleNextReview('studied', timestamp)
          : wasRated
            ? scheduleNextReview(grade, timestamp, reviewCount)
            : (previousState.nextReviewAt || 0),
      };

      const cardStates = { ...(current?.cardStates || {}) };
      unitCards.forEach(card => {
        cardStates[card.id] = { ...nextState };
      });
      const summary = summarizeProgress(song.cards || [], { cardStates, lastStudiedAt: timestamp, currentCardId: cardId });

      const nextProgress = {
        songId,
        currentCardId: cardId,
        completionRate: summary.completionRate,
        studiedCardIds: Object.entries(cardStates)
          .filter(([, state]) => state.state && state.state !== 'new')
          .map(([id]) => id),
        masteredCardIds: Object.entries(cardStates)
          .filter(([, state]) => state.state === 'mastered')
          .map(([id]) => id),
        cardStates,
        lastStudiedAt: timestamp,
      };

      await repositories.songs.touchSongStudyTime(songId, timestamp);
      return repositories.progress.saveProgress(nextProgress);
    },

    async listReviewCards(options = { filter: 'due' }) {
      const normalized = typeof options === 'string' ? { filter: options } : (options || {});
      const filter = normalized.filter || 'due';
      const dueBefore = normalized.dueBefore || Date.now();
      const songId = normalized.songId || '';
      if (repositories.learning?.listReviewPage && !songId) {
        const page = await repositories.learning.listReviewPage({
          filter,
          dueBefore,
          limit: normalized.limit || 50,
          cursor: normalized.cursor || null,
        });
        return page.items;
      }
      const songs = await repositories.songs.listSongs();
      const progressList = await repositories.progress?.listAllProgress?.()
        || await repositories.progress?.listRecentProgress?.(1000)
        || [];
      const progressMap = new Map(progressList.map(progress => [progress.songId, progress]));
      const items = songs
        .filter(song => !songId || song.id === songId)
        .flatMap(song => buildReviewItems(song, progressMap.get(song.id), dueBefore));
      return filterReviewItems(items, filter, dueBefore);
    },

    async getHomeDashboard() {
      if (repositories.songs.getHomeOverview && repositories.learning?.getReviewOverview) {
        const [songOverview, reviewOverview] = await Promise.all([
          repositories.songs.getHomeOverview(3),
          repositories.learning.getReviewOverview(Date.now()),
        ]);
        const continueSong = songOverview.recentSongs[0] || null;
        return {
          songCount: songOverview.songCount,
          studiedSongs: songOverview.studiedSongs,
          reviewCount: reviewOverview.dueCount,
          continueSong,
          recentSongs: songOverview.recentSongs,
          reviewItems: [],
          dueReviewItems: [],
        };
      }
      const songs = await this.listSongs('recent-studied');
      const reviewOverview = repositories.learning?.getReviewOverview
        ? await repositories.learning.getReviewOverview(Date.now())
        : null;
      const dueReviewItems = reviewOverview
        ? reviewOverview.historyItems.slice(0, 5)
        : await this.listReviewCards({ filter: 'due', dueBefore: Date.now(), limit: 5 });
      const overview = createTodayOverview(songs, dueReviewItems);
      return {
        ...overview,
        reviewCount: reviewOverview?.dueCount ?? overview.reviewCount,
        recentSongs: songs.slice(0, 3),
        reviewItems: dueReviewItems.slice(0, 5),
        dueReviewItems: dueReviewItems.slice(0, 5),
      };
    },

    async getReviewOverview(now = Date.now()) {
      if (repositories.learning?.getReviewOverview) {
        return repositories.learning.getReviewOverview(now);
      }
      const [dueItems, historyItems] = await Promise.all([
        this.listReviewCards({ filter: 'due', dueBefore: now }),
        this.listReviewCards({ filter: 'all' }),
      ]);
      return { dueCount: dueItems.length, historyItems: historyItems.slice(0, 20) };
    },

    async listReviewPage(options = {}) {
      if (repositories.learning?.listReviewPage) {
        return repositories.learning.listReviewPage(options);
      }
      const items = await this.listReviewCards(options);
      return { items: items.slice(0, options.limit || 50), nextCursor: null };
    },

    async countReviewItems(options = {}) {
      if (repositories.learning?.countReviewItems) {
        return repositories.learning.countReviewItems(options);
      }
      return (await this.listReviewCards(options)).length;
    },

    async previewNeteaseSong(input, options = {}) {
      return lyricProviderRegistry.getProvider('netease').previewSong(input, options);
    },

    async findSongBySource(source, sourceSongId) {
      return repositories.songs.findSongBySource?.(source, sourceSongId) || null;
    },

    async importNeteasePreview(preview) {
      const { song, meta } = importSongFromTrackBundle({
        songMeta: preview?.song || {},
        tracks: preview?.tracks || {},
      });
      const duplicateResult = await findDuplicateSong(repositories.songs, song);
      if (duplicateResult.song) {
        return {
          status: 'duplicate',
          duplicateBy: duplicateResult.reason,
          song: duplicateResult.song,
          meta,
          message: buildDuplicateMessage(duplicateResult.song, duplicateResult.reason),
        };
      }

      const savedSong = await repositories.songs.saveSong(song);
      if (!savedSong) {
        throw new Error('本地数据暂不可用，请关闭其他 ANISON 标签页并刷新后重试');
      }
      return {
        status: 'success',
        song: savedSong,
        meta,
        message: `已导入《${savedSong.title || '未命名歌曲'}》`,
      };
    },
  };
}

function hydrateSongCards(song, progress) {
  const cardStates = progress?.cardStates || {};
  return {
    ...song,
    cards: (song.cards || []).map(card => ({
      ...card,
      learning: {
        state: 'new',
        favorite: false,
        reviewCount: 0,
        lastReviewedAt: 0,
        nextReviewAt: 0,
        ...card.learning,
        ...(cardStates[card.id] || {}),
      },
    })),
  };
}

function sortSongs(songs, sortBy) {
  const list = [...songs];
  if (sortBy === 'recent-studied') {
    return list.sort((left, right) => (right.lastStudiedAt || 0) - (left.lastStudiedAt || 0));
  }
  return list.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

async function findDuplicateSong(repository, song) {
  const bySource = await repository.findSongBySource?.(song.source, song.sourceSongId);
  if (bySource) {
    return { reason: 'source-song-id', song: bySource };
  }

  const byHash = await repository.findSongByContentHash?.(song.contentHash);
  if (byHash) {
    return { reason: 'content-hash', song: byHash };
  }

  const byFileName = await repository.findSongByFileName?.(song.fileName);
  if (byFileName) {
    return { reason: 'file-name', song: byFileName };
  }

  const byMeta = await repository.findSongByTitleArtist?.(song.title, song.artist);
  if (byMeta) {
    return { reason: 'title-artist', song: byMeta };
  }

  return { reason: '', song: null };
}

function buildDuplicateMessage(song, reason) {
  const title = song?.title || '这首歌';
  if (reason === 'source-song-id') {
    return `《${title}》已经通过网易云导入，可直接继续学习`;
  }
  if (reason === 'file-name') {
    return `已按文件名识别到重复歌曲：${title}`;
  }
  if (reason === 'title-artist') {
    return `已按标题和歌手识别到重复歌曲：${title}`;
  }
  return `这首歌已经在本地曲库中了：${title}`;
}

function summarizeImportResults(results) {
  const successCount = results.filter(item => item.status === 'success').length;
  const duplicateCount = results.filter(item => item.status === 'duplicate').length;
  const failedCount = results.filter(item => item.status === 'failed').length;

  let status = 'success';
  if (!successCount && duplicateCount && !failedCount) {
    status = 'duplicate';
  } else if (failedCount && successCount) {
    status = 'partial';
  } else if (failedCount && !successCount) {
    status = duplicateCount ? 'partial' : 'failed';
  } else if (duplicateCount && successCount) {
    status = 'partial';
  }

  return {
    status,
    successCount,
    duplicateCount,
    failedCount,
    message: createBatchMessage({ successCount, duplicateCount, failedCount }),
  };
}

function createImportJob({ type = 'playlist', source = 'manual', playlistId = '', playlistName = '', sourceId = '', entries = [] }) {
  const now = Date.now();
  return {
    id: `import_${now}`,
    type,
    source,
    lyricSource: source === 'netease' ? 'netease' : 'manual-text',
    playlistId,
    playlistName,
    sourceId,
    status: 'pending',
    total: entries.length,
    successCount: 0,
    failedCount: 0,
    duplicateCount: 0,
    items: entries,
    results: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createPlaylistImportFailure(entry, message) {
  return {
    status: 'failed',
    fileName: entry?.fileName || '',
    song: null,
    meta: null,
    itemId: entry?.id || '',
    title: entry?.title || '',
    artist: entry?.artist || '',
    message,
  };
}

function createBatchMessage({ successCount, duplicateCount, failedCount }) {
  const parts = [];
  if (successCount) parts.push(`成功 ${successCount} 首`);
  if (duplicateCount) parts.push(`重复 ${duplicateCount} 首`);
  if (failedCount) parts.push(`失败 ${failedCount} 首`);
  return parts.length ? `批量导入完成：${parts.join('，')}` : '没有可导入的歌曲';
}

function createProgressSummary(song, progress) {
  return {
    ...summarizeProgress(song.cards || [], progress),
    lastStudiedAt: progress?.lastStudiedAt || song.lastStudiedAt || 0,
  };
}

export const __testables__ = {
  buildDuplicateMessage,
  summarizeImportResults,
  createProgressSummary,
  sortSongs,
  hydrateSongCards,
  createImportJob,
  createPlaylistImportFailure,
};
