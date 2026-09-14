/**
 * elemental.js
 * The rules of Elemental Chess, as pure functions over a FEN.
 *
 * Every piece on the board carries an element, and every element carries one
 * power that the piece may use ONCE in the whole match. Powers are free: using
 * one does not cost the turn, so a player may fire a power and then move as
 * normal. What limits them is that there are only ever sixteen charges a side,
 * they cannot be replenished, and only one standalone power may be used per
 * turn.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE IS PURE
 * ---------------------------------------------------------------------------
 * The variant needs to do two things ordinary chess cannot: remove pieces that
 * were not captured, and stop pieces moving that are otherwise free to. Both
 * live outside anything chess.js can represent, so they have to be layered on
 * top of it rather than pushed into it.
 *
 * Keeping that layer here — plain functions over a FEN string and a plain
 * effects list, importing nothing but constants — means the variant can be
 * reasoned about, and tested, without a session, an engine or a DOM. The
 * session (sessions/elemental-session.js) is the only place that holds this
 * state and drives an engine with it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MAKES THE REST SAFE
 * ---------------------------------------------------------------------------
 * A king can never be burned, frozen, shielded or struck by lightning.
 *
 * That is not a balance decision, or not only one. chess.js refuses a FEN with
 * a king missing ("Invalid FEN: missing black king" — verified against the
 * vendored 1.4.0), and a frozen king in check is a player with no legal reply
 * and no rule to say what that means. Keeping kings out of every effect keeps
 * checkmate, stalemate and the draws exactly as chess defines them, which is
 * what the whole variant rests on.
 */

import { FILES, RANKS } from './config.js';
import { boardFromFen, squareShade } from './board-shared.js';

/** The seven elements. */
export const ELEMENT = {
  FIRE: 'fire',
  WATER: 'water',
  LIGHTNING: 'lightning',
  ICE: 'ice',
  NATURE: 'nature',
  SHADOW: 'shadow',
  LIGHT: 'light',
};

/**
 * How a power is fired.
 *
 * `turn` powers are chosen and aimed by the player on their own turn, before
 * they move. `capture` powers are not chosen at all: they go off by themselves
 * when the piece that owns them takes something, because a choice you would
 * always make is not a choice, and a mid-move prompt would have to interrupt a
 * move that has already been played.
 */
export const POWER_TRIGGER = {
  TURN: 'turn',
  CAPTURE: 'capture',
};

/**
 * What a `turn` power needs aimed at it.
 *
 * `none` fires the moment it is chosen — there is nothing to point it at.
 */
export const POWER_AIM = {
  ENEMY: 'enemy',
  FRIEND: 'friend',
  EMPTY: 'empty',
  NONE: 'none',
};

/**
 * The elements, and the one power each of them grants.
 *
 * `piece` is what the element attaches to, and is decided by
 * elementAt() — the two must agree, and this table is the readable half.
 * Bishops are the interesting case: a bishop never changes the colour of the
 * squares it stands on for the whole game, so the pair splits cleanly and
 * permanently into one Water bishop and one Light bishop a side.
 */
export const ELEMENTS = {
  [ELEMENT.FIRE]: {
    id: ELEMENT.FIRE,
    emoji: '🔥',
    name: 'Fire',
    piece: 'Pawn',
    power: 'Burn',
    trigger: POWER_TRIGGER.CAPTURE,
    aim: POWER_AIM.NONE,
    blurb: 'When it captures, every enemy piece around it burns.',
    detail:
      'A Fire pawn that takes a piece sets light to all eight squares around '
      + 'the one it lands on. Every enemy piece standing there is destroyed. '
      + 'Kings do not burn.',
  },
  [ELEMENT.WATER]: {
    id: ELEMENT.WATER,
    emoji: '💧',
    name: 'Water',
    piece: 'Dark-squared bishop',
    power: 'Water Shield',
    trigger: POWER_TRIGGER.TURN,
    aim: POWER_AIM.FRIEND,
    blurb: 'Shields a friendly piece it can see for one turn.',
    detail:
      'Pick itself or the first friendly piece along any of its diagonals. '
      + 'That piece cannot be captured until your next turn comes round.',
  },
  [ELEMENT.LIGHTNING]: {
    id: ELEMENT.LIGHTNING,
    emoji: '⚡',
    name: 'Lightning',
    piece: 'Knight',
    power: 'Chain Attack',
    trigger: POWER_TRIGGER.CAPTURE,
    aim: POWER_AIM.NONE,
    blurb: 'When it captures, the strike arcs to a second enemy.',
    detail:
      'After a Lightning knight takes a piece, the strike jumps to the most '
      + 'valuable enemy piece a knight’s move from where it landed, and '
      + 'destroys that too. Kings are not struck.',
  },
  [ELEMENT.ICE]: {
    id: ELEMENT.ICE,
    emoji: '❄️',
    name: 'Ice',
    piece: 'Rook',
    power: 'Freeze',
    trigger: POWER_TRIGGER.TURN,
    aim: POWER_AIM.ENEMY,
    blurb: 'Freezes an enemy piece it can see for one turn.',
    detail:
      'Pick the first enemy piece along any of its rank or file. That piece '
      + 'cannot move on their next turn. Kings cannot be frozen.',
  },
  [ELEMENT.NATURE]: {
    id: ELEMENT.NATURE,
    emoji: '🌿',
    name: 'Nature',
    piece: 'Queen',
    power: 'Vines',
    trigger: POWER_TRIGGER.TURN,
    aim: POWER_AIM.EMPTY,
    blurb: 'Grows vines on an empty square it can see.',
    detail:
      'Pick any empty square the queen can reach. Until your next turn '
      + 'nothing may land on it or slide across it — including your own '
      + 'pieces. Vines block movement, not sight: a check still passes '
      + 'straight through them.',
  },
  [ELEMENT.SHADOW]: {
    id: ELEMENT.SHADOW,
    emoji: '🌑',
    name: 'Shadow',
    piece: 'King',
    power: 'Teleport',
    trigger: POWER_TRIGGER.TURN,
    aim: POWER_AIM.EMPTY,
    blurb: 'Slips away to any empty square where it would be safe.',
    detail:
      'Once in the match, and only to a square where the king would not be '
      + 'attacked and would not give check. It counts as having moved, so '
      + 'castling is gone afterwards. A charged enemy Light bishop holds the '
      + 'shadows shut and stops it entirely.',
  },
  [ELEMENT.LIGHT]: {
    id: ELEMENT.LIGHT,
    emoji: '✨',
    name: 'Light',
    piece: 'Light-squared bishop',
    power: 'Cleanse',
    trigger: POWER_TRIGGER.TURN,
    aim: POWER_AIM.NONE,
    blurb: 'Clears every effect on the board — and holds the enemy king.',
    detail:
      'Cleanse thaws frozen pieces, washes away shields and cuts down vines, '
      + 'wherever they are and whoever laid them. Until it is spent it also '
      + 'stops the enemy Shadow King teleporting — so choosing when to '
      + 'cleanse is choosing when to let their king run.',
  },
};

/** Ordered for display: the reading order of the rules card. */
export const ELEMENT_ORDER = [
  ELEMENT.FIRE,
  ELEMENT.WATER,
  ELEMENT.LIGHTNING,
  ELEMENT.ICE,
  ELEMENT.NATURE,
  ELEMENT.SHADOW,
  ELEMENT.LIGHT,
];

/** The three things a power can leave lying on the board. */
export const EFFECT = {
  FROZEN: 'frozen',
  SHIELD: 'shield',
  VINES: 'vines',
};

/**
 * How long an effect lasts, in half-moves.
 *
 * Two: the rest of the turn it was laid on, and the whole of the opponent's
 * reply. It then expires exactly as its owner's next turn begins, which is
 * what "for one turn" means from the far side of the board — and it is the
 * same cadence for all three effects, so a player only has to learn it once.
 */
export const EFFECT_PLIES = 2;

/**
 * Rough worth of each piece, for the two places this module has to choose a
 * target by itself: the lightning arc, and the bot's heuristics.
 *
 * Deliberately a separate table from the bot's own. bot.js runs inside a Web
 * Worker and is not importable from here, and a variant rule that silently
 * changed because somebody tuned the search would be a bad surprise.
 */
export const PIECE_WORTH = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// ---------------------------------------------------------------------------
// Geometry
//
// Squares are strings ("e4") everywhere else in the app, so they are strings
// here too; these four helpers are the only place the file/rank arithmetic
// behind them is done.
// ---------------------------------------------------------------------------

const fileOf = (square) => FILES.indexOf(square[0]);
const rankOf = (square) => RANKS.indexOf(square[1]);

function squareAt(file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${RANKS[rank]}`;
}

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_HOPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const NEIGHBOURS = QUEEN_DIRS;

/**
 * Walk one direction from a square until something stops the walk.
 * Returns the empty squares crossed and the first piece met, if any.
 */
function castRay(from, [df, dr], board) {
  const empties = [];
  let file = fileOf(from) + df;
  let rank = rankOf(from) + dr;

  while (true) {
    const square = squareAt(file, rank);
    if (!square) return { empties, blocker: null };
    const piece = board.get(square);
    if (piece) return { empties, blocker: { square, piece } };
    empties.push(square);
    file += df;
    rank += dr;
  }
}

/** Every square a piece would jump to from here, on or off the board. */
function hopsFrom(square, hops) {
  const file = fileOf(square);
  const rank = rankOf(square);
  return hops
    .map(([df, dr]) => squareAt(file + df, rank + dr))
    .filter(Boolean);
}

/**
 * The squares strictly between two aligned squares, or [] if they are not
 * aligned along a rank, file or diagonal.
 *
 * This is what makes vines block a slider's path rather than only its
 * destination. A knight is never aligned with where it lands in this sense, so
 * it jumps vines — which is the right answer and comes out for free.
 */
export function squaresBetween(from, to) {
  const df = Math.sign(fileOf(to) - fileOf(from));
  const dr = Math.sign(rankOf(to) - rankOf(from));
  const fileGap = Math.abs(fileOf(to) - fileOf(from));
  const rankGap = Math.abs(rankOf(to) - rankOf(from));

  const aligned = fileGap === 0 || rankGap === 0 || fileGap === rankGap;
  if (!aligned) return [];

  const between = [];
  let file = fileOf(from) + df;
  let rank = rankOf(from) + dr;
  while (squareAt(file, rank) && squareAt(file, rank) !== to) {
    between.push(squareAt(file, rank));
    file += df;
    rank += dr;
  }
  return between;
}

// ---------------------------------------------------------------------------
// Which element a piece carries
// ---------------------------------------------------------------------------

/**
 * The element of the piece standing on a square.
 *
 * A pure function of the piece and where it is, rather than something tracked
 * per piece — which means nothing has to be carried across a move, a capture
 * or a save, and a promoted piece simply arrives as whatever it has become.
 * Bishops are the only type that reads its square, and they can do so safely
 * because a bishop is stuck on one colour for the whole game.
 */
export function elementAt(piece, square) {
  if (!piece) return null;
  switch (piece.type) {
    case 'p': return ELEMENT.FIRE;
    case 'n': return ELEMENT.LIGHTNING;
    case 'r': return ELEMENT.ICE;
    case 'q': return ELEMENT.NATURE;
    case 'k': return ELEMENT.SHADOW;
    case 'b': return squareShade(square) === 'light' ? ELEMENT.LIGHT : ELEMENT.WATER;
    default: return null;
  }
}

/** The element record for a square, or null. */
export function elementInfoAt(piece, square) {
  const id = elementAt(piece, square);
  return id ? ELEMENTS[id] : null;
}

// ---------------------------------------------------------------------------
// Charges
//
// A charge is held by a piece, and pieces are only ever addressed by the
// square they stand on — so a charge is a square in a Set, and every move has
// to carry the Set along with it. followMove() below is that bookkeeping, and
// it is the one place in the variant where getting it wrong would quietly hand
// somebody a second charge.
// ---------------------------------------------------------------------------

/** Every occupied square at the start: all 32 pieces begin charged. */
export function startingCharges(fen) {
  return new Set(boardFromFen(fen).keys());
}

/** The square a pawn is actually taken from in an en passant capture. */
function enPassantVictim(move) {
  return `${move.to[0]}${move.from[1]}`;
}

/** Where the rook starts and ends in a castling move. */
function castlingRook(move) {
  const rank = move.to[1];
  return move.isKingsideCastle
    ? { from: `h${rank}`, to: `f${rank}` }
    : { from: `a${rank}`, to: `d${rank}` };
}

/**
 * Where a square's occupant ends up after a move, or null if it is gone.
 *
 * Everything attached to a piece — its charge, a shield on it, the ice holding
 * it — is remapped through here, so all of them follow a piece around the
 * board and all of them die with it, without any of the callers knowing how
 * castling or en passant work.
 */
export function followMove(square, move) {
  if (square === move.from) return move.to;
  // Whatever was standing on the destination has just been taken.
  if (square === move.to) return null;
  if (move.isEnPassant && square === enPassantVictim(move)) return null;
  if (move.isCastle) {
    const rook = castlingRook(move);
    if (square === rook.from) return rook.to;
  }
  return square;
}

/**
 * Carry the charges across a move.
 *
 * A promotion always lands charged, whether or not the pawn had already spent
 * itself getting there: the piece that arrives is a new one, and the walk down
 * the board has earned it.
 */
export function chargesAfterMove(charges, move) {
  const next = new Set();
  charges.forEach((square) => {
    const landed = followMove(square, move);
    if (landed) next.add(landed);
  });
  if (move.isPromotion) next.add(move.to);
  return next;
}

/** Drop the charges of pieces that a power has just destroyed. */
export function chargesAfterRemoval(charges, squares) {
  const next = new Set(charges);
  squares.forEach((square) => next.delete(square));
  return next;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * One effect on the board.
 * @typedef {{kind:string, square:string, color:string, until:number}} Effect
 *   `color` is whose side the effect belongs to: the owner of the piece for
 *   frozen and shield, and whoever laid them for vines. `until` is the ply at
 *   which it stops applying.
 */

/** The effects still applying at this ply. */
export function activeEffects(effects, ply) {
  return (effects ?? []).filter((effect) => ply < effect.until);
}

/** Those of them of one kind, as a square->effect map. */
function effectsOfKind(effects, ply, kind) {
  return new Map(
    activeEffects(effects, ply)
      .filter((effect) => effect.kind === kind)
      .map((effect) => [effect.square, effect]),
  );
}

/**
 * Carry the effects across a move, and drop the ones that have run out.
 *
 * Vines sit on a square rather than on a piece, so they stay put while
 * everything else travels. Expired effects are dropped here rather than merely
 * ignored so that a long game does not accumulate a list of dead ones in every
 * save it writes.
 */
export function effectsAfterMove(effects, move, ply) {
  return activeEffects(effects, ply)
    .map((effect) => {
      if (effect.kind === EFFECT.VINES) return effect;
      const landed = followMove(effect.square, move);
      return landed ? { ...effect, square: landed } : null;
    })
    .filter(Boolean);
}

/** Drop effects standing on squares a power has just cleared. */
export function effectsAfterRemoval(effects, squares) {
  const gone = new Set(squares);
  return effects.filter((effect) => effect.kind === EFFECT.VINES || !gone.has(effect.square));
}

// ---------------------------------------------------------------------------
// What the effects actually do to the move list
// ---------------------------------------------------------------------------

/**
 * Remove the moves the effects forbid.
 *
 * Three restrictions, and they only ever subtract: a frozen piece may not
 * move, a vined square may not be entered or crossed, and a shielded piece may
 * not be taken. Because they only subtract, chess.js' own verdicts stay
 * sound — if it says checkmate, it is checkmate, since the effects could not
 * have added the escape it failed to find.
 *
 * THE THAW. Subtracting can take the last move away from a player, which chess
 * has no word for: they are not mated and not stalemated, they are merely
 * stuck, and a game that ends there ends on an accident of bookkeeping. So the
 * effects give way instead — if filtering would leave nothing at all, nothing
 * is filtered, and the session clears the effects that did it. A player is
 * never frozen out of their own turn, and freezing can never stand in for
 * checkmate.
 */
export function filterMoves(moves, effects, ply) {
  const active = activeEffects(effects, ply);
  if (!active.length || !moves.length) return { moves, thawed: false };

  const frozen = new Set(
    active.filter((e) => e.kind === EFFECT.FROZEN).map((e) => e.square),
  );
  const shielded = new Set(
    active.filter((e) => e.kind === EFFECT.SHIELD).map((e) => e.square),
  );
  const vines = new Set(
    active.filter((e) => e.kind === EFFECT.VINES).map((e) => e.square),
  );

  const allowed = moves.filter((move) => {
    if (frozen.has(move.from)) return false;
    if (vines.has(move.to)) return false;
    if (vines.size && squaresBetween(move.from, move.to).some((sq) => vines.has(sq))) {
      return false;
    }
    if (move.isCapture) {
      const taken = move.isEnPassant ? enPassantVictim(move) : move.to;
      if (shielded.has(taken)) return false;
    }
    return true;
  });

  if (!allowed.length) return { moves, thawed: true };
  return { moves: allowed, thawed: false };
}

/** Is this one move allowed, given the effects? Used to vet the bot's choice. */
export function moveAllowed(move, effects, ply) {
  const { moves } = filterMoves([move], effects, ply);
  return moves.length > 0;
}

// ---------------------------------------------------------------------------
// Aiming a power
// ---------------------------------------------------------------------------

/**
 * The squares a power may be pointed at.
 *
 * Sight is worked out geometrically — walk the rays, take the first piece on
 * each — rather than by reading the piece's legal moves. A pinned rook can
 * still see down its file, and a rook is not blinded by its own king being in
 * check; legal moves would say otherwise on both counts, and a power that
 * quietly stopped working in a pin would be a bug nobody could explain.
 */
export function powerTargets({ element, square, fen, color, charges, isQuiet }) {
  const board = boardFromFen(fen);

  switch (element) {
    case ELEMENT.ICE:
      // The first piece down each rank and file, if it is a takeable enemy.
      return ROOK_DIRS
        .map((dir) => castRay(square, dir, board).blocker)
        .filter((hit) => hit && hit.piece.color !== color && hit.piece.type !== 'k')
        .map((hit) => hit.square);

    case ELEMENT.WATER: {
      // Itself, plus the first friend down each diagonal.
      const friends = BISHOP_DIRS
        .map((dir) => castRay(square, dir, board).blocker)
        .filter((hit) => hit && hit.piece.color === color && hit.piece.type !== 'k')
        .map((hit) => hit.square);
      return [square, ...friends];
    }

    case ELEMENT.NATURE:
      // Every empty square the queen could reach.
      return QUEEN_DIRS.flatMap((dir) => castRay(square, dir, board).empties);

    case ELEMENT.SHADOW:
      return teleportTargets({ square, fen, color, board, charges, isQuiet });

    default:
      return [];
  }
}

/**
 * Where the Shadow King may slip away to.
 *
 * Two conditions, and both are about keeping the position a legal one. The
 * king must not land where it is attacked, because a king standing in check on
 * its own turn is not a position chess.js can be handed. And it must not
 * DELIVER check either: teleporting out of a line can uncover a rook behind
 * it, which would leave the opponent in check on a turn that is not theirs —
 * a position chess.js will accept without complaint and then reason about
 * wrongly.
 *
 * Both are answered by probing rather than by a second attack generator of our
 * own: the caller passes `isQuiet`, which loads a candidate FEN into a real
 * engine and reports whether either king is in check. Writing the attack
 * detection again here would mean keeping two of them agreeing with each other
 * for ever, and the one that drifted would be this one.
 *
 * Sixty-odd probes for one power, once, while the player is deciding — which
 * is the cheapest moment in the whole game to spend them.
 */
function teleportTargets({ fen, color, board, charges, isQuiet }) {
  if (!canTeleport({ fen, color, charges })) return [];
  if (typeof isQuiet !== 'function') return [];

  const king = kingSquare(board, color);
  if (!king) return [];

  const safe = [];
  for (const file of FILES) {
    for (const rank of RANKS) {
      const candidate = `${file}${rank}`;
      if (board.has(candidate)) continue;
      if (isQuiet(relocateKing(fen, king, candidate))) safe.push(candidate);
    }
  }
  return safe;
}

/** Where a colour's king is standing, or null. */
function kingSquare(board, color) {
  for (const [square, piece] of board) {
    if (piece.type === 'k' && piece.color === color) return square;
  }
  return null;
}

/**
 * Is the Shadow King's power available at all?
 *
 * The Light counter lives here: while the enemy's light-squared bishop is
 * still on the board holding its charge, the shadows will not open. Spending
 * Cleanse is therefore also a decision to let their king run, which is the
 * whole of "Light counters Shadow" in one condition.
 */
export function canTeleport({ fen, color, charges }) {
  return !enemyLightBishop({ fen, color, charges });
}

/** The charged enemy Light bishop holding the shadows shut, or null. */
export function enemyLightBishop({ fen, color, charges }) {
  const board = boardFromFen(fen);
  for (const [square, piece] of board) {
    if (piece.color === color) continue;
    if (elementAt(piece, square) !== ELEMENT.LIGHT) continue;
    if (charges.has(square)) return square;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The two powers that ride along with a capture
// ---------------------------------------------------------------------------

/**
 * Everything a Fire pawn's landing square sets alight.
 *
 * The eight neighbours, enemy pieces only, kings excepted. The pawn's own
 * square is not in the list — it is standing in the fire and does not burn,
 * which is the only reading under which the power is worth using.
 */
export function burnSquares(landing, fen, color) {
  const board = boardFromFen(fen);
  return hopsFrom(landing, NEIGHBOURS).filter((square) => {
    const piece = board.get(square);
    return piece && piece.color !== color && piece.type !== 'k';
  });
}

/**
 * Where a Lightning knight's strike arcs to, or null if there is nothing to
 * jump to.
 *
 * A knight's move from where it landed, so the arc travels the same shape the
 * piece does. The most valuable enemy piece is chosen, and ties are broken by
 * square name — not because a1 deserves it, but because the choice has to be
 * the same every time it is worked out, including when a saved game is
 * reloaded and the arc is recomputed on a different device.
 */
export function arcTarget(landing, fen, color) {
  const board = boardFromFen(fen);
  const candidates = hopsFrom(landing, KNIGHT_HOPS)
    .map((square) => ({ square, piece: board.get(square) }))
    .filter(({ piece }) => piece && piece.color !== color && piece.type !== 'k');

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const worth = PIECE_WORTH[b.piece.type] - PIECE_WORTH[a.piece.type];
    return worth !== 0 ? worth : a.square.localeCompare(b.square);
  });
  return candidates[0].square;
}

// ---------------------------------------------------------------------------
// FEN surgery
//
// A power that changes the board does it by rewriting the FEN and reloading
// it, because chess.js has no way to express "this piece is simply gone". The
// cost is the move history: load() clears it (verified against the vendored
// 1.4.0), so PGN and undo only reach back as far as the last power that
// changed the position. Undo is already unavailable throughout the app, and
// the session persists elemental games by FEN for exactly this reason.
// ---------------------------------------------------------------------------

/** Split a FEN into its six fields, with the placement expanded to 64 cells. */
function readFen(fen) {
  const [placement, turn, castling, enPassant, halfmove, fullmove] = String(fen).split(' ');
  const cells = new Map();
  placement.split('/').forEach((row, rowIndex) => {
    const rank = RANKS[7 - rowIndex];
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      cells.set(`${FILES[file]}${rank}`, char);
      file += 1;
    }
  });
  return { cells, turn, castling, enPassant, halfmove, fullmove };
}

/** Put the six fields back together. */
function writeFen({ cells, turn, castling, enPassant, halfmove, fullmove }) {
  const rows = [];
  for (let rankIndex = 7; rankIndex >= 0; rankIndex -= 1) {
    let row = '';
    let gap = 0;
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const char = cells.get(`${FILES[fileIndex]}${RANKS[rankIndex]}`);
      if (char) {
        if (gap) row += String(gap);
        gap = 0;
        row += char;
      } else {
        gap += 1;
      }
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return [rows.join('/'), turn, castling || '-', enPassant || '-', halfmove, fullmove].join(' ');
}

/**
 * Castling rights, with any that no longer have a rook behind them removed.
 *
 * chess.js does NOT check this: it accepts "KQkq" with h1 empty and will then
 * offer a castle with a rook that burned down three moves ago. Verified
 * against the vendored 1.4.0, which is why this is done by hand here rather
 * than left to load() to notice.
 */
function pruneCastling(castling, cells) {
  if (!castling || castling === '-') return '-';
  const stillThere = {
    K: cells.get('h1') === 'R' && cells.get('e1') === 'K',
    Q: cells.get('a1') === 'R' && cells.get('e1') === 'K',
    k: cells.get('h8') === 'r' && cells.get('e8') === 'k',
    q: cells.get('a8') === 'r' && cells.get('e8') === 'k',
  };
  const kept = [...castling].filter((right) => stillThere[right]).join('');
  return kept || '-';
}

/**
 * Take pieces off the board without anybody having captured them.
 *
 * The halfmove clock resets: material has changed, which is progress in
 * exactly the sense the fifty-move rule is counting.
 */
export function removePieces(fen, squares) {
  const parsed = readFen(fen);
  squares.forEach((square) => parsed.cells.delete(square));
  parsed.castling = pruneCastling(parsed.castling, parsed.cells);
  parsed.halfmove = '0';
  return writeFen(parsed);
}

/**
 * Move the king to an empty square, mid-turn.
 *
 * The side to move is left alone: a power is free, so it is still the same
 * player's turn afterwards and they have their move to come. The en passant
 * square is left alone for the same reason — the capture it offers is still
 * on the table for the move they have not made yet, and clearing it would
 * quietly take a legal move away.
 */
export function relocateKing(fen, from, to) {
  const parsed = readFen(fen);
  const king = parsed.cells.get(from);
  if (!king) return fen;
  parsed.cells.delete(from);
  parsed.cells.set(to, king);
  // It has moved, so it may never castle again — and pruneCastling reads the
  // king's own square, so simply moving it is enough to drop both rights.
  parsed.castling = pruneCastling(parsed.castling, parsed.cells);
  return writeFen(parsed);
}

/**
 * The same position, with the other side to move.
 *
 * Only ever used to ask a question: "is THIS colour's king attacked?" An
 * engine will only answer that about the side to move, so the way to ask about
 * the other one is to hand it a position where they are. The result is thrown
 * away immediately and never played from — which is just as well, since the en
 * passant square it carries belongs to the turn that has been swapped out.
 */
export function withTurn(fen, color) {
  const parts = String(fen).split(' ');
  parts[1] = color;
  parts[3] = '-';
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Reading the state back out, for the views
// ---------------------------------------------------------------------------

/**
 * What the board should draw: an element and a charge for every piece, plus
 * whatever effects are standing on the squares.
 *
 * Built here rather than in either board renderer, so the flat board and the
 * WebGL one are working from one description and cannot drift apart.
 *
 * `marks` rather than `effects`, and deliberately: the state carries the real
 * effects too — the full records, with the ply they die on, which is what a
 * save needs — and two different shapes under one name in the same object is
 * a bug waiting for whichever of them gets spread second.
 */
export function describeBoard({ fen, charges, effects, ply }) {
  const board = boardFromFen(fen);
  const pieces = {};
  board.forEach((piece, square) => {
    const element = elementAt(piece, square);
    if (!element) return;
    pieces[square] = { element, charged: charges.has(square) };
  });

  const marks = {};
  activeEffects(effects, ply).forEach((effect) => {
    marks[effect.square] = effect.kind;
  });

  return { pieces, marks };
}

/**
 * The power the piece on this square is offering right now, or null.
 *
 * Answers one question for three callers — the power bar, the board's
 * targeting, and the bot — so "can this piece do something" is decided in one
 * place. A capture-triggered power is deliberately reported too, with
 * `ready: false`, because the bar still has something worth saying about a
 * Fire pawn: that it is loaded, and what will happen if it takes.
 */
export function powerAt({ square, fen, color, charges, isQuiet }) {
  const board = boardFromFen(fen);
  const piece = board.get(square);
  if (!piece || piece.color !== color) return null;
  if (!charges.has(square)) return null;

  const element = elementAt(piece, square);
  const info = ELEMENTS[element];
  if (!info) return null;

  if (info.trigger === POWER_TRIGGER.CAPTURE) {
    return { element, info, square, ready: false, targets: [] };
  }

  if (info.aim === POWER_AIM.NONE) {
    return { element, info, square, ready: true, targets: [] };
  }

  const targets = powerTargets({ element, square, fen, color, charges, isQuiet });
  // A Shadow King held shut by a charged enemy Light bishop is worth saying
  // out loud rather than leaving as a button that does nothing when pressed.
  const blockedBy = element === ELEMENT.SHADOW && !canTeleport({ fen, color, charges })
    ? ELEMENT.LIGHT
    : null;

  return { element, info, square, ready: targets.length > 0, targets, blockedBy };
}
