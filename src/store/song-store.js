import { annotateLearningUnits, applyLearningUnitProgress } from '../engine/learning-units.js';

/**
 * 歌词卡状态中心。
 *
 * 顶层状态结构：
 * {
 *   rawText: '',
 *   songContext: '',
 *   cards: [],
 *   isAnalyzed: false,
 *   inputMode: 'text',
 *   fileName: '',
 *   stats: { total: 0, japanese: 0, english: 0 }
 * }
 */

class SongStore {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {string} 原始歌词文本 */
    this.rawText = '';
    /** @type {string} 整首歌词上下文 */
    this.songContext = '';
    /** @type {Array} 标准化歌词卡 */
    this.cards = [];
    /** @type {boolean} 是否已分析 */
    this.isAnalyzed = false;
    /** @type {'text' | 'file'} 输入模式 */
    this.inputMode = 'text';
    /** @type {string} 文件名 */
    this.fileName = '';
    /** @type {{ total: number, japanese: number, english: number }} 统计信息 */
    this.stats = {
      total: 0,
      japanese: 0,
      english: 0,
    };
    /** @type {string} 当前歌曲 ID */
    this.songId = '';
    /** @type {string} 当前歌曲标题 */
    this.songTitle = '';
    /** @type {string} 当前歌曲歌手 */
    this.songArtist = '';
  }

  setRawText(text) {
    this.rawText = text;
  }

  setCards(cards) {
    this.cards = annotateLearningUnits(Array.isArray(cards) ? cards : []);
  }

  setInputMode(mode) {
    this.inputMode = mode;
  }

  setFileName(name) {
    this.fileName = name;
  }

  setAnalysisResult({ rawText = '', songContext = '', cards = [], stats = null, songId = '', songTitle = '', songArtist = '' }) {
    this.rawText = rawText;
    this.songContext = songContext;
    this.cards = annotateLearningUnits(cards);
    this.stats = stats || this.createStats(cards);
    this.songId = songId;
    this.songTitle = songTitle;
    this.songArtist = songArtist;
    this.isAnalyzed = true;
  }

  loadSong(song) {
    this.setFileName(song.fileName || '');
    this.setAnalysisResult({
      rawText: song.rawLrc || '',
      songContext: song.cards?.[0]?.songContext || '',
      cards: song.cards || [],
      stats: this.createStats(song.cards || []),
      songId: song.id || '',
      songTitle: song.title || '',
      songArtist: song.artist || '',
    });
  }

  createStats(cards = this.cards) {
    return {
      total: cards.length,
      japanese: cards.filter(card => card.type === 'jp-zh' || card.type === 'jp-zh-ro').length,
      english: cards.filter(card => card.type === 'en-zh').length,
    };
  }

  updateCardExplainState(cardId, patch) {
    const current = this.getCardById(cardId);
    const unitId = current?.learningUnit?.role === 'target' ? current.learningUnit.id : '';
    this.cards = this.cards.map(card => {
      const sameLearningUnit = unitId && card.learningUnit?.id === unitId;
      if (card.id !== cardId && !sameLearningUnit) return card;
      return {
        ...card,
        explain: {
          ...card.explain,
          ...patch,
        },
      };
    });
  }

  updateCardUIState(cardId, patch) {
    this.cards = this.cards.map(card => {
      if (card.id !== cardId) return card;
      return {
        ...card,
        ui: {
          ...card.ui,
          ...patch,
        },
      };
    });
  }

  updateCardLearningState(cardId, patch) {
    this.cards = this.cards.map(card => {
      if (card.id !== cardId) return card;
      return {
        ...card,
        learning: {
          state: 'new',
          favorite: false,
          reviewCount: 0,
          lastReviewedAt: 0,
          nextReviewAt: 0,
          ...card.learning,
          ...patch,
        },
      };
    });
  }

  setCurrentSongProgress(progress = null) {
    if (!progress) return;
    if (progress.changedUnit?.unitId) {
      this.cards = this.cards.map(card => (
        card.learningUnit?.id === progress.changedUnit.unitId
          ? { ...card, learning: { ...card.learning, ...progress.changedUnit.learning } }
          : card
      ));
      return;
    }
    if (Number(progress.storageVersion) >= 3) return;
    this.cards = applyLearningUnitProgress(this.cards, progress);
  }

  getCardById(cardId) {
    return this.cards.find(card => card.id === cardId) || null;
  }
}

export const songStore = new SongStore();
export default songStore;
