/**
 * config.js
 * Application-wide constants and feature flags.
 *
 * This module must not import anything else — it sits at the bottom of the
 * dependency graph so every other module can safely depend on it.
 */

/**
 * DEBUG mode.
 * When true: verbose console logging is enabled and the in-game developer
 * tools (custom FEN loader) become reachable. When false, developer UI is
 * never inserted into the DOM and log() is a no-op.
 */
export const DEBUG = true;

/** Storage schema version — bump when the persisted shape changes. */
export const STORAGE_VERSION = 1;

export const STORAGE_KEYS = {
  GAME: 'chess-arena:game',
  SETTINGS: 'chess-arena:settings',
};

/** Colors, mirroring chess.js' single-character notation. */
export const WHITE = 'w';
export const BLACK = 'b';

/** Board geometry. */
export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

/**
 * Canonical game statuses. The controller keeps one of these in state at all
 * times; UI text is derived from it, never the other way around.
 */
export const STATUS = {
  SETUP: 'setup',
  PLAYING: 'playing',
  CHECK: 'check',
  CHECKMATE: 'checkmate',
  DRAW: 'draw',
  RESIGNED: 'resigned',
  FINISHED: 'finished',
};

/** Statuses in which the board is frozen. */
export const TERMINAL_STATUSES = [
  STATUS.CHECKMATE,
  STATUS.DRAW,
  STATUS.RESIGNED,
  STATUS.FINISHED,
];

/**
 * Game modes.
 * A mode is only listed here once it is offered in the UI, and each has its
 * own session provider — local-session, bot-session, firebase-session.
 */
export const GAME_MODE = {
  LOCAL: 'local',
  BOT: 'bot',
  ONLINE: 'online',
};

/**
 * Roughly how long the bot may think, in ms.
 *
 * A time budget rather than a fixed depth, because depth is a guess about
 * hardware: measured against chess.js, a midgame depth-3 search runs in a
 * fraction of a second in a quiet position and several seconds in a busy one,
 * and a phone is slower again. The bot searches depth 1, then 2, then 3, and
 * plays the best move from the last depth that finished inside this budget —
 * so the wait is bounded everywhere, and a faster device simply gets a
 * stronger opponent rather than the same one sooner.
 *
 * This is the knob for difficulty, if levels are ever wanted.
 */
export const BOT_TIME_BUDGET_MS = 1200;

/** Never search deeper than this, however much budget is left. */
export const BOT_MAX_DEPTH = 4;

/**
 * Shortest time the bot may appear to think, in ms.
 *
 * An instant reply reads as a canned response rather than a decision, and
 * lands on top of the animation of the move that provoked it. This is a floor,
 * not a delay: a search that takes longer is not padded.
 */
export const BOT_MIN_THINK_MS = 450;

/** Shown wherever the bot's seat needs a player name. */
export const BOT_NAME = 'Bot';

/** Board themes. Values map to `data-theme` on the board element. */
export const BOARD_THEMES = [
  { id: 'classic', label: 'Classic' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'wood', label: 'Wood' },
];

/**
 * Available looks.
 *
 * `classic` is the flat, dark, premium look, rendered as a DOM grid.
 * `board3d` is the WebGL board — real geometry, lighting and shadows.
 * Which one is chosen decides which renderer app.js mounts; everything else
 * about the game is identical either way.
 */
export const UI_STYLES = [
  { id: 'classic', label: 'Classic', hint: 'Dark, flat, focused' },
  { id: 'board3d', label: '3D Board', hint: 'Real depth and shadows', webgl: true },
];

/**
 * Styles that need a GPU context, and so can fail at runtime for reasons that
 * have nothing to do with this app — a blocklisted driver, a hardened browser
 * profile, too many live WebGL contexts on the page. app.js checks before
 * committing to one and falls back to Classic if the context is refused.
 */
export const WEBGL_UI_STYLES = UI_STYLES.filter((s) => s.webgl).map((s) => s.id);

export function uiStyleNeedsWebgl(id) {
  return WEBGL_UI_STYLES.includes(id);
}

/** Ids the player is allowed to pick. */
export const SELECTABLE_UI_STYLES = UI_STYLES.map((s) => s.id);

/**
 * Which style to actually use.
 *
 * Anything not on the list falls back to the default rather than being trusted
 * — which is what retires a style cleanly. A player whose browser still has
 * `arcade` stored from an older build simply gets Classic, with no migration
 * step and nothing to clean up.
 *
 * `?ui=<id>` overrides the stored value while DEBUG is on, so a style stays
 * previewable without editing source. It is inert once DEBUG is false.
 */
export function resolveUiStyle(savedStyle) {
  if (DEBUG) {
    try {
      const requested = new URLSearchParams(globalThis.location?.search ?? '').get('ui');
      if (UI_STYLES.some((s) => s.id === requested)) return requested;
    } catch {
      /* no query string available */
    }
  }

  return SELECTABLE_UI_STYLES.includes(savedStyle) ? savedStyle : 'classic';
}

/**
 * Game controls that are shown but cannot be used.
 *
 * A locked control keeps its place in the row rather than disappearing: the
 * player can see the game has an Undo and that it is simply not on offer,
 * which an absent button cannot communicate. It is inert to pointer and
 * keyboard alike, and says so when pressed.
 *
 * Ids are the part after `btn-`. Take one out of this list to restore that
 * control — nothing else needs changing.
 */
export const LOCKED_CONTROLS = ['undo'];

export function isControlLocked(id) {
  return LOCKED_CONTROLS.includes(id);
}

export const DEFAULT_SETTINGS = {
  sound: true,
  // Classic is the default: it holds a 44px touch target on every rank, which
  // a board drawn in perspective cannot, and it needs no GPU context. The 3D
  // board is one tap away in Settings.
  uiStyle: 'classic',
  boardTheme: 'classic',
  showCoordinates: true,
  animations: true,
  autoFlip: false,
};

export const DEFAULT_PLAYER_NAMES = {
  white: 'Player 1',
  black: 'Player 2',
};

/** Move animation duration (ms). Kept short so play never feels gated on it. */
export const ANIMATION_MS = 180;

/**
 * Easing for the piece slide.
 *
 * A decelerating curve, not `ease` — `ease` eases IN as well, so the piece
 * hesitates for its first few frames and the move reads as laggy even though
 * it started instantly. Leaving at full speed and settling into the square is
 * what makes a short animation feel immediate rather than delayed.
 */
export const ANIMATION_EASING = 'cubic-bezier(0.2, 0.8, 0.3, 1)';

/**
 * The captured piece fades out over this fraction of ANIMATION_MS, so it is
 * gone by the time the capturing piece lands on top of it.
 */
export const CAPTURE_FADE_RATIO = 0.8;

/** How long toasts remain on screen (ms). */
export const TOAST_MS = 2400;

/** Namespaced logger that disappears entirely when DEBUG is false. */
export const log = DEBUG
  ? (...args) => console.log('%c[chess]', 'color:#e8b44c', ...args)
  : () => {};

export const warn = DEBUG
  ? (...args) => console.warn('[chess]', ...args)
  : () => {};
