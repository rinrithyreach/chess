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
  AVATARS: 'chess-arena:avatars',
};

/**
 * Seats on the New Game form that remember a profile picture between games.
 *
 * Seats, not colours: `p1` is whoever fills in the first name box, and a
 * rematch swapping colours does not move their picture to the other slot. The
 * form is the only place these ids mean anything.
 *
 * The picture is remembered, the name is not. A name is eight characters and
 * takes a moment to retype; a picture means opening the camera roll and
 * hunting for it again, which is the part nobody will do twice.
 */
export const AVATAR_SLOTS = ['p1', 'p2', 'online'];

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

/**
 * Board zoom — how big the squares are, and how even.
 *
 * Implemented as camera elevation rather than as a dolly, which sounds like
 * the wrong lever until you measure the board. On a 412px phone the frame is
 * square but the board, seen from 56 degrees, projects about 1.35 times wider
 * than tall: roughly 110px of the frame's height is empty sky above and below
 * it. Raising the camera spends that empty space on the board instead of
 * cropping anything, so the whole board stays visible at every level and there
 * is nothing to pan. A dolly would have to crop to achieve the same thing, and
 * a chessboard you have to scroll around is worse than a small one.
 *
 * It also fixes the more annoying half of the problem. At 56 degrees the far
 * rank is barely 23px tall while the near rank is 35px — the back rank is the
 * hardest thing on the board to tap. Elevation flattens that difference out;
 * at 84 degrees every square is within a few pixels of every other, and all of
 * them clear the 44px touch target.
 *
 * Ordered small to large, and the index is what is stored.
 */
/**
 * `rim` is how much of the board's wooden border has to stay in frame, as a
 * fraction. The border is 0.84 of the board's 8.84 units across — nearly a
 * tenth of the width, spent on something you never tap. At the low angle it
 * has to stay: it is the visible front edge of the slab, and clipping it makes
 * the board look broken. Seen from above it is just a margin, so the top level
 * lets the frame crop it and gives the squares the width back.
 */
export const BOARD_ZOOM_LEVELS = [
  { id: 'fit', label: 'Fit', elevation: 56, rim: 1, hint: 'The cinematic angle' },
  { id: 'large', label: 'Large', elevation: 70, rim: 0.5, hint: 'Bigger, still clearly 3D' },
  { id: 'max', label: 'Max', elevation: 84, rim: 0, hint: 'Every square the same size' },
];

/**
 * Large, not Fit.
 *
 * The 3D board is the only board now, and on a phone the cinematic angle makes
 * the back rank a 23px target. Defaulting to the middle step is the difference
 * between a board that is pleasant to look at and one that is pleasant to
 * play; anyone who prefers the low angle is one tap away from it.
 */
export const DEFAULT_BOARD_ZOOM = 1;

export function clampBoardZoom(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return DEFAULT_BOARD_ZOOM;
  return Math.min(Math.max(n, 0), BOARD_ZOOM_LEVELS.length - 1);
}

/** Board themes. Values map to `data-theme` on the board element. */
export const BOARD_THEMES = [
  { id: 'classic', label: 'Classic' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'wood', label: 'Wood' },
];

/**
 * Available looks.
 *
 * `board3d` is the WebGL board — real geometry, lighting and shadows — and is
 * now what every player gets. `classic`, the flat DOM grid, is still built and
 * still tested, but as the fallback for a device that will not grant a WebGL
 * context rather than as something to choose. Which renderer app.js mounts is
 * the whole of the difference; everything else about the game is identical.
 *
 * `selectable: false` is what retires a look without deleting it. The picker
 * lists only selectable styles and hides itself when fewer than two remain, so
 * this one flag is the entire change — and putting the flag back brings the
 * picker back with it.
 */
export const UI_STYLES = [
  { id: 'classic', label: 'Classic', hint: 'Dark, flat, focused', selectable: false },
  { id: 'board3d', label: '3D Board', hint: 'Real depth and shadows', webgl: true },
];

/** The look a player gets with nothing stored, and the fallback for anything unknown. */
export const DEFAULT_UI_STYLE = 'board3d';

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
export const SELECTABLE_UI_STYLES = UI_STYLES
  .filter((s) => s.selectable !== false)
  .map((s) => s.id);

/**
 * Which style to actually use.
 *
 * Anything not selectable falls back to the default rather than being trusted
 * — which is what retires a style cleanly. A player whose browser still has
 * `arcade` stored from an older build gets the 3D board, and so does one who
 * chose Classic back when it was on offer: no migration step, nothing to
 * clean up, and nobody left on a look that is no longer given out.
 *
 * `?ui=<id>` overrides the stored value while DEBUG is on, and accepts any
 * built style rather than only the selectable ones — `?ui=classic` is how the
 * fallback renderer stays previewable and testable now that no player can
 * reach it. Inert once DEBUG is false.
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

  return SELECTABLE_UI_STYLES.includes(savedStyle) ? savedStyle : DEFAULT_UI_STYLE;
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
  // The 3D board, for everyone, with no setting to find. Worth knowing what
  // that trades away: a board drawn in perspective cannot hold a 44px touch
  // target on every rank the way the flat grid does — the far rank is smaller
  // than the near one, which is what perspective means.
  uiStyle: DEFAULT_UI_STYLE,
  boardZoom: DEFAULT_BOARD_ZOOM,
  boardTheme: 'classic',
  showCoordinates: true,
  animations: true,
  autoFlip: false,
};

export const DEFAULT_PLAYER_NAMES = {
  white: 'Player 1',
  black: 'Player 2',
};

/**
 * Move animation duration (ms).
 *
 * This was 180ms, chosen so play would never feel gated on it. Nothing waits
 * on the animation — input is accepted the whole time it runs — so the only
 * thing 180ms actually bought was fewer frames to move in: eleven, of which a
 * measured four carried less than two pixels each. The motion had no room to
 * be anything but a jump.
 *
 * At 260ms the same move gets sixteen frames and twelve of them carry real
 * distance. The one thing that does key off this — the game-over dialog in
 * app.js — is written as `ANIMATION_MS + 120`, so it follows on its own.
 */
export const ANIMATION_MS = 260;

/**
 * Easing for the piece slide.
 *
 * The previous curve, `cubic-bezier(0.2, 0.8, 0.3, 1)`, was picked to avoid
 * easing IN, on the reasoning that a piece which hesitates for its first few
 * frames reads as laggy. The goal was right and the curve overshot it: with
 * the control point at (0.2, 0.8) the piece left the square at FOUR times its
 * own average speed, from a standing start, and was 72% of the way there by
 * the first quarter of the animation — leaving the last quarter of the
 * distance to fill three quarters of the time. That instantaneous launch is
 * what "not smooth" looks like: there is no acceleration to see, only a jump
 * followed by a crawl.
 *
 * This curve answers the original concern with a number rather than a shape.
 * Peak speed is 2.1x the average instead of 4x and arrives at t=0.35 rather
 * than at t=0; the first frame of a two-square move travels 1.9px and the
 * second 6px, so the piece is visibly under way within two frames without
 * ever jumping. It accelerates, carries, and settles.
 *
 * The other thing this curve is chosen for is the 3D board's arc. That arc is
 * driven by the eased travel, not by the clock, which makes it symmetric over
 * the PATH — the top is above the midpoint of the move, always. Where the
 * easing then puts that top is in TIME, and that is this curve's `t_half`,
 * the moment it passes the halfway mark: 0.39 here, against 0.145 for the
 * curve it replaces. See #animateMove in board-3d.js.
 */
export const ANIMATION_EASING = 'cubic-bezier(0.38, 0.06, 0.35, 1)';

/**
 * How long the captured piece takes to go, as a fraction of ANIMATION_MS.
 *
 * The fade is scheduled to END on the landing rather than to start with the
 * move — see CAPTURE_FADE_DELAY. So this is not "how long until it is gone"
 * but "how long it takes to go, once the piece taking it is nearly there",
 * which is why it is shorter than it used to be.
 */
export const CAPTURE_FADE_RATIO = 0.45;

/**
 * When the captured piece starts leaving.
 *
 * It used to start fading the instant the capturing piece set off, and was
 * gone before that piece arrived: the square emptied itself and was then
 * landed on, which reads as two unrelated events. Holding it until the
 * attacker is most of the way across makes them one event — the piece is
 * displaced by the piece taking it.
 *
 * Derived, so the two always end together whatever the ratio is set to.
 */
export const CAPTURE_FADE_DELAY = Math.round(ANIMATION_MS * (1 - CAPTURE_FADE_RATIO));

/**
 * How high a piece rides on its way across, in squares.
 *
 * A knight goes higher because it is the piece that jumps. Here rather than
 * inline in board-3d.js because every other number that decides what a move
 * looks like — how long it takes, how it accelerates, when the captured piece
 * goes — is here, and a lift buried in the renderer is the one you would not
 * think to look for when the motion needs tuning again.
 *
 * A fraction of a square, not a distance: the board happens to make a square
 * one world unit, and this should not quietly depend on that.
 */
export const CARRY_LIFT = 0.32;
export const CARRY_LIFT_KNIGHT = 0.85;

/** How long toasts remain on screen (ms). */
export const TOAST_MS = 2400;

/** Namespaced logger that disappears entirely when DEBUG is false. */
export const log = DEBUG
  ? (...args) => console.log('%c[chess]', 'color:#e8b44c', ...args)
  : () => {};

export const warn = DEBUG
  ? (...args) => console.warn('[chess]', ...args)
  : () => {};
