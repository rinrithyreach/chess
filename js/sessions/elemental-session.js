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
  activeEffects,
  arcSquares,
  arcTarget,
  arsenal,
  burnSquares,
  castDamage,
  chargesAfterMove,
  chargesAfterRemoval,
  describeBoard,
  effectsAfterMove,
  effectsAfterRemoval,
  elementAt,
  filterMoves,
  powerAt,
  relocateKing,
  removePieces,
  startingCharges,
  withTurn,
} from '../elemental.js';

/** What a refused power or move is called when the player is told about it. */
const REFUSAL = {
  [EFFECT.FROZEN]: 'That piece is frozen solid',
  [EFFECT.VINES]: 'Vines are in the way',
  [EFFECT.SHIELD]: 'A water shield turns that away',
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

  /** Frozen pieces, water shields and vines currently on the board. */
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
    const state = await super.createGame({ ...config, mode: GAME_MODE.ELEMENTAL });

    // After super, because the charges are read off the position it built —
    // which is the standard opening unless a FEN was handed in. The state
    // published by super therefore carries an empty elemental block for an
    // instant; this second publish is what corrects it, and it happens before
    // control returns to the caller.
    this.#charges = startingCharges(state.fen);

    log('Elemental game started with', this.#charges.size, 'charges');
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

    // A record with no elemental block at all is a game saved before this
    // mode existed, or a hand-edited one. Rather than refuse it, everything
    // on the board is charged: the position is right, and the alternative is
    // throwing away a game over bookkeeping nobody can see.
    if (!stored) this.#charges = startingCharges(result.state.fen);

    return { ok: true, state: this.publishState() };
  }

  #resetElemental() {
    this.#charges = new Set();
    this.#effects = [];
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
    return { ok: true, state: this.publishState() };
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
    });
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
      if (active.some((e) => e.kind === EFFECT.SHIELD && e.square === taken)) {
        return REFUSAL[EFFECT.SHIELD];
      }
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
    this.#charges = chargesAfterMove(this.#charges, move);
    this.#effects = effectsAfterMove(this.#effects, move, this.#ply);

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
    const element = elementAt({ type: move.piece, color: move.color }, move.to);
    if (!ELEMENTS[element]?.onCapture) return null;

    const targets = element === ELEMENT.FIRE
      ? burnSquares(move.to, fen, move.color)
      // ONE hop, not the chain. The knight has already destroyed something —
      // it captured, which is how this was triggered — so the arc is the
      // second piece and the pair costs one charge. Cast instead of captured,
      // the knight takes nothing itself, so the chain runs twice from the
      // square it struck and the pair still costs one charge. Both ways it is
      // two pieces for one charge, which is the rule; they only differ in
      // where the first of the two comes from.
      : [arcTarget(move.to, fen, move.color)].filter(Boolean);

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
    return {
      ok: true,
      destroyed: targets.map((square) => ({
        square,
        type: before.get(square)?.type ?? 'p',
        color: before.get(square)?.color ?? (color === WHITE ? BLACK : WHITE),
      })),
    };
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
      charges: this.#charges,
      isQuiet: (fen) => this.#isQuiet(fen),
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
      charges: this.#charges,
      isQuiet: (fen) => this.#isQuiet(fen),
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
    if (power.blockedBy === ELEMENT.LIGHT) {
      return { ok: false, error: 'A charged Light bishop holds the shadows shut' };
    }
    if (!power.ready) {
      return { ok: false, error: `${power.info.power} has nothing to aim at` };
    }
    if (power.info.aim !== POWER_AIM.NONE && !power.targets.includes(target)) {
      return { ok: false, error: 'Not a square that power can reach' };
    }

    const applied = this.#applyPower(power, target, state);
    if (!applied.ok) return applied;

    this.#charges.delete(from);
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
        targets: destroyed.length
          ? destroyed.map((piece) => piece.square)
          : [target].filter(Boolean),
        destroyed,
      },
      state: this.publishState(),
    };
  }

  #applyPower(power, target, state) {
    const color = state.turn;
    const until = this.#ply + EFFECT_PLIES;

    switch (power.element) {
      case ELEMENT.ICE:
        // The colour recorded is the OWNER of the frozen piece — the side the
        // ice is working against — not the side that laid it.
        this.#effects.push({
          kind: EFFECT.FROZEN,
          square: target,
          color: color === WHITE ? BLACK : WHITE,
          until,
        });
        return { ok: true };

      case ELEMENT.WATER:
        this.#effects.push({ kind: EFFECT.SHIELD, square: target, color, until });
        return { ok: true };

      case ELEMENT.NATURE:
        this.#effects.push({ kind: EFFECT.VINES, square: target, color, until });
        return { ok: true };

      case ELEMENT.LIGHT:
        // Everything, whoever laid it. Cleanse is not a scalpel, and the
        // interesting half of the decision is what spending it unlocks: the
        // enemy king's teleport, which this bishop was holding shut.
        this.#effects = [];
        return { ok: true };

      case ELEMENT.SHADOW: {
        const moved = relocateKing(state.fen, power.square, target);
        const applied = this.setPosition(moved);
        if (!applied.ok) return { ok: false, error: 'The king cannot go there' };
        // Whatever was riding on the king's old square goes with it — which is
        // only ever its own charge, since a king can be neither frozen nor
        // shielded, and that charge is about to be spent anyway.
        this.#charges.delete(power.square);
        return { ok: true };
      }

      // The two that destroy. What the player pointed at decides almost
      // nothing for Fire — the whole ring around the pawn goes either way, and
      // the aimed square is only how you say WHICH pawn. For Lightning it
      // decides everything: the bolt hits what you picked and arcs on from
      // there.
      case ELEMENT.FIRE:
        return this.#destroy(burnSquares(power.square, state.fen, color), color, state.fen);

      case ELEMENT.LIGHTNING:
        return this.#destroy(arcSquares(target, state.fen, color), color, state.fen);

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
      if (effect.kind === EFFECT.SHIELD) return effect.color === turn;
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
    const blast = [ELEMENT.FIRE, ELEMENT.LIGHTNING]
      .map((id) => ready.get(id))
      .filter(Boolean)
      .map((power) => ({ power, best: this.#bestBlast(power, state, color) }))
      .filter((entry) => entry.best)
      .sort((a, b) => b.best.worth - a.best.worth)[0];
    if (blast && blast.best.worth >= PIECE_WORTH.n) {
      return { from: blast.power.square, target: blast.best.target };
    }

    // 3. Something valuable is attacked and a bishop can put water over it.
    //    Not worth a charge for a pawn; a rook or better is worth it.
    const water = ready.get(ELEMENT.WATER);
    if (water) {
      const attacked = this.#attackedSquares(state, color);
      const saveable = water.targets
        .filter((square) => attacked.has(square))
        .sort((a, b) => worth(b) - worth(a));
      if (saveable.length && worth(saveable[0]) >= PIECE_WORTH.r) {
        return { from: water.square, target: saveable[0] };
      }
    }

    // 4. Ice on whatever of theirs is worth the most, once it is worth more
    //    than the charge being spent on it.
    const ice = ready.get(ELEMENT.ICE);
    if (ice) {
      const best = [...ice.targets].sort((a, b) => worth(b) - worth(a));
      if (best.length && worth(best[0]) >= PIECE_WORTH.n) {
        return { from: ice.square, target: best[0] };
      }
    }

    // 5. Light, but only once there is something to wash off — cleansing an
    //    empty board would throw away the hold it has on their king for
    //    nothing at all.
    const light = ready.get(ELEMENT.LIGHT);
    const binding = activeEffects(this.#effects, this.#ply).some((effect) => (
      effect.kind === EFFECT.VINES
      || (effect.kind === EFFECT.FROZEN && effect.color === color)
      || (effect.kind === EFFECT.SHIELD && effect.color !== color)
    ));
    if (light && binding) return { from: light.square };

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
