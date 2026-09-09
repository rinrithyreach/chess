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
  BOT_NAME,
  log,
  warn,
} from '../config.js';

export class BotSession extends LocalSession {
  /** The colour the human plays. The bot takes the other one. */
  #humanColor = WHITE;
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
    const state = await super.createGame({
      ...config,
      mode: GAME_MODE.BOT,
      // Whichever seat the bot is in gets its name, so every place that shows
      // a player name — cards, PGN headers, the game-over dialog — says who
      // actually played without any of them knowing a bot exists.
      white: this.#humanColor === WHITE ? config.white : { name: BOT_NAME },
      black: this.#humanColor === WHITE ? { name: BOT_NAME } : config.black,
    });
    this.#maybeMove();
    return state;
  }

  async restoreGame(saved) {
    // Which seat the human had is recoverable from the saved names, because
    // createGame put the bot's name in the bot's seat. Falling back to White
    // keeps a hand-edited or older record playable rather than stuck.
    this.#humanColor = saved?.players?.[BLACK]?.name === BOT_NAME ? WHITE : BLACK;
    if (saved?.players?.[WHITE]?.name !== BOT_NAME
        && saved?.players?.[BLACK]?.name !== BOT_NAME) {
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
      if (state.players?.[WHITE]?.name === BOT_NAME) this.#humanColor = BLACK;
      else if (state.players?.[BLACK]?.name === BOT_NAME) this.#humanColor = WHITE;
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

      const move = await this.#think(fen);

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
      const elapsed = Date.now() - started;
      if (elapsed < BOT_MIN_THINK_MS) await pause(BOT_MIN_THINK_MS - elapsed);
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
  async #think(fen) {
    const worker = this.#getWorker();
    if (worker) {
      try {
        return await this.#askWorker(worker, fen);
      } catch (error) {
        warn('Bot worker failed, falling back to the main thread', error);
        this.#workerFailed = true;
        this.#worker?.terminate();
        this.#worker = null;
      }
    }
    const { chooseMove } = await import('../bot.js');
    return chooseMove(fen, {
      timeBudgetMs: BOT_TIME_BUDGET_MS,
      maxDepth: BOT_MAX_DEPTH,
    });
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

  #askWorker(worker, fen) {
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
      worker.postMessage({
        id,
        fen,
        timeBudgetMs: BOT_TIME_BUDGET_MS,
        maxDepth: BOT_MAX_DEPTH,
      });
    });
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default BotSession;
