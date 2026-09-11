/**
 * sessions/firebase-session.js
 * Phase 2 session provider: two players, two devices, one Firebase room.
 *
 * Implements exactly the same contract as LocalSession (documented in
 * local-session.js), so the controller, board and UI drive it identically.
 * Everything network-specific is contained here.
 *
 * ---------------------------------------------------------------------------
 * AUTHORITY MODEL
 * ---------------------------------------------------------------------------
 * There is no server-side chess engine, so the model is:
 *
 *   - Each client validates its own move with chess.js before writing.
 *   - Every write is a transaction guarded on the position it was based on, so
 *     two clients can never interleave and lose a move.
 *   - Security rules enforce *identity and turn ownership*: only the player
 *     whose turn it is may advance the game, and only into the opposite turn.
 *   - On every remote update the local engine is rebuilt from the room's PGN,
 *     so the room is the single source of truth and clients cannot drift.
 *
 * Rules cannot verify chess legality (they cannot run a chess engine), so a
 * determined player using a modified client could write an illegal position.
 * They cannot forge the *other* player's moves, replay an old position, or
 * move out of turn. See README "Trust model" for the honest boundaries and how
 * Cloud Functions would close the remaining gap.
 * ---------------------------------------------------------------------------
 */

import { ChessEngine, DRAW_REASON, DRAW_REASON_LABEL } from '../chess-engine.js';
import {
  WHITE,
  BLACK,
  STATUS,
  TERMINAL_STATUSES,
  GAME_MODE,
  DEFAULT_PLAYER_NAMES,
  log,
  warn,
} from '../config.js';
import { isAvatar } from '../avatar.js';
import {
  FIREBASE_MODULES,
  EMULATOR,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isFirebaseConfigured,
  firebaseConfigError,
  isEmulatorMode,
  emulatorHost,
  emulatorAuthUrl,
  resolveFirebaseConfig,
} from '../firebase-config.js';
import { END_REASON, SESSION_ACTION } from './local-session.js';

/** Connection states surfaced to the UI. */
export const CONNECTION = {
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  ONLINE: 'online',
};

const colorName = (color) => (color === WHITE ? 'White' : 'Black');
const other = (color) => (color === WHITE ? BLACK : WHITE);

/**
 * Turn Firebase's error codes into something a person can act on.
 *
 * A freshly created project fails in the same handful of ways, and the raw
 * SDK messages ("PERMISSION_DENIED", "auth/operation-not-allowed") do not say
 * which setup step was missed. Each of these maps to one concrete fix.
 */
export function explainFirebaseError(error) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? error ?? '');

  if (code === 'auth/operation-not-allowed' || /operation-not-allowed/i.test(message)) {
    return 'Anonymous sign-in is not enabled. Firebase console → Build → Authentication → Sign-in method → Anonymous → Enable.';
  }
  if (code === 'auth/api-key-not-valid' || /api-key-not-valid|invalid.*api key/i.test(message)) {
    return 'That apiKey is not valid. Re-copy it from Project settings → Your apps → Web app.';
  }
  if (code === 'auth/configuration-not-found') {
    return 'Authentication is not set up for this project yet. Enable Anonymous sign-in in the Firebase console.';
  }
  // The SDK reports this as "PERMISSION_DENIED" in some paths and
  // "Permission denied" in others, so match both spellings.
  if (/permission[\s_]denied/i.test(message) || code === 'PERMISSION_DENIED') {
    return 'The database rejected that. Deploy the security rules: firebase deploy --only database';
  }
  if (/Cannot parse Firebase url|FIREBASE FATAL ERROR|Can't determine Firebase Database URL/i.test(message)) {
    return 'databaseURL is missing or malformed. Copy it exactly from Realtime Database in the console — regional databases do not end in firebaseio.com.';
  }
  if (/network|offline|Failed to fetch/i.test(message)) {
    return 'Could not reach Firebase. Check the network connection.';
  }
  return message || 'Unknown Firebase error';
}

/** Cryptographically-random room code from an unambiguous alphabet. */
function generateRoomCode() {
  const bytes = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise user-typed codes: uppercase, strip anything not in the alphabet. */
export function normalizeRoomCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
}

/**
 * One player's entry in a room.
 *
 * The picture is omitted rather than written as null when there is not one.
 * Realtime Database treats a null child as a deletion instruction, which is
 * the right outcome but a confusing thing to read in a transaction that is
 * building a record from scratch — and the rules validate `avatar` only when
 * it is present, so an absent key is the shape they are written for.
 */
function seatRecord(uid, name, avatar) {
  const seat = { uid, name, connected: true };
  if (isAvatar(avatar)) seat.avatar = avatar;
  return seat;
}

export class FirebaseSession {
  // --- Firebase handles, resolved lazily in initialize() ---
  #sdk = null;
  #app = null;
  #auth = null;
  #db = null;
  #uid = null;

  // --- Room state ---
  #roomCode = null;
  #roomRef = null;
  #room = null; // last raw snapshot from the database
  #myColor = null;
  #presenceColor = null; // seat our onDisconnect handler is bound to
  #waitingWatchdog = null; // periodic re-read while waiting for an opponent

  // --- Local mirror ---
  #engine = new ChessEngine();
  #listeners = new Set();
  #connection = CONNECTION.OFFLINE;
  #destroyed = false;

  // --- Subscriptions to detach on leave ---
  #detachers = [];

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Load the Firebase SDK from the CDN, start the app and sign in anonymously.
   * The SDK is imported lazily so that local play never touches the network.
   */
  async initialize() {
    if (this.#sdk) return this;

    if (!isFirebaseConfigured()) {
      throw new Error(firebaseConfigError());
    }

    this.#connection = CONNECTION.CONNECTING;

    const [appMod, authMod, dbMod] = await Promise.all([
      import(/* @vite-ignore */ FIREBASE_MODULES.app),
      import(/* @vite-ignore */ FIREBASE_MODULES.auth),
      import(/* @vite-ignore */ FIREBASE_MODULES.database),
    ]);

    this.#sdk = { ...appMod, ...authMod, ...dbMod };

    this.#app = this.#sdk.initializeApp(resolveFirebaseConfig());
    this.#auth = this.#sdk.getAuth(this.#app);
    this.#db = this.#sdk.getDatabase(this.#app);

    if (isEmulatorMode()) {
      // Host is resolved from the page's own address so that a phone on the
      // LAN reaches the computer running the emulator, not itself.
      const host = emulatorHost();
      this.#sdk.connectDatabaseEmulator(this.#db, host, EMULATOR.databasePort);
      this.#sdk.connectAuthEmulator(this.#auth, emulatorAuthUrl(), { disableWarnings: true });
      log('Firebase emulator mode via', host);
    }

    try {
      const credential = await this.#sdk.signInAnonymously(this.#auth);
      this.#uid = credential.user.uid;
    } catch (error) {
      // Surface the setup step that was missed, not the raw SDK code.
      warn('Anonymous sign-in failed', error);
      throw new Error(explainFirebaseError(error));
    }

    this.#watchConnection();

    log('FirebaseSession ready, uid', this.#uid);
    return this;
  }

  /** Track Firebase's own connection state so the UI can show it. */
  #watchConnection() {
    const { ref, onValue } = this.#sdk;
    const infoRef = ref(this.#db, '.info/connected');
    const stop = onValue(infoRef, (snap) => {
      const connected = snap.val() === true;
      this.#connection = connected ? CONNECTION.ONLINE : CONNECTION.CONNECTING;
      if (connected && this.#roomCode && this.#myColor) {
        // Re-arm presence after a dropped connection.
        this.#registerPresence().catch((error) => warn('presence re-arm failed', error));
      }
      this.#publish();
    });
    this.#detachers.push(stop);
  }

  getUid() {
    return this.#uid;
  }

  getRoomCode() {
    return this.#roomCode;
  }

  getMyColor() {
    return this.#myColor;
  }

  // -----------------------------------------------------------------------
  // Room creation and joining
  // -----------------------------------------------------------------------

  /**
   * Create a room and wait for an opponent.
   * Matches the LocalSession contract: config carries the local player's name.
   * The creator takes White by default.
   */
  async createGame(config = {}) {
    const { ref, runTransaction, serverTimestamp } = this.#sdk;
    const name = config.white?.name?.trim() || config.name?.trim() || DEFAULT_PLAYER_NAMES.white;
    const avatar = config.white?.avatar ?? config.avatar;
    const hostColor = config.hostColor === BLACK ? BLACK : WHITE;

    this.#engine = new ChessEngine();

    const initialRoom = {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      hostUid: this.#uid,
      status: STATUS.SETUP,
      fen: this.#engine.getFen(),
      pgn: '',
      turn: WHITE,
      moves: [],
      lastMove: null,
      result: null,
      startFen: null,
      drawOffer: null,
      rematch: null,
      players: {
        [hostColor]: seatRecord(this.#uid, name, avatar),
      },
    };

    // Retry on the (vanishingly unlikely) chance of a code collision.
    let code = null;
    for (let attempt = 0; attempt < 8 && !code; attempt += 1) {
      const candidate = generateRoomCode();
      const candidateRef = ref(this.#db, `rooms/${candidate}`);
      try {
        // Returning undefined from the callback aborts the transaction, so an
        // already-taken code is never overwritten.
        const outcome = await runTransaction(candidateRef, (current) =>
          current === null ? initialRoom : undefined,
        );
        if (outcome.committed) code = candidate;
      } catch (error) {
        // A rules or connectivity problem will fail every attempt, so report
        // it immediately instead of retrying eight times.
        warn('Room creation failed', error);
        return { ok: false, error: explainFirebaseError(error) };
      }
    }

    if (!code) return { ok: false, error: 'Could not allocate a room code' };

    this.#roomCode = code;
    this.#myColor = hostColor;
    this.#roomRef = ref(this.#db, `rooms/${code}`);

    await this.#registerPresence();
    await this.#subscribeToRoom();
    this.#startWaitingWatchdog();

    log('Room created', code);
    return { ok: true, roomCode: code, color: hostColor };
  }

  /** Join an existing room as the free colour. */
  async joinRoom(rawCode, { name, avatar } = {}) {
    const { ref, get, runTransaction, serverTimestamp } = this.#sdk;
    const code = normalizeRoomCode(rawCode);

    if (code.length !== ROOM_CODE_LENGTH) {
      return { ok: false, error: `Room codes are ${ROOM_CODE_LENGTH} characters` };
    }

    const roomRef = ref(this.#db, `rooms/${code}`);
    const playerName = name?.trim() || DEFAULT_PLAYER_NAMES.black;

    /*
      Two things have to happen before the join transaction can work.

      1. A plain read, so "no such room" is reported accurately and quickly.
      2. An ACTIVE listener on the room.

      runTransaction invokes its callback optimistically against the client's
      sync cache, and when that cache is cold the first invocation receives
      null — which our callback treats as "no room" and aborts. A one-off
      get() does not populate that cache; only a live listener does. So the
      room subscription is attached first and awaited, which both warms the
      cache and is needed for the rest of the game anyway.
    */
    let existing;
    try {
      existing = await get(roomRef);
    } catch (error) {
      warn('Could not read room', error);
      return { ok: false, error: explainFirebaseError(error) };
    }
    if (!existing.exists()) {
      return { ok: false, error: 'No room with that code' };
    }

    // Fail fast on a full room before touching anything.
    const preflight = existing.val().players ?? {};
    const alreadySeated = [WHITE, BLACK].some((c) => preflight[c]?.uid === this.#uid);
    if (!alreadySeated && preflight[WHITE]?.uid && preflight[BLACK]?.uid) {
      return { ok: false, error: 'That room is already full' };
    }

    this.#roomRef = roomRef;
    await this.#subscribeToRoom();

    let failure = null;
    let joinedColor = null;

    const outcome = await runTransaction(roomRef, (room) => {
      if (room === null) {
        failure = 'No room with that code';
        return undefined;
      }

      const players = room.players ?? {};

      // Rejoining a room we are already part of is always allowed.
      const existing = [WHITE, BLACK].find((c) => players[c]?.uid === this.#uid);
      if (existing) {
        joinedColor = existing;
        players[existing].connected = true;
        return { ...room, players, updatedAt: serverTimestamp() };
      }

      const free = [WHITE, BLACK].find((c) => !players[c]?.uid);
      if (!free) {
        failure = 'That room is already full';
        return undefined;
      }

      joinedColor = free;
      return {
        ...room,
        players: {
          ...players,
          [free]: seatRecord(this.#uid, playerName, avatar),
        },
        status: STATUS.PLAYING,
        updatedAt: serverTimestamp(),
      };
    });

    if (!outcome.committed) {
      this.#detachAll();
      this.#roomRef = null;
      return { ok: false, error: failure ?? 'Could not join that room' };
    }

    this.#roomCode = code;
    this.#myColor = joinedColor;

    await this.#registerPresence();
    this.#publish();

    log('Joined room', code, 'as', joinedColor);
    return { ok: true, roomCode: code, color: joinedColor };
  }

  /**
   * Reconnect to a room this device was already part of — used after a page
   * refresh. Fails cleanly if the room is gone or we were never in it.
   */
  async rejoinRoom(rawCode) {
    const code = normalizeRoomCode(rawCode);
    const { ref, get } = this.#sdk;
    const snapshot = await get(ref(this.#db, `rooms/${code}`));

    if (!snapshot.exists()) return { ok: false, error: 'That room no longer exists' };

    const room = snapshot.val();
    const mine = [WHITE, BLACK].find((c) => room.players?.[c]?.uid === this.#uid);
    if (!mine) return { ok: false, error: 'You are not a player in that room' };

    this.#roomCode = code;
    this.#myColor = mine;
    this.#roomRef = ref(this.#db, `rooms/${code}`);

    await this.#registerPresence();
    await this.#subscribeToRoom();
    if (!this.#bothSeated()) this.#startWaitingWatchdog();

    log('Rejoined room', code, 'as', mine);
    return { ok: true, roomCode: code, color: mine };
  }

  /**
   * Mark this player present, and arrange for Firebase to mark them absent if
   * the connection drops. onDisconnect is registered server-side, so it fires
   * even if the tab is closed or the device loses power.
   *
   * The registration is bound to a specific seat, so a rematch that swaps
   * seats must cancel the old one — otherwise disconnecting would mark the
   * *opponent* as away.
   */
  async #registerPresence() {
    const { ref, set, onDisconnect } = this.#sdk;
    if (!this.#roomCode || !this.#myColor) return;

    if (this.#presenceColor && this.#presenceColor !== this.#myColor) {
      try {
        const staleRef = ref(
          this.#db,
          `rooms/${this.#roomCode}/players/${this.#presenceColor}/connected`,
        );
        await onDisconnect(staleRef).cancel();
      } catch (error) {
        warn('Could not cancel stale presence handler', error);
      }
    }

    const connectedRef = ref(
      this.#db,
      `rooms/${this.#roomCode}/players/${this.#myColor}/connected`,
    );
    await onDisconnect(connectedRef).set(false);
    await set(connectedRef, true);
    this.#presenceColor = this.#myColor;
  }

  /**
   * Listen for every change to the room. This drives the UI, and keeps the
   * client's sync cache warm so transactions see real data on their first
   * attempt. Resolves once the first snapshot has arrived.
   */
  #subscribeToRoom() {
    return new Promise((resolve) => {
      const { onValue } = this.#sdk;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const stop = onValue(
        this.#roomRef,
        (snapshot) => {
          if (this.#destroyed) return settle();
          const room = snapshot.val();
          if (!room) {
            warn('Room disappeared');
            return settle();
          }
          this.#applyRemote(room);
          settle();
        },
        (error) => {
          warn('Room subscription error', error);
          this.#connection = CONNECTION.OFFLINE;
          this.#publish();
          settle();
        },
      );
      this.#detachers.push(stop);
    });
  }

  /**
   * Adopt the room's state as our own.
   * The engine is rebuilt from the room's PGN rather than trusting our local
   * copy, which makes the room the single source of truth and means a client
   * can never silently drift out of sync.
   */
  /**
   * Safety net for the host sitting on the waiting screen.
   *
   * Normally the room subscription delivers the opponent's arrival instantly.
   * But that is the one moment where being stranded is unrecoverable by the
   * player — there is nothing to tap and no way to know whether the code even
   * worked. A dropped socket, a backgrounded tab, or a client running stale
   * cached code can all leave the listener silent. Re-reading every few
   * seconds while waiting costs almost nothing and turns a dead end into a
   * few seconds' delay. It stops the moment both seats are filled.
   */
  #startWaitingWatchdog() {
    this.#stopWaitingWatchdog();
    if (!this.#roomRef) return;

    this.#waitingWatchdog = window.setInterval(async () => {
      if (this.#destroyed || !this.#roomRef || this.#bothSeated()) {
        this.#stopWaitingWatchdog();
        return;
      }
      try {
        const snapshot = await this.#sdk.get(this.#roomRef);
        const room = snapshot.val();
        log('waiting watchdog re-read', this.#roomCode);
        if (room) this.#applyRemote(room);
      } catch (error) {
        warn('waiting watchdog read failed', error);
      }
    }, 4000);
  }

  #stopWaitingWatchdog() {
    if (this.#waitingWatchdog === null) return;
    window.clearInterval(this.#waitingWatchdog);
    this.#waitingWatchdog = null;
  }

  #applyRemote(room) {
    this.#room = room;

    /*
      Our seat is read from the room, never remembered locally.

      A rematch swaps the two players, and that swap is written by whichever
      device asked second. Without re-deriving here, the *other* device would
      keep its old colour, believe it was still its turn, and have every move
      rejected. Treating the room as authoritative for identity as well as
      position keeps both devices correct.
    */
    const seated = [WHITE, BLACK].find((c) => room.players?.[c]?.uid === this.#uid);
    if (seated && seated !== this.#myColor) {
      log('Seat changed', this.#myColor, '->', seated);
      this.#myColor = seated;
      // Move our disconnect handler to the new seat.
      this.#registerPresence().catch((error) => warn('presence move failed', error));
    }

    // Both seats filled — the watchdog has nothing left to watch for.
    if (this.#bothSeated()) this.#stopWaitingWatchdog();

    const pgn = room.pgn ?? '';
    const targetFen = room.fen;

    if (this.#engine.getFen() !== targetFen) {
      let rebuilt = false;
      if (pgn.trim()) {
        const replay = this.#engine.loadPgn(pgn);
        rebuilt = replay.ok && this.#engine.getFen() === targetFen;
      }
      if (!rebuilt && targetFen) {
        // Fall back to the raw position. History (and therefore undo) is lost,
        // but the board stays correct — which matters more.
        const loaded = this.#engine.loadFen(targetFen);
        if (!loaded.ok) warn('Could not apply remote position', loaded.error);
      }
    }

    this.#publish();
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  subscribeToState(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
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
  // Moves
  // -----------------------------------------------------------------------

  /** Online, this device controls exactly one colour — and only once both seats are filled. */
  getControllableColors() {
    if (!this.#myColor || !this.#bothSeated()) return [];
    return [this.#myColor];
  }

  #bothSeated() {
    const players = this.#room?.players ?? {};
    return Boolean(players[WHITE]?.uid && players[BLACK]?.uid);
  }

  /**
   * Play a move.
   *
   * Validated locally first (so an illegal tap never reaches the network),
   * then written in a transaction guarded on the position we based it on. If
   * the opponent's move landed first, the transaction aborts and nothing is
   * lost — the incoming update simply re-renders the board.
   */
  async submitMove({ from, to, promotion } = {}) {
    if (this.#destroyed) return { ok: false, error: 'Session destroyed' };
    if (!this.#roomCode) return { ok: false, error: 'Not in a room' };
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };
    if (!this.#bothSeated()) return { ok: false, error: 'Waiting for an opponent' };
    if (this.#engine.getTurn() !== this.#myColor) {
      return { ok: false, error: 'Not your turn' };
    }

    const baseFen = this.#engine.getFen();
    const applied = this.#engine.makeMove(from, to, promotion);
    if (!applied.ok) return { ok: false, error: applied.error };

    const next = this.#describeAfterMove();

    const { runTransaction, serverTimestamp } = this.#sdk;
    let aborted = null;

    const outcome = await runTransaction(this.#roomRef, (room) => {
      if (room === null) {
        aborted = 'Room no longer exists';
        return undefined;
      }
      // Guard: only advance from the exact position this move was made on.
      if (room.fen !== baseFen) {
        aborted = 'Position changed';
        return undefined;
      }
      if (room.players?.[this.#myColor]?.uid !== this.#uid) {
        aborted = 'You are not that player';
        return undefined;
      }
      return {
        ...room,
        ...next,
        // A move always cancels any outstanding draw offer.
        drawOffer: null,
        updatedAt: serverTimestamp(),
      };
    });

    if (!outcome.committed) {
      // Roll the local engine back; the room's own update will re-render.
      this.#engine.undo();
      this.#publish();
      return { ok: false, error: aborted ?? 'Move rejected' };
    }

    return { ok: true, move: applied.move, state: this.getState() };
  }

  /** Build the room fields that describe the position after a move. */
  #describeAfterMove() {
    const engine = this.#engine;
    const lastMove = engine.getLastMove();
    const { status, result } = this.#deriveOutcome();

    return {
      fen: engine.getFen(),
      pgn: engine.getPgn(),
      turn: engine.getTurn(),
      moves: engine.getHistory(),
      lastMove: lastMove ? { from: lastMove.from, to: lastMove.to } : null,
      status,
      result,
    };
  }

  /** Rule-driven status and result for the current position. */
  #deriveOutcome() {
    const engine = this.#engine;

    if (engine.isCheckmate()) {
      const winner = engine.getOpponent();
      return {
        status: STATUS.CHECKMATE,
        result: {
          winner,
          reason: END_REASON.CHECKMATE,
          label: `${colorName(winner)} Wins`,
          detail: 'Checkmate',
        },
      };
    }

    const drawReason = engine.getDrawReason();
    if (drawReason) {
      return {
        status: STATUS.DRAW,
        result: {
          winner: null,
          reason: drawReason,
          label: 'Draw',
          detail: DRAW_REASON_LABEL[drawReason],
        },
      };
    }

    return {
      status: engine.isCheck() ? STATUS.CHECK : STATUS.PLAYING,
      result: null,
    };
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async submitAction(action, payload = {}) {
    if (this.#destroyed) return { ok: false, error: 'Session destroyed' };
    if (!this.#roomCode) return { ok: false, error: 'Not in a room' };

    switch (action) {
      case SESSION_ACTION.RESIGN:
        return this.#resign();
      case SESSION_ACTION.DRAW:
        return this.#respondToDraw(true);
      case SESSION_ACTION.REMATCH:
        return this.#requestRematch();
      case SESSION_ACTION.UNDO:
        // Deliberately unsupported online: a unilateral take-back would let a
        // player rewind the opponent's position. Offered as a request in a
        // future revision.
        return { ok: false, error: 'Undo is not available in online games' };
      case SESSION_ACTION.RESTART:
        return { ok: false, error: 'Use Rematch in online games' };
      default:
        warn('Unknown session action', action);
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  #resign() {
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };
    const winner = other(this.#myColor);
    return this.#updateRoom({
      status: STATUS.RESIGNED,
      result: {
        winner,
        reason: END_REASON.RESIGNATION,
        label: `${colorName(winner)} Wins`,
        detail: `${colorName(this.#myColor)} resigned`,
      },
      drawOffer: null,
    });
  }

  /** Send a draw offer to the opponent. */
  async offerDraw() {
    if (this.#isTerminal()) return { ok: false, error: 'Game is over' };
    if (this.#room?.drawOffer?.from === this.#myColor) {
      return { ok: false, error: 'You already offered a draw' };
    }
    return this.#updateRoom({ drawOffer: { from: this.#myColor } });
  }

  /** Accept or decline the opponent's outstanding draw offer. */
  async #respondToDraw(accept) {
    const offer = this.#room?.drawOffer;
    if (!offer) return { ok: false, error: 'No draw has been offered' };

    if (!accept) return this.#updateRoom({ drawOffer: null });

    return this.#updateRoom({
      status: STATUS.DRAW,
      result: {
        winner: null,
        reason: END_REASON.DRAW_AGREEMENT,
        label: 'Draw',
        detail: DRAW_REASON_LABEL[DRAW_REASON.AGREEMENT],
      },
      drawOffer: null,
    });
  }

  async declineDraw() {
    return this.#respondToDraw(false);
  }

  /**
   * Ask for a rematch. When both players have asked, the position resets and
   * colours swap — so the same player does not always have White.
   */
  async #requestRematch() {
    const { runTransaction, serverTimestamp } = this.#sdk;
    const myColor = this.#myColor;
    const uid = this.#uid;

    const outcome = await runTransaction(this.#roomRef, (room) => {
      if (room === null) return undefined;

      const rematch = { ...(room.rematch ?? {}), [myColor]: true };
      const bothAgreed = rematch[WHITE] && rematch[BLACK];

      if (!bothAgreed) {
        return { ...room, rematch, updatedAt: serverTimestamp() };
      }

      // Both agreed — reset the board and swap seats.
      const players = room.players ?? {};
      const fresh = new ChessEngine();
      return {
        ...room,
        players: {
          [WHITE]: players[BLACK] ?? null,
          [BLACK]: players[WHITE] ?? null,
        },
        fen: fresh.getFen(),
        pgn: '',
        turn: WHITE,
        moves: [],
        lastMove: null,
        result: null,
        status: STATUS.PLAYING,
        drawOffer: null,
        rematch: null,
        updatedAt: serverTimestamp(),
      };
    });

    if (!outcome.committed) return { ok: false, error: 'Rematch request failed' };

    // Seats may have just swapped; #applyRemote re-derives ours from the room
    // when the resulting snapshot arrives, so nothing to do here.
    return { ok: true, state: this.getState() };
  }

  /** Merge fields into the room, guarded so a stale client cannot clobber it. */
  async #updateRoom(fields) {
    const { runTransaction, serverTimestamp } = this.#sdk;
    const outcome = await runTransaction(this.#roomRef, (room) => {
      if (room === null) return undefined;
      return { ...room, ...fields, updatedAt: serverTimestamp() };
    });
    return outcome.committed
      ? { ok: true, state: this.getState() }
      : { ok: false, error: 'Update rejected' };
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /** Leave the room: mark ourselves away but leave the room intact to rejoin. */
  async leave() {
    this.#stopWaitingWatchdog();
    try {
      if (this.#roomCode && this.#myColor && this.#sdk) {
        const { ref, set } = this.#sdk;
        await set(
          ref(this.#db, `rooms/${this.#roomCode}/players/${this.#myColor}/connected`),
          false,
        );
      }
    } catch (error) {
      warn('leave() failed', error);
    }
    this.#detachAll();
    this.#listeners.clear();
    this.#roomCode = null;
    this.#roomRef = null;
    this.#room = null;
    this.#myColor = null;
  }

  destroy() {
    this.#destroyed = true;
    this.#stopWaitingWatchdog();
    this.#detachAll();
    this.#listeners.clear();
  }

  #detachAll() {
    this.#detachers.forEach((stop) => {
      try {
        stop();
      } catch (error) {
        warn('detach failed', error);
      }
    });
    this.#detachers = [];
  }

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  #isTerminal() {
    return TERMINAL_STATUSES.includes(this.#room?.status);
  }

  /**
   * The same snapshot shape LocalSession produces, plus an `online` block the
   * UI uses to render room code, opponent presence and connection state.
   * Local games leave `online` null, so one render path serves both.
   */
  getState() {
    const engine = this.#engine;
    const room = this.#room;
    const turn = engine.getTurn();
    const isCheck = engine.isCheck();

    const players = room?.players ?? {};
    const status = room?.status ?? STATUS.SETUP;
    const opponentColor = this.#myColor ? other(this.#myColor) : null;
    const waiting = Boolean(this.#roomCode) && !this.#bothSeated();

    return {
      mode: GAME_MODE.ONLINE,
      status,
      fen: engine.getFen(),
      pgn: engine.getPgn(),
      turn,
      moves: room?.moves ?? engine.getHistory(),
      verboseMoves: engine.getVerboseHistory(),
      lastMove: engine.getLastMove(),
      // The opponent's picture arrives over the network, so it is validated
      // here rather than anywhere downstream. The security rules cap its size
      // and shape too, but rules protect the ROOM; this is what protects this
      // device from whatever a modified client felt like writing.
      players: {
        [WHITE]: {
          name: players[WHITE]?.name ?? 'Waiting…',
          avatar: isAvatar(players[WHITE]?.avatar) ? players[WHITE].avatar : null,
        },
        [BLACK]: {
          name: players[BLACK]?.name ?? 'Waiting…',
          avatar: isAvatar(players[BLACK]?.avatar) ? players[BLACK].avatar : null,
        },
      },
      result: room?.result ?? null,
      isCheck,
      checkSquare: isCheck ? engine.getKingSquare(turn) : null,
      // Undo is intentionally unavailable online.
      canUndo: false,
      moveNumber: engine.moveNumber(),
      startFen: room?.startFen ?? null,
      isGameOver: this.#isTerminal(),

      online: {
        roomCode: this.#roomCode,
        myColor: this.#myColor,
        opponentColor,
        opponentName: opponentColor ? players[opponentColor]?.name ?? null : null,
        opponentConnected: opponentColor
          ? players[opponentColor]?.connected === true
          : false,
        connection: this.#connection,
        waitingForOpponent: waiting,
        isMyTurn: this.#myColor === turn && !waiting && !this.#isTerminal(),
        drawOfferFrom: room?.drawOffer?.from ?? null,
        rematch: room?.rematch ?? null,
        uid: this.#uid,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Read-only helpers the controller uses (same names as LocalSession)
  // -----------------------------------------------------------------------

  getLegalMoves(square) {
    return this.#engine.getLegalMoves(square);
  }

  requiresPromotion(from, to) {
    return this.#engine.requiresPromotion(from, to);
  }

  getPiece(square) {
    return this.#engine.getPiece(square);
  }

  /**
   * Restoring an online game means rejoining its room, not replaying a local
   * save — the room is authoritative.
   */
  async restoreGame(saved) {
    if (!saved?.roomCode) return { ok: false, error: 'No room to rejoin' };
    return this.rejoinRoom(saved.roomCode);
  }
}

export default FirebaseSession;
