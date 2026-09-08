/**
 * board.js
 * Chessboard rendering and interaction.
 *
 * Deliberately free of chess rules: it renders whatever state it is given and
 * reports which square the user touched. Legality, turns and promotion all
 * belong to the controller.
 *
 * Performance notes:
 *   - The 64 squares are created once and then only mutated. Nothing is ever
 *     torn down and rebuilt on a move.
 *   - Interaction uses a single set of delegated listeners on the board
 *     container, so listeners are never recreated per render.
 */

import { FILES, RANKS, ANIMATION_MS, WHITE } from './config.js';

/**
 * Piece rendering.
 *
 * Phase 1 uses Unicode chess glyphs. The solid glyph set is used for BOTH
 * colours and recoloured in CSS, which keeps the two sides visually identical
 * in shape and avoids the thin, inconsistent outline glyphs some platforms
 * ship for the white pieces. Because they are font glyphs they stay sharp at
 * any resolution.
 *
 * To swap in SVG or image pieces later, replace `renderPieceContent` with a
 * renderer that returns an <img> or inline <svg>; nothing else needs to change.
 */
/**
 * U+FE0E is VARIATION SELECTOR-15: "render the previous character as text,
 * not as an emoji".
 *
 * It is load-bearing, not decorative. U+265A–265F have an emoji presentation
 * in several system fonts (Segoe UI Emoji, Noto Color Emoji). When the browser
 * picks that presentation the glyph is painted in the font's own colours and
 * CSS `color` is ignored entirely — so a *white* piece renders as a solid
 * black emoji, and the two sides become indistinguishable. Fonts differ per
 * glyph, which is why it can hit only the pawns, or only some of the back
 * rank. Requesting text presentation explicitly keeps `color` in charge.
 */
export const TEXT_PRESENTATION = '\uFE0E';

const PIECE_GLYPHS = {
  k: `♚${TEXT_PRESENTATION}`,
  q: `♛${TEXT_PRESENTATION}`,
  r: `♜${TEXT_PRESENTATION}`,
  b: `♝${TEXT_PRESENTATION}`,
  n: `♞${TEXT_PRESENTATION}`,
  p: `♟${TEXT_PRESENTATION}`,
};

const PIECE_NAMES = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

function renderPieceContent(pieceEl, piece) {
  pieceEl.textContent = PIECE_GLYPHS[piece.type] ?? '';
}

/** All 64 squares in a8..h1 order (matching chess.js' board() layout). */
function buildSquareList() {
  const squares = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    for (const file of FILES) squares.push(`${file}${rank}`);
  }
  return squares;
}

const ALL_SQUARES = buildSquareList();

/** Light or dark, computed from the coordinate rather than the array index. */
function squareShade(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rankIndex = RANKS.indexOf(square[1]);
  return (fileIndex + rankIndex) % 2 === 0 ? 'dark' : 'light';
}

export class Board {
  #root;
  #squares = new Map();
  #orientation = 'white';
  #onSquareActivate = () => {};
  #lastRendered = new Map();
  #animationsEnabled = true;
  #showCoordinates = true;
  #focusedSquare = 'e1';

  // Drag state (mouse/pen only — touch uses tap-to-move).
  #drag = null;

  constructor(rootElement) {
    if (!rootElement) throw new Error('Board root element is required');
    this.#root = rootElement;
    this.#build();
    this.#attachListeners();
  }

  /** Register the tap/click handler. The controller decides what it means. */
  onSquareActivate(handler) {
    if (typeof handler === 'function') this.#onSquareActivate = handler;
  }

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  #build() {
    this.#root.innerHTML = '';
    this.#root.setAttribute('role', 'grid');
    this.#root.setAttribute('aria-label', 'Chessboard');

    ALL_SQUARES.forEach((square) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `square square--${squareShade(square)}`;
      el.dataset.square = square;
      el.setAttribute('role', 'gridcell');
      el.tabIndex = -1;

      const fileLabel = document.createElement('span');
      fileLabel.className = 'square__coord square__coord--file';
      fileLabel.textContent = square[0];
      fileLabel.setAttribute('aria-hidden', 'true');

      const rankLabel = document.createElement('span');
      rankLabel.className = 'square__coord square__coord--rank';
      rankLabel.textContent = square[1];
      rankLabel.setAttribute('aria-hidden', 'true');

      const piece = document.createElement('span');
      piece.className = 'piece';
      piece.setAttribute('aria-hidden', 'true');

      el.append(rankLabel, fileLabel, piece);
      this.#root.append(el);
      this.#squares.set(square, { el, piece, fileLabel, rankLabel });
    });

    this.#applyOrientation();
  }

  /**
   * Reorder the DOM so visual order matches reading order.
   * Rebuilding order (rather than rotating with CSS) keeps coordinates upright
   * and keeps keyboard navigation matching what the player sees.
   */
  #applyOrientation() {
    const ordered =
      this.#orientation === 'white' ? ALL_SQUARES : [...ALL_SQUARES].reverse();

    const fragment = document.createDocumentFragment();
    ordered.forEach((square, index) => {
      const entry = this.#squares.get(square);
      const row = Math.floor(index / 8);
      const col = index % 8;

      // Coordinates live in the edge squares of the current orientation.
      entry.rankLabel.hidden = !(this.#showCoordinates && col === 0);
      entry.fileLabel.hidden = !(this.#showCoordinates && row === 7);

      fragment.append(entry.el);
    });
    this.#root.append(fragment);
  }

  setOrientation(orientation) {
    const next = orientation === 'black' ? 'black' : 'white';
    if (next === this.#orientation) return;
    this.#orientation = next;
    this.#applyOrientation();
  }

  setShowCoordinates(show) {
    if (this.#showCoordinates === show) return;
    this.#showCoordinates = Boolean(show);
    this.#applyOrientation();
  }

  setAnimationsEnabled(enabled) {
    this.#animationsEnabled = Boolean(enabled);
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  /**
   * Render a full snapshot.
   * @param {object} snapshot Controller snapshot: {state, view, settings}.
   * @param {object} [options] {animateMove} — a move descriptor to animate.
   */
  render(snapshot, options = {}) {
    const { state, view } = snapshot;
    if (!state) return;

    const board = this.#boardFromFen(state.fen);
    const selected = view?.selected ?? null;
    const targets = new Map((view?.legalTargets ?? []).map((m) => [m.to, m]));
    const lastMove = state.lastMove;

    this.#squares.forEach((entry, square) => {
      const piece = board.get(square) ?? null;
      this.#renderPiece(entry, piece, square);

      const target = targets.get(square);
      const el = entry.el;

      el.classList.toggle('is-selected', square === selected);
      el.classList.toggle('is-legal', Boolean(target) && !target.isCapture);
      el.classList.toggle('is-capture', Boolean(target) && target.isCapture);
      el.classList.toggle(
        'is-last-move',
        Boolean(lastMove) && (square === lastMove.from || square === lastMove.to),
      );
      el.classList.toggle('is-check', square === state.checkSquare);

      el.setAttribute('aria-label', this.#describeSquare(square, piece, target));
    });

    if (options.animateMove && this.#animationsEnabled) {
      this.#animateMove(options.animateMove);
    }
  }

  #renderPiece(entry, piece, square) {
    const key = piece ? `${piece.color}${piece.type}` : '';
    if (this.#lastRendered.get(square) === key) return;
    this.#lastRendered.set(square, key);

    const { piece: pieceEl } = entry;
    if (!piece) {
      pieceEl.textContent = '';
      pieceEl.removeAttribute('data-piece');
      pieceEl.removeAttribute('data-color');
      return;
    }
    pieceEl.dataset.piece = piece.type;
    pieceEl.dataset.color = piece.color;
    renderPieceContent(pieceEl, piece);
  }

  #describeSquare(square, piece, target) {
    const who = piece
      ? `${piece.color === WHITE ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}`
      : 'empty';
    if (target) {
      return `${square}, ${who}, ${target.isCapture ? 'capture' : 'move here'}`;
    }
    return `${square}, ${who}`;
  }

  /**
   * Parse the piece-placement field of a FEN into a square->piece map.
   * The board renders from FEN so its input is exactly the same serialized
   * state the session publishes and storage persists.
   */
  #boardFromFen(fen) {
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

  /**
   * Slide the moved piece from its origin into place.
   * Runs after the position has already been rendered, so it is purely
   * cosmetic and can never desynchronise the board from the game state.
   */
  #animateMove(move) {
    const animate = (from, to) => {
      const fromEntry = this.#squares.get(from);
      const toEntry = this.#squares.get(to);
      if (!fromEntry || !toEntry || !toEntry.piece.textContent) return;

      const fromRect = fromEntry.el.getBoundingClientRect();
      const toRect = toEntry.el.getBoundingClientRect();
      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      if (!dx && !dy) return;

      const pieceEl = toEntry.piece;
      pieceEl.style.transition = 'none';
      pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;

      requestAnimationFrame(() => {
        pieceEl.style.transition = `transform ${ANIMATION_MS}ms ease-out`;
        pieceEl.style.transform = 'translate(0, 0)';
        window.setTimeout(() => {
          pieceEl.style.transition = '';
          pieceEl.style.transform = '';
        }, ANIMATION_MS + 30);
      });
    };

    animate(move.from, move.to);

    // Castling moves two pieces; animate the rook as well.
    if (move.isCastle) {
      const rank = move.color === WHITE ? '1' : '8';
      if (move.isKingsideCastle) animate(`h${rank}`, `f${rank}`);
      else animate(`a${rank}`, `d${rank}`);
    }
  }

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------

  #squareFromEvent(event) {
    const el = event.target.closest?.('.square');
    return el?.dataset.square ?? null;
  }

  #attachListeners() {
    // Pointer down: begin a tap, and possibly a drag for mouse/pen.
    this.#root.addEventListener('pointerdown', (event) => {
      const square = this.#squareFromEvent(event);
      if (!square) return;

      this.#focusSquare(square, false);

      const isTouch = event.pointerType === 'touch';
      const hasPiece = Boolean(this.#squares.get(square)?.piece.textContent);

      this.#drag = {
        square,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
        // Dragging is offered on mouse/pen only. On touch, tap-to-move is the
        // primary interaction and page scrolling must keep working.
        eligible: !isTouch && hasPiece,
        ghost: null,
      };
    });

    this.#root.addEventListener('pointermove', (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId || !drag.eligible) return;

      if (!drag.active) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.hypot(dx, dy) < 8) return;
        this.#beginDrag(drag, event);
      }

      if (drag.active && drag.ghost) {
        drag.ghost.style.transform =
          `translate(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px)`;
      }
    });

    const finish = (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.#drag = null;

      if (!drag.active) {
        // No meaningful movement — this was a tap/click.
        const square = this.#squareFromEvent(event) ?? drag.square;
        if (square) this.#onSquareActivate(square);
        return;
      }

      this.#endDrag(drag);

      // Resolve the drop target from the pointer position.
      const dropEl = document.elementFromPoint(event.clientX, event.clientY);
      const dropSquare = dropEl?.closest?.('.square')?.dataset.square ?? null;

      // The origin was already selected when the drag began, so activating the
      // destination alone completes the move — the controller sees exactly the
      // same two-step sequence a tap-to-move produces. Re-activating the origin
      // here would toggle the selection off and swallow the move.
      if (dropSquare && dropSquare !== drag.square) {
        this.#onSquareActivate(dropSquare);
      }
      // Dropped back where it started: leave the piece selected so the player
      // can simply tap a destination instead.
    };

    this.#root.addEventListener('pointerup', finish);
    this.#root.addEventListener('pointercancel', (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.#drag = null;
      if (drag.active) this.#endDrag(drag);
    });

    // Keyboard: Enter/Space activates, arrows move focus (roving tabindex).
    this.#root.addEventListener('keydown', (event) => {
      const square = this.#squareFromEvent(event);
      if (!square) return;

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.#onSquareActivate(square);
        return;
      }

      const delta = {
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }[event.key];
      if (!delta) return;

      event.preventDefault();
      const flip = this.#orientation === 'black' ? -1 : 1;
      const fileIndex = FILES.indexOf(square[0]) + delta[0] * flip;
      const rankIndex = RANKS.indexOf(square[1]) + delta[1] * flip;
      const next = `${FILES[fileIndex] ?? ''}${RANKS[rankIndex] ?? ''}`;
      if (next.length === 2) this.#focusSquare(next, true);
    });
  }

  #beginDrag(drag, event) {
    const entry = this.#squares.get(drag.square);
    if (!entry || !entry.piece.textContent) return;

    drag.active = true;
    const rect = entry.piece.getBoundingClientRect();
    drag.offsetX = rect.width / 2;
    drag.offsetY = rect.height / 2;

    const ghost = entry.piece.cloneNode(true);
    ghost.classList.add('piece--ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.fontSize = window.getComputedStyle(entry.piece).fontSize;
    ghost.style.transform = `translate(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px)`;
    document.body.append(ghost);

    drag.ghost = ghost;
    entry.el.classList.add('is-dragging');

    try {
      this.#root.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; dragging still works without it.
    }

    // Show the origin's legal moves while dragging.
    this.#onSquareActivate(drag.square);
  }

  #endDrag(drag) {
    drag.ghost?.remove();
    this.#squares.get(drag.square)?.el.classList.remove('is-dragging');
    try {
      this.#root.releasePointerCapture(drag.pointerId);
    } catch {
      // Nothing to release.
    }
  }

  /** Roving tabindex: exactly one square is tabbable at a time. */
  #focusSquare(square, moveFocus) {
    const entry = this.#squares.get(square);
    if (!entry) return;
    this.#squares.get(this.#focusedSquare)?.el.setAttribute('tabindex', '-1');
    this.#focusedSquare = square;
    entry.el.setAttribute('tabindex', '0');
    if (moveFocus) entry.el.focus();
  }
}

export default Board;
