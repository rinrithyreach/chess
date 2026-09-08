/**
 * chess-engine.js
 * A thin, defensive wrapper around chess.js.
 *
 * Responsibilities:
 *   - Own the single authoritative chess.js instance.
 *   - Translate chess.js' throwing API into predictable return values, so no
 *     illegal move or corrupt FEN can ever escape as an unhandled exception.
 *   - Expose only plain, serializable data to the rest of the app.
 *
 * This module knows nothing about the DOM, storage, or sessions.
 *
 * chess.js version: 1.4.0 (vendored at js/vendor/chess.js)
 * API notes verified against that version:
 *   - move() THROWS on an illegal move (it does not return null). The position
 *     is left untouched when it throws.
 *   - load() THROWS on an invalid FEN, and clears the move history.
 *   - loadPgn() THROWS on unparseable PGN.
 *   - A move to the back rank by a pawn THROWS unless `promotion` is supplied.
 *   - isDraw() is true for stalemate, insufficient material, threefold
 *     repetition and the fifty-move rule, so the specific reason must be
 *     probed separately.
 */

import { Chess, validateFen } from './vendor/chess.js';
import { WHITE, BLACK, warn } from './config.js';

/** Reasons a game can end in a draw, in the order we report them. */
export const DRAW_REASON = {
  STALEMATE: 'stalemate',
  INSUFFICIENT_MATERIAL: 'insufficient-material',
  THREEFOLD: 'threefold-repetition',
  FIFTY_MOVE: 'fifty-move-rule',
  AGREEMENT: 'agreement',
};

export const DRAW_REASON_LABEL = {
  [DRAW_REASON.STALEMATE]: 'Stalemate',
  [DRAW_REASON.INSUFFICIENT_MATERIAL]: 'Insufficient Material',
  [DRAW_REASON.THREEFOLD]: 'Threefold Repetition',
  [DRAW_REASON.FIFTY_MOVE]: 'Fifty-Move Rule',
  [DRAW_REASON.AGREEMENT]: 'Draw by Agreement',
};

/**
 * Convert a chess.js Move object into a plain, serializable descriptor.
 * We call the descriptor methods (isCapture etc.) here because the `flags`
 * string field is deprecated in chess.js 1.x.
 */
function describeMove(move) {
  if (!move) return null;
  return {
    from: move.from,
    to: move.to,
    color: move.color,
    piece: move.piece,
    captured: move.captured ?? null,
    promotion: move.promotion ?? null,
    san: move.san,
    lan: move.lan,
    before: move.before,
    after: move.after,
    // chess.js reports isCapture() === false for en passant, because that move
    // carries the separate 'e' flag rather than the 'c' capture flag. For the
    // UI and sound layers en passant *is* a capture, so fold it in here.
    isCapture: move.isCapture() || move.isEnPassant(),
    isPromotion: move.isPromotion(),
    isEnPassant: move.isEnPassant(),
    isCastle: move.isKingsideCastle() || move.isQueensideCastle(),
    isKingsideCastle: move.isKingsideCastle(),
    isQueensideCastle: move.isQueensideCastle(),
  };
}

export class ChessEngine {
  #chess;

  constructor(fen) {
    this.#chess = new Chess();
    if (fen) this.loadFen(fen);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /** Reset to the standard starting position and clear all history. */
  reset() {
    this.#chess.reset();
  }

  /**
   * Load a FEN. Returns {ok, error}. Never throws.
   * Note: this discards move history — prefer loadPgn() when restoring a game
   * that needs undo or threefold-repetition detection.
   */
  loadFen(fen) {
    const check = ChessEngine.validateFen(fen);
    if (!check.ok) return check;
    try {
      this.#chess.load(fen);
      return { ok: true };
    } catch (error) {
      warn('loadFen failed', error);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Restore from PGN, replaying every move. This is the preferred restore
   * path: unlike loadFen it rebuilds the full move history, which keeps undo
   * and threefold-repetition detection working after a page refresh. PGN from
   * a non-standard starting position carries SetUp/FEN headers, so custom
   * positions round-trip correctly too.
   */
  loadPgn(pgn) {
    if (typeof pgn !== 'string' || !pgn.trim()) {
      return { ok: false, error: 'Empty PGN' };
    }
    try {
      this.#chess.loadPgn(pgn);
      return { ok: true };
    } catch (error) {
      warn('loadPgn failed', error);
      return { ok: false, error: error.message };
    }
  }

  /** Static FEN validation that never throws. */
  static validateFen(fen) {
    if (typeof fen !== 'string' || !fen.trim()) {
      return { ok: false, error: 'FEN must be a non-empty string' };
    }
    try {
      const result = validateFen(fen);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ---------------------------------------------------------------------
  // Position queries
  // ---------------------------------------------------------------------

  getFen() {
    return this.#chess.fen();
  }

  getPgn() {
    return this.#chess.pgn();
  }

  getTurn() {
    return this.#chess.turn();
  }

  /** 8x8 array from rank 8 down to rank 1; entries are {square,type,color}|null. */
  getBoard() {
    return this.#chess.board();
  }

  /** The piece on a square, or null. */
  getPiece(square) {
    return this.#chess.get(square) ?? null;
  }

  /** SAN list, e.g. ['e4','e5','Nf3']. */
  getHistory() {
    return this.#chess.history();
  }

  /** Full move descriptors for the whole game. */
  getVerboseHistory() {
    return this.#chess.history({ verbose: true }).map(describeMove);
  }

  /** The move just played, or null at the start of a game. */
  getLastMove() {
    const history = this.#chess.history({ verbose: true });
    return history.length ? describeMove(history[history.length - 1]) : null;
  }

  moveNumber() {
    return this.#chess.moveNumber();
  }

  /**
   * Legal moves from a square, as plain descriptors.
   * Returns [] for an empty square, an opponent's piece, or a finished game —
   * chess.js handles all three without throwing.
   */
  getLegalMoves(square) {
    if (!square) return [];
    try {
      return this.#chess.moves({ square, verbose: true }).map(describeMove);
    } catch (error) {
      warn('getLegalMoves failed', square, error);
      return [];
    }
  }

  /** Every legal move in the position. */
  getAllLegalMoves() {
    try {
      return this.#chess.moves({ verbose: true }).map(describeMove);
    } catch (error) {
      warn('getAllLegalMoves failed', error);
      return [];
    }
  }

  /**
   * Does moving from->to require choosing a promotion piece?
   * Determined by inspecting legal moves, so we never have to call move() and
   * catch a throw just to find out.
   */
  requiresPromotion(from, to) {
    return this.getLegalMoves(from).some((m) => m.to === to && m.isPromotion);
  }

  /** Is from->to legal (ignoring which promotion piece would be chosen)? */
  isLegalMove(from, to) {
    return this.getLegalMoves(from).some((m) => m.to === to);
  }

  /** Square occupied by the given colour's king, or null. */
  getKingSquare(color) {
    try {
      const found = this.#chess.findPiece({ type: 'k', color });
      return found.length ? found[0] : null;
    } catch (error) {
      warn('getKingSquare failed', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------

  /**
   * Attempt a move. Returns {ok:true, move} or {ok:false, error}.
   * An illegal move leaves the position completely untouched.
   */
  makeMove(from, to, promotion) {
    try {
      const request = { from, to };
      if (promotion) request.promotion = promotion;
      const move = this.#chess.move(request);
      return { ok: true, move: describeMove(move) };
    } catch (error) {
      // Expected whenever a player taps an illegal destination.
      return { ok: false, error: error.message };
    }
  }

  /** Undo the last half-move. Returns the undone move descriptor, or null. */
  undo() {
    try {
      return describeMove(this.#chess.undo());
    } catch (error) {
      warn('undo failed', error);
      return null;
    }
  }

  /** Can a half-move be taken back? */
  canUndo() {
    return this.#chess.history().length > 0;
  }

  /** Set a PGN header (used for player names and the result tag). */
  setHeader(key, value) {
    try {
      this.#chess.setHeader(key, String(value));
    } catch (error) {
      warn('setHeader failed', key, error);
    }
  }

  // ---------------------------------------------------------------------
  // Rule state
  // ---------------------------------------------------------------------

  isCheck() {
    return this.#chess.isCheck();
  }

  isCheckmate() {
    return this.#chess.isCheckmate();
  }

  isStalemate() {
    return this.#chess.isStalemate();
  }

  isInsufficientMaterial() {
    return this.#chess.isInsufficientMaterial();
  }

  isThreefoldRepetition() {
    return this.#chess.isThreefoldRepetition();
  }

  isFiftyMoveDraw() {
    return this.#chess.isDrawByFiftyMoves();
  }

  isDraw() {
    return this.#chess.isDraw();
  }

  isGameOver() {
    return this.#chess.isGameOver();
  }

  /**
   * Which draw rule applies, or null if the position is not a draw.
   * Checked most-specific first: stalemate is reported as stalemate rather
   * than as a generic draw.
   */
  getDrawReason() {
    if (!this.isDraw()) return null;
    if (this.isStalemate()) return DRAW_REASON.STALEMATE;
    if (this.isInsufficientMaterial()) return DRAW_REASON.INSUFFICIENT_MATERIAL;
    if (this.isThreefoldRepetition()) return DRAW_REASON.THREEFOLD;
    if (this.isFiftyMoveDraw()) return DRAW_REASON.FIFTY_MOVE;
    return null;
  }

  /** The side to move, spelled out — handy for status text. */
  getTurnName() {
    return this.getTurn() === WHITE ? 'White' : 'Black';
  }

  /** The side that is not to move. */
  getOpponent(color = this.getTurn()) {
    return color === WHITE ? BLACK : WHITE;
  }
}

export default ChessEngine;
