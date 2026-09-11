/**
 * storage.js
 * Versioned, validated persistence on top of localStorage.
 *
 * Everything here is defensive: localStorage can be unavailable (private
 * browsing, disabled cookies), full, or hold data written by an older version
 * of the app. No read path is allowed to throw, and anything that fails
 * validation is discarded rather than half-trusted.
 */

import {
  STORAGE_KEYS,
  STORAGE_VERSION,
  DEFAULT_SETTINGS,
  AVATAR_SLOTS,
  BOARD_THEMES,
  resolveUiStyle,
  clampBoardZoom,
  STATUS,
  TERMINAL_STATUSES,
  GAME_MODE,
  log,
  warn,
} from './config.js';
import { isAvatar } from './avatar.js';
import { ChessEngine } from './chess-engine.js';

/** Probe localStorage once; if it is unusable the app still runs, just without saves. */
function detectStorage() {
  try {
    const probe = '__chess_arena_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (error) {
    warn('localStorage unavailable — saves disabled', error);
    return null;
  }
}

const store = detectStorage();

export const isAvailable = () => store !== null;

/**
 * Read and parse a key.
 * Distinguishes "absent" from "present but unparseable" so callers can clear
 * corrupt data rather than silently leaving it behind.
 */
function readJson(key) {
  if (!store) return { found: false, value: null };
  let raw;
  try {
    raw = store.getItem(key);
  } catch (error) {
    warn('Failed to read', key, error);
    return { found: false, value: null };
  }
  if (!raw) return { found: false, value: null };

  try {
    return { found: true, value: JSON.parse(raw) };
  } catch (error) {
    warn('Corrupt JSON at', key, error);
    return { found: true, value: null, corrupt: true };
  }
}

function writeJson(key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // Most likely QuotaExceededError. Failing to save must never break play.
    warn('Failed to write', key, error);
    return false;
  }
}

function removeKey(key) {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch (error) {
    warn('Failed to remove', key, error);
  }
}

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------

const VALID_THEME_IDS = BOARD_THEMES.map((t) => t.id);

/**
 * Load settings, merged over defaults so a partial or older record still
 * yields a complete, valid settings object.
 */
export function loadSettings() {
  const { value: raw } = readJson(STORAGE_KEYS.SETTINGS);
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS, uiStyle: resolveUiStyle(DEFAULT_SETTINGS.uiStyle) };
  }

  const source = raw.settings && typeof raw.settings === 'object' ? raw.settings : raw;
  const merged = { ...DEFAULT_SETTINGS };

  if (typeof source.sound === 'boolean') merged.sound = source.sound;
  // resolveUiStyle trusts a stored style only while it is still selectable, so
  // a look that has since been retired cannot come back out of storage.
  merged.uiStyle = resolveUiStyle(source.uiStyle);
  // Clamped rather than range-checked: a level from a build with more steps
  // than this one should land on the nearest, not silently reset the player's
  // preference to the default.
  if (source.boardZoom !== undefined) merged.boardZoom = clampBoardZoom(source.boardZoom);
  if (typeof source.showCoordinates === 'boolean') merged.showCoordinates = source.showCoordinates;
  if (typeof source.animations === 'boolean') merged.animations = source.animations;
  if (typeof source.autoFlip === 'boolean') merged.autoFlip = source.autoFlip;
  if (VALID_THEME_IDS.includes(source.boardTheme)) merged.boardTheme = source.boardTheme;

  return merged;
}

export function saveSettings(settings) {
  return writeJson(STORAGE_KEYS.SETTINGS, {
    version: STORAGE_VERSION,
    savedAt: Date.now(),
    settings,
  });
}

// -------------------------------------------------------------------------
// Profile pictures
//
// Kept under their own key rather than inside settings, for two reasons. They
// are the only thing here measured in kilobytes rather than bytes, and a
// quota failure writing a picture must not take the whole settings record
// down with it. And they are not settings: nothing reads them during a game,
// only the New Game form, which is where a picture is chosen and where it is
// offered back.
// -------------------------------------------------------------------------

const noAvatars = () => Object.fromEntries(AVATAR_SLOTS.map((slot) => [slot, null]));

/**
 * The remembered picture for each seat on the New Game form.
 *
 * Every slot is always present and is either a valid avatar or null, so
 * callers never have to ask which. Anything that fails validation is dropped
 * silently rather than discarding the whole record — a picture is decoration,
 * and losing one is not a reason to forget the other two.
 */
export function loadAvatars() {
  const { value: raw } = readJson(STORAGE_KEYS.AVATARS);
  const avatars = noAvatars();
  const source = raw && typeof raw === 'object' ? raw.avatars : null;
  if (!source || typeof source !== 'object') return avatars;

  AVATAR_SLOTS.forEach((slot) => {
    if (isAvatar(source[slot])) avatars[slot] = source[slot];
  });
  return avatars;
}

export function saveAvatars(avatars) {
  return writeJson(STORAGE_KEYS.AVATARS, {
    version: STORAGE_VERSION,
    savedAt: Date.now(),
    avatars,
  });
}

// -------------------------------------------------------------------------
// Game
// -------------------------------------------------------------------------

const VALID_STATUSES = Object.values(STATUS);

/**
 * A player record only has to carry a name to be usable.
 *
 * The avatar is deliberately not part of this check. A picture that fails
 * validation is dropped when the session rebuilds the player (see
 * makePlayer in local-session.js), which loses the picture and keeps the
 * game — and throwing away a finished-but-for-the-picture game would be a
 * ludicrous price for a corrupt thumbnail.
 */
function isPlayer(value) {
  return value && typeof value === 'object' && typeof value.name === 'string';
}

/**
 * Validate a persisted game record thoroughly before the app trusts it.
 * The PGN is actually replayed and the resulting FEN compared against the
 * stored FEN — a record that fails is treated as corrupt.
 */
function validateGameRecord(record) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'Not an object' };
  if (record.version !== STORAGE_VERSION) {
    return { ok: false, error: `Unsupported version ${record.version}` };
  }

  const game = record.game;
  if (!game || typeof game !== 'object') return { ok: false, error: 'Missing game' };
  if (!VALID_STATUSES.includes(game.status)) {
    return { ok: false, error: `Unknown status ${game.status}` };
  }
  if (typeof game.fen !== 'string') return { ok: false, error: 'Missing FEN' };

  const fenCheck = ChessEngine.validateFen(game.fen);
  if (!fenCheck.ok) return { ok: false, error: `Invalid FEN: ${fenCheck.error}` };

  if (!isPlayer(game.players?.w) || !isPlayer(game.players?.b)) {
    return { ok: false, error: 'Invalid players' };
  }
  if (game.orientation !== 'white' && game.orientation !== 'black') {
    return { ok: false, error: 'Invalid orientation' };
  }

  // Online games resume by rejoining their room, which is authoritative. The
  // stored position is only a summary for the menu, so it is not cross-checked
  // — it is expected to be stale the moment the opponent moves.
  if (game.mode === GAME_MODE.ONLINE) {
    if (typeof game.roomCode !== 'string' || !game.roomCode) {
      return { ok: false, error: 'Online save has no room code' };
    }
    return { ok: true };
  }

  // For local games the PGN is the authoritative restore path, so prove it
  // replays cleanly and agrees with the stored FEN.
  if (typeof game.pgn !== 'string') return { ok: false, error: 'Missing PGN' };
  if (game.pgn.trim()) {
    const probe = new ChessEngine();
    const replay = probe.loadPgn(game.pgn);
    if (!replay.ok) return { ok: false, error: `PGN replay failed: ${replay.error}` };
    if (probe.getFen() !== game.fen) {
      return { ok: false, error: 'PGN and FEN disagree' };
    }
  }

  return { ok: true };
}

/**
 * Load the saved game, or null if none exists or it fails validation.
 * A corrupt record is cleared so the app returns to a clean state instead of
 * offering a broken "Continue".
 */
export function loadGame() {
  const { found, value: record, corrupt } = readJson(STORAGE_KEYS.GAME);
  if (!found) return null;

  // Present but unparseable — the most common form of corruption. Clear it so
  // the app never offers a "Continue" that cannot work.
  if (corrupt || !record) {
    warn('Clearing unreadable saved game');
    clearGame();
    return { corrupt: true, error: 'Saved game could not be read' };
  }

  const check = validateGameRecord(record);
  if (!check.ok) {
    warn('Discarding corrupt saved game:', check.error);
    clearGame();
    return { corrupt: true, error: check.error };
  }

  log('Loaded saved game', record.game.status);
  return record.game;
}

export function saveGame(game) {
  return writeJson(STORAGE_KEYS.GAME, {
    version: STORAGE_VERSION,
    savedAt: Date.now(),
    game,
  });
}

export function clearGame() {
  removeKey(STORAGE_KEYS.GAME);
}

/**
 * Is there a saved game worth offering "Continue" for?
 * Finished games are not resumable, and neither is an untouched setup record.
 */
export function hasResumableGame() {
  const game = loadGame();
  if (!game || game.corrupt) return false;
  return !TERMINAL_STATUSES.includes(game.status);
}

/** Peek at the saved game without validating deeply — used for menu labels. */
export function peekSavedGame() {
  const game = loadGame();
  return game && !game.corrupt ? game : null;
}
