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
 * A mode is only listed here once it is offered in the UI — the AI mode is
 * Phase 6 and its placeholder has been removed from the setup screen, so it
 * gets added back when it is actually built.
 */
export const GAME_MODE = {
  LOCAL: 'local',
  ONLINE: 'online',
};

/** Board themes. Values map to `data-theme` on the board element. */
export const BOARD_THEMES = [
  { id: 'classic', label: 'Classic' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'wood', label: 'Wood' },
];

/**
 * Overall visual style.
 *
 * `classic` is the flat, dark, premium look. `arcade` is a bright casual-game
 * skin with a board tilted into 3D perspective. Purely presentational — the
 * board still renders the same 64 squares in the same DOM order, so gameplay,
 * coordinates and hit-testing are unchanged.
 */
/**
 * Available looks.
 *
 * `locked: true` shows the option in Settings with a padlock but makes it
 * unselectable. Remove the flag to unlock — the skin itself is complete and
 * needs no other change.
 */
export const UI_STYLES = [
  { id: 'classic', label: 'Classic', hint: 'Dark, flat, focused' },
  { id: 'board3d', label: '3D Board', hint: 'Real depth and shadows', webgl: true },
  { id: 'arcade', label: 'Arcade 3D', hint: 'Locked', locked: true },
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

/** Ids the player is actually allowed to pick. */
export const SELECTABLE_UI_STYLES = UI_STYLES.filter((s) => !s.locked).map((s) => s.id);

export function isUiStyleLocked(id) {
  return UI_STYLES.some((s) => s.id === id && s.locked);
}

/**
 * Which style to actually use.
 *
 * A locked style is never honoured, even if it is already stored from before
 * it was locked — that value falls back to the default instead.
 *
 * `?ui=arcade` overrides the lock while DEBUG is on, so a locked skin stays
 * previewable and testable without editing source. It is inert once DEBUG is
 * false, so it cannot be used to bypass the lock in production.
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

export const DEFAULT_SETTINGS = {
  sound: true,
  // Classic is the default: it holds a 44px touch target on every rank, which
  // the tilted Arcade board cannot. Arcade is one tap away in Settings.
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
