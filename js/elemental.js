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
import { ALL_SQUARES, boardFromFen, squareDistance, squareShade } from './board-shared.js';

/** The seventeen elements. */
export const ELEMENT = {
  FIRE: 'fire',
  WATER: 'water',
  LIGHTNING: 'lightning',
  ICE: 'ice',
  NATURE: 'nature',
  SHADOW: 'shadow',
  LIGHT: 'light',
  METAL: 'metal',
  VOID: 'void',
  SUN: 'sun',
  MOON: 'moon',
  BLOOD: 'blood',
  SPIRIT: 'spirit',
  GRAVITY: 'gravity',
  TIME: 'time',
  CRYSTAL: 'crystal',
  SPACE: 'space',
};

/**
 * What a power needs aimed at it.
 *
 * `none` fires the moment it is chosen — there is nothing to point it at.
 *
 * All of them are chosen and aimed by the player on their own turn. Two —
 * Fire and Lightning, marked `onCapture` in the table below — ALSO go off by
 * themselves when their piece takes something, for free and without being
 * asked, because a choice you would always make is not a choice and a mid-move
 * prompt would have to interrupt a move that has already been played.
 *
 * Those two used to be capture-only, which made two of the rows in the powers
 * panel permanently unpressable: loaded, explained, and impossible to do
 * anything with. Being given something you may not use is worse than not
 * having it, and worse than either is being shown it in a list of buttons.
 */
export const POWER_AIM = {
  ENEMY: 'enemy',
  FRIEND: 'friend',
  EMPTY: 'empty',
  NONE: 'none',
};

/**
 * ---------------------------------------------------------------------------
 * SLOTS, AND WHY THERE IS A LOADOUT
 * ---------------------------------------------------------------------------
 * An element used to be a pure function of a piece and its square: pawns were
 * Fire, rooks were Ice, and bishops split by the colour of square they are
 * stuck on for the whole game. That is a lovely rule and it has exactly one
 * failing — it can only ever name as many elements as there are kinds of
 * piece, which is seven.
 *
 * There are seventeen now, and a side only ever has sixteen pieces, so no
 * assignment can put all of them on the board at once. That is not a problem
 * to be worked around; it is the game. Before a match the players choose which
 * elements they are bringing, and the roster is free to grow past the board
 * for ever afterwards.
 *
 * A SLOT is the kind of piece an element wants to ride on, and the slots hold
 * sixteen between them — eight pawns, two rooks, two knights, one bishop of
 * each colour, a queen and a king. An element declares one slot; a slot with
 * more elements than squares is a choice, and a slot with exactly as many is
 * settled. Today only the pawns are contested — nine elements for eight
 * squares — so the loadout is "which eight do you bring". Add a second queen
 * element tomorrow and the queen slot becomes a choice too, with no other code
 * needing to hear about it.
 */
export const SLOT = {
  PAWN: 'pawn',
  ROOK_A: 'rookA',
  ROOK_H: 'rookH',
  KNIGHT_B: 'knightB',
  KNIGHT_G: 'knightG',
  BISHOP_DARK: 'bishopDark',
  BISHOP_LIGHT: 'bishopLight',
  QUEEN: 'queen',
  KING: 'king',
};

/** How many pieces each slot puts on the board, per side. */
export const SLOT_SIZE = {
  [SLOT.PAWN]: 8,
  [SLOT.ROOK_A]: 1,
  [SLOT.ROOK_H]: 1,
  [SLOT.KNIGHT_B]: 1,
  [SLOT.KNIGHT_G]: 1,
  [SLOT.BISHOP_DARK]: 1,
  [SLOT.BISHOP_LIGHT]: 1,
  [SLOT.QUEEN]: 1,
  [SLOT.KING]: 1,
};

/**
 * The elements, and the one power each of them grants.
 *
 * `slot` is the kind of piece it rides on. `piece` is the same fact in the
 * words the rules card uses, and the two must agree — this table is the
 * readable half and assignElements() below is the half that decides.
 *
 * Bishops remain the interesting case: a bishop never changes the colour of
 * the squares it stands on for the whole game, so the pair splits cleanly and
 * permanently into one dark-squared slot and one light-squared slot a side.
 */
export const ELEMENTS = {
  [ELEMENT.FIRE]: {
    id: ELEMENT.FIRE,
    emoji: '\u{1F525}',
    name: 'Fire',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Burn',
    onCapture: true,
    aim: POWER_AIM.ENEMY,
    blurb: 'Sets light to everything around your Fire pawn.',
    detail:
      'Pick an enemy piece standing next to your Fire pawn. That pawn goes '
      + 'up, and every enemy piece on the eight squares around it is '
      + 'destroyed — not only the one you pointed at. It also happens by '
      + 'itself, free, whenever the Fire pawn captures. Kings do not burn.',
  },
  [ELEMENT.WATER]: {
    id: ELEMENT.WATER,
    emoji: '\u{1F4A7}',
    name: 'Water',
    slot: SLOT.BISHOP_DARK,
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
    slot: SLOT.KNIGHT_B,
    piece: 'Queen’s knight',
    power: 'Chain Attack',
    onCapture: true,
    aim: POWER_AIM.ENEMY,
    blurb: 'Strikes an enemy a knight’s move away, then arcs on.',
    detail:
      'Pick an enemy piece a knight’s move from your Lightning knight. It '
      + 'is destroyed, and the strike arcs on to the most valuable enemy a '
      + 'knight’s move from THAT square, which is destroyed too. It also '
      + 'happens by itself, free, whenever the Lightning knight captures. '
      + 'Kings are not struck.',
  },
  [ELEMENT.ICE]: {
    id: ELEMENT.ICE,
    emoji: '❄️',
    name: 'Ice',
    slot: SLOT.ROOK_A,
    piece: 'Queen’s rook',
    power: 'Freeze',
    aim: POWER_AIM.ENEMY,
    blurb: 'Freezes any one enemy piece for a turn.',
    detail:
      'Pick any enemy piece anywhere on the board. It cannot move on their '
      + 'next turn. Kings cannot be frozen.',
  },
  [ELEMENT.NATURE]: {
    id: ELEMENT.NATURE,
    emoji: '\u{1F33F}',
    name: 'Nature',
    slot: SLOT.QUEEN,
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
    emoji: '\u{1F311}',
    name: 'Shadow',
    slot: SLOT.KING,
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
    slot: SLOT.BISHOP_LIGHT,
    piece: 'Light-squared bishop',
    power: 'Cleanse',
    aim: POWER_AIM.NONE,
    blurb: 'Clears every effect on the board — and holds the enemy king.',
    detail:
      'Cleanse thaws frozen pieces, washes away shields, armour and crystal, '
      + 'cuts down vines and lifts silence, wherever they are and whoever '
      + 'laid them. Until it is spent it also stops the enemy Shadow King '
      + 'teleporting — so choosing when to cleanse is choosing when to let '
      + 'their king run.',
  },

  // ---------------------------------------------------------------------
  // The ten added afterwards.
  //
  // Every one of them was asked for in terms the game does not have: armour
  // that reduces damage, health to spend on a stronger attack, a move taken
  // back. Chess has no hit points and no damage numbers, so each is written
  // here as the nearest thing the board can actually say, and the wording in
  // `detail` is the rule rather than a description of one.
  // ---------------------------------------------------------------------

  [ELEMENT.METAL]: {
    id: ELEMENT.METAL,
    emoji: '⚙️',
    name: 'Metal',
    slot: SLOT.ROOK_H,
    piece: 'King’s rook',
    power: 'Bulwark',
    aim: POWER_AIM.FRIEND,
    blurb: 'Armours one of your pieces against every power.',
    detail:
      'Pick any piece of your own. Until your next turn no power may destroy '
      + 'it, freeze it, silence it or drag it anywhere. Armour is proof '
      + 'against powers and not against pieces, so it can still be captured '
      + 'by an ordinary move — that is the whole difference between it and '
      + 'a water shield. Kings need no armour and cannot be given it.',
  },
  [ELEMENT.VOID]: {
    id: ELEMENT.VOID,
    emoji: '\u{1F573}️',
    name: 'Void',
    slot: SLOT.KNIGHT_G,
    piece: 'King’s knight',
    power: 'Silence',
    aim: POWER_AIM.ENEMY,
    blurb: 'Shuts one enemy piece’s power off for a turn.',
    detail:
      'Pick any enemy piece that still holds a charge. It keeps the charge '
      + 'but cannot spend it until your next turn. The enemy king is a legal '
      + 'target, and is the only effect in the game it is: silence takes '
      + 'nothing away from how a piece MOVES, so holding a king’s teleport '
      + 'shut is safe where freezing the king would not be.',
  },
  [ELEMENT.SUN]: {
    id: ELEMENT.SUN,
    emoji: '☀️',
    name: 'Sun',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Solar Flare',
    aim: POWER_AIM.ENEMY,
    blurb: 'Burns an enemy down a line, and recharges an ally.',
    detail:
      'Pick the first enemy piece on any rank, file or diagonal out of your '
      + 'Sun pawn, up to three squares away with nothing in between. It is '
      + 'destroyed, and the nearest spent piece of your own gets its power '
      + 'back. Kings do not burn.',
  },
  [ELEMENT.MOON]: {
    id: ELEMENT.MOON,
    emoji: '\u{1F319}',
    name: 'Moon',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Tide',
    aim: POWER_AIM.ENEMY,
    blurb: 'Draws a whole rank of them back down the board.',
    detail:
      'Pick an enemy piece. It and every other enemy piece on its rank are '
      + 'pulled one square back towards their own side, wherever the square '
      + 'behind them is empty. Nothing is destroyed and nothing is captured '
      + '— the board simply moves. Kings do not feel the tide, and a pawn '
      + 'is never pulled onto its own back rank.',
  },
  [ELEMENT.BLOOD]: {
    id: ELEMENT.BLOOD,
    emoji: '\u{1FA78}',
    name: 'Blood',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Bloodletting',
    aim: POWER_AIM.ENEMY,
    blurb: 'Spends its own life to take something of theirs.',
    detail:
      'Your Blood pawn dies where it stands, and any one enemy piece '
      + 'anywhere on the board worth no more than a rook dies with it. The '
      + 'reach is the whole board because the cost is a whole piece — this '
      + 'is the one power paid for twice. Queens are beyond it, and so are '
      + 'kings.',
  },
  [ELEMENT.SPIRIT]: {
    id: ELEMENT.SPIRIT,
    emoji: '\u{1F47B}',
    name: 'Spirit',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Revive',
    aim: POWER_AIM.EMPTY,
    blurb: 'Calls the last piece you lost back to the board.',
    detail:
      'Pick an empty square in your own half. The piece you lost most '
      + 'recently stands up on it, spent — it comes back with no power of '
      + 'its own. A pawn will not come back onto the back rank, and nothing '
      + 'comes back if you have lost nothing yet.',
  },
  [ELEMENT.GRAVITY]: {
    id: ELEMENT.GRAVITY,
    emoji: '\u{1F300}',
    name: 'Gravity',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Pull',
    aim: POWER_AIM.ENEMY,
    blurb: 'Drags an enemy piece one square towards your pawn.',
    detail:
      'Pick any enemy piece on the board that has an empty square on the '
      + 'side facing your Gravity pawn. It is dragged one square that way. '
      + 'Nothing is captured — a dragged piece is a piece that has moved '
      + 'without their turn being spent on it. Kings hold their ground.',
  },
  [ELEMENT.TIME]: {
    id: ELEMENT.TIME,
    emoji: '⏳',
    name: 'Time',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Rewind',
    aim: POWER_AIM.NONE,
    blurb: 'Puts their last move back where it came from.',
    detail:
      'The piece your opponent has just moved returns to the square it came '
      + 'from, and the turn they spent on it is gone. Rewind takes back a '
      + 'move, not a capture: it will not undo a move that took something, a '
      + 'castle or a promotion, and it needs the square they left to still '
      + 'be empty.',
  },
  [ELEMENT.CRYSTAL]: {
    id: ELEMENT.CRYSTAL,
    emoji: '\u{1F48E}',
    name: 'Crystal',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Prism',
    aim: POWER_AIM.FRIEND,
    blurb: 'A shield that throws powers back at whoever cast them.',
    detail:
      'Pick any piece of your own. Until your next turn it cannot be '
      + 'captured, and any enemy power aimed squarely at it rebounds: the '
      + 'power is spent, nothing happens to your piece, and the piece that '
      + 'cast it is destroyed instead. Kings cannot be given the crystal.',
  },
  [ELEMENT.SPACE]: {
    id: ELEMENT.SPACE,
    emoji: '\u{1F30C}',
    name: 'Space',
    slot: SLOT.PAWN,
    piece: 'Pawn',
    power: 'Displace',
    aim: POWER_AIM.FRIEND,
    blurb: 'Changes places with any one of your own pieces.',
    detail:
      'Pick any piece of your own but the king, anywhere on the board. It '
      + 'and your Space pawn swap squares. Both keep everything they were '
      + 'carrying, and the swap is refused if it would leave your king in '
      + 'check.',
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
  ELEMENT.METAL,
  ELEMENT.VOID,
  ELEMENT.SUN,
  ELEMENT.MOON,
  ELEMENT.BLOOD,
  ELEMENT.SPIRIT,
  ELEMENT.GRAVITY,
  ELEMENT.TIME,
  ELEMENT.CRYSTAL,
  ELEMENT.SPACE,
];

/**
 * The elements competing for each slot, in roster order.
 *
 * Derived rather than written out, so adding a row to ELEMENTS is the whole of
 * adding an element to the game: the loadout screen, the assignment and the
 * counts all read this.
 */
export const SLOT_CANDIDATES = ELEMENT_ORDER.reduce((slots, id) => {
  const { slot } = ELEMENTS[id];
  (slots[slot] ??= []).push(id);
  return slots;
}, {});

/** Slots holding more elements than squares: the ones a player actually picks. */
export const CONTESTED_SLOTS = Object.keys(SLOT_CANDIDATES)
  .filter((slot) => SLOT_CANDIDATES[slot].length > SLOT_SIZE[slot]);

/**
 * The elements a side brings by default: the first that fit in every slot.
 *
 * Roster order rather than anything cleverer, because the default has to be
 * stable. A saved game is restored by laying its loadout back out over the
 * board, and a default that depended on the day would quietly reassign a
 * position somebody left half-played.
 */
export function defaultLoadout() {
  return ELEMENT_ORDER.filter((id) => {
    const { slot } = ELEMENTS[id];
    return SLOT_CANDIDATES[slot].indexOf(id) < SLOT_SIZE[slot];
  });
}

/**
 * A chosen list of elements, made safe to build a board from.
 *
 * Anything unknown is dropped, any slot with too many is trimmed to its size
 * in roster order, and any slot left short is topped up from the elements the
 * player did not pick. It always returns a list that fills all sixteen
 * squares, because the alternative — a piece with no element — is a piece
 * holding a charge nobody can spend and a glyph nobody can draw.
 */
export function normalizeLoadout(chosen) {
  const wanted = new Set(
    (Array.isArray(chosen) ? chosen : []).filter((id) => ELEMENTS[id]),
  );

  return Object.keys(SLOT_CANDIDATES).flatMap((slot) => {
    const candidates = SLOT_CANDIDATES[slot];
    const picked = candidates.filter((id) => wanted.has(id));
    const rest = candidates.filter((id) => !wanted.has(id));
    return [...picked, ...rest].slice(0, SLOT_SIZE[slot]);
  });
}

/**
 * The supers: one per element, and the only thing in the variant that costs a
 * move.
 *
 * Every ordinary power is free — fire it and still play your turn — which is
 * what stops the powers being a second game bolted on beside the chess. A
 * super inverts exactly that one rule and nothing else: it spends the charge
 * the ordinary power would have spent, AND it is your whole turn. You fire it
 * instead of moving.
 *
 * That is the entire price, and it is deliberately enormous. Giving up a move
 * in a game of chess is the most expensive thing a player can do, so a super
 * can be as loud as it likes without becoming the obvious choice: the question
 * is never "is this good" but "is this better than the move I am not making".
 * It also needs no new economy — no cooldowns, no second currency, no counter
 * to keep on screen — and it scales to every element evenly, which two charges
 * of the same element would not: most of the roster has only one piece to draw
 * a charge from.
 *
 * A super cannot be fired while your own king is in check. Passing the turn
 * there would hand the opponent a king they could simply take, which is not a
 * position chess has a word for.
 *
 * `aim` reads exactly as it does for an ordinary power. The ones that aim at
 * nothing fire the moment they are chosen, because what they do is already
 * decided by the board.
 */
export const SUPERS = {
  [ELEMENT.FIRE]: {
    element: ELEMENT.FIRE,
    power: 'Firestorm',
    aim: POWER_AIM.NONE,
    blurb: 'Every pawn of yours that is in contact goes up at once.',
    detail:
      'Every pawn of yours still holding its charge with an enemy piece '
      + 'beside it erupts together, and everything around each of them burns. '
      + 'All of those pawns are spent, whatever element they were carrying — '
      + 'the fire takes the whole front rank with it. Kings do not burn.',
  },
  [ELEMENT.WATER]: {
    element: ELEMENT.WATER,
    power: 'Tidal Guard',
    aim: POWER_AIM.NONE,
    blurb: 'Nothing of yours can be taken for a turn.',
    detail:
      'Every piece you have is shielded until your next turn comes round, '
      + 'not just the one. Kings cannot be shielded, so yours is the one '
      + 'piece the tide does not cover.',
  },
  [ELEMENT.LIGHTNING]: {
    element: ELEMENT.LIGHTNING,
    power: 'Thunderstorm',
    aim: POWER_AIM.ENEMY,
    blurb: 'The bolt keeps going: three pieces, not two.',
    detail:
      'Pick an enemy a knight’s move from your Lightning knight. It is '
      + 'destroyed, and the bolt arcs on twice more — each time to the most '
      + 'valuable enemy a knight’s move from where it just struck. Kings are '
      + 'not struck.',
  },
  [ELEMENT.ICE]: {
    element: ELEMENT.ICE,
    power: 'Deep Freeze',
    aim: POWER_AIM.ENEMY,
    blurb: 'Freezes a piece and everything standing around it.',
    detail:
      'Pick any enemy piece anywhere. It and every enemy piece on the eight '
      + 'squares around it are frozen until your next turn. Kings cannot be '
      + 'frozen, and a king standing in the middle of it is simply skipped.',
  },
  [ELEMENT.NATURE]: {
    element: ELEMENT.NATURE,
    power: 'Overgrowth',
    aim: POWER_AIM.EMPTY,
    blurb: 'A thicket, not a square — three by three.',
    detail:
      'Pick any empty square. It and every empty square around it grow vines '
      + 'until your next turn: nothing may land on them or slide across them, '
      + 'including your own pieces. Vines block movement, not sight.',
  },
  [ELEMENT.SHADOW]: {
    element: ELEMENT.SHADOW,
    power: 'Shadow Swap',
    aim: POWER_AIM.FRIEND,
    blurb: 'Your king changes places with one of your own pieces.',
    detail:
      'Pick any piece of your own, anywhere on the board. It and your king '
      + 'swap squares — one power, two pieces moved — provided the king would '
      + 'not be in check where it lands. It counts as having moved, so '
      + 'castling is gone afterwards. A charged enemy Light bishop holds the '
      + 'shadows shut and stops this too.',
  },
  [ELEMENT.LIGHT]: {
    element: ELEMENT.LIGHT,
    power: 'Dawn',
    aim: POWER_AIM.FRIEND,
    blurb: 'Clears the board, and gives a spent piece its charge back.',
    detail:
      'Every effect on the board is washed away, whoever laid it, and the '
      + 'piece you point at gets its power back. It is one of only two ways a '
      + 'charge ever returns — point it at something that has already fired.',
  },

  // ---------------------------------------------------------------------
  // The ten added afterwards. Same economy, same price: each is its
  // element's ordinary power asked to do the same thing over a wider piece
  // of board, or asked to drop the one limit that made the small version
  // fair.
  // ---------------------------------------------------------------------

  [ELEMENT.METAL]: {
    element: ELEMENT.METAL,
    power: 'Ironclad',
    aim: POWER_AIM.NONE,
    blurb: 'Every piece you have is proof against powers for a turn.',
    detail:
      'Armour on all of them at once rather than the one: until your next '
      + 'turn nothing of theirs may destroy, freeze, silence or drag anything '
      + 'of yours. They can still take your pieces with their pieces. Kings '
      + 'need no armour and do not get any.',
  },
  [ELEMENT.VOID]: {
    element: ELEMENT.VOID,
    power: 'Nullify',
    aim: POWER_AIM.NONE,
    blurb: 'Silences their whole army, and sweeps their effects away.',
    detail:
      'Every enemy piece is silenced until your next turn — they keep their '
      + 'charges and cannot spend one of them — and every effect THEY have '
      + 'laid on the board is gone. Yours are left standing, which is the one '
      + 'thing this does that Cleanse will not.',
  },
  [ELEMENT.SUN]: {
    element: ELEMENT.SUN,
    power: 'Solstice',
    aim: POWER_AIM.NONE,
    blurb: 'Every line out of the Sun fires at once.',
    detail:
      'The first enemy piece on each of the eight lines out of your Sun '
      + 'pawn, up to three squares away, is destroyed — all of them together '
      + '— and every piece of your own standing beside that pawn gets its '
      + 'power back. Kings do not burn.',
  },
  [ELEMENT.MOON]: {
    element: ELEMENT.MOON,
    power: 'Spring Tide',
    aim: POWER_AIM.NONE,
    blurb: 'The whole enemy army is drawn back one square.',
    detail:
      'Every enemy piece on the board is pulled one square back towards '
      + 'their own side, wherever the square behind it is empty. Nothing is '
      + 'destroyed; a developed position simply stops being one. Kings do not '
      + 'feel the tide, and a pawn is never pulled onto its own back rank.',
  },
  [ELEMENT.BLOOD]: {
    element: ELEMENT.BLOOD,
    power: 'Bloodrite',
    aim: POWER_AIM.ENEMY,
    blurb: 'The same bargain, with nothing held back.',
    detail:
      'Your Blood pawn dies where it stands and takes any one enemy piece on '
      + 'the board with it — the queen included, which the ordinary power '
      + 'will not touch. Kings are still beyond it.',
  },
  [ELEMENT.SPIRIT]: {
    element: ELEMENT.SPIRIT,
    power: 'Resurrection',
    aim: POWER_AIM.EMPTY,
    blurb: 'The best piece you have lost, back and fully charged.',
    detail:
      'Pick an empty square in your own half. The most valuable piece you '
      + 'have lost all match stands up on it holding a full charge — not the '
      + 'last one to fall, and not spent. A pawn will not come back onto the '
      + 'back rank.',
  },
  [ELEMENT.GRAVITY]: {
    element: ELEMENT.GRAVITY,
    power: 'Singularity',
    aim: POWER_AIM.EMPTY,
    blurb: 'Everything of theirs nearby falls in towards one square.',
    detail:
      'Pick any empty square. Every enemy piece within two squares of it is '
      + 'dragged one square closer, nearest first, wherever there is room. '
      + 'Nothing is captured and nothing is destroyed. Kings hold their '
      + 'ground.',
  },
  [ELEMENT.TIME]: {
    element: ELEMENT.TIME,
    power: 'Stasis',
    aim: POWER_AIM.NONE,
    blurb: 'Their last move is undone, and your half of the board stops.',
    detail:
      'The piece they have just moved goes back where it came from, and '
      + 'every enemy piece standing in YOUR half of the board is frozen until '
      + 'your next turn. It needs a move there is any taking back — the same '
      + 'move Rewind needs. Kings cannot be frozen.',
  },
  [ELEMENT.CRYSTAL]: {
    element: ELEMENT.CRYSTAL,
    power: 'Refraction',
    aim: POWER_AIM.NONE,
    blurb: 'The whole army turns to crystal for a turn.',
    detail:
      'Every piece you have is uncapturable until your next turn, and any '
      + 'enemy power aimed squarely at any of them rebounds onto the piece '
      + 'that cast it. Kings cannot be given the crystal, so yours is the one '
      + 'piece still worth attacking.',
  },
  [ELEMENT.SPACE]: {
    element: ELEMENT.SPACE,
    power: 'Wormhole',
    aim: POWER_AIM.EMPTY,
    blurb: 'Your pawn opens somewhere else, and shoves them aside.',
    detail:
      'Pick any empty square on the board. Your Space pawn appears on it, '
      + 'and every enemy piece standing around that square is shoved one '
      + 'square further away, wherever there is room. Kings are not shoved, '
      + 'and your king must not be left in check by the pawn leaving.',
  },
};

/** Is there a super for this element? All of them have one; this is the guard. */
export function superFor(element) {
  return SUPERS[element] ?? null;
}
/**
 * The six things a power can leave lying on the board.
 *
 * Three of them subtract from the move list and three do not, and the split
 * matters more than the count: FROZEN, SHIELD and CRYSTAL are read by
 * filterMoves() and can therefore strand a player, so they are the three the
 * thaw has to be able to break. ARMOUR and SILENCED take nothing away from how
 * a piece moves — they only answer questions other POWERS ask — so they can
 * never strand anybody and the thaw leaves them alone.
 */
export const EFFECT = {
  FROZEN: 'frozen',
  SHIELD: 'shield',
  VINES: 'vines',
  /** Metal. Proof against powers, not against pieces: still capturable. */
  ARMOUR: 'armour',
  /** Crystal. Uncapturable, and a power aimed at it rebounds on its caster. */
  CRYSTAL: 'crystal',
  /** Void. Keeps its charge and may not spend it. */
  SILENCED: 'silenced',
};

/** The effects that stop a piece being captured. Read by filterMoves(). */
export const WARDS_CAPTURE = [EFFECT.SHIELD, EFFECT.CRYSTAL];

/** The effects that turn a power away, and what each of them does to it. */
export const WARDS_POWER = [EFFECT.ARMOUR, EFFECT.CRYSTAL];

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
//
// This used to be a pure function of the piece and its square, and that was
// the nicest thing in the file: nothing had to be carried across a move, a
// capture or a save. It could also only ever name seven elements, because
// there are only seven kinds of piece to read.
//
// So elements are tracked per piece now, exactly the way charges already are —
// a square in a Map rather than a square in a Set, remapped through
// followMove() by the same bookkeeping, dying with the piece it belongs to.
// The cost is that every caller has to be handed the map; the gain is that the
// roster is no longer capped by the number of piece types, which is the whole
// of what made a loadout possible.
//
// A piece keeps its element for life, promotion included. A Fire pawn that
// walks to the eighth rank is a Fire queen, which is the only answer that does
// not quietly delete something the player has been protecting for thirty
// moves.
// ---------------------------------------------------------------------------

/** Which slot the piece standing on a starting square belongs to, or null. */
function slotOfHome(piece, square) {
  const rank = square[1];
  const file = square[0];
  const home = piece.color === 'w' ? '1' : '8';
  const pawnRank = piece.color === 'w' ? '2' : '7';

  if (piece.type === 'p') return rank === pawnRank ? SLOT.PAWN : null;
  if (rank !== home) return null;

  switch (piece.type) {
    case 'r':
      if (file === 'a') return SLOT.ROOK_A;
      return file === 'h' ? SLOT.ROOK_H : null;
    case 'n':
      if (file === 'b') return SLOT.KNIGHT_B;
      return file === 'g' ? SLOT.KNIGHT_G : null;
    case 'b':
      return squareShade(square) === 'light' ? SLOT.BISHOP_LIGHT : SLOT.BISHOP_DARK;
    case 'q':
      return SLOT.QUEEN;
    case 'k':
      return SLOT.KING;
    default:
      return null;
  }
}

/**
 * The element a piece would carry if it had no loadout to read.
 *
 * The old rule, kept for exactly one job: a position hand-loaded from a FEN,
 * where the pieces are wherever somebody put them and no starting square means
 * anything. Every piece still gets an element — a piece without one holds a
 * charge nobody can spend — and it gets the one its type used to imply.
 */
export function defaultElementFor(piece, square) {
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

/**
 * Lay a loadout out over a position: square -> element, for every piece.
 *
 * Both sides get the same list, so a2 and a7 carry the same element and the
 * board is symmetrical however the elements were chosen. Within a slot the
 * elements fill its squares in roster order and in file order, which is
 * arbitrary but has to be the SAME arbitrary every time: a saved game is
 * restored by laying the stored loadout back out, and an assignment that
 * depended on the order somebody tapped the chips would come back different.
 *
 * Anything not standing on one of its own starting squares — a hand-loaded
 * FEN, a position pasted in for testing — falls back to defaultElementFor().
 */
export function assignElements(fen, loadout) {
  const chosen = normalizeLoadout(loadout);
  const bySlot = {};
  chosen.forEach((id) => {
    const { slot } = ELEMENTS[id];
    (bySlot[slot] ??= []).push(id);
  });

  // Files, so the nth element of a slot lands on the nth square of it.
  const seats = {};
  Object.keys(bySlot).forEach((slot) => {
    seats[slot] = { taken: new Map(), next: 0, ids: bySlot[slot] };
  });

  const board = boardFromFen(fen);
  const elements = new Map();

  // File order within each slot, and white before black, so the two sides are
  // dealt the same element on the same file rather than in board order.
  const squares = [...board.keys()].sort((a, b) => (
    a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
  ));

  squares.forEach((square) => {
    const piece = board.get(square);
    const slot = slotOfHome(piece, square);
    const seat = slot && seats[slot];
    if (!seat) {
      const fallback = defaultElementFor(piece, square);
      if (fallback) elements.set(square, fallback);
      return;
    }

    // Both colours share a seat number, keyed by file, so a2 and a7 agree.
    const key = `${slot}:${square[0]}`;
    if (!seat.taken.has(key)) {
      seat.taken.set(key, seat.ids[seat.next % seat.ids.length]);
      seat.next += 1;
    }
    elements.set(square, seat.taken.get(key));
  });

  return elements;
}

/** The element on a square, or null. */
export function elementAt(elements, square) {
  return elements?.get(square) ?? null;
}

/** The element record for a square, or null. */
export function elementInfoAt(elements, square) {
  const id = elementAt(elements, square);
  return id ? ELEMENTS[id] : null;
}

/**
 * Carry the elements across a move.
 *
 * The same remapping charges get, and for the same reason — but with one
 * difference that matters: a promotion KEEPS the pawn's element rather than
 * minting a new one. chargesAfterMove() hands a promoted piece a fresh charge
 * because the walk earned it; the element is not a reward, it is what the
 * piece is.
 */
export function elementsAfterMove(elements, move) {
  const next = new Map();
  elements.forEach((element, square) => {
    const landed = followMove(square, move);
    if (landed) next.set(landed, element);
  });
  return next;
}

/** Drop the elements of pieces a power has just destroyed. */
export function elementsAfterRemoval(elements, squares) {
  const next = new Map(elements);
  squares.forEach((square) => next.delete(square));
  return next;
}

/**
 * Move one piece's element from one square to another, mid-turn.
 *
 * For everything that shifts a piece without a move having been played: a
 * king's teleport, a Space pawn's swap, a Gravity pull, a Moon tide. Written
 * as a swap rather than an assignment because half of those ARE swaps, and a
 * pull onto an empty square is the same operation with nothing coming back.
 */
export function elementsAfterShift(elements, pairs) {
  const next = new Map(elements);
  // Read every source first: a chain of shifts must all see the board as it
  // was, or the second one moves what the first one has just put down.
  const lifted = pairs.map(([from, to]) => [to, elements.get(from) ?? null]);
  pairs.forEach(([from]) => next.delete(from));
  lifted.forEach(([to, element]) => {
    if (element) next.set(to, element);
    else next.delete(to);
  });
  return next;
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
  // Water's shield and Crystal's prism differ entirely in what they do to a
  // POWER and not at all in what they do to a capture, so the move list only
  // has to know that both of them mean "not this one".
  const shielded = new Set(
    active.filter((e) => WARDS_CAPTURE.includes(e.kind)).map((e) => e.square),
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
export function powerTargets({
  element, square, fen, color, charges, elements, isQuiet, graveyard,
}) {
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
      return teleportTargets({ square, fen, color, board, charges, elements, isQuiet });

    // The aimed square is only where you point. Burn takes the whole ring
    // around the pawn either way — see burnSquares, which is what actually
    // decides, and which the capture trigger calls too.
    case ELEMENT.FIRE:
      return reachable(NEIGHBOURS);

    case ELEMENT.LIGHTNING:
      return reachable(KNIGHT_HOPS);

    // The two defensive ones cover the same set Water does, and for the same
    // reason: a piece worth protecting is a piece worth protecting wherever it
    // is standing. What they differ in is what protection MEANS, which is a
    // question for the session and not for the aiming.
    case ELEMENT.METAL:
    case ELEMENT.CRYSTAL:
      return ownPieces(fen, color);

    // Space cannot swap with itself — a swap with nothing on the far end is a
    // charge spent on a piece staying exactly where it was — and it cannot
    // swap a pawn onto a back rank, in either direction. A Space pawn on the
    // seventh trading places with a rook on the eighth would put a pawn
    // somewhere no move could have put it.
    case ELEMENT.SPACE:
      return ownPieces(fen, color)
        .filter((at) => at !== square && maySwap(fen, square, at));

    // Silence is the one effect a king may be given, because it is the one
    // that says nothing about how a piece moves. See its entry in ELEMENTS.
    case ELEMENT.VOID:
      return chargedEnemies(fen, color, charges);

    case ELEMENT.SUN:
      return raySquares(square, fen, color);

    case ELEMENT.MOON:
      return tideTargets(fen, color);

    case ELEMENT.BLOOD:
      return bloodTargets(fen, color);

    case ELEMENT.GRAVITY:
      return pullTargets(square, fen, color);

    case ELEMENT.SPIRIT:
      return revivalSquares(fen, color, revivalPiece(graveyard, color));

    // Time aims at nothing: what it undoes is already decided. Its readiness
    // is worked out in powerAt(), which is where the NONE powers say whether
    // they would do anything at all.
    default:
      return [];
  }
}

/**
 * Everything a power would destroy if it were cast at this square, and what
 * that is worth.
 *
 * Only the powers that DESTROY have an answer; everything else returns
 * nothing, because freezing a queen does not remove her and pretending it is
 * worth 900 would have the bot trading a charge for a delay. Dragging is
 * nothing here for the same reason and a stronger one: a Tide that pushes
 * their whole rank back has not taken a thing.
 *
 * Used twice: to sort the casters a panel might fire from, so that choosing
 * "Burn" with four pawns in contact picks the one that burns the most, and by
 * the bot, which has no other way to tell a good burn from a pointless one.
 *
 * Blood is the one row here that is worth less than it looks. What it removes
 * is counted net: the enemy piece minus the pawn it costs you, because a
 * bargain reported at face value is a bot cheerfully trading a pawn for a
 * pawn.
 */
export function castDamage({ element, square, target, fen, color }) {
  const board = boardFromFen(fen);
  const worthOf = (squares) => squares.reduce(
    (sum, at) => sum + (PIECE_WORTH[board.get(at)?.type] ?? 0),
    0,
  );

  switch (element) {
    case ELEMENT.FIRE: {
      const squares = burnSquares(square, fen, color);
      return { squares, worth: worthOf(squares) };
    }
    case ELEMENT.LIGHTNING: {
      const squares = arcSquares(target, fen, color);
      return { squares, worth: worthOf(squares) };
    }
    case ELEMENT.SUN: {
      const squares = target ? [target] : [];
      return { squares, worth: worthOf(squares) };
    }
    case ELEMENT.BLOOD: {
      const squares = target ? [target] : [];
      const cost = PIECE_WORTH[board.get(square)?.type] ?? 0;
      return { squares, worth: Math.max(0, worthOf(squares) - cost) };
    }
    default:
      return { squares: [], worth: 0 };
  }
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
function teleportTargets({ fen, color, board, charges, elements, isQuiet }) {
  if (!canTeleport({ fen, color, charges, elements })) return [];
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
export function canTeleport({ fen, color, charges, elements }) {
  return !enemyLightBishop({ fen, color, charges, elements });
}

/** The charged enemy Light bishop holding the shadows shut, or null. */
export function enemyLightBishop({ fen, color, charges, elements }) {
  const board = boardFromFen(fen);
  for (const [square, piece] of board) {
    if (piece.color === color) continue;
    if (elementAt(elements, square) !== ELEMENT.LIGHT) continue;
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
 * Swap two pieces, mid-turn.
 *
 * Used by one power only — Shadow Swap — and written as a general swap rather
 * than as "move the king and put the other thing where it was", because those
 * are the same operation and only one of them is easy to read.
 *
 * Castling rights are pruned from the result rather than reasoned about: the
 * king has moved, and pruneCastling reads the board it is given, so moving it
 * is enough to drop both. The side to move is left alone here — flipping it is
 * what a super costs, and that is the session's decision to make, not this
 * function's.
 */
export function swapPieces(fen, a, b) {
  const parsed = readFen(fen);
  const first = parsed.cells.get(a);
  const second = parsed.cells.get(b);
  if (!first || !second) return fen;
  parsed.cells.set(a, second);
  parsed.cells.set(b, first);
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
// The mechanics the ten added elements needed
//
// Four shapes that the original seven had no use for, written once here and
// shared between an element's ordinary power and its super — which is what
// keeps a super honestly "the same thing, wider" rather than a second rule
// wearing the same name.
//
//   RAYS      the eight lines out of a square, stopping at the first piece
//             on each.                              (Sun: Solar Flare, Solstice)
//   DRAGGING  a piece moved one square without anybody having moved it.
//                        (Gravity: Pull, Singularity; Moon: Tide, Spring Tide;
//                         Space: Wormhole)
//   REVIVAL   a piece coming back from the pile of things already taken.
//                                      (Spirit: Revive, Resurrection)
//   REWIND    the move just played, put back.        (Time: Rewind, Stasis)
//
// Dragging is the one worth reading twice. Nothing is ever captured by it: a
// piece is only ever dragged onto an EMPTY square, so a drag can open a line,
// break a defence or shove a pawn off a rank it was holding, but it can never
// take material. That is deliberate — the two powers that take material away
// from anywhere on the board are Blood and Sun, and both of them pay for it.
// ---------------------------------------------------------------------------

/** How far a Sun pawn's lines reach. Three, so a pawn has to be brought up. */
export const RAY_REACH = 3;

/** The eight directions a ray travels: the neighbours, used as steps. */
const RAY_STEPS = NEIGHBOURS;

/**
 * The first piece on each of the eight lines out of a square, within reach.
 *
 * Stops at the first ANYTHING — a piece of your own on a line blocks it, which
 * is what makes a Sun pawn's position a decision rather than a formality. Only
 * the enemies among them come back; kings never do.
 */
export function raySquares(square, fen, color, reach = RAY_REACH) {
  const board = boardFromFen(fen);
  const found = [];

  RAY_STEPS.forEach(([df, dr]) => {
    for (let step = 1; step <= reach; step += 1) {
      const at = squareAt(fileOf(square) + df * step, rankOf(square) + dr * step);
      if (!at) return;
      const piece = board.get(at);
      if (!piece) continue;
      if (piece.color !== color && piece.type !== 'k') found.push(at);
      return;
    }
  });

  return found.sort();
}

/** The square one step from `from` in the direction of `towards`. */
function stepToward(from, towards) {
  const df = Math.sign(fileOf(towards) - fileOf(from));
  const dr = Math.sign(rankOf(towards) - rankOf(from));
  if (!df && !dr) return null;
  return squareAt(fileOf(from) + df, rankOf(from) + dr);
}

/** The square one step from `from` directly away from `awayFrom`. */
function stepAway(from, awayFrom) {
  const df = Math.sign(fileOf(from) - fileOf(awayFrom));
  const dr = Math.sign(rankOf(from) - rankOf(awayFrom));
  if (!df && !dr) return null;
  return squareAt(fileOf(from) + df, rankOf(from) + dr);
}

/** The square one step back towards a piece's own side of the board. */
function stepHome(square, color) {
  return squareAt(fileOf(square), rankOf(square) + (color === 'w' ? -1 : 1));
}

/**
 * May this piece stand on this square?
 *
 * One rule, and it is not a balance decision: a pawn on the first or last rank
 * is a position chess.js will load and then reason about wrongly, because
 * there is no move that could have put it there and no promotion left to make.
 * Every drag, every revival and every swap is checked against this — and the
 * swaps need it in BOTH directions, because a swap moves two pieces and only
 * one of them is the one you were thinking about.
 */
export function mayStandOn(piece, square) {
  if (!piece) return false;
  if (piece.type !== 'p') return true;
  return square[1] !== '1' && square[1] !== '8';
}

/** Could these two change places without either landing somewhere illegal? */
export function maySwap(fen, a, b) {
  const board = boardFromFen(fen);
  const first = board.get(a);
  const second = board.get(b);
  if (!first || !second) return false;
  return mayStandOn(first, b) && mayStandOn(second, a);
}

/**
 * Work a list of drags out, in an order where they do not tread on each other.
 *
 * `move(square) -> square|null` says where one piece is going. Pieces are
 * taken in the order given, and each one is checked against a board that
 * already has the earlier drags applied — so a column of pieces all sliding
 * the same way slides as a column, provided the caller hands them over
 * front-first. A piece whose square is taken simply does not move.
 *
 * Returns [[from, to], ...] for the ones that actually shift.
 */
function planDrags(squares, fen, move) {
  const board = boardFromFen(fen);
  const occupied = new Set(board.keys());
  const drags = [];

  squares.forEach((from) => {
    const piece = board.get(from);
    if (!piece) return;
    const to = move(from, piece);
    if (!to || occupied.has(to)) return;
    if (!mayStandOn(piece, to)) return;
    occupied.delete(from);
    occupied.add(to);
    drags.push([from, to]);
  });

  return drags;
}

/** Enemy pieces that could be dragged one square towards `square`. */
export function pullTargets(square, fen, color) {
  const board = boardFromFen(fen);
  const reachable = [];
  board.forEach((piece, at) => {
    if (piece.color === color || piece.type === 'k') return;
    const to = stepToward(at, square);
    if (!to || board.has(to) || !mayStandOn(piece, to)) return;
    reachable.push(at);
  });
  return reachable.sort();
}

/** The one drag a Gravity pull performs. */
export function pullDrags(target, square, fen, color) {
  if (!target) return [];
  const piece = boardFromFen(fen).get(target);
  if (!piece || piece.color === color || piece.type === 'k') return [];
  return planDrags([target], fen, (from) => stepToward(from, square));
}

/**
 * A Singularity: everything of theirs within two squares falls inward.
 *
 * Nearest first, so the ring closest to the centre moves before the ring
 * behind it and the two do not collide — which is also why it looks like
 * collapse rather than like a shuffle.
 */
export function singularityDrags(centre, fen, color, reach = 2) {
  if (!centre) return [];
  const board = boardFromFen(fen);
  const caught = [];
  board.forEach((piece, at) => {
    if (piece.color === color || piece.type === 'k') return;
    if (squareDistance(at, centre) > reach) return;
    caught.push(at);
  });
  caught.sort((a, b) => squareDistance(a, centre) - squareDistance(b, centre)
    || a.localeCompare(b));
  return planDrags(caught, fen, (from) => stepToward(from, centre));
}

/**
 * A Tide: every enemy piece on one rank, pulled one square back.
 *
 * Ordered from the rank they are heading home to outward, so a piece with
 * another one directly behind it still moves if that one moved first.
 */
export function tideDrags(rank, fen, color, everywhere = false) {
  if (!rank && !everywhere) return [];
  const board = boardFromFen(fen);
  const them = color === 'w' ? 'b' : 'w';
  const caught = [];
  board.forEach((piece, at) => {
    if (piece.color !== them || piece.type === 'k') return;
    if (!everywhere && at[1] !== rank) return;
    caught.push(at);
  });
  // Their home rank is 1 for white and 8 for black, so sort towards it.
  caught.sort((a, b) => (them === 'w'
    ? rankOf(a) - rankOf(b)
    : rankOf(b) - rankOf(a)) || a.localeCompare(b));
  return planDrags(caught, fen, (from, piece) => stepHome(from, piece.color));
}

/** Enemy pieces whose rank has anything on it the tide could move. */
export function tideTargets(fen, color) {
  const board = boardFromFen(fen);
  const them = color === 'w' ? 'b' : 'w';
  const ranks = new Set(
    tideDrags(null, fen, color, true).map(([from]) => from[1]),
  );
  const targets = [];
  board.forEach((piece, at) => {
    if (piece.color !== them || piece.type === 'k') return;
    if (ranks.has(at[1])) targets.push(at);
  });
  return targets.sort();
}

/** A Wormhole: everything of theirs beside the arrival square, shoved off it. */
export function wormholeDrags(centre, fen, color) {
  if (!centre) return [];
  const board = boardFromFen(fen);
  const caught = hopsFrom(centre, NEIGHBOURS).filter((at) => {
    const piece = board.get(at);
    return piece && piece.color !== color && piece.type !== 'k';
  });
  return planDrags(caught, fen, (from) => stepAway(from, centre));
}

/**
 * The half of the board a colour starts on. Spirit revives into it.
 *
 * Four ranks rather than three or the whole board: far enough back that a
 * revived queen is not simply placed next to their king, and far enough
 * forward that the power is worth a charge in a crowded opening.
 */
export function ownHalf(fen, color) {
  const board = boardFromFen(fen);
  const ranks = color === 'w' ? ['1', '2', '3', '4'] : ['5', '6', '7', '8'];
  return ALL_SQUARES.filter((at) => ranks.includes(at[1]) && !board.has(at));
}

/**
 * The piece a Spirit power would bring back, or null.
 *
 * `best` picks between the two versions: Revive takes the piece lost most
 * recently, and Resurrection takes the most valuable one lost all match. Two
 * different questions asked of the same list, which is why the graveyard is
 * kept in the order things fell rather than sorted.
 */
export function revivalPiece(graveyard, color, best = false) {
  const mine = (graveyard ?? []).filter((piece) => piece.color === color && piece.type !== 'k');
  if (!mine.length) return null;
  if (!best) return mine[mine.length - 1];
  return mine.reduce((top, piece) => (
    PIECE_WORTH[piece.type] > PIECE_WORTH[top.type] ? piece : top
  ), mine[0]);
}

/** The empty squares a revived piece could be stood up on. */
export function revivalSquares(fen, color, piece) {
  if (!piece) return [];
  return ownHalf(fen, color).filter((at) => mayStandOn(piece, at));
}

/**
 * Can this move be put back where it came from?
 *
 * Four conditions, and each of them is a thing the board could not otherwise
 * say afterwards. A capture cannot be rewound because the piece it took is
 * gone and bringing it back is Spirit's job, not this one. A castle moves two
 * pieces and restores a right that pruneCastling() has no way to give back. A
 * promotion would have to un-become a queen. And the square they left has to
 * still be empty, because something else may have moved into it in between.
 */
export function canRewind(move, fen) {
  if (!move) return false;
  if (move.isCapture || move.isCastle || move.isPromotion || move.isEnPassant) return false;
  const board = boardFromFen(fen);
  if (board.has(move.from)) return false;
  const piece = board.get(move.to);
  return Boolean(piece) && piece.color === move.color && piece.type === move.piece;
}

/** Enemy pieces standing in your own half, which Stasis freezes. */
export function intruders(fen, color) {
  const board = boardFromFen(fen);
  const ranks = color === 'w' ? ['1', '2', '3', '4'] : ['5', '6', '7', '8'];
  const found = [];
  board.forEach((piece, at) => {
    if (piece.color === color || piece.type === 'k') return;
    if (ranks.includes(at[1])) found.push(at);
  });
  return found.sort();
}

/**
 * The spent pieces a Sun power hands a charge back to.
 *
 * Solar Flare recharges the ONE nearest the pawn, Solstice recharges every
 * piece touching it. Distance is Chebyshev and ties break by square name, for
 * the same reason the lightning arc's do: the answer has to be the same every
 * time it is worked out, including on the other player's device.
 */
export function rechargeable(square, fen, color, charges, elements, all = false) {
  const board = boardFromFen(fen);
  const spent = [];
  board.forEach((piece, at) => {
    if (piece.color !== color || at === square) return;
    if (charges.has(at) || !elements.has(at)) return;
    if (all && squareDistance(at, square) > 1) return;
    spent.push(at);
  });
  if (all) return spent.sort();
  spent.sort((a, b) => squareDistance(a, square) - squareDistance(b, square)
    || a.localeCompare(b));
  return spent.slice(0, 1);
}

/** Enemy pieces worth no more than this, for Blood to bargain with. */
export function bloodTargets(fen, color, cap = PIECE_WORTH.r) {
  const board = boardFromFen(fen);
  const found = [];
  board.forEach((piece, at) => {
    if (piece.color === color || piece.type === 'k') return;
    if (PIECE_WORTH[piece.type] > cap) return;
    found.push(at);
  });
  return found.sort();
}

/** Enemy pieces still holding a charge: what Silence has to aim at. */
export function chargedEnemies(fen, color, charges) {
  const board = boardFromFen(fen);
  const found = [];
  board.forEach((piece, at) => {
    if (piece.color === color) return;
    if (charges.has(at)) found.push(at);
  });
  return found.sort();
}

/** Your own pieces, king excepted: what the defensive powers cover. */
export function ownPieces(fen, color, { includeKing = false } = {}) {
  const board = boardFromFen(fen);
  const found = [];
  board.forEach((piece, at) => {
    if (piece.color !== color) return;
    if (!includeKing && piece.type === 'k') return;
    found.push(at);
  });
  return found.sort();
}

// ---------------------------------------------------------------------------
// More FEN surgery, for the powers that move pieces without a move
// ---------------------------------------------------------------------------

/**
 * Apply a list of [from, to] drags to a position.
 *
 * The side to move is left alone, exactly as relocateKing() leaves it: a power
 * is free, so it is still the caster's turn and they still have their move to
 * come. Castling rights are pruned from the result rather than reasoned about
 * — dragging a rook off h1 has to take that right with it, and pruneCastling()
 * reads the board it is given.
 */
export function dragPieces(fen, drags) {
  if (!drags.length) return fen;
  const parsed = readFen(fen);
  const lifted = drags.map(([from, to]) => [to, parsed.cells.get(from)]);
  drags.forEach(([from]) => parsed.cells.delete(from));
  lifted.forEach(([to, piece]) => { if (piece) parsed.cells.set(to, piece); });
  parsed.castling = pruneCastling(parsed.castling, parsed.cells);
  return writeFen(parsed);
}

/**
 * Stand a piece that was already taken back up on an empty square.
 *
 * The halfmove clock resets: material has changed, which is progress in the
 * sense the fifty-move rule is counting — the same reasoning removePieces()
 * uses going the other way.
 */
export function addPiece(fen, square, piece) {
  const parsed = readFen(fen);
  if (parsed.cells.has(square)) return fen;
  const char = piece.color === 'w' ? piece.type.toUpperCase() : piece.type.toLowerCase();
  parsed.cells.set(square, char);
  parsed.halfmove = '0';
  return writeFen(parsed);
}

// ---------------------------------------------------------------------------
// The supers
//
// Each one is the ordinary power asked to do the same thing over a wider
// piece of board, so each is written as "which squares does this touch" and
// nothing else. The session decides what touching means — destroy, freeze,
// shield, grow — exactly as it already does for the ordinary seven.
// ---------------------------------------------------------------------------

/**
 * Every square a Firestorm burns, and every pawn it spends.
 *
 * Not one pawn’s ring but all of them at once: every charged pawn with
 * something to burn erupts together. `casters` is returned beside `squares`
 * because the cost is the interesting half — a Firestorm that catches four
 * pieces may spend four pawns doing it, and a player about to press the
 * button is entitled to know that before they do.
 *
 * EVERY pawn, not only the Fire one, and that is a deliberate change from the
 * days when all eight of them were Fire. There is one Fire pawn now, so a
 * Firestorm that only ever spent Fire pawns would be an ordinary Burn wearing
 * a bigger name and costing a whole move. What it takes instead is the front
 * rank — your Blood pawn and your Crystal pawn go up with it, charges and all
 * — which is a price loud enough to be worth the move it costs.
 *
 * A pawn with nothing beside it does not erupt and is not spent. Firestorm is
 * a bigger Burn, not a way of setting light to your own front rank for free.
 */
export function firestormSquares(fen, color, charges) {
  const board = boardFromFen(fen);
  const casters = [];
  const squares = new Set();

  board.forEach((piece, square) => {
    if (piece.color !== color || piece.type !== 'p') return;
    if (!charges.has(square)) return;
    const caught = burnSquares(square, fen, color);
    if (!caught.length) return;
    casters.push(square);
    caught.forEach((at) => squares.add(at));
  });

  return { casters, squares: [...squares].sort() };
}

/**
 * The three squares a Thunderstorm strikes, in the order it strikes them.
 *
 * The bolt cannot double back: each hop is chosen from a board that already
 * has the previous victims taken off it, which is what stops a pair of
 * knights’-move neighbours bouncing it between them and returning two
 * squares for three hops.
 */
export function stormSquares(struck, fen, color) {
  if (!struck) return [];
  const hit = [struck];
  let where = struck;
  for (let hop = 0; hop < 2; hop += 1) {
    const onward = arcTarget(where, removePieces(fen, hit), color);
    if (!onward) break;
    hit.push(onward);
    where = onward;
  }
  return hit;
}

/** A Deep Freeze: the piece aimed at, and every enemy piece touching it. */
export function deepFreezeSquares(target, fen, color) {
  if (!target) return [];
  const board = boardFromFen(fen);
  const around = hopsFrom(target, NEIGHBOURS).filter((square) => {
    const piece = board.get(square);
    return piece && piece.color !== color && piece.type !== 'k';
  });
  return [target, ...around].sort();
}

/** An Overgrowth: the square aimed at, and every empty square touching it. */
export function overgrowthSquares(target, fen) {
  if (!target) return [];
  const board = boardFromFen(fen);
  const around = hopsFrom(target, NEIGHBOURS).filter((square) => !board.has(square));
  return [target, ...around].sort();
}

/** Everything a Tidal Guard covers: all your pieces bar the king. */
export function tidalSquares(fen, color) {
  const board = boardFromFen(fen);
  const covered = [];
  board.forEach((piece, square) => {
    if (piece.color === color && piece.type !== 'k') covered.push(square);
  });
  return covered.sort();
}

/**
 * Where a super may be pointed. Same contract as powerTargets().
 *
 * The three that aim at nothing return [] and are `ready` on their own
 * terms, worked out in superAt() below — there is no square to offer.
 */
export function superTargets({
  element, square, fen, color, charges, elements, graveyard,
}) {
  const board = boardFromFen(fen);

  switch (element) {
    // A knight’s move from this knight, exactly as Chain Attack is. The
    // reach is the piece’s shape either way; what the super buys is how far
    // the bolt travels afterwards, not where it may start.
    case ELEMENT.LIGHTNING:
      return hopsFrom(square, KNIGHT_HOPS).filter((at) => {
        const piece = board.get(at);
        return piece && piece.color !== color && piece.type !== 'k';
      });

    case ELEMENT.ICE: {
      const found = [];
      board.forEach((piece, at) => {
        if (piece.color !== color && piece.type !== 'k') found.push(at);
      });
      return found;
    }

    case ELEMENT.NATURE:
      return ALL_SQUARES.filter((at) => !board.has(at));

    // Any piece of your own but the king, and only where the king would be
    // safe standing on it. Checked here rather than left to the session, so
    // a square that cannot be swapped to is never offered in the first
    // place — the legality check in the session is the backstop, not the
    // explanation.
    case ELEMENT.SHADOW:
      return swapTargets({ square, fen, color });

    // Something that has already fired. Dawn on a loaded piece would be a
    // turn spent giving somebody a charge they already had.
    case ELEMENT.LIGHT: {
      const spent = [];
      board.forEach((piece, at) => {
        if (piece.color !== color) return;
        if (charges.has(at)) return;
        if (!elementAt(elements, at)) return;
        spent.push(at);
      });
      return spent;
    }

    // Bloodrite drops the worth cap the ordinary bargain carries, and that is
    // the whole of the difference: the queen is on the table.
    case ELEMENT.BLOOD:
      return bloodTargets(fen, color, Infinity);

    case ELEMENT.SPIRIT:
      return revivalSquares(fen, color, revivalPiece(graveyard, color, true));

    case ELEMENT.GRAVITY:
    case ELEMENT.SPACE:
      return ALL_SQUARES.filter((at) => !board.has(at));

    // Ironclad, Refraction, Nullify, Solstice, Spring Tide and Stasis aim at
    // nothing: what they reach is decided by the board, and superAt() below
    // works out whether that is anything at all.
    default:
      return [];
  }
}

/**
 * Your own pieces the king could change places with.
 *
 * Every piece but the king itself, kept only where the king would not be in
 * check after the swap. The piece coming the other way is placed first, so a
 * rook that was shielding the king from a1 is gone from a1 when the question
 * is asked — which is the position the swap actually produces.
 */
export function swapTargets({ square, fen, color }) {
  const board = boardFromFen(fen);
  const mine = [];
  board.forEach((piece, at) => {
    if (piece.color === color && piece.type !== 'k') mine.push(at);
  });
  // maySwap as well as the check, and it is not a formality: a king on its
  // own back rank swapping with a pawn would put that pawn on the rank no
  // move could have put it on. The king is never the piece that fails this —
  // it is always the one coming the other way.
  return mine.filter((at) => (
    maySwap(fen, square, at) && !kingExposedBySwap(fen, square, at, color)
  ));
}

/** Would swapping these two leave this colour’s king attacked? */
function kingExposedBySwap(fen, kingSquare, other, color) {
  const swapped = swapPieces(fen, kingSquare, other);
  return attacked(swapped, other, color);
}

/**
 * Is the piece on `square` attacked by the side that is not `color`?
 *
 * Worked out without an engine, by walking the board outward from the square
 * — this module imports nothing but constants on purpose, and pulling chess.js
 * in here to answer one question would cost that. Pawns, knights, kings and
 * the sliders each get their own pass; between them that is every way a piece
 * can be attacked.
 */
function attacked(fen, square, color) {
  const board = boardFromFen(fen);
  const them = color === 'w' ? 'b' : 'w';
  const at = (df, dr) => squareAt(fileOf(square) + df, rankOf(square) + dr);
  const isThem = (target, type) => {
    const piece = target && board.get(target);
    return Boolean(piece) && piece.color === them && piece.type === type;
  };

  // Pawns capture forwards, so a white king is attacked from the rank above.
  const forward = color === 'w' ? 1 : -1;
  if (isThem(at(-1, forward), 'p') || isThem(at(1, forward), 'p')) return true;

  if (KNIGHT_HOPS.some(([df, dr]) => isThem(at(df, dr), 'n'))) return true;
  if (NEIGHBOURS.some(([df, dr]) => isThem(at(df, dr), 'k'))) return true;

  const rays = [
    [[1, 0], [-1, 0], [0, 1], [0, -1], 'r'],
    [[1, 1], [1, -1], [-1, 1], [-1, -1], 'b'],
  ];
  for (const ray of rays) {
    const kind = ray[ray.length - 1];
    for (const [df, dr] of ray.slice(0, -1)) {
      for (let step = 1; step < 8; step += 1) {
        const where = at(df * step, dr * step);
        if (!where) break;
        const piece = board.get(where);
        if (!piece) continue;
        if (piece.color === them && (piece.type === kind || piece.type === 'q')) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * What this piece’s super could do right now, or null if it has none to do.
 *
 * The same shape powerAt() returns, so every caller that already knows how to
 * read a power can read a super without learning a second shape.
 */
export function superAt({
  square, fen, color, charges, elements, isQuiet, graveyard, lastMove, silenced,
}) {
  const board = boardFromFen(fen);
  const piece = board.get(square);
  if (!piece || piece.color !== color) return null;
  if (!charges.has(square)) return null;

  const element = elementAt(elements, square);
  const info = SUPERS[element];
  if (!info) return null;

  // Silence shuts BOTH of a piece's powers, and it has to be reported here as
  // well as in powerAt() or the bar offers a super it is about to refuse.
  if (silenced?.has?.(square)) {
    return {
      element, info, square, ready: false, targets: [], blockedBy: ELEMENT.VOID, isSuper: true,
    };
  }

  const blockedBy = element === ELEMENT.SHADOW
    && !canTeleport({ fen, color, charges, elements })
    ? ELEMENT.LIGHT
    : null;

  if (info.aim === POWER_AIM.NONE) {
    // Nothing to point at, so readiness is whether it would do anything. A
    // super that costs a whole move and changes nothing is not a button worth
    // offering, so each of these asks the board its own question rather than
    // sharing one — Firestorm with no pawn in contact, Dawn with nothing
    // spent, Nullify against an army holding no charges and Stasis with no
    // move to take back are all the same mistake wearing different names.
    //
    // Fire asks whether THIS pawn is one of the ones about to erupt, not
    // merely whether some pawn is. A Firestorm offered from a pawn standing
    // alone in the centre would spend it for nothing and read as the power
    // having misfired.
    return {
      element,
      info,
      square,
      ready: superWouldDo({ element, square, fen, color, charges, lastMove }),
      targets: [],
      blockedBy,
      isSuper: true,
    };
  }

  const targets = superTargets({
    element, square, fen, color, charges, elements, graveyard,
  });
  return {
    element,
    info,
    square,
    ready: targets.length > 0 && !blockedBy,
    targets,
    blockedBy,
    isSuper: true,
    isQuiet,
  };
}

/** Would an unaimed super actually change anything? */
function superWouldDo({ element, square, fen, color, charges, lastMove }) {
  switch (element) {
    case ELEMENT.FIRE:
      return firestormSquares(fen, color, charges).casters.includes(square);
    case ELEMENT.VOID:
      return chargedEnemies(fen, color, charges).length > 0;
    case ELEMENT.SUN:
      return raySquares(square, fen, color).length > 0;
    case ELEMENT.MOON:
      return tideDrags(null, fen, color, true).length > 0;
    case ELEMENT.TIME:
      return canRewind(lastMove, fen);
    // Ironclad and Refraction cover the same pieces Tidal Guard does, so they
    // are ready on the same terms: you have something other than a king.
    default:
      return tidalSquares(fen, color).length > 0;
  }
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
export function describeBoard({ fen, charges, effects, ply, elements }) {
  const board = boardFromFen(fen);
  const pieces = {};
  board.forEach((piece, square) => {
    const element = elementAt(elements, square);
    if (!element) return;
    pieces[square] = { element, charged: charges.has(square) };
  });

  // Last one wins, and the order is the order they were laid. Two effects can
  // sit on one square now — armour under a silence, a shield under vines that
  // grew where its piece used to be — and a square only has one corner to draw
  // a glyph in, so the most recent is the one shown. It is also the one that
  // has just changed, which is the one worth looking at.
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
export function powerAt({
  square, fen, color, charges, elements, isQuiet, graveyard, lastMove, silenced,
}) {
  const board = boardFromFen(fen);
  const piece = board.get(square);
  if (!piece || piece.color !== color) return null;
  if (!charges.has(square)) return null;

  const element = elementAt(elements, square);
  const info = ELEMENTS[element];
  if (!info) return null;

  // Silence is reported the same way the Light bishop's hold is, and for the
  // same reason: a piece that is being STOPPED is a different thing from a
  // piece with nothing to aim at, and a button that refuses without saying
  // which of the two it is teaches the player nothing.
  if (silenced?.has?.(square)) {
    return {
      element, info, square, ready: false, targets: [], blockedBy: ELEMENT.VOID,
    };
  }

  if (info.aim === POWER_AIM.NONE) {
    // Cleanse always has something to do — there is always a board to wash.
    // Rewind does not: it needs a move there is any taking back.
    const ready = element === ELEMENT.TIME ? canRewind(lastMove, fen) : true;
    return { element, info, square, ready, targets: [] };
  }

  const targets = powerTargets({
    element, square, fen, color, charges, elements, isQuiet, graveyard,
  });
  // A Shadow King held shut by a charged enemy Light bishop is worth saying
  // out loud rather than leaving as a button that does nothing when pressed.
  const blockedBy = element === ELEMENT.SHADOW
    && !canTeleport({ fen, color, charges, elements })
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
 * One row per element the side is CARRYING, in ELEMENT_ORDER — including the
 * ones that are spent. A panel drawn from this keeps the same rows in the same
 * places for the whole match, so a power running out leaves a gap where it was
 * instead of letting the rest shuffle up under the player's thumb.
 *
 * `carried` is what a loadout added to the shape of this: with seventeen
 * elements and sixteen pieces, at least one row is not in the game at all, and
 * a row for a power nobody brought is worse than no row — it is a promise the
 * board cannot keep. The panel draws the ones marked carried and nothing else.
 *
 * `ready` is the subset of `squares` that could fire right now, best first.
 *
 * "Best" only means anything for the powers that destroy, and for them it
 * means a great deal: four pawns in contact with the enemy are four quite
 * different burns, and the panel fires from ready[0] without asking. Sorting
 * here rather than choosing there keeps the judgement beside PIECE_WORTH,
 * which is the only thing in the app entitled to say what a piece is worth to
 * this variant. For the rest every caster is interchangeable — and most of
 * them only ever have one — so the order is board order.
 */
export function arsenal({
  fen, color, charges, elements, isQuiet, graveyard, lastMove, silenced,
}) {
  const board = boardFromFen(fen);
  const held = new Map(ELEMENT_ORDER.map((id) => [id, []]));
  const carried = new Set();

  board.forEach((piece, square) => {
    if (piece.color !== color) return;
    const element = elementAt(elements, square);
    if (!element) return;
    // Carried is read off the board rather than off the loadout, so a row
    // survives its piece being spent and disappears with its piece being
    // taken — which is the honest answer to "do I still have this".
    carried.add(element);
    if (charges.has(square)) held.get(element)?.push(square);
  });

  return ELEMENT_ORDER.filter((element) => carried.has(element)).map((element) => {
    const info = ELEMENTS[element];
    const squares = held.get(element) ?? [];

    const ready = squares
      .filter((square) => powerAt({
        square, fen, color, charges, elements, isQuiet, graveyard, lastMove, silenced,
      })?.ready)
      .map((square) => ({
        square,
        worth: castDamage({ element, square, fen, color }).worth,
      }))
      .sort((a, b) => (b.worth - a.worth) || a.square.localeCompare(b.square))
      .map((entry) => entry.square);

    // Said out loud rather than left as an empty `ready`, because "nothing in
    // reach", "their Light bishop is holding this shut" and "the Void has it
    // by the throat" are three different problems and only one of them is
    // worth waiting for.
    const allSilenced = squares.length > 0
      && squares.every((square) => silenced?.has?.(square));
    let blockedBy = null;
    if (allSilenced) blockedBy = ELEMENT.VOID;
    else if (element === ELEMENT.SHADOW && squares.length > 0
      && !canTeleport({ fen, color, charges, elements })) blockedBy = ELEMENT.LIGHT;

    return { element, info, squares, ready, blockedBy, carried: true };
  });
}
