/**
 * game-controller.js
 * The brain of the application.
 *
 * Sits between the session provider (authoritative game state) and the view
 * layer (board.js / ui.js). It owns everything the session deliberately does
 * not: the current selection, board orientation, the pending promotion, the
 * input lock, and autosave.
 *
 * It contains no DOM code. Views subscribe to `onChange` and re-render from
 * the snapshot they are handed.
 */

import {
  WHITE,
  BLACK,
  GAME_MODE,
  DEFAULT_SETTINGS,
  AVATAR_SLOTS,
  log,
  warn,
} from './config.js';
import { isAvatar } from './avatar.js';
import { LocalSession, SESSION_ACTION } from './sessions/local-session.js';
import * as storage from './storage.js';
import sound from './sound.js';

/** Events views can subscribe to. */
export const EVENT = {
  CHANGE: 'change', // state or view changed — re-render
  PROMOTION: 'promotion', // a promotion choice is required
  GAME_OVER: 'game-over', // the game just ended
  TOAST: 'toast', // transient user-facing message
  DRAW_OFFER: 'draw-offer', // a draw has been offered to the opponent
  MOVE: 'move', // a move was just committed (for animation/sound)
};

export class GameController {
  #session;
  #state = null;
  #listeners = new Map();

  /** View-only concerns the session does not own. */
  #view = {
    orientation: 'white',
    selected: null,
    legalTargets: [],
    pendingPromotion: null,
    lastRejected: null,
  };

  #settings = { ...DEFAULT_SETTINGS };

  /**
   * Remembered profile pictures, by New Game form slot.
   *
   * Not game state and not settings — see storage.js. They live here only
   * because the controller is the one layer allowed to touch storage, and
   * ui.js has to be able to offer a picture back next time without becoming
   * the second.
   */
  #avatars = Object.fromEntries(AVATAR_SLOTS.map((slot) => [slot, null]));

  /** Input lock — blocks duplicate submissions from rapid tapping. */
  #processing = false;

  #started = false;

  /**
   * What the controller has already reacted to.
   *
   * State can now arrive from two directions: this device's own actions, and
   * (online) the opponent's. Rather than have every action emit its own
   * events — which would double-fire when the network echoes our own write
   * back — reactions are derived by comparing each incoming snapshot against
   * what we last reacted to. That makes the handler idempotent and identical
   * for local and remote changes.
   *
   * `baseline` marks a deliberate jump (new game, restore, rematch) that
   * should be adopted silently rather than treated as a move.
   */
  #reacted = { moves: 0, gameOver: false, drawOffer: null, baseline: true };

  #unsubscribeSession = null;

  constructor(session = new LocalSession()) {
    this.#session = session;
  }

  /** The active session provider (local or online). */
  getSession() {
    return this.#session;
  }

  /** Is this an online game? */
  isOnline() {
    return Boolean(this.#state?.online);
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.#listeners.get(event)?.delete(listener);
  }

  #emit(event, payload) {
    this.#listeners.get(event)?.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        // A broken view must not take down the game loop.
        warn(`Listener for "${event}" threw`, error);
      }
    });
  }

  #emitChange() {
    this.#emit(EVENT.CHANGE, this.getSnapshot());
  }

  #toast(message, tone = 'info') {
    this.#emit(EVENT.TOAST, { message, tone });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async init() {
    this.#settings = storage.loadSettings();
    this.#avatars = storage.loadAvatars();
    sound.setEnabled(this.#settings.sound);
    await this.#session.initialize();
    this.#attachSession();

    log('Controller ready', this.#settings);
    return this;
  }

  /** Subscribe to the current session. Re-called when the provider is swapped. */
  #attachSession() {
    this.#unsubscribeSession?.();
    this.#reacted = { moves: 0, gameOver: false, drawOffer: null, baseline: true };
    this.#unsubscribeSession = this.#session.subscribeToState((state) => {
      this.#syncFromSession(state);
    });
  }

  /**
   * Replace the session provider — this is the Phase 2 swap point.
   * The controller, board and UI are unchanged; only the transport differs.
   */
  async useSession(session) {
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = null;

    if (this.#session && this.#session !== session) {
      try {
        this.#session.leave?.();
      } catch (error) {
        warn('Leaving previous session failed', error);
      }
    }

    this.#session = session;
    this.#state = null;
    this.#started = false;
    this.#resetView();
    await this.#session.initialize();
    this.#attachSession();
    return this.#session;
  }

  /**
   * The single place state changes turn into effects.
   *
   * Called for every snapshot the session publishes, whether this device
   * caused it or the opponent did. Everything is derived by diffing against
   * `#reacted`, so an echoed write cannot double-fire a sound or a modal.
   */
  #syncFromSession(state) {
    const previous = this.#reacted;
    const moveCount = state.moves?.length ?? 0;
    const gameOver = Boolean(state.isGameOver);
    const drawOffer = state.online?.drawOfferFrom ?? null;

    const previousColor = this.#state?.online?.myColor ?? null;
    this.#state = state;
    this.#reacted = { moves: moveCount, gameOver, drawOffer, baseline: false };

    // Online, a rematch swaps seats. Follow the swap so the local player is
    // always the one at the bottom of their own board.
    const myColor = state.online?.myColor ?? null;
    if (myColor && myColor !== previousColor) {
      this.#view.orientation = myColor === BLACK ? 'black' : 'white';
    }

    // A deliberate reset (new game, restore, rematch) is adopted silently.
    if (previous.baseline) {
      this.#emitChange();
      return;
    }

    const moveAdded = moveCount > previous.moves;
    const movesRemoved = moveCount < previous.moves;

    if (moveAdded || movesRemoved) {
      this.#clearSelection();
      this.#applyAutoFlip();
    }

    if (moveAdded) {
      sound.playForMove(state.lastMove, {
        isCheck: state.isCheck,
        isGameOver: gameOver,
      });
      this.#emit(EVENT.MOVE, { move: state.lastMove, state });
    }

    // A draw offered by the opponent, arriving over the network.
    if (drawOffer && drawOffer !== previous.drawOffer && drawOffer !== state.online?.myColor) {
      this.#emit(EVENT.DRAW_OFFER, {
        from: drawOffer,
        to: state.online?.myColor ?? this.#opponentOf(drawOffer),
        remote: true,
      });
    }

    this.#save();
    this.#emitChange();

    if (gameOver && !previous.gameOver) {
      // Resignations and agreed draws end the game without a move, so they
      // still need their own sound.
      if (!moveAdded) sound.playForMove(null, { isGameOver: true });
      this.#emit(EVENT.GAME_OVER, this.getSnapshot());
    }
  }

  #opponentOf(color) {
    return color === WHITE ? BLACK : WHITE;
  }

  /** Mark the next snapshot as a deliberate reset rather than a move. */
  #expectReset() {
    this.#reacted = { ...this.#reacted, baseline: true };
  }

  /** True when a valid, unfinished saved game is available to resume. */
  hasSavedGame() {
    return storage.hasResumableGame();
  }

  getSavedGameInfo() {
    const saved = storage.peekSavedGame();
    if (!saved) return null;
    return {
      white: saved.players?.[WHITE]?.name ?? 'Player 1',
      black: saved.players?.[BLACK]?.name ?? 'Player 2',
      moveCount: Array.isArray(saved.moves) ? saved.moves.length : 0,
      mode: saved.mode ?? GAME_MODE.LOCAL,
      roomCode: saved.roomCode ?? null,
    };
  }

  /**
   * Start a brand-new game. Clears previous game data but deliberately keeps
   * user settings, which survive across games.
   */
  async newGame({
    whiteName,
    blackName,
    whiteAvatar = null,
    blackAvatar = null,
    mode = GAME_MODE.LOCAL,
    startFen,
  } = {}) {
    storage.clearGame();
    this.#resetView();
    this.#expectReset();

    // The picture is copied into the game rather than referenced from the
    // remembered set, so changing it later — or clearing it — leaves the game
    // already under way exactly as it was.
    await this.#session.createGame({
      white: { name: whiteName, avatar: whiteAvatar },
      black: { name: blackName, avatar: blackAvatar },
      mode,
      startFen,
    });

    this.#started = true;
    this.#view.orientation = 'white';
    this.#applyAutoFlip();
    this.#save();
    this.#emitChange();
    log('New game started');
    return this.getSnapshot();
  }

  /** Resume the saved game. Returns {ok, error}. */
  async continueGame() {
    const saved = storage.loadGame();
    if (!saved || saved.corrupt) {
      this.#toast('Saved game could not be restored', 'error');
      return { ok: false, error: saved?.error ?? 'No saved game' };
    }

    this.#expectReset();
    const restored = await this.#session.restoreGame(saved);
    if (!restored.ok) {
      storage.clearGame();
      this.#toast('Saved game was invalid and has been cleared', 'error');
      return restored;
    }

    this.#resetView();
    this.#started = true;
    this.#view.orientation = saved.orientation === 'black' ? 'black' : 'white';
    this.#applyAutoFlip();
    this.#emitChange();
    this.#toast('Game restored');
    return { ok: true };
  }

  isStarted() {
    return this.#started;
  }

  // -----------------------------------------------------------------------
  // Online rooms (Phase 2)
  //
  // These are thin: all the networking lives in the session provider. The
  // controller only needs to know that a room now exists.
  // -----------------------------------------------------------------------

  /** Host a new online room. Resolves with the room code to share. */
  async createRoom({ name, avatar = null } = {}) {
    this.#resetView();
    this.#expectReset();

    const result = await this.#session.createGame({
      white: { name, avatar },
      name,
      avatar,
    });
    if (!result?.ok) {
      const error = result?.error ?? 'Could not create a room';
      this.#toast(error, 'error');
      return { ok: false, error };
    }

    this.#started = true;
    this.#view.orientation = result.color === BLACK ? 'black' : 'white';
    this.#save();
    this.#emitChange();
    log('Hosting room', result.roomCode);
    return result;
  }

  /** Join someone else's room by code. */
  async joinRoom(code, { name, avatar = null } = {}) {
    this.#resetView();
    this.#expectReset();

    const result = await this.#session.joinRoom(code, { name, avatar });
    if (!result?.ok) {
      const error = result?.error ?? 'Could not join that room';
      this.#toast(error, 'error');
      return { ok: false, error };
    }

    this.#started = true;
    // Each device sees its own colour at the bottom of the board.
    this.#view.orientation = result.color === BLACK ? 'black' : 'white';
    this.#save();
    this.#emitChange();
    log('Joined room', result.roomCode);
    return result;
  }

  /** Rejoin a room this device was already part of, after a refresh. */
  async rejoinRoom(code) {
    this.#resetView();
    this.#expectReset();

    const result = await this.#session.rejoinRoom(code);
    if (!result?.ok) {
      const error = result?.error ?? 'Could not rejoin that room';
      this.#toast(error, 'error');
      return { ok: false, error };
    }

    this.#started = true;
    this.#view.orientation = result.color === BLACK ? 'black' : 'white';
    this.#save();
    this.#emitChange();
    this.#toast('Reconnected');
    return result;
  }

  /** Leave the current online room and drop back to local play. */
  async leaveRoom() {
    try {
      await this.#session.leave?.();
    } catch (error) {
      warn('leaveRoom failed', error);
    }
    storage.clearGame();
    this.#started = false;
    this.#resetView();
  }

  // -----------------------------------------------------------------------
  // Board interaction
  // -----------------------------------------------------------------------

  /**
   * The single entry point for tapping/clicking a square.
   *
   * Behaviour:
   *   - tapping your own piece selects it (or re-selects a different one)
   *   - tapping a highlighted destination plays that move
   *   - tapping the selected square again deselects
   *   - anything else clears the selection
   */
  async selectSquare(square) {
    if (!this.#state || !square) return;

    // Ignore board input entirely while a promotion is pending or a move is
    // mid-flight — this is what stops double-taps creating duplicate moves.
    if (this.#view.pendingPromotion || this.#processing) return;

    if (this.isGameOver()) {
      this.#toast('The game is over', 'warn');
      return;
    }

    const selected = this.#view.selected;

    if (selected === square) {
      this.#clearSelection();
      this.#emitChange();
      return;
    }

    // A tap on a highlighted destination is a move attempt.
    if (selected && this.#view.legalTargets.some((t) => t.to === square)) {
      await this.attemptMove(selected, square);
      return;
    }

    const piece = this.#session.getPiece(square);

    if (piece && this.#canControl(piece.color)) {
      if (piece.color !== this.#state.turn) {
        this.#toast(`It is ${this.#state.turn === WHITE ? 'White' : 'Black'}'s turn`, 'warn');
        this.#clearSelection();
        this.#emitChange();
        return;
      }
      this.#select(square);
      this.#emitChange();
      return;
    }

    // Illegal destination or an opponent piece — clear consistently.
    if (selected) {
      this.#view.lastRejected = square;
      this.#clearSelection();
      this.#emitChange();
    }
  }

  #select(square) {
    this.#view.selected = square;
    this.#view.legalTargets = this.#session.getLegalMoves(square);
    this.#view.lastRejected = null;
  }

  #clearSelection() {
    this.#view.selected = null;
    this.#view.legalTargets = [];
  }

  /** Can this device move pieces of the given colour? */
  #canControl(color) {
    return this.#session.getControllableColors().includes(color);
  }

  /**
   * Attempt a move. Promotions are intercepted here: rather than submitting a
   * move that chess.js would reject for a missing promotion piece, we pause
   * and ask the player which piece they want.
   */
  async attemptMove(from, to, promotion) {
    if (this.#processing) return { ok: false, error: 'Busy' };
    if (this.isGameOver()) return { ok: false, error: 'Game is over' };

    if (!promotion && this.#session.requiresPromotion(from, to)) {
      this.#view.pendingPromotion = { from, to };
      this.#emit(EVENT.PROMOTION, {
        from,
        to,
        color: this.#state.turn,
      });
      this.#emitChange();
      return { ok: false, pendingPromotion: true };
    }

    this.#processing = true;
    try {
      const result = await this.#session.submitMove({ from, to, promotion });

      if (!result.ok) {
        this.#clearSelection();
        this.#emitChange();
        // Online, a rejected move is worth explaining — it usually means the
        // opponent moved first or it was not our turn.
        if (this.isOnline() && result.error) this.#toast(result.error, 'warn');
        return result;
      }

      // Rendering, sound and autosave are driven by the state subscription,
      // so a move we made and a move the opponent made behave identically.
      return result;
    } catch (error) {
      // Defensive: the session should never throw, but a bug here must not
      // leave the board permanently locked.
      warn('Move submission threw', error);
      this.#toast('Move could not be played', 'error');
      return { ok: false, error: error.message };
    } finally {
      this.#processing = false;
    }
  }

  /** Complete a pending promotion with the chosen piece. */
  async completePromotion(piece) {
    const pending = this.#view.pendingPromotion;
    if (!pending) return { ok: false, error: 'No promotion pending' };

    const valid = ['q', 'r', 'b', 'n'];
    const choice = valid.includes(piece) ? piece : 'q';

    this.#view.pendingPromotion = null;
    return this.attemptMove(pending.from, pending.to, choice);
  }

  /** Abandon a pending promotion; the move is not played. */
  cancelPromotion() {
    if (!this.#view.pendingPromotion) return;
    this.#view.pendingPromotion = null;
    this.#clearSelection();
    this.#emitChange();
  }

  // -----------------------------------------------------------------------
  // Game actions
  //
  // These submit to the session and return. Rendering, sound, autosave and
  // the game-over modal are all driven by #syncFromSession, so an action
  // taken here and one taken by a remote opponent follow the same path.
  // -----------------------------------------------------------------------

  async undo() {
    if (this.#processing) return { ok: false };
    if (!this.#state?.canUndo) {
      this.#toast(
        this.isOnline() ? 'Undo is not available online' : 'Nothing to undo',
        'warn',
      );
      return { ok: false };
    }

    this.#processing = true;
    try {
      const result = await this.#session.submitAction(SESSION_ACTION.UNDO);
      if (result.ok) this.#toast('Move taken back');
      else if (result.error) this.#toast(result.error, 'warn');
      return result;
    } finally {
      this.#processing = false;
    }
  }

  async restart() {
    this.#expectReset();
    const result = await this.#session.submitAction(SESSION_ACTION.RESTART);
    if (result.ok) {
      this.#resetView();
      this.#applyAutoFlip();
      this.#save();
      this.#emitChange();
      this.#toast('Game restarted');
    } else if (result.error) {
      this.#toast(result.error, 'warn');
    }
    return result;
  }

  /**
   * Resign. Locally this is whoever is to move; online it is always the local
   * player, which the session determines from its own seat.
   */
  async resign(color = this.#state?.turn) {
    const result = await this.#session.submitAction(SESSION_ACTION.RESIGN, { color });
    if (!result.ok && result.error) this.#toast(result.error, 'warn');
    return result;
  }

  /**
   * Offer a draw.
   *
   * Locally both players share the device, so this raises a confirmation
   * aimed at the opponent. Online it writes a real offer that the opponent's
   * device picks up through its own subscription.
   */
  async offerDraw() {
    if (this.isGameOver()) return { ok: false };

    if (this.isOnline()) {
      if (typeof this.#session.offerDraw !== 'function') return { ok: false };
      const result = await this.#session.offerDraw();
      this.#toast(result.ok ? 'Draw offered' : result.error ?? 'Could not offer a draw',
        result.ok ? 'info' : 'warn');
      return result;
    }

    const from = this.#state.turn;
    this.#emit(EVENT.DRAW_OFFER, { from, to: this.#opponentOf(from), remote: false });
    return { ok: true };
  }

  async acceptDraw() {
    const result = await this.#session.submitAction(SESSION_ACTION.DRAW);
    if (!result.ok && result.error) this.#toast(result.error, 'warn');
    return result;
  }

  async declineDraw() {
    if (this.isOnline() && typeof this.#session.declineDraw === 'function') {
      await this.#session.declineDraw();
    }
    this.#toast('Draw declined');
  }

  /**
   * Start a rematch. Colours always swap.
   *
   * They used to swap only if a checkbox in the game-over dialog said so —
   * but that checkbox never reached an online game at all: the Firebase
   * session swaps seats unconditionally inside the transaction that resets
   * the room, because a swap has to be agreed by both devices and there is
   * nowhere for one player's preference to be honoured. So the option was
   * really "swap, unless this is a local game and you unticked this", which
   * is not a rule anyone would choose to write down. Now the loser of the
   * last game gets White everywhere, which is the convention it was defaulting
   * to anyway.
   *
   * Locally this is immediate. Online it registers a request; the board only
   * resets once both players have asked, which the session handles.
   */
  async rematch() {
    this.#expectReset();
    const result = await this.#session.submitAction(SESSION_ACTION.REMATCH);

    if (!result.ok) {
      if (result.error) this.#toast(result.error, 'warn');
      return result;
    }

    this.#resetView();
    this.#applyAutoFlip();

    if (this.isOnline()) {
      const rematch = this.#state?.online?.rematch;
      const bothAgreed = !rematch || (rematch[WHITE] && rematch[BLACK]);
      this.#toast(bothAgreed ? 'Rematch starting' : 'Rematch requested — waiting for opponent');
    } else {
      this.#save();
      this.#toast('Rematch — colors swapped');
    }

    this.#emitChange();
    return result;
  }

  // -----------------------------------------------------------------------
  // View state
  // -----------------------------------------------------------------------

  /** Flip the board. Purely a rendering change — game state is untouched. */
  flipBoard() {
    this.#view.orientation = this.#view.orientation === 'white' ? 'black' : 'white';
    this.#save();
    this.#emitChange();
    this.#toast(`Board flipped — ${this.#view.orientation === 'white' ? 'White' : 'Black'} at bottom`);
    return this.#view.orientation;
  }

  /** When Auto Flip is on, keep the side to move at the bottom. */
  #applyAutoFlip() {
    if (!this.#settings.autoFlip || !this.#state) return;
    this.#view.orientation = this.#state.turn === WHITE ? 'white' : 'black';
  }

  #resetView() {
    this.#view.selected = null;
    this.#view.legalTargets = [];
    this.#view.pendingPromotion = null;
    this.#view.lastRejected = null;
  }

  getOrientation() {
    return this.#view.orientation;
  }

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------

  getSettings() {
    return { ...this.#settings };
  }

  updateSettings(patch) {
    this.#settings = { ...this.#settings, ...patch };
    sound.setEnabled(this.#settings.sound);
    storage.saveSettings(this.#settings);

    if (Object.prototype.hasOwnProperty.call(patch, 'autoFlip')) {
      this.#applyAutoFlip();
    }

    this.#emitChange();
    return this.getSettings();
  }

  // -----------------------------------------------------------------------
  // Profile pictures
  // -----------------------------------------------------------------------

  /** Remembered pictures, by form slot. Always every slot, valid or null. */
  getAvatars() {
    return { ...this.#avatars };
  }

  /**
   * Remember, or forget, the picture for one seat on the New Game form.
   *
   * Deliberately does NOT emit a change: this touches no game state, and the
   * picture on a player card comes from the session's player record rather
   * than from here. Changing your picture mid-game therefore does nothing to
   * the game in progress, which is the honest behaviour — the seat was taken
   * with the picture it had.
   *
   * Returns whether it was actually written. A failure here is almost always
   * a full quota, and it is worth saying so: the picture still works for the
   * game about to be started, it just will not be offered back next time.
   */
  setAvatar(slot, avatar) {
    if (!AVATAR_SLOTS.includes(slot)) return false;
    this.#avatars[slot] = isAvatar(avatar) ? avatar : null;
    const saved = storage.saveAvatars(this.#avatars);
    if (!saved && this.#avatars[slot]) {
      this.#toast('Picture set, but could not be saved for next time', 'warn');
    }
    return saved;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Autosave the current game. Called after every meaningful action.
   *
   * Online games persist only the room code and seat: the room itself is the
   * source of truth, so resuming means rejoining rather than replaying a
   * local copy. The position is stored too, but purely so the menu can show a
   * useful summary before reconnecting.
   */
  #save() {
    if (!this.#state || !this.#started) return;

    storage.saveGame({
      status: this.#state.status,
      mode: this.#state.mode,
      fen: this.#state.fen,
      pgn: this.#state.pgn,
      moves: this.#state.moves,
      lastMove: this.#state.lastMove,
      players: this.#state.players,
      result: this.#state.result,
      startFen: this.#state.startFen,
      orientation: this.#view.orientation,
      roomCode: this.#state.online?.roomCode ?? null,
      myColor: this.#state.online?.myColor ?? null,
      savedAt: Date.now(),
    });
  }

  getPgn() {
    return this.#state?.pgn ?? '';
  }

  getFen() {
    return this.#state?.fen ?? '';
  }

  isGameOver() {
    return Boolean(this.#state?.isGameOver);
  }

  /** Everything a view needs to render, in one object. */
  getSnapshot() {
    return {
      state: this.#state,
      view: { ...this.#view },
      settings: this.getSettings(),
      orientation: this.#view.orientation,
      isProcessing: this.#processing,
    };
  }

  // -----------------------------------------------------------------------
  // Developer tools (DEBUG only)
  // -----------------------------------------------------------------------

  /**
   * Load an arbitrary position, for testing a specific scenario.
   *
   * There is no longer any UI for this — reach it from the console via
   * `chessArena.controller.loadFen(fen)`, which exists only while DEBUG is on.
   * The automated suites use the same entry point.
   */
  async loadFen(fen) {
    if (typeof this.#session.loadFenForTesting !== 'function') {
      return { ok: false, error: 'Not supported by this session' };
    }
    this.#expectReset();
    const result = await this.#session.loadFenForTesting(fen);
    if (result.ok) {
      this.#resetView();
      this.#started = true;
      this.#save();
      this.#emitChange();
      this.#toast('Position loaded');
    } else {
      this.#toast(`Invalid FEN: ${result.error}`, 'error');
    }
    return result;
  }
}

export default GameController;
