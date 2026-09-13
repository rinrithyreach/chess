/**
 * sessions/local-session.js
 * The Phase 1 session provider: both players share one device.
 *
 * ---------------------------------------------------------------------------
 * SESSION PROVIDER CONTRACT
 * ---------------------------------------------------------------------------
 * A session provider is the transport between a player's intent and the
 * authoritative game state. It is the ONLY layer that would need replacing to
 * add networked play, which is why nothing above it (board, ui) is allowed to
 * touch the chess engine directly.
 *
 * Every provider implements:
 *
 *   async initialize()                       Prepare the provider.
 *   async createGame(config)                 Start a new game. -> state
 *   async restoreGame(saved)                 Rebuild from a saved record. -> state
 *   async submitMove({from, to, promotion})  -> {ok, error?, move?}
 *   async submitAction(action, payload)      resign / draw / undo / restart /
 *                                            rematch -> {ok, error?}
 *   subscribeToState(listener)               -> unsubscribe function
 *   getState()                               Current snapshot (synchronous).
 *   getControllableColors()                  Colors this device may move.
 *   leave()                                  Stop participating, keep data.
 *   destroy()                                Tear down and release listeners.
 *
 * All mutating methods are async so that a future FirebaseSession — where a
 * move is a network round trip — is a drop-in replacement with no changes to
 * the controller.
 *
 * State snapshots are plain JSON-serializable objects. That is deliberate:
 * Phase 2 can write a snapshot straight to the Realtime Database.
 *
 * NOTE: board orientation and user settings are intentionally NOT part of
 * session state. They are per-device display preferences — in online play each
 * device orients the board for its own player — so the controller owns them.
 * ---------------------------------------------------------------------------
 */

import { ChessEngine, DRAW_REASON, DRAW_REASON_LABEL } from '../chess-engine.js';
import {
  WHITE,
  BLACK,
  STATUS,
  TERMINAL_STATUSES,
  GAME_MODE,
  resolveTimeControl,
  DEFAULT_PLAYER_NAMES,
  log,
  warn,
} from '../config.js';
import { isAvatar } from '../avatar.js';

/** How a finished game ended. */
export const END_REASON = {
  CHECKMATE: 'checkmate',
  RESIGNATION: 'resignation',
  TIMEOUT: 'timeout',
  DRAW_AGREEMENT: 'draw-agreement',
  ...DRAW_REASON,
};

export const SESSION_ACTION = {
  RESIGN: 'resign',
  DRAW: 'draw',
  UNDO: 'undo',
  RESTART: 'restart',
  REMATCH: 'rematch',
};

const colorName = (color) => (color === WHITE ? 'White' : 'Black');
const otherColor = (color) => (color === WHITE ? BLACK : WHITE);

/** A full clock for one time control, not yet running. */
function newClock(id) {
  const control = resolveTimeControl(id);
  return {
    control: control.id,
    incrementMs: control.incrementMs,
    initialMs: control.initialMs,
    remaining: { [WHITE]: control.initialMs, [BLACK]: control.initialMs },
    running: null,
    since: null,
  };
}

/**
 * Rebuild a clock from a saved game, or null if that game had none.
 *
 * The balances are taken as stored and the stopwatch is restarted from now,
 * so the time a player spent thinking before the tab was closed is given back
 * to them. That is the deliberate side of the trade: the alternative is
 * counting the hours a closed tab was closed, and losing a blitz game
 * overnight while nobody was playing it.
 */
function restoreClock(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const control = resolveTimeControl(saved.control);
  const ms = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
  };
  const running = saved.running === WHITE || saved.running === BLACK ? saved.running : null;

  return {
    control: control.id,
    incrementMs: control.incrementMs,
    initialMs: control.initialMs,
    remaining: {
      [WHITE]: ms(saved.remaining?.[WHITE], control.initialMs),
      [BLACK]: ms(saved.remaining?.[BLACK], control.initialMs),
    },
    running,
    since: running ? Date.now() : null,
  };
}

/**
 * Build a player record from whatever a caller supplied.
 *
 * One helper for both entry points — a new game and a restored one — because
 * they are the same problem seen twice: an object of unknown provenance that
 * has to become a player. The saved record in particular can be anything, so
 * the picture is validated here rather than trusted and rendered later. An
 * avatar that does not pass is simply absent; the player keeps their seat.
 */
function makePlayer(source, fallbackName) {
  return {
    name: source?.name?.trim() || fallbackName,
    avatar: isAvatar(source?.avatar) ? source.avatar : null,
  };
}

export class LocalSession {
  #engine = new ChessEngine();
  #listeners = new Set();
  #players = {
    [WHITE]: { name: DEFAULT_PLAYER_NAMES.white, avatar: null },
    [BLACK]: { name: DEFAULT_PLAYER_NAMES.black, avatar: null },
  };
  #status = STATUS.SETUP;
  #result = null;
  #mode = GAME_MODE.LOCAL;
  #startFen = null;
  #destroyed = false;

  /**
   * The chess clock, or null in a game that has none.
   *
   * Time is held as a pair of remaining balances plus ONE timestamp: the
   * moment the running side's turn began. Everything else is arithmetic
   * against `Date.now()`, which is what makes this correct without being
   * driven — no interval has to fire on time, or fire at all, for the
   * reading to be right. A tab that sleeps for a minute wakes up having
   * lost a minute, which is exactly what a chess clock does.
   *
   * `running` is null before the first move. The clocks are idle until
   * White actually plays, because on a shared device nobody is ready at the
   * instant the board appears, and a bullet game that has eaten four
   * seconds before either player has looked at it is worse than a free
   * first move.
   */
  #clock = null;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize() {
    log('LocalSession initialized');
    return this;
  }

  /**
   * Start a new game.
   * @param {object} config
   * @param {{name:string, avatar?:string}} [config.white]
   * @param {{name:string, avatar?:string}} [config.black]
   * @param {string} [config.startFen] Non-standard starting position (DEBUG).
   */
  async createGame(config = {}) {
    this.#engine = new ChessEngine();
    this.#startFen = null;

    if (config.startFen) {
      const loaded = this.#engine.loadFen(config.startFen);
      if (loaded.ok) {
        this.#startFen = config.startFen;
      } else {
        warn('Ignoring invalid start FEN:', loaded.error);
      }
    }

    this.#players = {
      [WHITE]: makePlayer(config.white, DEFAULT_PLAYER_NAMES.white),
      [BLACK]: makePlayer(config.black, DEFAULT_PLAYER_NAMES.black),
    };
    this.#mode = config.mode ?? GAME_MODE.LOCAL;
    this.#result = null;
    this.#status = STATUS.PLAYING;
    this.#clock = config.timeControl ? newClock(config.timeControl) : null;

    this.#syncHeaders();
    this.#refreshStatus();
    return this.#publish();
  }

  /**
   * Rebuild a game from a validated saved record.
   *
   * The PGN is replayed rather than the FEN loaded, because replaying rebuilds
   * the full move history — which is what keeps undo and threefold-repetition
   * detection working across a page refresh. The FEN is used only as a
   * cross-check, and as a last-resort fallback if replay somehow fails.
   */
  async restoreGame(saved) {
    if (!saved) return { ok: false, error: 'Nothing to restore' };

    this.#engine = new ChessEngine();
    let restored = false;

    if (typeof saved.pgn === 'string' && saved.pgn.trim()) {
      const replay = this.#engine.loadPgn(saved.pgn);
      if (replay.ok && this.#engine.getFen() === saved.fen) {
        restored = true;
      } else {
        warn('PGN replay mismatch, falling back to FEN', replay.error);
      }
    }

    if (!restored) {
      const loaded = this.#engine.loadFen(saved.fen);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      // History is empty on this path, so undo is unavailable — acceptable
      // because the position itself is correct.
    }

    this.#players = {
      [WHITE]: makePlayer(saved.players?.[WHITE], DEFAULT_PLAYER_NAMES.white),
      [BLACK]: makePlayer(saved.players?.[BLACK], DEFAULT_PLAYER_NAMES.black),
    };
    this.#mode = saved.mode ?? GAME_MODE.LOCAL;
    this.#startFen = saved.startFen ?? null;
    this.#result = saved.result ?? null;
    this.#status = saved.status ?? STATUS.PLAYING;
    this.#clock = restoreClock(saved.clock);

    this.#syncHeaders();
    // Re-derive rule-driven status so a tampered record cannot leave the game
    // claiming to be playable when the position is actually over.
    if (!this.#isTerminal()) this.#refreshStatus();

    log('Game restored', this.#status);
    return { ok: true, state: this.#publish() };
  }

  leave() {
    this.#listeners.clear();
  }

  destroy() {
    this.#destroyed = true;
    this.#listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  subscribeToState(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    // Deliver the current snapshot immediately so subscribers never render
    // an empty first frame.
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  #publish() {
    const state = this.getState();
    this.#listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        warn('State listener threw', error);
      }
    });
    return state;
  }

  // -----------------------------------------------------------------------
  // Moves and actions
  // -----------------------------------------------------------------------

  /**
   * Both players are on this device, so every colour is controllable.
   * A FirebaseSession would return only the local player's colour, and the
   * controller's turn check would then reject the opponent's pieces without
   * any other code changing.
   */
  getControllableColors() {
    return [WHITE, BLACK];
  }

  async submitMove({ from, to, promotion } = {}) {
    if (this.#destroyed) return { ok: false, error: 'Session destroyed' };
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };

    const result = this.#engine.makeMove(from, to, promotion);
    if (!result.ok) return { ok: false, error: result.error };

    // Before the status refresh, so a move that both mates and would have
    // flagged is scored as the mate it is: the clock stops the instant the
    // move lands, and a player who moved in time has moved in time.
    this.#handOverClock();
    this.#refreshStatus();
    this.#publish();
    return { ok: true, move: result.move, state: this.getState() };
  }

  async submitAction(action, payload = {}) {
    if (this.#destroyed) return { ok: false, error: 'Session destroyed' };

    switch (action) {
      case SESSION_ACTION.RESIGN:
        return this.#resign(payload.color ?? this.#engine.getTurn());
      case SESSION_ACTION.DRAW:
        return this.#agreeDraw();
      case SESSION_ACTION.UNDO:
        return this.#undo();
      case SESSION_ACTION.RESTART:
        return this.#restart();
      case SESSION_ACTION.REMATCH:
        return this.#rematch();
      default:
        warn('Unknown session action', action);
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  #resign(color) {
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };
    const winner = color === WHITE ? BLACK : WHITE;
    this.#status = STATUS.RESIGNED;
    this.#result = {
      winner,
      reason: END_REASON.RESIGNATION,
      label: `${colorName(winner)} Wins`,
      detail: `${colorName(color)} resigned`,
    };
    this.#engine.setHeader('Result', winner === WHITE ? '1-0' : '0-1');
    this.#publish();
    return { ok: true, state: this.getState() };
  }

  #agreeDraw() {
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };
    this.#status = STATUS.DRAW;
    this.#result = {
      winner: null,
      reason: END_REASON.DRAW_AGREEMENT,
      label: 'Draw',
      detail: DRAW_REASON_LABEL[DRAW_REASON.AGREEMENT],
    };
    this.#engine.setHeader('Result', '1/2-1/2');
    this.#publish();
    return { ok: true, state: this.getState() };
  }

  /**
   * Take back one half-move (one player's move), as required for local play.
   * Also clears any finished-game result, so undoing out of a checkmate
   * returns the game to a playable state rather than a frozen board.
   */
  #undo() {
    if (!this.#engine.canUndo()) return { ok: false, error: 'Nothing to undo' };
    const undone = this.#engine.undo();
    if (!undone) return { ok: false, error: 'Undo failed' };

    this.#result = null;
    this.#engine.setHeader('Result', '*');
    this.#refreshStatus();
    this.#publish();
    return { ok: true, move: undone, state: this.getState() };
  }

  /** Reset the position but keep both players — names and pictures. */
  #restart() {
    this.#engine = new ChessEngine();
    if (this.#startFen) this.#engine.loadFen(this.#startFen);
    this.#result = null;
    this.#status = STATUS.PLAYING;
    // A new game on the same terms: full clocks, idle until the first move.
    if (this.#clock) this.#clock = newClock(this.#clock.control);
    this.#syncHeaders();
    this.#refreshStatus();
    this.#publish();
    return { ok: true, state: this.getState() };
  }

  /**
   * Restart with the two players swapping colours.
   *
   * Always, with nothing to opt out of: the online session has no way to
   * offer the choice — the swap is part of the transaction that resets the
   * room, agreed by both devices — so making it conditional here only bought
   * a local game that behaved differently from an online one.
   */
  #rematch() {
    const white = this.#players[WHITE];
    this.#players[WHITE] = this.#players[BLACK];
    this.#players[BLACK] = white;
    return this.#restart();
  }

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  #isTerminal() {
    return TERMINAL_STATUSES.includes(this.#status);
  }

  #syncHeaders() {
    this.#engine.setHeader('Event', 'Chess zin two bc zin — Local Game');
    this.#engine.setHeader('Site', 'Chess zin two bc zin');
    this.#engine.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
    this.#engine.setHeader('White', this.#players[WHITE].name);
    this.#engine.setHeader('Black', this.#players[BLACK].name);
  }

  /**
   * Recompute status and result from the position.
   * Rule-driven outcomes (checkmate, the draws) are derived here; agreed
   * outcomes (resignation, draw agreement) are set by their own handlers and
   * left alone.
   */
  // -----------------------------------------------------------------------
  // The clock
  // -----------------------------------------------------------------------

  /** What one side has left right now, counting the turn in progress. */
  #remaining(color) {
    const clock = this.#clock;
    if (!clock) return null;
    const banked = clock.remaining[color];
    if (clock.running !== color) return banked;
    return Math.max(0, banked - (Date.now() - clock.since));
  }

  /**
   * Stop the mover's clock, pay their increment, start the opponent's.
   *
   * The increment is paid only to a clock that was actually running. On the
   * very first move nothing has been spent, and paying two seconds for a move
   * made before the clocks started would hand White a head start.
   */
  #handOverClock() {
    const clock = this.#clock;
    if (!clock) return;

    const mover = clock.running;
    if (mover) {
      clock.remaining[mover] = Math.max(0, this.#remaining(mover)) + clock.incrementMs;
    }
    clock.running = this.#engine.getTurn();
    clock.since = Date.now();
  }

  /**
   * Has the running side run out? Ends the game if so.
   *
   * Called from outside on a timer, because a balance that is only ever
   * computed when someone asks would let a flagged game sit there looking
   * playable until the next move was attempted. Returns whether anything
   * changed, so the caller can stop asking.
   */
  tickClock() {
    const clock = this.#clock;
    if (!clock?.running || this.#isTerminal()) return false;
    if (this.#remaining(clock.running) > 0) return false;

    const loser = clock.running;
    const winner = otherColor(loser);
    clock.remaining[loser] = 0;
    clock.running = null;
    clock.since = null;

    this.#status = STATUS.FINISHED;
    this.#result = {
      winner,
      reason: END_REASON.TIMEOUT,
      label: `${colorName(winner)} Wins`,
      detail: `${colorName(loser)} ran out of time`,
    };
    this.#engine.setHeader('Result', winner === WHITE ? '1-0' : '0-1');
    this.#publish();
    return true;
  }

  /**
   * The clock, read live, without going through a state snapshot.
   *
   * The whole state is only rebuilt when something happens, and between two
   * moves nothing does — so a caller watching the time has to ask for the
   * time rather than re-read a snapshot that was accurate when it was taken
   * and has been standing still ever since.
   */
  getClock() {
    return this.#clockState();
  }

  /** The clock as the rest of the app sees it: live balances, no stopwatch. */
  #clockState() {
    const clock = this.#clock;
    if (!clock) return null;
    return {
      control: clock.control,
      incrementMs: clock.incrementMs,
      initialMs: clock.initialMs,
      remaining: {
        [WHITE]: this.#remaining(WHITE),
        [BLACK]: this.#remaining(BLACK),
      },
      running: clock.running,
    };
  }

  #refreshStatus() {
    const engine = this.#engine;

    if (engine.isCheckmate()) {
      const winner = engine.getOpponent();
      this.#status = STATUS.CHECKMATE;
      this.#result = {
        winner,
        reason: END_REASON.CHECKMATE,
        label: `${colorName(winner)} Wins`,
        detail: 'Checkmate',
      };
      engine.setHeader('Result', winner === WHITE ? '1-0' : '0-1');
      return;
    }

    const drawReason = engine.getDrawReason();
    if (drawReason) {
      this.#status = STATUS.DRAW;
      this.#result = {
        winner: null,
        reason: drawReason,
        label: 'Draw',
        detail: DRAW_REASON_LABEL[drawReason],
      };
      engine.setHeader('Result', '1/2-1/2');
      return;
    }

    this.#result = null;
    this.#status = engine.isCheck() ? STATUS.CHECK : STATUS.PLAYING;
  }

  /**
   * A complete, JSON-serializable snapshot of the game.
   * This shape is what a Phase 2 FirebaseSession would synchronise.
   */
  getState() {
    const engine = this.#engine;
    const turn = engine.getTurn();
    const isCheck = engine.isCheck();

    return {
      mode: this.#mode,
      status: this.#status,
      fen: engine.getFen(),
      pgn: engine.getPgn(),
      turn,
      moves: engine.getHistory(),
      verboseMoves: engine.getVerboseHistory(),
      lastMove: engine.getLastMove(),
      players: {
        [WHITE]: { ...this.#players[WHITE] },
        [BLACK]: { ...this.#players[BLACK] },
      },
      result: this.#result ? { ...this.#result } : null,
      isCheck,
      checkSquare: isCheck ? engine.getKingSquare(turn) : null,
      canUndo: engine.canUndo(),
      moveNumber: engine.moveNumber(),
      startFen: this.#startFen,
      isGameOver: this.#isTerminal(),
      clock: this.#clockState(),
    };
  }

  /**
   * Legal destinations from a square, as descriptors.
   * Read-only, so exposing it here keeps the board from needing the engine.
   */
  getLegalMoves(square) {
    return this.#engine.getLegalMoves(square);
  }

  /** Does this move need a promotion choice before it can be submitted? */
  requiresPromotion(from, to) {
    return this.#engine.requiresPromotion(from, to);
  }

  /** The piece on a square, or null. */
  getPiece(square) {
    return this.#engine.getPiece(square);
  }

  /** Load an arbitrary position — DEBUG tooling only. */
  async loadFenForTesting(fen) {
    const loaded = this.#engine.loadFen(fen);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    this.#startFen = fen;
    this.#result = null;
    this.#status = STATUS.PLAYING;
    this.#syncHeaders();
    this.#refreshStatus();
    this.#publish();
    return { ok: true, state: this.getState() };
  }
}

export default LocalSession;
