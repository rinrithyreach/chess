/**
 * bot.js
 * The computer opponent: position evaluation and search.
 *
 * Pure and self-contained — it takes a FEN and returns a move. It touches no
 * DOM, no app state and nothing else in the project except chess.js, which is
 * what lets the same file run either inside a Web Worker (the normal case) or
 * on the main thread (the fallback) with no changes.
 *
 * Negamax with alpha-beta, ordered moves, a quiescence search at the leaves,
 * and iterative deepening under a time budget.
 *
 * Two decisions are worth explaining, because both were measured rather than
 * assumed:
 *
 * 1. The search calls `chess.moves()` and moves by SAN, NOT
 *    `chess.moves({ verbose: true })`. Verbose mode costs about 1570µs per
 *    call against roughly 110µs for the plain form — fourteen times more —
 *    because it builds SAN for every move, which means disambiguation and
 *    check detection per move. Paying that at every node made a midgame
 *    depth-3 search take over a minute. Everything the ordering needs is
 *    recoverable from the SAN string plus one cheap board lookup.
 *
 * 2. Depth is not fixed, it is whatever fits the time budget. A fixed depth
 *    is a guess about hardware: the same number that answers instantly on a
 *    laptop can stall a cheap phone for ten seconds. Iterative deepening
 *    searches depth 1, then 2, then 3, keeping the best result from the last
 *    depth that finished — so the wait is bounded on every device, and faster
 *    hardware simply gets a stronger opponent for the same wait.
 */

import { Chess } from './vendor/chess.js';

/**
 * Centipawn values. A knight and a bishop are deliberately not equal — the
 * half-pawn edge is what makes the bot keep the bishop pair rather than trade
 * pieces off at random.
 */
const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

/**
 * Piece-square tables, from White's point of view, a8 first (the order the
 * ranks come in). Material alone produces a bot that shuffles pieces aimlessly
 * in the opening; these are what make it develop, castle, push central pawns
 * and keep knights off the rim.
 */
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  // Middlegame: stay home and castled.
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
  // Endgame: the opposite advice — walk to the centre and help.
  kEnd: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

/** Mate scores sit far outside any material evaluation. */
const MATE = 100000;

/**
 * Below this much non-pawn material, use the endgame king table. A crude phase
 * test, but it captures the one transition that matters: the king going from
 * something to hide to something to use.
 */
const ENDGAME_MATERIAL = 1300;

/** How many plies of captures to play out past the search horizon. */
const QUIESCENCE_PLIES = 3;

/** Thrown to unwind the search when the time budget runs out. */
const TIMEOUT = Symbol('bot-timeout');

/**
 * Score a position from the side-to-move's point of view.
 * One pass over the board: the phase test and the score accumulate together.
 */
function evaluate(chess) {
  const board = chess.board();
  let score = 0;
  let nonPawn = 0;

  // Two passes over the same array rather than one pass into a list: the
  // phase has to be known before the king is scored, and board() costs about
  // a microsecond while allocating a list per call — at hundreds of thousands
  // of calls a search — does not.
  for (let rank = 0; rank < 8; rank += 1) {
    const row = board[rank];
    for (let file = 0; file < 8; file += 1) {
      const piece = row[file];
      if (piece && piece.type !== 'p' && piece.type !== 'k') {
        nonPawn += PIECE_VALUE[piece.type];
      }
    }
  }

  const endgame = nonPawn <= ENDGAME_MATERIAL;
  for (let rank = 0; rank < 8; rank += 1) {
    const row = board[rank];
    for (let file = 0; file < 8; file += 1) {
      const piece = row[file];
      if (!piece) continue;
      const table = piece.type === 'k' && endgame ? PST.kEnd : PST[piece.type];
      // The tables are written from White's side, so Black reads them mirrored.
      const white = piece.color === 'w';
      const index = white ? rank * 8 + file : (7 - rank) * 8 + file;
      const value = PIECE_VALUE[piece.type] + table[index];
      score += white ? value : -value;
    }
  }

  return chess.turn() === 'w' ? score : -score;
}

/**
 * The square a SAN move lands on, or null for castling.
 * Cheap string work, in place of asking chess.js for verbose moves.
 */
function sanTarget(san) {
  if (san.charCodeAt(0) === 79) return null; // 'O' — castling
  // Walk back past the suffixes rather than running two replaces and a test.
  // This is called for every capture at every node, where regex allocation is
  // a measurable share of the search.
  let end = san.length;
  while (end > 0) {
    const c = san.charCodeAt(end - 1);
    // + # ! ?
    if (c === 43 || c === 35 || c === 33 || c === 63) { end -= 1; continue; }
    break;
  }
  // Promotion: "=Q" sits before the suffixes.
  if (end >= 2 && san.charCodeAt(end - 2) === 61) end -= 2;
  if (end < 2) return null;
  const file = san.charCodeAt(end - 2);
  const rank = san.charCodeAt(end - 1);
  if (file < 97 || file > 104 || rank < 49 || rank > 56) return null; // a-h, 1-8
  return san.slice(end - 2, end);
}

/**
 * Order moves so alpha-beta prunes early.
 *
 * With good ordering alpha-beta examines roughly the square root of the tree;
 * with none it examines all of it, which is the difference between a bot that
 * answers in a second and one that appears to hang. Captures come first, most
 * valuable victim against least valuable attacker.
 */
function orderMoves(chess, sanMoves) {
  const scored = sanMoves.map((san) => {
    let score = 0;
    const capture = san.includes('x');
    if (capture) {
      const target = sanTarget(san);
      const victim = target ? chess.get(target) : null;
      // En passant leaves the target square empty; it is a pawn either way.
      const victimValue = victim ? PIECE_VALUE[victim.type] : PIECE_VALUE.p;
      // Uppercase leading letter means a piece; anything else is a pawn.
      const lead = san.charCodeAt(0);
      const attacker = lead >= 65 && lead <= 90 ? san[0].toLowerCase() : 'p';
      score += 10 * victimValue - PIECE_VALUE[attacker];
    }
    if (san.includes('=')) score += PIECE_VALUE.q;
    if (san.includes('+') || san.includes('#')) score += 50;
    return { san, score, capture };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Play out the captures before scoring.
 *
 * Not an optimisation — the difference between a bot that plays chess and one
 * that does not. A fixed-depth search stopping mid-exchange scores a position
 * with material still hanging, so it cheerfully plays QxP into PxQ and looks
 * broken to anyone who can see one move further than it can.
 *
 * Standing pat first: the side to move is never obliged to capture, so a
 * position already good enough cuts off immediately.
 */
function quiesce(chess, alpha, beta, plies, ctx) {
  ctx.check();

  const standPat = evaluate(chess);
  if (plies === 0) return standPat;
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  const captures = orderMoves(chess, chess.moves()).filter((m) => m.capture);
  for (const { san } of captures) {
    chess.move(san);
    const score = -quiesce(chess, -beta, -alpha, plies - 1, ctx);
    chess.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/** Negamax with alpha-beta. Returns the score for the side to move. */
function search(chess, depth, alpha, beta, ctx) {
  ctx.check();

  const sanMoves = chess.moves();
  if (!sanMoves.length) {
    // No legal moves: checkmate if in check, stalemate otherwise. Derived
    // here rather than by calling isGameOver(), which costs ~39µs a node.
    // Deeper mates score lower, so the bot prefers the quickest one.
    return chess.isCheck() ? -MATE + (100 - depth) : 0;
  }
  if (depth === 0) return quiesce(chess, alpha, beta, QUIESCENCE_PLIES, ctx);

  for (const { san } of orderMoves(chess, sanMoves)) {
    chess.move(san);
    const score = -search(chess, depth - 1, -beta, -alpha, ctx);
    chess.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/**
 * Score every legal move at one depth. Throws TIMEOUT if the budget runs out.
 *
 * The window narrows as better moves are found, which is where most of
 * alpha-beta's benefit lives. Searching every root move with a full window —
 * as this did at first — prunes essentially nothing between them: a midgame
 * depth-3 search visited around thirty thousand nodes instead of a few
 * hundred, and took seven seconds instead of a fraction of one.
 *
 * The window is relaxed by `spread` rather than pulled tight to alpha, so
 * every move close enough to be a candidate for the random pick still gets an
 * exact score. Moves below that cut off with a bound, which is all they need:
 * they are already too far behind to be chosen.
 */
function searchRoot(chess, depth, ctx, spread) {
  const scored = [];
  let alpha = -Infinity;

  for (const { san } of orderMoves(chess, chess.moves())) {
    const move = chess.move(san);
    const window = alpha === -Infinity ? Infinity : -(alpha - spread);
    const score = -search(chess, depth - 1, -Infinity, window, ctx);
    chess.undo();
    scored.push({
      score,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      san: move.san,
    });
    if (score > alpha) alpha = score;
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Choose a move for the side to move in `fen`.
 *
 * @param {string} fen Position to move in.
 * @param {object} [options]
 * @param {number} [options.timeBudgetMs] Rough ceiling on thinking time. The
 *   deepest search that finishes inside it is the one used.
 * @param {number} [options.maxDepth] Never search deeper than this, however
 *   much time is left — a simple endgame can otherwise recurse a long way
 *   for no practical gain.
 * @param {number} [options.depth] Fixed depth, ignoring the time budget.
 *   For tests that need a deterministic amount of searching.
 * @param {number} [options.spread] Centipawns within which moves count as
 *   equally good and one is chosen at random. Without it the bot answers any
 *   given position identically every time and playing it becomes an exercise
 *   in memorising one game.
 * @param {() => number} [options.random] Injectable randomness, so a test can
 *   make the choice deterministic.
 * @returns {?{from: string, to: string, promotion?: string, san: string,
 *   score: number, depth: number}}
 */
export function chooseMove(fen, options = {}) {
  const {
    timeBudgetMs = 900,
    maxDepth = 4,
    depth = null,
    spread = 30,
    random = Math.random,
    now = () => Date.now(),
  } = options;

  const chess = new Chess();
  try {
    chess.load(fen);
  } catch {
    return null;
  }
  if (!chess.moves().length) return null;

  const deadline = now() + timeBudgetMs;
  let counter = 0;
  const ctx = {
    // Checked every 512 nodes rather than every node: reading the clock is
    // not free, and the budget is a soft ceiling, not a deadline to the ms.
    check() {
      counter += 1;
      if (depth === null && (counter & 511) === 0 && now() > deadline) {
        throw TIMEOUT;
      }
    },
  };

  let best = null;
  let reached = 0;
  const floor = depth ?? 1;
  const ceiling = depth ?? maxDepth;

  for (let d = floor; d <= ceiling; d += 1) {
    try {
      best = searchRoot(chess, d, ctx, spread);
      reached = d;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break; // keep the last depth that completed
    }
    // Nothing deeper will change a forced mate.
    if (best.length && Math.abs(best[0].score) > MATE / 2) break;
  }

  if (!best?.length) return null;

  // Any move within `spread` of the best is good enough to be interesting.
  // A forced win or loss is excluded: variety is worth having, throwing away
  // a mate to get it is not.
  const top = best[0].score;
  const nearBest = Math.abs(top) > MATE / 2
    ? best.filter((entry) => entry.score === top)
    : best.filter((entry) => entry.score >= top - spread);

  const pick = nearBest[Math.floor(random() * nearBest.length)] ?? best[0];
  return { ...pick, depth: reached };
}

export default chooseMove;
