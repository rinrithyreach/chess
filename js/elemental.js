/**
 * elemental.js
 * The rules of Elemental Chess, as pure functions over a FEN.
 *
 * Every piece on the board carries an element, and every element carries one
 * power that the piece may use ONCE in the whole match.
 *
 * All seven are chosen and aimed by the player. Two of them — Fire and
 * Lightning — ALSO go off by themselves, free and unasked, when their piece
 * captures; nothing else about them is different.
 *
 * Powers are free in two senses. Using one does not cost the turn, so a player
 * may fire a power and then move as normal. And a power may be pointed
 * anywhere it makes sense — freeze any enemy piece, shield any piece of your
 * own, grow vines on any empty square — rather than only along the lines its
 * caster happens to be looking down.
 *
 * The exception is the two that DESTROY, and it is the only one in the file.
 * A power that removes material from any square on the board for the price of
 * one turn is not a power, it is a win button, so fire and lightning keep the
 * shape of the piece that owns them: the eight squares around the pawn, and a
 * knight's move from the knight. Walking the piece into position first is the
 * cost, and it is paid in the currency the game is already played in.
 *
 * That second sense used to be the other way round, and it was wrong. Reach
 * was worked out from the caster's rays, so at the opening bell five of the
 * seven powers had nothing to aim at: both rooks were walled in behind their
 * own pawns, the queen could not see an empty square, and a player who opened
 * the panel to see what they had was told, correctly and uselessly, that
 * almost none of it could be used. A resource you cannot spend is not a
 * decision, and the sightlines were adding a second layer of chess on top of
 * the one already being played rather than a layer of the variant.
 *
 * What limits powers instead is the thing that was always doing the real
 * work: there are only ever sixteen charges a side, one per piece, they cannot
 * be replenished, and only one standalone power may be used per turn. Ice is
 * still two freezes a game and no more, and losing a rook still costs you one
 * of them — so the pieces carrying the powers are still worth protecting.
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
import { ALL_SQUARES, boardFromFen, squareShade } from './board-shared.js';

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
 * What a power needs aimed at it.
 *
 * `none` fires the moment it is chosen — there is nothing to point it at.
 *
 * All seven are chosen and aimed by the player on their own turn. Two of them
 * — Fire and Lightning, marked `onCapture` in the table below — ALSO go off
 * by themselves when their piece takes something, for free and without being
 * asked, because a choice you would always make is not a choice and a mid-move
 * prompt would have to interrupt a move that has already been played.
 *
 * Those two used to be capture-only, which made two of the seven rows in the
 * powers panel permanently unpressable: loaded, explained, and impossible to
 * do anything with. Being given something you may not use is worse than not
 * having it, and worse than either is being shown it in a list of buttons.
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
    onCapture: true,
    aim: POWER_AIM.ENEMY,
    blurb: 'Sets light to everything around one of your pawns.',
    detail:
      'Pick an enemy piece standing next to one of your Fire pawns. That '
      + 'pawn goes up, and every enemy piece on the eight squares around it '
      + 'is destroyed — not only the one you pointed at. It also happens by '
      + 'itself, free, whenever a Fire pawn captures. Kings do not burn.',
  },
  [ELEMENT.WATER]: {
    id: ELEMENT.WATER,
    emoji: '💧',
    name: 'Water',
    piece: 'Dark-squared bishop',
    power: 'Water Shield',
    aim: POWER_AIM.FRIEND,
    blurb: 'Shields any one of your pieces for a turn.',
    detail:
      'Pick any piece of your own, itself included, anywhere on the board. '
      + 'That piece cannot be captured until your next turn comes round. '
      + 'Kings cannot be shielded.',
  },
  [ELEMENT.LIGHTNING]: {
    id: ELEMENT.LIGHTNING,
    emoji: '⚡',
    name: 'Lightning',
    piece: 'Knight',
    power: 'Chain Attack',
    onCapture: true,
    aim: POWER_AIM.ENEMY,
    blurb: 'Strikes an enemy a knight’s move away, then arcs on.',
    detail:
      'Pick an enemy piece a knight’s move from one of your Lightning '
      + 'knights. It is destroyed, and the strike arcs on to the most '
      + 'valuable enemy a knight’s move from THAT square, which is destroyed '
      + 'too. It also happens by itself, free, whenever a Lightning knight '
      + 'captures. Kings are not struck.',
  },
  [ELEMENT.ICE]: {
    id: ELEMENT.ICE,
    emoji: '❄️',
    name: 'Ice',
    piece: 'Rook',
    power: 'Freeze',
    aim: POWER_AIM.ENEMY,
    blurb: 'Freezes any one enemy piece for a turn.',
    detail:
      'Pick any enemy piece anywhere on the board. It cannot move on their '
      + 'next turn. Kings cannot be frozen.',
  },
  [ELEMENT.NATURE]: {
    id: ELEMENT.NATURE,
    emoji: '🌿',
    name: 'Nature',
    piece: 'Queen',
    power: 'Vines',
    aim: POWER_AIM.EMPTY,
    blurb: 'Grows vines on any empty square.',
    detail:
      'Pick any empty square on the board. Until your next turn nothing may '
      + 'land on it or slide across it — including your own pieces. Vines '
      + 'block movement, not sight: a check still passes straight through '
      + 'them.',
  },
  [ELEMENT.SHADOW]: {
    id: ELEMENT.SHADOW,
    emoji: '🌑',
    name: 'Shadow',
    piece: 'King',
    power: 'Teleport',
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

const KNIGHT_HOPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

/** The eight squares around one — the shape a Fire pawn's capture burns. */
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

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
 * Three of them are the whole board, filtered only by what the power is for:
 * an enemy to freeze, a piece of your own to shield, an empty square to grow
 * vines on. Kings are excluded from the first two by the rule at the top of
 * this file, which is the only exclusion any of them carries. For those three
 * the caster's square is not read at all, which is the point rather than an
 * oversight — every charged rook offers exactly the same freeze, so "which
 * rook casts it" is not a question worth asking the player.
 *
 * FIRE AND LIGHTNING ARE THE EXCEPTION, and deliberately. They are the two
 * that destroy, and a power that removes material from anywhere on the board
 * for the price of one turn is not a power, it is a win button. So they keep
 * the shape of the piece that owns them: fire reaches the eight squares around
 * its pawn, lightning reaches a knight's move from its knight. You have to
 * have walked the piece into position first, which is the cost, and it is paid
 * in the currency the game is already played in.
 *
 * Teleport is the one whose reach is genuinely a computation, because the only
 * squares a king may appear on are the ones that leave the position legal for
 * both sides. It gets its own function below.
 */
export function powerTargets({ element, square, fen, color, charges, isQuiet }) {
  const board = boardFromFen(fen);
  const pieces = (keep) => {
    const found = [];
    board.forEach((piece, at) => { if (keep(piece)) found.push(at); });
    return found;
  };

  // Enemies this piece could destroy, at the hops its own shape allows.
  const reachable = (hops) => hopsFrom(square, hops).filter((at) => {
    const piece = board.get(at);
    return piece && piece.color !== color && piece.type !== 'k';
  });

  switch (element) {
    case ELEMENT.ICE:
      return pieces((piece) => piece.color !== color && piece.type !== 'k');

    case ELEMENT.WATER:
      // Its own square is in here already: the bishop is one of your pieces,
      // and shielding itself is a perfectly ordinary thing to want.
      return pieces((piece) => piece.color === color && piece.type !== 'k');

    case ELEMENT.NATURE:
      return ALL_SQUARES.filter((at) => !board.has(at));

    case ELEMENT.SHADOW:
      return teleportTargets({ square, fen, color, board, charges, isQuiet });

    // The aimed square is only where you point. Burn takes the whole ring
    // around the pawn either way — see burnSquares, which is what actually
    // decides, and which the capture trigger calls too.
    case ELEMENT.FIRE:
      return reachable(NEIGHBOURS);

    case ELEMENT.LIGHTNING:
      return reachable(KNIGHT_HOPS);

    default:
      return [];
  }
}

/**
 * Everything a power would destroy if it were cast at this square, and what
 * that is worth.
 *
 * Only the two destroying powers have an answer; everything else returns
 * nothing, because freezing a queen does not remove her and pretending it is
 * worth 900 would have the bot trading a charge for a delay.
 *
 * Used twice: to sort the casters a panel might fire from, so that choosing
 * "Burn" with four pawns in contact picks the one that burns the most, and by
 * the bot, which has no other way to tell a good burn from a pointless one.
 */
export function castDamage({ element, square, target, fen, color }) {
  if (element !== ELEMENT.FIRE && element !== ELEMENT.LIGHTNING) {
    return { squares: [], worth: 0 };
  }

  const squares = element === ELEMENT.FIRE
    ? burnSquares(square, fen, color)
    : arcSquares(target, fen, color);

  const board = boardFromFen(fen);
  const worth = squares.reduce(
    (sum, at) => sum + (PIECE_WORTH[board.get(at)?.type] ?? 0),
    0,
  );
  return { squares, worth };
}

/**
 * The struck square and wherever the bolt arcs on to from it.
 *
 * The arc is measured from the SQUARE THAT WAS HIT rather than from the
 * knight, which is what makes it a chain rather than a second shot: the bolt
 * goes where it has just been, and a knight with one enemy in range still only
 * gets one kill out of it.
 */
export function arcSquares(struck, fen, color) {
  if (!struck) return [];
  const onward = arcTarget(struck, fen, color);
  return onward ? [struck, onward] : [struck];
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
 * place.
 */
export function powerAt({ square, fen, color, charges, isQuiet }) {
  const board = boardFromFen(fen);
  const piece = board.get(square);
  if (!piece || piece.color !== color) return null;
  if (!charges.has(square)) return null;

  const element = elementAt(piece, square);
  const info = ELEMENTS[element];
  if (!info) return null;

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

/**
 * Every power the side to move still holds, in a fixed order.
 *
 * powerAt() answers "what can THIS piece do", which is the right question once
 * a piece is already in your hand. This answers the other one — "what do I
 * still have" — which is the question asked before anything is picked up, and
 * which the board on its own cannot answer: a charge is a small glyph on a
 * square, so counting what is left means reading all sixty-four of them and
 * knowing by heart which element each piece carries.
 *
 * One row per element, always, in ELEMENT_ORDER — including the ones that are
 * spent. A panel drawn from this keeps the same seven rows in the same places
 * for the whole match, so a power running out leaves a gap where it was
 * instead of letting the rest shuffle up under the player's thumb.
 *
 * `ready` is the subset of `squares` that could fire right now, best first.
 *
 * "Best" only means anything for the two that destroy, and for them it means
 * a great deal: four pawns in contact with the enemy are four quite different
 * burns, and the panel fires from ready[0] without asking. Sorting here rather
 * than choosing there keeps the judgement beside PIECE_WORTH, which is the
 * only thing in the app entitled to say what a piece is worth to this variant.
 * For the other five every caster is interchangeable and the order is board
 * order, which is as good as any.
 */
export function arsenal({ fen, color, charges, isQuiet }) {
  const board = boardFromFen(fen);
  const held = new Map(ELEMENT_ORDER.map((id) => [id, []]));

  board.forEach((piece, square) => {
    if (piece.color !== color || !charges.has(square)) return;
    const element = elementAt(piece, square);
    if (element) held.get(element)?.push(square);
  });

  return ELEMENT_ORDER.map((element) => {
    const info = ELEMENTS[element];
    const squares = held.get(element) ?? [];

    const ready = squares
      .filter((square) => powerAt({ square, fen, color, charges, isQuiet })?.ready)
      .map((square) => ({
        square,
        worth: castDamage({ element, square, fen, color }).worth,
      }))
      .sort((a, b) => (b.worth - a.worth) || a.square.localeCompare(b.square))
      .map((entry) => entry.square);

    // Said out loud rather than left as an empty `ready`, because "nothing in
    // reach" and "their Light bishop is holding this shut" are different
    // problems and only one of them is worth waiting for.
    const blockedBy = element === ELEMENT.SHADOW
      && squares.length > 0
      && !canTeleport({ fen, color, charges })
      ? ELEMENT.LIGHT
      : null;

    return { element, info, squares, ready, blockedBy };
  });
}
