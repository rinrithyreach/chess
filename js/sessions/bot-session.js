/**
 * sessions/bot-session.js
 * Player versus computer, as a session provider.
 *
 * This is the session seam doing what it was built for. The board, the UI and
 * the controller are untouched: they already know how to render a game where
 * only some colours are controllable, because that is what online play needs,
 * and a bot is the same shape — one side is not yours to move. app.js swaps
 * this in for LocalSession and nothing else changes.
 *
 * It extends LocalSession rather than reimplementing it, so the rules, status
 * handling, PGN headers, save/restore and every action stay in exactly one
 * place. What it adds is: one colour is not yours, and after every state
 * change the other side is asked whether it would like to move.
 *
 * The search runs in a Web Worker. See #think for why, and for what happens
 * when a worker cannot be created.
 */

import { LocalSession } from './local-session.js';
import {
  WHITE,
  BLACK,
  GAME_MODE,
  BOT_TIME_BUDGET_MS,
  BOT_MAX_DEPTH,
  BOT_MIN_THINK_MS,
  BOT_CLOCK_MARGIN_MS,
  BOT_NAME,
  gauntletRound,
  clampGauntletRound,
  log,
  warn,
} from '../config.js';

/**
 * Modes the bot can play that are not "Player vs Bot".
 *
 * A game the bot is in keeps its own mode rather than being flattened to
 * `bot`, because the mode is what the rest of the app reads to know what kind
 * of game it is: a Speed Chess game against the bot is still Speed Chess, and
 * has a clock to prove it.
 */
const BOT_MODES = [GAME_MODE.TOURNAMENT, GAME_MODE.SPEED];

export class BotSession extends LocalSession {
  /** The colour the human plays. The bot takes the other one. */
  #humanColor = WHITE;

  /**
   * How hard this particular bot thinks, and which rung it is.
   *
   * Held per GAME rather than read from the constants at every search,
   * because the tournament needs five different opponents out of one bot.
   * Null round means an ordinary Player-vs-Bot game, which is the default
   * strength and no rung at all.
   */
  #strength = { timeBudgetMs: BOT_TIME_BUDGET_MS, maxDepth: BOT_MAX_DEPTH };
  #round = null;

  #worker = null;
  #workerFailed = false;
  #pending = 0;
  #thinking = false;
  #stopped = false;

  async initialize() {
    await super.initialize();
    log('BotSession initialized');
    return this;
  }

  async createGame(config = {}) {
    this.#humanColor = config.humanColor === BLACK ? BLACK : WHITE;
    this.#setRound(config.gauntletRound ?? null);

    const botName = this.#opponentName();
    const state = await super.createGame({
      ...config,
      mode: BOT_MODES.includes(config.mode) ? config.mode : GAME_MODE.BOT,
      // Whichever seat the bot is in gets its name, so every place that shows
      // a player name — cards, PGN headers, the game-over dialog — says who
      // actually played without any of them knowing a bot exists. On the
      // ladder that name is the rung, so the board itself says who you are up
      // against without a single extra label anywhere.
      white: this.#humanColor === WHITE ? config.white : { name: botName },
      black: this.#humanColor === WHITE ? { name: botName } : config.black,
    });
    this.#maybeMove();
    return state;
  }

  /**
   * Point this session at one rung of the ladder, or at the ordinary bot.
   *
   * The strength is copied out rather than held by reference so that a later
   * edit to the ladder cannot change the opponent in a game already under way.
   */
  #setRound(round) {
    const rung = round === null ? null : gauntletRound(clampGauntletRound(round));
    this.#round = rung?.round ?? null;
    this.#strength = rung
      ? { timeBudgetMs: rung.timeBudgetMs, maxDepth: rung.maxDepth }
      : { timeBudgetMs: BOT_TIME_BUDGET_MS, maxDepth: BOT_MAX_DEPTH };
  }

  /** What the bot's seat is called: the rung's name, or just Bot. */
  #opponentName() {
    return this.#round === null ? BOT_NAME : gauntletRound(this.#round).label;
  }

  /**
   * The rung rides along in the state, so it survives a save.
   *
   * Without it, resuming a Champion game after a refresh would hand the board
   * back with the Novice thinking for it: the position would be right and the
   * opponent would quietly have been swapped.
   */
  getState() {
    const state = super.getState();
    if (!state) return state;
    // `vsBot` is what tells a RESUMED game to mount a bot again. The mode
    // cannot carry it on its own any more: a Speed Chess game is mode
    // `speed` whether the other seat holds a person or this.
    return { ...state, gauntletRound: this.#round, vsBot: true };
  }

  async restoreGame(saved) {
    // The rung first, because it decides what the bot's seat is called and so
    // has to be known before the names below are read.
    this.#setRound(saved?.gauntletRound ?? null);
    const botName = this.#opponentName();

    // Which seat the human had is recoverable from the saved names, because
    // createGame put the bot's name in the bot's seat. Falling back to White
    // keeps a hand-edited or older record playable rather than stuck.
    this.#humanColor = saved?.players?.[BLACK]?.name === botName ? WHITE : BLACK;
    if (saved?.players?.[WHITE]?.name !== botName
        && saved?.players?.[BLACK]?.name !== botName) {
      this.#humanColor = WHITE;
    }
    const result = await super.restoreGame(saved);
    if (result.ok) this.#maybeMove();
    return result;
  }

  /**
   * Only the human's pieces answer to this device.
   *
   * The controller already rejects moves for colours it does not control, so
   * this single line is the whole of "you cannot move the bot's pieces" — no
   * check anywhere in the board or the UI.
   */
  getControllableColors() {
    return [this.#humanColor];
  }

  async submitMove(move) {
    const result = await super.submitMove(move);
    if (result.ok) this.#maybeMove();
    return result;
  }

  async submitAction(action, payload) {
    const result = await super.submitAction(action, payload);
    // A rematch can swap seats and a restart resets the position, so whose
    // turn it is has to be re-derived rather than assumed.
    if (result.ok) {
      const state = this.getState();
      const botName = this.#opponentName();
      if (state.players?.[WHITE]?.name === botName) this.#humanColor = BLACK;
      else if (state.players?.[BLACK]?.name === botName) this.#humanColor = WHITE;
      this.#maybeMove();
    }
    return result;
  }

  leave() {
    this.#stopped = true;
    super.leave();
  }

  destroy() {
    this.#stopped = true;
    this.#worker?.terminate();
    this.#worker = null;
    super.destroy?.();
  }

  // -----------------------------------------------------------------------
  // The bot's turn
  // -----------------------------------------------------------------------

  /** Is it the bot's move, in a game that is still going? */
  #botToMove() {
    const state = this.getState();
    if (!state || state.isGameOver) return false;
    return state.turn !== this.#humanColor;
  }

  #maybeMove() {
    if (this.#stopped || this.#thinking || !this.#botToMove()) return;
    this.#thinking = true;
    // Not awaited: submitMove must return to the player's tap immediately, so
    // their own move renders and animates while the bot is still thinking.
    this.#play().catch((error) => warn('Bot failed to move', error));
  }

  async #play() {
    try {
      const state = this.getState();
      const fen = state.fen;
      const started = Date.now();

      const move = await this.#think(fen, this.#budget());

      // The game can end, restart or be left while the search runs.
      if (this.#stopped) return;
      const now = this.getState();
      if (!now || now.fen !== fen || now.isGameOver) return;
      if (!move) {
        warn('Bot found no move for', fen);
        return;
      }

      // A reply that lands the instant the player's finger lifts reads as a
      // canned response rather than a decision, and steps on the animation of
      // the move that provoked it. Wait out the remainder of a short beat.
      // The pause is a courtesy, and courtesy is not worth losing on time
      // for: on a clock it is trimmed to whatever the bot can spare, and in
      // a scramble it disappears entirely.
      const elapsed = Date.now() - started;
      const beat = Math.min(BOT_MIN_THINK_MS - elapsed, this.#spare());
      if (beat > 0) await pause(beat);
      if (this.#stopped || this.getState().fen !== fen) return;

      await super.submitMove({
        from: move.from,
        to: move.to,
        promotion: move.promotion,
      });
    } finally {
      this.#thinking = false;
    }
    // A move may have handed the turn straight back — a bot playing both
    // sides of a restart, say. Cheap, and terminates because #botToMove goes
    // false as soon as it is the human's turn or the game is over.
    this.#maybeMove();
  }

  /**
   * Search for a move, in a worker when one can be had.
   *
   * The fallback is a real one, not a formality: module workers need a
   * same-origin document, so opening the page straight from the filesystem
   * (file://) — which this project otherwise supports — cannot create one.
   * There the search runs on the main thread instead, which briefly costs
   * smoothness but never costs a move.
   */
  /**
   * What the bot may spend on this move.
   *
   * Its own strength, or everything it has left bar a margin — whichever is
   * less. Without this a Champion in a bullet game would sit and think for
   * three seconds with two seconds on its clock, and flag in the middle of
   * a search it never got to use.
   */
  #budget() {
    const want = this.#strength.timeBudgetMs;
    const left = this.#clockLeft();
    if (left === null) return want;
    return Math.max(60, Math.min(want, left - BOT_CLOCK_MARGIN_MS));
  }

  /** How much of the courtesy pause the clock can afford. */
  #spare() {
    const left = this.#clockLeft();
    if (left === null) return BOT_MIN_THINK_MS;
    return Math.max(0, left - BOT_CLOCK_MARGIN_MS);
  }

  /** The bot's own remaining time, or null in a game with no clock. */
  #clockLeft() {
    const clock = this.getClock?.();
    if (!clock) return null;
    return clock.remaining[this.#humanColor === WHITE ? BLACK : WHITE] ?? null;
  }

  async #think(fen, timeBudgetMs = this.#strength.timeBudgetMs) {
    const worker = this.#getWorker();
    if (worker) {
      try {
        return await this.#askWorker(worker, fen, timeBudgetMs);
      } catch (error) {
        warn('Bot worker failed, falling back to the main thread', error);
        this.#workerFailed = true;
        this.#worker?.terminate();
        this.#worker = null;
      }
    }
    const { chooseMove } = await import('../bot.js');
    return chooseMove(fen, { ...this.#strength, timeBudgetMs });
  }

  #getWorker() {
    if (this.#worker || this.#workerFailed) return this.#worker;
    try {
      this.#worker = new Worker(new URL('../bot-worker.js', import.meta.url), {
        type: 'module',
      });
    } catch (error) {
      warn('No bot worker available, searching on the main thread', error);
      this.#workerFailed = true;
      this.#worker = null;
    }
    return this.#worker;
  }

  #askWorker(worker, fen, timeBudgetMs = this.#strength.timeBudgetMs) {
    const id = (this.#pending += 1);
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        cleanup();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.move);
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(event.message ?? 'Bot worker error'));
      };
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, fen, ...this.#strength, timeBudgetMs });
    });
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default BotSession;
