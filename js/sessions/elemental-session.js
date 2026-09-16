/**
 * sessions/elemental-session.js
 * Elemental Chess, as a layer over any other session.
 *
 * A MIXIN rather than a class, because this variant has to be playable against
 * a person and against the bot, and those are two different sessions:
 *
 *   ElementalSession    = withElemental(LocalSession)
 *   ElementalBotSession = withBot(withElemental(LocalSession))
 *
 * The bot goes on the OUTSIDE deliberately. Its submitMove calls down through
 * this one, so a capture's fire and lightning have already gone off — and the
 * board has already settled — before the bot is asked whether it would like to
 * reply. Stack them the other way round and the bot starts thinking about a
 * position that is one burn out of date.
 *
 * What lives here: the charges, the effects, the ply count they expire
 * against, and the one power a turn. What lives in elemental.js: every rule
 * that can be written as a function of a FEN. This file is the part that needs
 * an engine — because a power that changes the board has to load a new
 * position into one, and because only an engine can answer whether a king is
 * attacked.
 */

import { GAME_MODE, WHITE, BLACK, log, warn } from '../config.js';
import { ChessEngine } from '../chess-engine.js';
import { boardFromFen } from '../board-shared.js';
import { LocalSession, SESSION_ACTION } from './local-session.js';
import {
  EFFECT,
  EFFECT_PLIES,
  ELEMENT,
  ELEMENTS,
  POWER_AIM,
  PIECE_WORTH,
  WARDS_CAPTURE,
  WARDS_POWER,
  activeEffects,
  addPiece,
  arcSquares,
  arcTarget,
  arsenal,
  assignElements,
  bloodTargets,
  burnSquares,
  canRewind,
  castDamage,
  chargedEnemies,
  chargesAfterMove,
  chargesAfterRemoval,
  defaultLoadout,
  describeBoard,
  dragPieces,
  effectsAfterMove,
  effectsAfterRemoval,
  elementAt,
  elementsAfterMove,
  elementsAfterRemoval,
  elementsAfterShift,
  filterMoves,
  intruders,
  maySwap,
  normalizeLoadout,
  ownPieces,
  powerAt,
  pullDrags,
  raySquares,
  rechargeable,
  relocateKing,
  removePieces,
  revivalPiece,
  singularityDrags,
  SUPERS,
  superAt,
  superTargets,
  firestormSquares,
  stormSquares,
  deepFreezeSquares,
  overgrowthSquares,
  tideDrags,
  tidalSquares,
  swapPieces,
  startingCharges,
  withTurn,
  wormholeDrags,
} from '../elemental.js';

/** What a refused power or move is called when the player is told about it. */
const REFUSAL = {
  [EFFECT.FROZEN]: 'That piece is frozen solid',
  [EFFECT.VINES]: 'Vines are in the way',
  [EFFECT.SHIELD]: 'A water shield turns that away',
  [EFFECT.CRYSTAL]: 'The crystal turns that away',
};

/** What a power turned aside by a ward is called when it is reported. */
const WARD_REFUSAL = {
  [EFFECT.ARMOUR]: 'Metal armour turns that away',
  [EFFECT.CRYSTAL]: 'The crystal throws it straight back',
};

export const withElemental = (Base) => class extends Base {
  /**
   * Squares whose piece still has its one power.
   *
   * Charges are held by square because that is the only name a piece has. Every
   * move therefore has to carry them along — chargesAfterMove does that, and it
   * is the one piece of bookkeeping in the variant that would silently hand
   * somebody a second power if it were wrong.
   */
  #charges = new Set();

  /**
   * Which element each piece is carrying: square -> element id.
   *
   * Tracked rather than derived, which is the change a seventeen-element
   * roster forced. It is remapped by exactly the same bookkeeping the charges
   * get — elementsAfterMove() beside chargesAfterMove(), one after the other,
   * every time — and the two must be kept in step or a piece ends up holding
   * a charge for a power it is not carrying.
   *
   * It differs from the charges in one place and one only: a promotion keeps
   * the element and mints a new charge. See elementsAfterMove().
   */
  #elements = new Map();

  /**
   * The elements this game is being played with.
   *
   * Kept whole rather than inferred back off the board, because a piece taken
   * on move four takes its element off the board with it and the saved game
   * still has to lay the same seventeen out the same way when it is restored.
   */
  #loadout = defaultLoadout();

  /**
   * Everything taken, in the order it fell. Spirit's supply.
   *
   * Captures and power kills both land here — a queen burned by a Fire pawn is
   * every bit as dead as one that was taken, and a Spirit power that could
   * only revive the politely captured half of your losses would be a rule
   * nobody could hold in their head.
   */
  #graveyard = [];

  /**
   * The last move played, kept here rather than read off the engine.
   *
   * Time's Rewind needs it, and the engine cannot be asked: a power that
   * changes the board reloads the position and the move history goes with it,
   * so by the time anybody wants to take a move back the engine has usually
   * forgotten there was one. This survives that, exactly as #ply does.
   */
  #lastMove = null;

  /** Frozen pieces, water shields, vines, armour, crystal and silence. */
  #effects = [];

  /**
   * Half-moves played in this game.
   *
   * Kept here rather than read off the engine's history, because a power that
   * changes the board reloads the position and the engine's history goes with
   * it. The effects expire against this number, so it has to survive that.
   */
  #ply = 0;

  /** The ply a standalone power was last used on — one per turn is the rule. */
  #powerPly = -1;

  /** A probe engine for the "is that king attacked?" questions. Reused. */
  #probe = new ChessEngine();

  /**
   * Set while the bot is choosing and firing its own power.
   *
   * getPower and usePower both refuse a colour this device may not move, which
   * is what stops a player firing the bot's rook at their own convenience. The
   * bot is inside this session rather than at a keyboard, so it needs the same
   * two methods with that one check stood down — and this is narrower than
   * either a second copy of them or a public flag the UI could pass.
   */
  #botActing = false;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async createGame(config = {}) {
    this.#resetElemental();
    // Read before super, which knows nothing about a loadout and would pass it
    // straight through to a base session that knows less.
    this.#loadout = normalizeLoadout(config.loadout ?? defaultLoadout());
    const state = await super.createGame({ ...config, mode: GAME_MODE.ELEMENTAL });

    // After super, because the charges are read off the position it built —
    // which is the standard opening unless a FEN was handed in. The state
    // published by super therefore carries an empty elemental block for an
    // instant; this second publish is what corrects it, and it happens before
    // control returns to the caller.
    this.#charges = startingCharges(state.fen);
    this.#elements = assignElements(state.fen, this.#loadout);

    log('Elemental game started with', this.#charges.size, 'charges and',
      new Set(this.#elements.values()).size, 'elements');
    return this.publishState();
  }

  /**
   * Rebuild from a save.
   *
   * By FEN, always — the PGN is not to be trusted here. A power that took
   * pieces off the board reloaded the position and threw the history away with
   * it, so replaying the moves that are left lands somewhere the game has not
   * been for a while. super.restoreGame() would notice the mismatch and fall
   * back to the FEN anyway; stripping the PGN first means it does not have to
   * warn about a disagreement that is expected.
   */
  async restoreGame(saved) {
    this.#resetElemental();
    const result = await super.restoreGame({ ...saved, pgn: '' });
    if (!result.ok) return result;

    const stored = saved?.elemental;
    this.#ply = Number.isFinite(stored?.ply) ? Math.max(0, Math.trunc(stored.ply)) : 0;
    this.#powerPly = Number.isFinite(stored?.powerPly) ? stored.powerPly : -1;
    this.#charges = new Set(
      Array.isArray(stored?.charges) ? stored.charges.filter((s) => typeof s === 'string') : [],
    );
    this.#effects = this.#readEffects(stored?.effects);
    this.#loadout = normalizeLoadout(stored?.loadout ?? defaultLoadout());
    this.#graveyard = this.#readGraveyard(stored?.graveyard);
    this.#lastMove = this.#readMove(stored?.lastMove);
    this.#elements = this.#readElements(stored?.elements, result.state.fen);

    // A record with no elemental block at all is a game saved before this
    // mode existed, or a hand-edited one. Rather than refuse it, everything
    // on the board is charged: the position is right, and the alternative is
    // throwing away a game over bookkeeping nobody can see.
    if (!stored) this.#charges = startingCharges(result.state.fen);

    return { ok: true, state: this.publishState() };
  }

  #resetElemental() {
    this.#charges = new Set();
    this.#elements = new Map();
    this.#effects = [];
    this.#graveyard = [];
    this.#lastMove = null;
    this.#ply = 0;
    this.#powerPly = -1;
  }

  /**
   * Restart and Rematch put a fresh board up, so they have to put fresh
   * charges on it.
   *
   * Without this the new game inherits the old one's bookkeeping: the pieces
   * are back on their squares but a rook that spent its ice an hour ago is
   * still spent, effects laid in the previous game are still standing, and the
   * ply they expire against never resets so they never expire. All of it
   * invisible until somebody taps a piece and is told it has nothing left.
   *
   * Undo is the one action not handled here, and deliberately: it is locked
   * app-wide (LOCKED_CONTROLS), and rolling a charge back would mean keeping a
   * history of every power ever used to roll back through.
   */
  async submitAction(action, payload) {
    const resets = action === SESSION_ACTION.RESTART || action === SESSION_ACTION.REMATCH;
    const result = await super.submitAction(action, payload);
    if (!result.ok || !resets) return result;

    this.#resetElemental();
    this.#charges = startingCharges(super.getState().fen);
    // The loadout is the one thing a rematch keeps: the players chose it for
    // this match, and making them choose again between games would be asking
    // a question whose answer has not changed.
    this.#elements = assignElements(super.getState().fen, this.#loadout);
    return { ...result, state: this.publishState() };
  }

  /**
   * The DEBUG position loader, taught about the variant.
   *
   * Without this it loads the pieces and leaves the charges behind, so a
   * hand-loaded position arrives with powers belonging to whatever was
   * standing on those squares in the last position — pieces that can fire
   * things they never had, and pieces that cannot fire what they should.
   * Everything on the new board starts charged, which is the only answer that
   * does not depend on what was there before.
   */
  async loadFenForTesting(fen) {
    const result = await super.loadFenForTesting(fen);
    if (!result.ok) return result;
    this.#resetElemental();
    this.#charges = startingCharges(result.state.fen);
    // Pieces in a hand-loaded position are not on their starting squares, so
    // there is no loadout to lay out over them; assignElements() falls back to
    // the element each piece TYPE used to imply, which is the only answer that
    // does not depend on what was standing there in the last position.
    this.#elements = assignElements(result.state.fen, this.#loadout);
    return { ok: true, state: this.publishState() };
  }

  /**
   * Elements out of a saved record.
   *
   * Stored as pairs rather than rebuilt by replaying the game, because there is
   * no game left to replay — a power that changed the board threw the history
   * away. A record written before the roster grew has no element list at all,
   * and gets one laid out fresh over the position it does have: wrong for any
   * piece that has moved off its starting square, and the only alternative is
   * refusing to open a game somebody was in the middle of.
   *
   * Any piece the record does not mention is topped up the same way, so the
   * one thing that cannot happen is a piece on the board with no element.
   */
  #readElements(pairs, fen) {
    const fallback = assignElements(fen, this.#loadout);
    if (!Array.isArray(pairs)) return fallback;

    const board = boardFromFen(fen);
    const elements = new Map();
    pairs.forEach((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) return;
      const [square, element] = pair;
      if (typeof square !== 'string' || !board.has(square)) return;
      if (!ELEMENTS[element]) return;
      elements.set(square, element);
    });

    board.forEach((piece, square) => {
      if (!elements.has(square)) elements.set(square, fallback.get(square));
    });
    return elements;
  }

  /** The pile of taken pieces out of a saved record. */
  #readGraveyard(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((piece) => piece && typeof piece === 'object')
      .filter((piece) => 'pnbrqk'.includes(piece.type))
      .map((piece) => ({
        type: piece.type,
        color: piece.color === BLACK ? BLACK : WHITE,
      }));
  }

  /**
   * The last move out of a saved record.
   *
   * Only the fields Rewind reads, and all of them checked: a saved move is the
   * one piece of this state that decides whether a power may rewrite the board,
   * so a malformed one has to come back as "there is nothing to take back"
   * rather than as a half-move canRewind() will believe.
   */
  #readMove(move) {
    if (!move || typeof move !== 'object') return null;
    if (typeof move.from !== 'string' || typeof move.to !== 'string') return null;
    if (!'pnbrqk'.includes(move.piece)) return null;
    return {
      from: move.from,
      to: move.to,
      piece: move.piece,
      color: move.color === BLACK ? BLACK : WHITE,
      isCapture: Boolean(move.isCapture),
      isCastle: Boolean(move.isCastle),
      isPromotion: Boolean(move.isPromotion),
      isEnPassant: Boolean(move.isEnPassant),
    };
  }

  /** Effects out of a saved record, keeping only ones that make sense. */
  #readEffects(list) {
    if (!Array.isArray(list)) return [];
    const kinds = Object.values(EFFECT);
    return list
      .filter((effect) => effect && typeof effect === 'object')
      .filter((effect) => kinds.includes(effect.kind))
      .filter((effect) => typeof effect.square === 'string')
      .map((effect) => ({
        kind: effect.kind,
        square: effect.square,
        color: effect.color === BLACK ? BLACK : WHITE,
        until: Number.isFinite(effect.until) ? Math.trunc(effect.until) : 0,
      }));
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  getState() {
    const state = super.getState();
    if (!state) return state;

    return {
      ...state,
      elemental: {
        ply: this.#ply,
        charges: [...this.#charges],
        elements: [...this.#elements],
        loadout: [...this.#loadout],
        graveyard: this.#graveyard.map((piece) => ({ ...piece })),
        lastMove: this.#lastMove ? { ...this.#lastMove } : null,
        effects: this.#effects.map((effect) => ({ ...effect })),
        // One standalone power a turn. The bar reads this to grey itself out
        // rather than offering a button that will be refused.
        powerUsed: this.#powerPly === this.#ply,
        ...this.#describe(state.fen),
      },
    };
  }

  #describe(fen) {
    return describeBoard({
      fen,
      charges: this.#charges,
      effects: this.#effects,
      ply: this.#ply,
      elements: this.#elements,
    });
  }

  /**
   * The context every power question needs beyond the position.
   *
   * Gathered in one place because powerAt(), superAt() and arsenal() each want
   * all of it and each would otherwise be assembled by hand at four call sites
   * — which is four chances to forget the graveyard and have Spirit quietly
   * report that you have lost nothing.
   */
  #powerContext() {
    return {
      charges: this.#charges,
      elements: this.#elements,
      graveyard: this.#graveyard,
      lastMove: this.#lastMove,
      silenced: this.#silenced(),
      isQuiet: (fen) => this.#isQuiet(fen),
    };
  }

  /** The squares a Void has shut, right now. */
  #silenced() {
    return new Set(
      activeEffects(this.#effects, this.#ply)
        .filter((effect) => effect.kind === EFFECT.SILENCED)
        .map((effect) => effect.square),
    );
  }

  /**
   * What is standing between a power and this square, or null.
   *
   * The one place the two wards are read, so that every power turns aside for
   * the same reasons. ARMOUR means the square is simply skipped; CRYSTAL means
   * the power comes back at whoever cast it. Both only ever protect the side
   * that laid them, which is what stops your own Bulwark blocking your own
   * Burn.
   */
  #wardOn(square, caster) {
    const board = boardFromFen(super.getState().fen);
    const owner = board.get(square)?.color;
    if (!owner || owner === caster) return null;
    const ward = activeEffects(this.#effects, this.#ply)
      .find((effect) => effect.square === square && WARDS_POWER.includes(effect.kind));
    return ward?.kind ?? null;
  }

  /** Squares a power may not touch: warded, and belonging to the other side. */
  #unwarded(squares, caster) {
    return squares.filter((square) => !this.#wardOn(square, caster));
  }

  // -----------------------------------------------------------------------
  // Moves under the effects
  // -----------------------------------------------------------------------

  /**
   * Legal moves, with the ones the effects forbid taken out.
   *
   * Filtered against the WHOLE position rather than square by square, because
   * the thaw rule is a question about the player and not about one piece: it
   * asks whether they have any move left anywhere. Answering that per square
   * would let a player be stranded as long as each individual piece looked
   * stuck for its own reason.
   */
  getAllLegalMoves() {
    return filterMoves(super.getAllLegalMoves(), this.#effects, this.#ply).moves;
  }

  getLegalMoves(square) {
    if (!square) return [];
    const allowed = this.getAllLegalMoves();
    return allowed.filter((move) => move.from === square);
  }

  /** Is this move allowed once the effects have had their say? */
  isMoveAllowed(from, to) {
    return this.getLegalMoves(from).some((move) => move.to === to);
  }

  /** Why a move was refused, in words, or null if it was not the effects. */
  #refusalFor(from, to) {
    const active = activeEffects(this.#effects, this.#ply);
    const frozen = active.find((e) => e.kind === EFFECT.FROZEN && e.square === from);
    if (frozen) return REFUSAL[EFFECT.FROZEN];

    const raw = super.getLegalMoves(from).find((move) => move.to === to);
    if (!raw) return null;

    if (raw.isCapture) {
      const taken = raw.isEnPassant ? `${raw.to[0]}${raw.from[1]}` : raw.to;
      // Both of the effects that stop a capture, not just the water shield.
      // filterMoves() has treated them alike since Crystal was added, and a
      // move refused with nothing to say is a move the player believes they
      // mis-tapped.
      const ward = active.find(
        (e) => WARDS_CAPTURE.includes(e.kind) && e.square === taken,
      );
      if (ward) return REFUSAL[ward.kind];
    }
    if (active.some((e) => e.kind === EFFECT.VINES)) return REFUSAL[EFFECT.VINES];
    return null;
  }

  async submitMove(request = {}) {
    const { from, to } = request;

    // Vetted here rather than left to the board, because the bot submits moves
    // that never went near the board — its search knows the rules of chess and
    // nothing about ice.
    if (from && to && !this.isMoveAllowed(from, to)) {
      const reason = this.#refusalFor(from, to);
      if (reason) return { ok: false, error: reason };
    }

    // Read BEFORE the move: whether the piece that is about to capture still
    // has its power. Afterwards the charge has moved to the landing square,
    // where a promotion may also have just minted a fresh one — and a pawn
    // that spent its fire long ago would look loaded again.
    const chargedMover = this.#charges.has(from);

    const result = await super.submitMove(request);
    if (!result.ok) return result;

    const move = result.move;
    this.#ply += 1;
    // The order here is the bookkeeping, and all four lines follow the same
    // move. The graveyard goes first because it has to read the board as it
    // was — by the time the charges and elements have been remapped, the piece
    // that was taken is already gone from both.
    this.#bury(move);
    this.#charges = chargesAfterMove(this.#charges, move);
    this.#elements = elementsAfterMove(this.#elements, move);
    this.#effects = effectsAfterMove(this.#effects, move, this.#ply);
    this.#lastMove = { ...move };

    const struck = chargedMover && move.isCapture ? this.#fireCapturePower(move) : null;
    this.#thawIfStranded();

    const state = this.publishState();
    return { ...result, state, elemental: struck };
  }

  /**
   * Fire or lightning, going off by itself because something was taken.
   *
   * Returns what happened, for the toast and the sound, or null if nothing
   * did. The element is read from the piece that MOVED rather than the one
   * standing on the square afterwards: a pawn that captures onto the back rank
   * is a Fire pawn making a capture, and arrives as a queen a moment later.
   */
  #fireCapturePower(move) {
    const fen = super.getState().fen;
    // Read off the landing square, which is where the element has just been
    // carried to. A pawn that captures onto the back rank is a Fire pawn
    // making a capture and arrives as a queen a moment later; the element
    // travelled with the piece, not with what it became.
    const element = elementAt(this.#elements, move.to);
    if (!ELEMENTS[element]?.onCapture) return null;

    const targets = element === ELEMENT.FIRE
      ? this.#unwarded(burnSquares(move.to, fen, move.color), move.color)
      // ONE hop, not the chain. The knight has already destroyed something —
      // it captured, which is how this was triggered — so the arc is the
      // second piece and the pair costs one charge. Cast instead of captured,
      // the knight takes nothing itself, so the chain runs twice from the
      // square it struck and the pair still costs one charge. Both ways it is
      // two pieces for one charge, which is the rule; they only differ in
      // where the first of the two comes from.
      : this.#unwarded([arcTarget(move.to, fen, move.color)].filter(Boolean), move.color);

    if (!targets.length) return null;

    const gone = this.#destroy(targets, move.color, fen);
    // All or nothing. Taking an enemy piece out of the way can open a line
    // that was pointing at YOUR king all along, and the turn has already
    // passed — so there would be no move left to answer it with. Fire will
    // not burn away your own defence; it simply does not go off, and the
    // charge is not spent either.
    // `withheld` means one thing and one thing only: the blast was held back
    // to protect your own king, which is worth a toast because the evidence
    // is a piece that is inexplicably still standing there. A position the
    // engine refused is not that, and saying it was would be a lie about a
    // rule — it is warned about inside #destroy and reported as nothing
    // happening, which from the player's side is true.
    if (!gone.ok) {
      return gone.reason === 'king'
        ? { element, from: move.to, withheld: true, targets: [] }
        : null;
    }

    this.#charges.delete(move.to);
    return {
      element, from: move.to, withheld: false, targets, destroyed: gone.destroyed,
    };
  }

  /**
   * Take pieces off the board, or refuse to.
   *
   * The one place a power removes material, shared by the capture trigger and
   * by Burn and Chain Attack being cast on purpose — so the rule that keeps
   * the position legal is written once and cannot apply to one of them and
   * not the other.
   *
   * THE RULE. Removing an enemy piece can open a line that was pointing at
   * your OWN king all along. On a capture the turn has already passed, so
   * there would be no move left to answer it with; cast, it would hand the
   * engine a position where the side not to move is in check. Neither is a
   * position chess has a word for, so the removal does not happen at all.
   */
  #destroy(targets, color, fen = super.getState().fen) {
    const after = removePieces(fen, targets);
    if (this.#kingAttacked(after, color)) {
      return { ok: false, reason: 'king', error: 'That would open a line onto your own king' };
    }

    const applied = this.setPosition(after);
    if (!applied.ok) {
      warn('Elemental removal produced an invalid position', applied.error);
      return { ok: false, reason: 'invalid', error: 'That power did not work' };
    }

    this.#charges = chargesAfterRemoval(this.#charges, targets);
    this.#elements = elementsAfterRemoval(this.#elements, targets);
    this.#effects = effectsAfterRemoval(this.#effects, targets);

    // WHAT was destroyed, not only where. The board has to draw these pieces
    // coming apart, and by the time it hears about the power they are gone
    // from its own copy of the position — publishState() has already run,
    // from inside this very call, and the repaint it caused took them off.
    // Reading them off the board a moment earlier here costs nothing and
    // removes the board's dependence on the order two events happen to be
    // emitted in, which is exactly the kind of thing that works until
    // somebody moves a line.
    const before = boardFromFen(fen);
    const destroyed = targets.map((square) => ({
      square,
      type: before.get(square)?.type ?? 'p',
      color: before.get(square)?.color ?? (color === WHITE ? BLACK : WHITE),
    }));

    // Burned, struck and bled-out pieces go in the same pile captured ones do.
    // Spirit draws from all of it, because a queen a Fire pawn took apart is
    // exactly as gone as one that was captured, and a rule that could tell
    // them apart would be a rule nobody could hold in their head.
    destroyed.forEach(({ type, color: side }) => this.#graveyard.push({ type, color: side }));

    return { ok: true, destroyed };
  }

  /**
   * Put whatever a move took into the graveyard.
   *
   * Off `move.captured` rather than off the board, because the board has
   * already moved on: by the time this is called the capturing piece is
   * standing on the square and there is nothing there to read. En passant is
   * the case that proves it — the pawn it takes was never on the landing
   * square at all.
   */
  #bury(move) {
    if (!move?.captured) return;
    this.#graveyard.push({
      type: move.captured,
      color: move.color === WHITE ? BLACK : WHITE,
    });
  }

  // -----------------------------------------------------------------------
  // Powers
  // -----------------------------------------------------------------------

  /** May whoever is asking fire a power for this colour right now? */
  #mayAct(color) {
    return this.#botActing || this.getControllableColors().includes(color);
  }

  /**
   * What the piece on this square can do right now, or null.
   *
   * The one question the power bar, the board's targeting and the bot all ask,
   * so that "can this piece do something" has exactly one answer.
   */
  getPower(square) {
    const state = super.getState();
    if (!state || state.isGameOver) return null;
    if (!this.#mayAct(state.turn)) return null;

    return powerAt({
      square,
      fen: state.fen,
      color: state.turn,
      ...this.#powerContext(),
    });
  }

  /**
   * The same question about the piece's SUPER.
   *
   * A separate method rather than a flag on getPower, because the two are
   * asked at different moments and by different things: the bar asks both
   * about the piece in hand, but the board asks getPower about every square
   * while it decides what to highlight, and the bot asks it while it thinks.
   * Folding them together would make every one of those calls compute a
   * Firestorm they had no use for.
   *
   * Null once your king is in check. A super is your whole turn, and passing
   * the turn in check leaves a king that can simply be taken — so it is not
   * offered rather than being offered and refused.
   */
  getSuper(square) {
    const state = super.getState();
    if (!state || state.isGameOver) return null;
    if (!this.#mayAct(state.turn)) return null;
    if (state.isCheck) return null;

    return superAt({
      square,
      fen: state.fen,
      color: state.turn,
      ...this.#powerContext(),
    });
  }

  /**
   * Every power this side still holds, spent ones included.
   *
   * The panel's question rather than the power bar's: the bar is only ever
   * about the piece in hand, and this is about what is left in the match. Not
   * folded into getState() on purpose — it walks the board and probes the
   * engine for the Shadow king, and the state is read on every tick and
   * written into every save, neither of which wants to pay for a panel that
   * is usually closed.
   */
  getArsenal() {
    const state = super.getState();
    if (!state || state.isGameOver) return [];
    // Deliberately NOT #mayAct, which getPower uses. #mayAct stands the seat
    // check down while the bot is inside this session choosing and firing its
    // own power, which getPower needs and this must not have: the panel is a
    // view, it repaints on every state change, and one of the changes the bot
    // publishes lands while that flag is still set. The panel would then draw
    // the bot's hand — its counts, its readiness — on the player's screen for
    // a frame or two and go blank again, which is both a leak and a flicker.
    //
    // Found by a test that had asserted the right thing for the wrong reason:
    // it passed for months only because the bot never had a power ready this
    // early, back when reach came off the caster's own lines.
    if (!this.getControllableColors().includes(state.turn)) return [];

    return arsenal({
      fen: state.fen,
      color: state.turn,
      ...this.#powerContext(),
    });
  }

  /**
   * Use a power. Returns {ok, error?, used?}.
   *
   * Powers are free — this does not end the turn, and the player still has
   * their move to make afterwards. What stops the board disappearing under a
   * pile of them is that there is one charge per piece, and one standalone
   * power per turn.
   */
  async usePower({ from, target } = {}) {
    const state = super.getState();
    if (!state) return { ok: false, error: 'No game' };
    if (state.isGameOver) return { ok: false, error: 'The game is over' };
    if (!this.#mayAct(state.turn)) {
      return { ok: false, error: 'Not your turn' };
    }
    if (this.#powerPly === this.#ply) {
      return { ok: false, error: 'One power a turn — make your move' };
    }

    const power = this.getPower(from);
    if (!power) return { ok: false, error: 'Nothing to use there' };
    if (power.blockedBy === ELEMENT.VOID) {
      return { ok: false, error: 'The Void has that piece by the throat' };
    }
    if (power.blockedBy === ELEMENT.LIGHT) {
      return { ok: false, error: 'A charged Light bishop holds the shadows shut' };
    }
    if (!power.ready) {
      return { ok: false, error: `${power.info.power} has nothing to aim at` };
    }
    if (power.info.aim !== POWER_AIM.NONE && !power.targets.includes(target)) {
      return { ok: false, error: 'Not a square that power can reach' };
    }

    const turned = this.#wardOn(target, state.turn);
    if (turned === EFFECT.ARMOUR) {
      return { ok: false, error: WARD_REFUSAL[EFFECT.ARMOUR] };
    }
    // Before anything is applied, because a rebound ends the power: the charge
    // is still spent and the caster dies, which is the whole of what makes a
    // Prism worth a turn to lay down.
    const rebound = this.#rebound(power, target, state);
    if (rebound) return rebound;

    const applied = this.#applyPower(power, target, state);
    if (!applied.ok) return applied;

    // `spent` rather than `from` wherever the power moved its own caster:
    // a Space pawn that has swapped is not on `from` any more, and deleting
    // that square would take the charge off whatever came the other way while
    // leaving the pawn loaded.
    (applied.spent ?? [from]).forEach((square) => this.#charges.delete(square));
    this.#powerPly = this.#ply;
    this.#thawIfStranded();

    // `targets` is every square the power landed on; `destroyed` is the
    // subset whose piece is now gone, as {square, type, color} so the board
    // can draw it burning without still having it. They are reported apart
    // because the board has to tell them apart: a frozen queen and a burned
    // one leave the same trace in the state that follows, and only one of
    // them should be seen to come to pieces.
    const destroyed = applied.destroyed ?? [];
    log('Power used:', power.info.power, from, '->', target ?? '(no target)');
    return {
      ok: true,
      used: {
        element: power.element,
        from,
        target,
        // `touched` first, because the powers that drag and revive reach
        // squares the player never pointed at and the board has to light all
        // of them: a Tide that pulls six pieces back is not one square's worth
        // of animation.
        targets: applied.touched ?? (destroyed.length
          ? destroyed.map((piece) => piece.square)
          : [target].filter(Boolean)),
        destroyed,
      },
      state: this.publishState(),
    };
  }

  /**
   * Use a super. Returns the same shape usePower does.
   *
   * The one thing in the variant that costs a move. Everything an ordinary
   * power does happens first — the charge is spent, the board changes — and
   * then the turn is handed over without a move having been played, by
   * rewriting the side to move into the FEN and reloading it. That is the
   * whole of the price, and it is why a super can be as loud as it likes.
   *
   * Refused in check, before anything is spent. Passing the turn there leaves
   * a king that can simply be taken, which is not a position chess has a word
   * for — and refusing it here rather than letting it produce an illegal
   * board is the difference between a rule and a crash.
   */
  async useSuper({ from, target } = {}) {
    const state = super.getState();
    if (!state) return { ok: false, error: 'No game' };
    if (state.isGameOver) return { ok: false, error: 'The game is over' };
    if (!this.#mayAct(state.turn)) return { ok: false, error: 'Not your turn' };
    if (state.isCheck) {
      return { ok: false, error: 'You cannot give up your move while in check' };
    }
    if (this.#powerPly === this.#ply) {
      return { ok: false, error: 'One power a turn — make your move' };
    }

    const power = this.getSuper(from);
    if (!power) return { ok: false, error: 'Nothing to use there' };
    if (this.#silenced().has(from)) {
      return { ok: false, error: 'The Void has that piece by the throat' };
    }
    if (power.blockedBy === ELEMENT.LIGHT) {
      return { ok: false, error: 'A charged Light bishop holds the shadows shut' };
    }
    if (!power.ready) {
      return { ok: false, error: `${power.info.power} has nothing to aim at` };
    }
    if (power.info.aim !== POWER_AIM.NONE && !power.targets.includes(target)) {
      return { ok: false, error: 'Not a square that power can reach' };
    }

    if (this.#wardOn(target, state.turn) === EFFECT.ARMOUR) {
      return { ok: false, error: WARD_REFUSAL[EFFECT.ARMOUR] };
    }
    const rebound = this.#rebound(power, target, state);
    if (rebound) return rebound;

    const applied = this.#applySuper(power, target, state);
    if (!applied.ok) return applied;

    // Every caster it used, not only the one it was called from: a Firestorm
    // is several pawns going up together and each of them is spent.
    (applied.spent ?? [from]).forEach((square) => this.#charges.delete(square));

    // And now the price. The ply advances exactly as a move would advance it,
    // so effects laid this turn expire on the same cadence they always do,
    // and the side to move is swapped in the FEN. #powerPly is set to the ply
    // BEFORE the advance, which is the turn that has just been spent.
    this.#powerPly = this.#ply;
    this.#ply += 1;

    const handed = this.setPosition(withTurn(super.getState().fen, this.#otherColor(state.turn)));
    if (!handed.ok) {
      warn('Handing over the turn after a super produced an invalid position', handed.error);
      return { ok: false, error: 'That power did not work' };
    }

    // Nothing is pruned here on purpose. An effect laid this turn carries
    // `until = ply + EFFECT_PLIES`, and the ply has just advanced by one
    // without a move, so activeEffects() keeps it for exactly the opponent's
    // single reply and drops it as the caster's next turn begins. That is the
    // same cadence an ordinary power gets — the difference is only that there
    // is no "rest of your turn" left to cover, because you gave it away.
    this.#thawIfStranded();

    const destroyed = applied.destroyed ?? [];
    log('Super used:', power.info.power, from, '->', target ?? '(no target)');
    return {
      ok: true,
      used: {
        element: power.element,
        from,
        target,
        isSuper: true,
        name: power.info.power,
        targets: applied.touched ?? (destroyed.length
          ? destroyed.map((piece) => piece.square)
          : [target].filter(Boolean)),
        destroyed,
      },
      state: this.publishState(),
    };
  }

  #otherColor(color) {
    return color === WHITE ? BLACK : WHITE;
  }

  /**
   * Does this power come straight back at whoever fired it?
   *
   * Only for the square the player POINTED AT, and never for the ones a blast
   * happens to catch on the way past. That line is drawn on purpose: a Burn
   * takes a whole ring and a Deep Freeze takes a whole neighbourhood, and a
   * crystal standing anywhere in either of them turning the entire power round
   * would make every wide power a coin toss. Aim at the crystal and it throws
   * the power back; catch one in the blast and it simply does not burn.
   *
   * A SUPER turned away this way costs its charge but not the move: the turn
   * is not handed over, because the power never resolved. That is generous and
   * deliberately so — a super is already the most expensive thing in the game,
   * and paying the charge, the caster and the whole move to one enemy Prism
   * would be three prices for a single misread.
   *
   * Returns a finished usePower() result when it rebounds, and null otherwise,
   * so the caller can `if (rebound) return rebound`.
   */
  #rebound(power, target, state) {
    if (!target) return null;
    if (this.#wardOn(target, state.turn) !== EFFECT.CRYSTAL) return null;

    // The caster dies. #destroy rather than a hand-rolled removal, because the
    // rule about not opening a line onto your own king applies here too — and
    // here it protects the person being rebounded ONTO, which is the one case
    // where the caster would have been delighted to break it.
    const gone = this.#destroy([power.square], this.#otherColor(state.turn), state.fen);
    // A rebound that cannot be carried out still costs the charge. The power
    // was fired and it was turned away; the only question the board could not
    // answer is where the wreckage goes.
    this.#charges.delete(power.square);
    this.#powerPly = this.#ply;
    this.#thawIfStranded();

    log('Power rebounded:', power.info.power, power.square, '->', target);
    return {
      ok: true,
      used: {
        element: ELEMENT.CRYSTAL,
        from: target,
        target: power.square,
        rebounded: power.element,
        targets: [power.square],
        destroyed: gone.ok ? gone.destroyed : [],
      },
      state: this.publishState(),
    };
  }

  /**
   * Lay one effect on every square in a list.
   *
   * Five of the six effects are laid exactly like this and differ only in
   * whose side they belong to, so the rule about that is written once: FROZEN
   * and SILENCED record the OWNER of the piece they are working against, and
   * SHIELD, ARMOUR and CRYSTAL record the side they are protecting. Both read
   * as "the colour this effect is about", which is the only reading under
   * which the thaw can tell them apart.
   */
  #lay(kind, squares, color) {
    const until = this.#ply + EFFECT_PLIES;
    const against = kind === EFFECT.FROZEN || kind === EFFECT.SILENCED;
    const side = against ? this.#otherColor(color) : color;
    squares.forEach((square) => this.#effects.push({
      kind, square, color: side, until,
    }));
    return squares;
  }

  /**
   * Shift pieces around the board without anybody having moved them.
   *
   * The one path every drag takes — Gravity, Moon, Space — so the three things
   * that have to happen together cannot come apart: the FEN is rewritten, the
   * charges and elements ride along with the pieces, and the effects standing
   * on them do too. Refused outright if it would leave the caster's own king
   * attacked, which is the same rule #destroy keeps and for the same reason.
   */
  #drag(drags, color, fen) {
    if (!drags.length) return { ok: false, error: 'Nothing would move' };

    const after = dragPieces(fen, drags);
    if (this.#kingAttacked(after, color)) {
      return { ok: false, reason: 'king', error: 'That would open a line onto your own king' };
    }

    const applied = this.setPosition(after);
    if (!applied.ok) {
      warn('Elemental drag produced an invalid position', applied.error);
      return { ok: false, reason: 'invalid', error: 'That power did not work' };
    }

    this.#elements = elementsAfterShift(this.#elements, drags);
    drags.forEach(([from, to]) => {
      if (this.#charges.delete(from)) this.#charges.add(to);
    });
    // Effects travel with the piece they are on, exactly as they do across an
    // ordinary move. A frozen piece dragged one square is still frozen; a
    // shielded one is still shielded. Vines stay where they were grown.
    const moved = new Map(drags);
    this.#effects = this.#effects.map((effect) => (
      effect.kind === EFFECT.VINES || !moved.has(effect.square)
        ? effect
        : { ...effect, square: moved.get(effect.square) }
    ));

    return { ok: true, touched: drags.flat() };
  }

  /**
   * Put the opponent's last move back where it came from.
   *
   * Shared by Rewind and Stasis, and it is the only power in the variant that
   * changes a position by reaching backwards rather than by reaching across.
   * canRewind() has already said the move can be taken back — the square is
   * empty, nothing was captured, it was not a castle or a promotion — so all
   * that is left is the one check every board-changing power makes.
   *
   * The move is forgotten afterwards. Not because it could be rewound twice —
   * the charge is spent either way — but because a move that is no longer on
   * the board is not a move anything else should be reasoning about.
   */
  #rewind(color, fen) {
    const move = this.#lastMove;
    if (!canRewind(move, fen)) return { ok: false, error: 'There is nothing to take back' };

    const back = this.#drag([[move.to, move.from]], color, fen);
    if (!back.ok) return back;
    this.#lastMove = null;
    return back;
  }

  /** Drags with the warded pieces left standing where they are. */
  #unwardedDrags(drags, color) {
    return drags.filter(([from]) => !this.#wardOn(from, color));
  }

  /**
   * Blood's bargain: the caster and its victim, in one removal.
   *
   * One call to #destroy rather than two, because the rule it enforces — that
   * a power may not open a line onto your own king — has to be asked of the
   * board the bargain actually produces. Asked twice it would refuse bargains
   * that are perfectly safe: your own pawn coming off first can look like it
   * exposes your king right up until the enemy rook it was traded for comes
   * off as well.
   */
  #bargain(caster, victim, color, fen) {
    if (!victim) return { ok: false, error: 'Nothing to bargain with' };
    const gone = this.#destroy([caster, victim], color, fen);
    if (!gone.ok) return gone;
    return { ...gone, touched: [caster, victim] };
  }

  /**
   * Space's swap: two of your own pieces changing places, mid-turn.
   *
   * Close kin to Shadow Swap, and it borrows the same FEN surgery, but the
   * caster is not a king — so the thing being checked is not "would the king
   * be safe where it lands" but the plainer "is your king in check afterwards
   * at all", which is what every board-changing power asks.
   */
  #swap(from, to, color, fen) {
    if (!maySwap(fen, from, to)) {
      return { ok: false, error: 'A pawn cannot end up on a back rank' };
    }
    const swapped = swapPieces(fen, from, to);
    if (swapped === fen) return { ok: false, error: 'Nothing to swap with' };
    if (this.#kingAttacked(swapped, color)) {
      return { ok: false, reason: 'king', error: 'That would leave your king in check' };
    }

    const applied = this.setPosition(swapped);
    if (!applied.ok) return { ok: false, error: 'Those pieces cannot swap' };

    this.#elements = elementsAfterShift(this.#elements, [[from, to], [to, from]]);
    // Both charges change hands with their pieces. The caster's is about to be
    // spent at its NEW square, which is why usePower is told about `spent`.
    const casterCharged = this.#charges.has(from);
    const otherCharged = this.#charges.has(to);
    this.#charges.delete(from);
    this.#charges.delete(to);
    if (casterCharged) this.#charges.add(to);
    if (otherCharged) this.#charges.add(from);

    const moved = new Map([[from, to], [to, from]]);
    this.#effects = this.#effects.map((effect) => (
      effect.kind === EFFECT.VINES || !moved.has(effect.square)
        ? effect
        : { ...effect, square: moved.get(effect.square) }
    ));

    return { ok: true, touched: [from, to], spent: [to] };
  }

  /** Hand charges back to a list of pieces. Sun's half of the bargain. */
  #recharge(squares) {
    squares.forEach((square) => this.#charges.add(square));
    return squares;
  }

  /**
   * Stand a piece that was already taken back up on the board.
   *
   * It arrives carrying the element its slot would have given it, which is the
   * only answer that keeps a revived rook from being a rook with no power at
   * all — and `charged` decides whether it arrives able to use it. Revive says
   * no and Resurrection says yes, which is most of what a whole move buys.
   */
  #revive(square, piece, color, fen, { charged = false } = {}) {
    const after = addPiece(fen, square, { ...piece, color });
    if (after === fen) return { ok: false, error: 'Something is standing there' };

    const applied = this.setPosition(after);
    if (!applied.ok) {
      warn('Elemental revival produced an invalid position', applied.error);
      return { ok: false, error: 'That power did not work' };
    }

    this.#elements.set(square, assignElements(after, this.#loadout).get(square));
    if (charged) this.#charges.add(square);
    else this.#charges.delete(square);

    // Taken off the pile, so the same bishop cannot be raised twice. Searched
    // from the back, because that is the end Revive reads from and the end the
    // most recent loss is at.
    const at = this.#graveyard.findLastIndex(
      (fallen) => fallen.type === piece.type && fallen.color === color,
    );
    if (at >= 0) this.#graveyard.splice(at, 1);

    return { ok: true, touched: [square] };
  }

  /**
   * What each super does to the board.
   *
   * Returns `touched` — every square the power reached, for the animation —
   * and optionally `spent`, when the power costs more charges than the one it
   * was called from.
   */
  #applySuper(power, target, state) {
    const color = state.turn;
    const until = this.#ply + EFFECT_PLIES;
    const fen = state.fen;

    switch (power.element) {
      case ELEMENT.FIRE: {
        const storm = firestormSquares(fen, color, this.#charges);
        const gone = this.#destroy(storm.squares, color, fen);
        if (!gone.ok) return gone;
        return { ...gone, touched: storm.squares, spent: storm.casters };
      }

      case ELEMENT.LIGHTNING: {
        const struck = stormSquares(target, fen, color);
        const gone = this.#destroy(struck, color, fen);
        if (!gone.ok) return gone;
        return { ...gone, touched: struck };
      }

      // All three through #lay, like every other effect in the file: whose
      // side an effect belongs to is a rule with one home, and three arms
      // spelling it out by hand were three chances for the copy to drift.
      case ELEMENT.ICE: {
        const frozen = this.#unwarded(deepFreezeSquares(target, fen, color), color);
        return { ok: true, touched: this.#lay(EFFECT.FROZEN, frozen, color) };
      }

      case ELEMENT.WATER:
        return { ok: true, touched: this.#lay(EFFECT.SHIELD, tidalSquares(fen, color), color) };

      case ELEMENT.NATURE: {
        const grown = overgrowthSquares(target, fen);
        // Vines are the one effect that sits on a square rather than a piece,
        // so #lay's owner rule does not apply — the colour is simply whoever
        // grew them.
        grown.forEach((square) => this.#effects.push({
          kind: EFFECT.VINES, square, color, until,
        }));
        return { ok: true, touched: grown };
      }

      case ELEMENT.SHADOW: {
        const swapped = swapPieces(fen, power.square, target);
        const applied = this.setPosition(swapped);
        if (!applied.ok) return { ok: false, error: 'The king cannot go there' };
        if (this.#kingAttacked(swapped, color)) {
          this.setPosition(fen);
          return { ok: false, reason: 'king', error: 'That would leave your king in check' };
        }
        // Both elements change hands with their pieces, the same way #swap
        // does it for Space — two pieces moved means two elements moved, and
        // the king's is as much a thing it is carrying as the other one's.
        this.#elements = elementsAfterShift(
          this.#elements, [[power.square, target], [target, power.square]],
        );
        // The piece that came the other way keeps its charge, which has moved
        // with it. The king's own is about to be spent either way.
        if (this.#charges.has(target)) {
          this.#charges.delete(target);
          this.#charges.add(power.square);
        }
        return { ok: true, touched: [power.square, target] };
      }

      case ELEMENT.LIGHT: {
        this.#effects = [];
        // The only way a charge ever comes back. Added after the cleanse so a
        // piece that was frozen is both thawed and reloaded by one power.
        this.#charges.add(target);
        return { ok: true, touched: [target] };
      }

      // Armour and crystal on everything at once. The same shape Tidal Guard
      // has, and deliberately: three mass defences that differ only in what
      // they are proof against is one rule a player learns once, where three
      // differently shaped ones would be three.
      case ELEMENT.METAL:
        return { ok: true, touched: this.#lay(EFFECT.ARMOUR, ownPieces(fen, color), color) };

      case ELEMENT.CRYSTAL:
        return { ok: true, touched: this.#lay(EFFECT.CRYSTAL, ownPieces(fen, color), color) };

      case ELEMENT.VOID: {
        const shut = chargedEnemies(fen, color, this.#charges);
        // Their effects, and only theirs — the one thing Cleanse will not do.
        // Whose an effect is belongs to is read exactly the way #lay writes
        // it: a freeze or a silence records the side it works AGAINST, so the
        // ones THEY laid are the ones pointed at me.
        this.#effects = this.#effects.filter((effect) => (
          effect.kind === EFFECT.FROZEN || effect.kind === EFFECT.SILENCED
            ? effect.color !== color
            : effect.color === color
        ));
        return { ok: true, touched: this.#lay(EFFECT.SILENCED, shut, color) };
      }

      case ELEMENT.SUN: {
        const struck = this.#unwarded(raySquares(power.square, fen, color), color);
        const gone = this.#destroy(struck, color, fen);
        if (!gone.ok) return gone;
        const back = this.#recharge(rechargeable(
          power.square, super.getState().fen, color, this.#charges, this.#elements, true,
        ));
        return { ...gone, touched: [...struck, ...back] };
      }

      case ELEMENT.MOON:
        return this.#drag(
          this.#unwardedDrags(tideDrags(null, fen, color, true), color), color, fen,
        );

      case ELEMENT.BLOOD:
        // The pawn dies with its victim, in one removal rather than two, so
        // the position is handed to the engine once and the rule about opening
        // a line onto your own king is asked of the board the bargain actually
        // produces rather than of a half-finished one.
        return this.#bargain(power.square, target, color, fen);

      case ELEMENT.SPIRIT: {
        const piece = revivalPiece(this.#graveyard, color, true);
        if (!piece) return { ok: false, error: 'You have lost nothing yet' };
        return this.#revive(target, piece, color, fen, { charged: true });
      }

      case ELEMENT.GRAVITY:
        return this.#drag(
          this.#unwardedDrags(singularityDrags(target, fen, color), color), color, fen,
        );

      case ELEMENT.TIME: {
        const back = this.#rewind(color, fen);
        if (!back.ok) return back;
        const held = this.#lay(
          EFFECT.FROZEN,
          this.#unwarded(intruders(super.getState().fen, color), color),
          color,
        );
        return { ok: true, touched: [...back.touched, ...held] };
      }

      case ELEMENT.SPACE: {
        const shoved = this.#unwardedDrags(wormholeDrags(target, fen, color), color);
        const moved = this.#drag([[power.square, target], ...shoved], color, fen);
        if (!moved.ok) return moved;
        // The charge travelled with the pawn, so it is the square it ARRIVED
        // on that has to be spent — the one it left is empty.
        return { ...moved, spent: [target] };
      }

      default:
        return { ok: false, error: 'That power cannot be aimed' };
    }
  }

  #applyPower(power, target, state) {
    const color = state.turn;
    const until = this.#ply + EFFECT_PLIES;

    switch (power.element) {
      case ELEMENT.ICE:
        // The colour #lay records is the OWNER of the frozen piece — the side
        // the ice is working against — not the side that laid it.
        this.#lay(EFFECT.FROZEN, [target], color);
        return { ok: true };

      case ELEMENT.WATER:
        this.#lay(EFFECT.SHIELD, [target], color);
        return { ok: true };

      case ELEMENT.NATURE:
        // Vines are the one effect that is not on a piece, so the square is
        // its own and the colour is simply whoever grew them.
        this.#effects.push({ kind: EFFECT.VINES, square: target, color, until });
        return { ok: true };

      case ELEMENT.LIGHT:
        // Everything, whoever laid it. Cleanse is not a scalpel, and the
        // interesting half of the decision is what spending it unlocks: the
        // enemy king's teleport, which this bishop was holding shut.
        this.#effects = [];
        return { ok: true };

      // The three that only lay something down. They differ from Water's
      // shield in what they are proof against and in nothing else, so they are
      // written the same way and #lay settles whose side each belongs to.
      case ELEMENT.METAL:
        this.#lay(EFFECT.ARMOUR, [target], color);
        return { ok: true };

      case ELEMENT.CRYSTAL:
        this.#lay(EFFECT.CRYSTAL, [target], color);
        return { ok: true };

      case ELEMENT.VOID:
        this.#lay(EFFECT.SILENCED, [target], color);
        return { ok: true };

      // The two that take a piece off the board from anywhere, and both of
      // them pay for the reach. Sun pays by having to be brought up the board
      // into a line; Blood pays with the pawn itself.
      case ELEMENT.SUN: {
        const gone = this.#destroy([target], color, state.fen);
        if (!gone.ok) return gone;
        this.#recharge(rechargeable(
          power.square, super.getState().fen, color, this.#charges, this.#elements,
        ));
        return gone;
      }

      case ELEMENT.BLOOD:
        return this.#bargain(power.square, target, color, state.fen);

      // The three that move pieces without moving them. Nothing is ever
      // captured by a drag — see the mechanics in elemental.js — so these are
      // the only powers that change the position without changing the
      // material on it.
      case ELEMENT.GRAVITY:
        return this.#drag(pullDrags(target, power.square, state.fen, color), color, state.fen);

      case ELEMENT.MOON:
        return this.#drag(
          this.#unwardedDrags(tideDrags(target[1], state.fen, color), color),
          color,
          state.fen,
        );

      case ELEMENT.SPACE:
        return this.#swap(power.square, target, color, state.fen);

      case ELEMENT.SPIRIT: {
        const piece = revivalPiece(this.#graveyard, color);
        if (!piece) return { ok: false, error: 'You have lost nothing yet' };
        return this.#revive(target, piece, color, state.fen);
      }

      case ELEMENT.TIME:
        return this.#rewind(color, state.fen);

      case ELEMENT.SHADOW: {
        const moved = relocateKing(state.fen, power.square, target);
        const applied = this.setPosition(moved);
        if (!applied.ok) return { ok: false, error: 'The king cannot go there' };
        // Everything riding on the king's old square goes with it. Its charge
        // is about to be spent either way; its ELEMENT is not, and a king that
        // teleports out of its element is a king holding a power the board
        // cannot name and the panel cannot draw.
        this.#elements = elementsAfterShift(this.#elements, [[power.square, target]]);
        this.#charges.delete(power.square);
        return { ok: true, touched: [power.square, target] };
      }

      // The two that destroy. What the player pointed at decides almost
      // nothing for Fire — the whole ring around the pawn goes either way, and
      // the aimed square is only how you say WHICH pawn. For Lightning it
      // decides everything: the bolt hits what you picked and arcs on from
      // there.
      case ELEMENT.FIRE:
        return this.#destroy(
          this.#unwarded(burnSquares(power.square, state.fen, color), color),
          color,
          state.fen,
        );

      case ELEMENT.LIGHTNING:
        return this.#destroy(
          this.#unwarded(arcSquares(target, state.fen, color), color),
          color,
          state.fen,
        );

      default:
        return { ok: false, error: 'That power cannot be aimed' };
    }
  }

  // -----------------------------------------------------------------------
  // Keeping the position legal
  // -----------------------------------------------------------------------

  /** Load a FEN into the probe engine. Returns false if it will not load. */
  #loadProbe(fen) {
    return this.#probe.loadFen(fen).ok;
  }

  /**
   * Is this colour's king attacked in that position?
   *
   * An engine will only answer about the side to move, so the position is
   * handed over with that colour to move — see withTurn() for why throwing the
   * en passant square away in the process is safe.
   */
  #kingAttacked(fen, color) {
    if (!this.#loadProbe(withTurn(fen, color))) return true;
    return this.#probe.isCheck();
  }

  /** Neither king in check: what a teleport has to leave behind it. */
  #isQuiet(fen) {
    return !this.#kingAttacked(fen, WHITE) && !this.#kingAttacked(fen, BLACK);
  }

  /**
   * The thaw.
   *
   * Effects only ever take moves away, and taking the last one away would
   * leave a player who is neither mated nor stalemated with nothing they are
   * allowed to do. Chess has no word for that and this variant is not going to
   * invent one, so the effects give way instead — precisely the ones working
   * against whoever is about to move, and no others.
   *
   * Checked once, at the end of every turn, so the board a player is handed is
   * always one they can play from. It is rare; it is also the only thing
   * standing between a freeze and a win by paperwork.
   */
  #thawIfStranded() {
    const raw = super.getAllLegalMoves();
    // No moves at all is checkmate or stalemate, which is chess doing its job.
    if (!raw.length) return;
    if (!filterMoves(raw, this.#effects, this.#ply).thawed) return;

    const turn = super.getState().turn;
    this.#effects = this.#effects.filter((effect) => {
      if (effect.kind === EFFECT.VINES) return false;
      if (effect.kind === EFFECT.FROZEN) return effect.color !== turn;
      // Crystal stops a capture exactly as a water shield does, so it can
      // strand exactly as one can and has to give way on the same terms.
      // Armour and silence never appear here: neither takes a move away.
      if (effect.kind === EFFECT.SHIELD || effect.kind === EFFECT.CRYSTAL) {
        return effect.color === turn;
      }
      return true;
    });
    log('Effects broke rather than strand', turn);
  }

  // -----------------------------------------------------------------------
  // The bot's powers
  //
  // The search in bot.js plays chess and knows nothing about any of this, and
  // teaching it would mean an evaluation for six powers and a move generator
  // that understands vines. What it gets instead is this: a short list of
  // things worth doing, checked in order, before it moves. It uses its powers
  // sensibly rather than brilliantly, which is the honest description.
  // -----------------------------------------------------------------------

  /**
   * The bot's one power for this turn, if it likes any of them.
   * Called by the bot session before it submits its move.
   */
  async botUsePower() {
    const state = super.getState();
    if (!state || state.isGameOver) return;
    if (this.#powerPly === this.#ply) return;
    // Only for the seat this device is NOT playing. In a two-human game
    // nothing calls this at all, and if something did, it must not reach in
    // and spend a charge on the player's behalf.
    if (this.getControllableColors().includes(state.turn)) return;

    this.#botActing = true;
    try {
      const choice = this.#botChoosePower(state, state.turn);
      if (!choice) return;
      const result = await this.usePower(choice);
      if (!result.ok) log('Bot power refused:', result.error);
    } finally {
      this.#botActing = false;
    }
  }

  /**
   * Pick a power, in priority order: get the king out of trouble, save a piece
   * that is about to be lost, then take something away from the opponent.
   */
  #botChoosePower(state, color) {
    const board = boardFromFen(state.fen);
    const worth = (square) => PIECE_WORTH[board.get(square)?.type] ?? 0;

    // Resolved once and looked up by element. getPower() on a king costs a
    // probe per empty square, so asking for it inside separate searches would
    // be sixty FEN loads apiece for an answer that cannot have changed.
    //
    // One entry per element, and for the two that destroy it is the caster
    // that would destroy the most — four pawns in contact are four quite
    // different burns, and taking whichever came first out of a Set would
    // have the bot setting light to a pawn while a queen stood beside the
    // pawn next door.
    const ready = new Map();
    this.#charges.forEach((square) => {
      if (board.get(square)?.color !== color) return;
      const power = this.getPower(square);
      if (!power?.ready) return;
      const held = ready.get(power.element);
      if (!held || this.#blastWorth(power, state, color) > this.#blastWorth(held, state, color)) {
        ready.set(power.element, power);
      }
    });
    if (!ready.size) return null;

    // 1. The king is in check and can slip away. The most dramatic escape in
    //    the variant, and the one the search cannot find on its own.
    const shadow = ready.get(ELEMENT.SHADOW);
    if (state.isCheck && shadow) {
      return { from: shadow.square, target: this.#safestSquare(shadow.targets, state, color) };
    }

    // 2. Take something off the board. Permanent material beats everything
    //    below it, all of which only ever delays something by a turn — and
    //    unlike a capture there is nothing to recapture afterwards. A knight's
    //    worth is the floor, so it does not spend a pawn's whole charge on a
    //    pawn.
    //    All four that destroy are weighed together and the best one wins.
    //    Blood is in here on the same terms as the rest because castDamage()
    //    reports it NET of the pawn it costs — a bargain valued at face value
    //    is a bot cheerfully trading a pawn for a pawn.
    const blast = [ELEMENT.FIRE, ELEMENT.LIGHTNING, ELEMENT.SUN, ELEMENT.BLOOD]
      .map((id) => ready.get(id))
      .filter(Boolean)
      .map((power) => ({ power, best: this.#bestBlast(power, state, color) }))
      .filter((entry) => entry.best)
      .sort((a, b) => b.best.worth - a.best.worth)[0];
    if (blast && blast.best.worth >= PIECE_WORTH.n) {
      return { from: blast.power.square, target: blast.best.target };
    }

    // 3. Something valuable is attacked and one of the three defences can be
    //    put over it. Not worth a charge for a pawn; a rook or better is.
    //
    //    Water first, then Crystal, then Metal, and the order is the strength
    //    of what each one actually prevents HERE: the piece is about to be
    //    taken by a piece, which water and crystal both stop outright and
    //    metal does not stop at all. Metal is still offered last rather than
    //    not at all, because a bot holding a charge it will never find a
    //    better moment for is a bot that has wasted it.
    const attacked = this.#attackedSquares(state, color);
    const rescue = [ELEMENT.WATER, ELEMENT.CRYSTAL, ELEMENT.METAL]
      .map((id) => ready.get(id))
      .filter(Boolean)
      .map((power) => {
        const saveable = power.targets
          .filter((square) => attacked.has(square))
          .sort((a, b) => worth(b) - worth(a));
        return { power, square: saveable[0] ?? null };
      })
      .find((entry) => entry.square && worth(entry.square) >= PIECE_WORTH.r);
    if (rescue) return { from: rescue.power.square, target: rescue.square };

    // 4. Ice on whatever of theirs is worth the most, once it is worth more
    //    than the charge being spent on it.
    const ice = ready.get(ELEMENT.ICE);
    if (ice) {
      const best = [...ice.targets].sort((a, b) => worth(b) - worth(a));
      if (best.length && worth(best[0]) >= PIECE_WORTH.n) {
        return { from: ice.square, target: best[0] };
      }
    }

    // 5. Silence, on whatever of theirs is worth the most and still loaded.
    //    Slotted in beside Ice because it is the same kind of move — a turn
    //    taken away rather than a piece — and because the pieces worth
    //    silencing are the ones worth freezing.
    const shut = ready.get(ELEMENT.VOID);
    if (shut) {
      const best = [...shut.targets].sort((a, b) => worth(b) - worth(a));
      if (best.length && worth(best[0]) >= PIECE_WORTH.r) {
        return { from: shut.square, target: best[0] };
      }
    }

    // 6. Spirit, once there is something worth raising. A pawn back is not
    //    worth a charge; a rook or a queen is worth it the moment it falls.
    const spirit = ready.get(ELEMENT.SPIRIT);
    if (spirit) {
      const back = revivalPiece(this.#graveyard, color);
      if (back && PIECE_WORTH[back.type] >= PIECE_WORTH.r) {
        return { from: spirit.square, target: this.#safestSquare(spirit.targets, state, color) };
      }
    }

    // 7. Light, but only once there is something to wash off — cleansing an
    //    empty board would throw away the hold it has on their king for
    //    nothing at all.
    const light = ready.get(ELEMENT.LIGHT);
    const binding = activeEffects(this.#effects, this.#ply).some((effect) => (
      effect.kind === EFFECT.VINES
      || (effect.kind === EFFECT.FROZEN && effect.color === color)
      || (effect.kind === EFFECT.SHIELD && effect.color !== color)
      || (effect.kind === EFFECT.CRYSTAL && effect.color !== color)
      || (effect.kind === EFFECT.SILENCED && effect.color === color)
    ));
    if (light && binding) return { from: light.square };

    // The rest — Nature, Space, Time, Moon, Gravity — are left alone on
    // purpose rather than left out by oversight. Each of them changes the
    // SHAPE of the position without changing the material on it, and the
    // search in bot.js is the only thing here that can judge a shape. Handing
    // it a heuristic instead would be guessing on its behalf, and a bot that
    // drags a rook one square for no reason is worse than a bot that holds
    // the charge.
    return null;
  }

  /**
   * The best thing a destroying power could be pointed at, and what it takes.
   *
   * Fire's answer does not depend on where you point it — the whole ring
   * around the pawn goes up either way, and the aimed square is only how the
   * player says WHICH pawn — so one probe settles it. Lightning's does depend
   * on it, because the bolt arcs onward from the square it struck, and two
   * enemies in range of the same knight can be worth very different chains.
   */
  #bestBlast(power, state, color) {
    if (!power?.targets?.length) return null;
    const candidates = power.element === ELEMENT.FIRE ? [power.targets[0]] : power.targets;

    let best = null;
    candidates.forEach((target) => {
      const { worth } = castDamage({
        element: power.element, square: power.square, target, fen: state.fen, color,
      });
      if (!best || worth > best.worth) best = { target, worth };
    });
    return best;
  }

  /** What that power is worth as a blast, or nought if it does not destroy. */
  #blastWorth(power, state, color) {
    return this.#bestBlast(power, state, color)?.worth ?? 0;
  }

  /** Squares of `color` that the opponent can capture right now. */
  #attackedSquares(state, color) {
    const theirs = withTurn(state.fen, color === WHITE ? BLACK : WHITE);
    if (!this.#loadProbe(theirs)) return new Set();
    return new Set(
      this.#probe.getAllLegalMoves()
        .filter((move) => move.isCapture)
        .map((move) => move.to),
    );
  }

  /** Of several teleport squares, the one furthest from anything of theirs. */
  #safestSquare(targets, state, color) {
    const attacked = this.#attackedSquares(state, color);
    const quiet = targets.filter((square) => !attacked.has(square));
    return (quiet.length ? quiet : targets)[0];
  }
};

/** Two people, one device, seven elements. */
export const ElementalSession = withElemental(LocalSession);

export default ElementalSession;
