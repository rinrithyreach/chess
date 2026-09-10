/**
 * board-shared.js
 * Pure helpers shared by both board renderers.
 *
 * There are two boards — a DOM one (board.js) and a WebGL one (board-3d.js) —
 * and they must agree exactly on the things a player can notice: which squares
 * exist and in what order, which are light or dark, how a FEN maps onto them,
 * and what a screen reader is told about each one. Keeping that here means the
 * two renderers cannot drift apart on any of it; the only thing they disagree
 * about is how a square is drawn.
 *
 * Nothing in this file touches the DOM, WebGL, or the chess rules. The one
 * browser API it does reach for is `matchMedia`, for the motion preference —
 * which lives here for the same reason as everything else in the file: three
 * places now have to agree on what "reduced motion" means, and agreeing by
 * having three copies of the check is how they stop agreeing.
 */

import { FILES, RANKS, WHITE } from './config.js';

export const PIECE_NAMES = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

/**
 * Whether the player has asked their system for less motion.
 *
 * Both boards consult this before animating anything, and so does the motion
 * preview in Settings — which is the point of it living here. The preview
 * exists to show what the Animations setting does, so it has to decline in
 * exactly the circumstances the board declines: a preview that glides while
 * the board it describes does not would be a lie about the product.
 *
 * Checked live rather than cached, and checked in SCRIPT rather than left to
 * CSS. The `prefers-reduced-motion` block in style.css only neutralises CSS
 * transitions and CSS animations; a Web Animations API effect is neither and
 * sails straight past it, and the WebGL board's motion is not CSS at all. So
 * motion has to be declined here or it is not declined.
 *
 * Guarded, because `matchMedia` is absent in jsdom and in older engines, and
 * a missing preference means the player has not asked for anything.
 */
export function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** All 64 squares in a8..h1 order (matching chess.js' board() layout). */
function buildSquareList() {
  const squares = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    for (const file of FILES) squares.push(`${file}${rank}`);
  }
  return squares;
}

export const ALL_SQUARES = buildSquareList();

/** Light or dark, computed from the coordinate rather than the array index. */
export function squareShade(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rankIndex = RANKS.indexOf(square[1]);
  return (fileIndex + rankIndex) % 2 === 0 ? 'dark' : 'light';
}

/**
 * Parse the piece-placement field of a FEN into a square->piece map.
 *
 * Both boards render from FEN so their input is exactly the same serialized
 * state the session publishes and storage persists — not a private structure
 * that could fall out of step with it.
 */
export function boardFromFen(fen) {
  const map = new Map();
  const placement = String(fen).split(' ')[0] ?? '';
  const rows = placement.split('/');

  rows.forEach((row, rowIndex) => {
    const rank = 8 - rowIndex;
    let fileIndex = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        continue;
      }
      const file = FILES[fileIndex];
      if (file) {
        map.set(`${file}${rank}`, {
          type: char.toLowerCase(),
          color: char === char.toUpperCase() ? 'w' : 'b',
        });
      }
      fileIndex += 1;
    }
  });
  return map;
}

/** The label a screen reader reads for one square. */
export function describeSquare(square, piece, target) {
  const who = piece
    ? `${piece.color === WHITE ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}`
    : 'empty';
  if (target) {
    return `${square}, ${who}, ${target.isCapture ? 'capture' : 'move here'}`;
  }
  return `${square}, ${who}`;
}

/**
 * Turn a CSS `cubic-bezier(a, b, c, d)` string into an easing function.
 *
 * The 3D board animates in a script loop rather than through CSS, so it cannot
 * hand the browser a timing function and let it interpolate. Parsing the same
 * constant both boards already share — rather than hand-picking a curve that
 * looks close — is what keeps a move feeling identical whichever board is on
 * screen.
 *
 * Solved with Newton-Raphson, falling back to bisection on the flat stretches
 * where the derivative is too small for Newton to converge.
 */
export function cubicBezierEasing(css) {
  const match = /cubic-bezier\(([^)]+)\)/.exec(String(css));
  const [x1, y1, x2, y2] = match
    ? match[1].split(',').map((n) => Number(n.trim()))
    : [0.25, 0.1, 0.25, 1];
  if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) return (t) => t;

  const curve = (t, a, b) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return ((e * t + d) * t + c) * t;
  };
  const slope = (t, a, b) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return (3 * e * t + 2 * d) * t + c;
  };

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = curve(t, x1, x2) - x;
      if (Math.abs(error) < 1e-6) return curve(t, y1, y2);
      const dt = slope(t, x1, x2);
      if (Math.abs(dt) < 1e-6) break;
      t -= error / dt;
    }
    let low = 0;
    let high = 1;
    t = x;
    while (low < high) {
      const error = curve(t, x1, x2);
      if (Math.abs(error - x) < 1e-6) break;
      if (x > error) low = t;
      else high = t;
      t = (high - low) / 2 + low;
      if (high - low < 1e-7) break;
    }
    return curve(t, y1, y2);
  };
}
