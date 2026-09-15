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

/**
 * Modes the bot can play that are not "Player vs Bot".
 *
 * A game the bot is in keeps its own mode rather than being flattened to
 * `bot`, because the mode is what the rest of the app reads to know what kind
 * of game it is: an Elemental game against the bot is still Elemental, and
 * has seven powers to prove it.
 */
const BOT_MODES = [GAME_MODE.ELEMENTAL];

/**
 * Piece worth, for the one decision made without the search: which move to
 * fall back on when a variant's rules refuse the one it chose. Kept local and
 * deliberately crude — it is a tie-break between moves that are all already
 * legal, not an evaluation.
 */
const FALLBACK_WORTH = { p: 100, n: 320, b: 330, r: 500, q: 900 };

/**
 * The bot, as a layer over any other session.
 *
 * A mixin rather than a plain class, because the bot now has two things to sit
 * on: ordinary chess, and Elemental Chess. The class body below is identical
 * either way — what differs is only what `super` reaches.
 *
 * The bot always goes on the OUTSIDE. Its submitMove calls down through
 * whatever it wraps, so by the time it asks itself whether to reply, the layer
 * beneath has finished with the move — including, in the elemental game, the
 * fire and lightning a capture sets off. Stacked the other way round, the bot
 * would be handed a position one burn out of date.
 */
export const withBot = (Base) => class extends Base {
  /** The colour the human plays. The bot takes the other one. */
  #humanColor = WHITE;

  /**
   * How hard this bot thinks.
   *
   * Held per GAME rather than read from the constants at every search. It was
   * five different opponents out of one bot while the ladder existed, and is
   * one opponent now — but a search that reads its own budget off a field is
   * the shape that let it be five, and it costs nothing to keep.
   */
  #strength = { timeBudgetMs: BOT_TIME_BUDGET_MS, maxDepth: BOT_MAX_DEPTH };

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

    const botName = BOT_NAME;
    const state = await super.createGame({
      ...config,
      mode: BOT_MODES.includes(config.mode) ? config.mode : GAME_MODE.BOT,
      // Whichever seat the bot is in gets its name, so every place that shows
      // a player name — cards, PGN headers, the game-over dialog — says who
      // actually played without any of them knowing a bot exists.
      white: this.#humanColor === WHITE ? config.white : { name: botName },
      black: this.#humanColor === WHITE ? { name: botName } : config.black,
    });
    this.#maybeMove();
    return state;
  }

  getState() {
    const state = super.getState();
    if (!state) return state;
    // `vsBot` is what tells a RESUMED game to mount a bot again. The mode
    // cannot carry it on its own: an Elemental game is mode `elemental`
    // whether the other seat holds a person or this.
    return { ...state, vsBot: true };
  }

  async restoreGame(saved) {
    const botName = BOT_NAME;

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
      const botName = BOT_NAME;
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
      // Powers first, and only in a game that has any: a teleport moves the
      // king, so searching before spending them would be searching a position
      // the bot is about to change out from under itself. A no-op everywhere
      // else, because nothing else defines the hook.
      await this.botUsePower?.();
      if (this.#stopped) return;

      const state = this.getState();
      const fen = state.fen;
      const started = Date.now();

      // No second argument: with no clock to spare time for, what the bot
      // may spend IS its own strength, which is #think's default.
      const move = this.#vet(await this.#think(fen));

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
      const beat = BOT_MIN_THINK_MS - (Date.now() - started);
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
   * The searched move, or the best one the rules underneath will actually
   * accept.
   *
   * The search plays chess. In Elemental Chess it can therefore come back with
   * a move that a freeze, a shield or a patch of vines forbids, having never
   * been told any of them exist. Rather than teach a move generator about ice,
   * the answer is vetted afterwards and swapped for the best allowed
   * alternative when it has to be — losing the bot some of its strength on the
   * turns where effects are on the board, which is a handful of turns a game,
   * and never losing it a move.
   *
   * `isMoveAllowed` only exists on the elemental layer, so in an ordinary game
   * this hands back exactly what it was given.
   */
  #vet(move) {
    if (!move) return move;
    if (this.isMoveAllowed?.(move.from, move.to) !== false) return move;

    const allowed = this.getAllLegalMoves();
    if (!allowed.length) return null;
    const worth = (type) => FALLBACK_WORTH[type] ?? 0;
    const best = [...allowed].sort((a, b) => worth(b.captured) - worth(a.captured))[0];
    log('Bot move blocked by an effect; playing', best.san, 'instead');
    return best;
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
};

/** Player versus computer, at ordinary chess. */
export const BotSession = withBot(LocalSession);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default BotSession;
