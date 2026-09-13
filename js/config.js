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
  // How far up the ladder you have got. Its own key rather than a corner of
  // the game record, because it outlives every individual game in the run —
  // and because losing a game must not be able to lose the run with it.
  GAUNTLET: 'chess-arena:gauntlet',
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
  TOURNAMENT: 'tournament',
  SPEED: 'speed',
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

/**
 * Time the bot keeps back from its own clock, in ms.
 *
 * On a clock the bot is spending its OWN time to think, so the budget has to
 * be the smaller of what it wants and what it has. This is the margin it
 * leaves itself: enough to return a move and submit it rather than flagging
 * mid-search, which would lose a game it might have drawn by playing almost
 * anything. It is not a way out — a bot that has run out of time still loses,
 * it just loses having made its last move.
 */
export const BOT_CLOCK_MARGIN_MS = 300;

/** Shown wherever the bot's seat needs a player name. */
export const BOT_NAME = 'Bot';

/**
 * The tournament ladder: five bots, each harder than the last.
 *
 * Strength is the same two numbers the bot already takes, because there is
 * only one bot here — a ladder of separate engines would be five times the
 * code for a difference nobody asked for. `timeBudgetMs` is what actually
 * binds: the search deepens iteratively until the budget runs out, so more
 * time is more plies wherever the position allows them. `maxDepth` is the
 * ceiling that stops a quiet position being searched past the point of
 * usefulness, and raising it with the budget is what keeps the two in step.
 *
 * Round 3 is deliberately today's bot, unchanged — the opponent anyone who has
 * played this app already knows. Two rounds sit below it so the ladder opens
 * with something a casual player beats, and two above so finishing it means
 * something.
 *
 * The budget is also a promise about waiting. Champion thinks for around three
 * seconds a move, which is a long time on a phone and is meant to be: it is
 * the last round, and BOT_MIN_THINK_MS shows the same pause is deliberate at
 * the other end of the ladder too.
 */
export const GAUNTLET_ROUNDS = [
  { round: 1, label: 'Novice', hint: 'Barely looks ahead', timeBudgetMs: 200, maxDepth: 2 },
  { round: 2, label: 'Club', hint: 'Takes what you leave', timeBudgetMs: 500, maxDepth: 3 },
  { round: 3, label: 'Expert', hint: 'Sees short tactics', timeBudgetMs: 1200, maxDepth: 4 },
  { round: 4, label: 'Master', hint: 'Thinks before answering', timeBudgetMs: 2200, maxDepth: 5 },
  { round: 5, label: 'Champion', hint: 'Takes its time', timeBudgetMs: 3000, maxDepth: 6 },
];

export const GAUNTLET_LENGTH = GAUNTLET_ROUNDS.length;

/** A run nobody has started: standing at round one, nothing beaten. */
export const DEFAULT_GAUNTLET = { round: 1, best: 0 };

/** One rung, or null. Rounds are 1-based because that is how they are read. */
export function gauntletRound(round) {
  return GAUNTLET_ROUNDS.find((rung) => rung.round === round) ?? null;
}

/**
 * Force a stored round back into the ladder.
 *
 * A record from a build with more rungs than this one, or a hand-edited
 * number, must not leave the player standing on a round that does not exist —
 * which would be a game with no opponent rather than a wrong difficulty.
 */
export function clampGauntletRound(round) {
  const n = Math.trunc(Number(round));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), GAUNTLET_LENGTH);
}

/**
 * Time controls for Speed Chess, written the way chess writes them.
 *
 * `initialMs + incrementMs` per side, Fischer-style: the increment is added
 * after a move is made, not before it, so it can never be banked by a player
 * who has already flagged.
 *
 * Four, because these are the four games people actually play — a minute for
 * bullet, three-plus-two and five-flat for blitz, ten-plus-five for something
 * you can think in. The `name` is what the format is called and the `label` is
 * the format itself; both are shown, because "3 + 2" is precise and "Blitz" is
 * what you say out loud.
 */
export const TIME_CONTROLS = [
  { id: '1+0', label: '1 + 0', name: 'Bullet', initialMs: 60_000, incrementMs: 0 },
  { id: '3+2', label: '3 + 2', name: 'Blitz', initialMs: 180_000, incrementMs: 2_000 },
  { id: '5+0', label: '5 + 0', name: 'Blitz', initialMs: 300_000, incrementMs: 0 },
  { id: '10+5', label: '10 + 5', name: 'Rapid', initialMs: 600_000, incrementMs: 5_000 },
];

/** What a player gets without choosing: the middle of the road. */
export const DEFAULT_TIME_CONTROL = '3+2';

/**
 * One time control, or null.
 *
 * Resolved rather than trusted, for the same reason every other stored id is:
 * a control from a build that offered more of them must not become a game with
 * no clock in a mode whose whole point is the clock.
 */
export function timeControl(id) {
  return TIME_CONTROLS.find((control) => control.id === id) ?? null;
}

export function resolveTimeControl(id) {
  return timeControl(id) ?? timeControl(DEFAULT_TIME_CONTROL);
}

/**
 * How often the clock display is repainted, in ms.
 *
 * Not how the time is MEASURED — that is done from timestamps, so the reading
 * is right however irregularly this fires. This is only how often the number
 * on screen catches up, and 100ms is the coarsest tick at which a tenths
 * display still counts down smoothly rather than stuttering.
 */
export const CLOCK_TICK_MS = 100;

/**
 * When a clock starts shouting, in ms.
 *
 * Ten seconds is also where the display switches to tenths, and the two go
 * together on purpose: the moment the number starts moving fast enough to
 * watch is the moment it is worth watching.
 */
export const CLOCK_URGENT_MS = 10_000;

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
 * Fit — the first level, and the cinematic angle.
 *
 * This is a deliberate choice of looks over reach, and it is worth being
 * precise about what it trades. Measured through the live camera on a 390px
 * phone, with the board now running edge to edge:
 *
 *   Fit    far square 31x24   near 40x36
 *   Large  far square 36x32   near 43x43
 *   Max    far square 43x42   near 46x47
 *
 * So the back rank is a 24px target here against 42px at Max. That is well
 * under the 44px this app uses everywhere else, and it is the cost of seeing
 * the board in perspective: a board drawn at an angle cannot hold the same
 * target on every rank, because that is what perspective means.
 *
 * It is a default, not a decision. The Size control cycles the three levels
 * and says which one you are on, so a player who finds the back rank fiddly is
 * one tap from Large and two from Max — and the choice is remembered.
 */
export const DEFAULT_BOARD_ZOOM = 0;

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
 * App backgrounds. Values map to `data-bg` on the root element.
 *
 * The background is not just the strip around the board. The 3D renderer is
 * transparent — `alpha: true`, clear colour alpha 0 — so the page shows
 * through the board's own scene as well as around it, which is why this is
 * worth a setting at all and why every one of these is dark: a light ground
 * behind a lit 3D board reads as a photograph on the wrong wall.
 *
 * Each id is a block in style.css that redefines the surface tokens only —
 * base, glow, panels and borders, in one hue, holding the lightness ladder
 * the default sets. Text and accent tokens are deliberately untouched: they
 * are what carry contrast, and a background is no reason to renegotiate it.
 */
export const BACKGROUNDS = [
  { id: 'midnight', label: 'Midnight', hint: 'Cool and dark' },
  { id: 'charcoal', label: 'Charcoal', hint: 'Neutral graphite' },
  { id: 'forest', label: 'Forest', hint: 'Club-room green' },
  { id: 'mahogany', label: 'Mahogany', hint: 'Warm and wooden' },
];

/** The background a player gets with nothing stored, and the fallback. */
export const DEFAULT_BACKGROUND = 'midnight';

export const VALID_BACKGROUNDS = BACKGROUNDS.map((b) => b.id);

/**
 * Which background to actually use.
 *
 * An unknown id — one from a build that offered more of them — falls back to
 * the default rather than being written to the DOM, where it would match no
 * block and leave the page on whatever `:root` happens to say.
 */
export function resolveBackground(id) {
  return VALID_BACKGROUNDS.includes(id) ? id : DEFAULT_BACKGROUND;
}

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
  background: DEFAULT_BACKGROUND,
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
