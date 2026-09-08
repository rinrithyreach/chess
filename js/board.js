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

import {
  FILES,
  RANKS,
  ANIMATION_MS,
  ANIMATION_EASING,
  CAPTURE_FADE_RATIO,
  WHITE,
} from './config.js';

/**
 * Does this device want motion kept to a minimum?
 *
 * Checked live rather than cached, and checked HERE rather than left to CSS:
 * the `prefers-reduced-motion` block in style.css only neutralises CSS
 * transitions and CSS animations. A Web Animations API effect is neither, so
 * it sails straight past that override — motion has to be declined in script
 * or it is not declined at all.
 */
function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

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

  /**
   * Slides currently in flight, keyed by the square they are landing on.
   * A second move onto a square while the first is still running must cancel
   * it: two effects animating one element's `transform` fight each other and
   * the piece visibly stutters.
   */
  #running = new Map();

  /**
   * The move the player just completed by dragging, as `from|to`.
   *
   * They dragged the piece across the board with their own hand, so replaying
   * that same journey as an animation reads as the board lagging a beat behind
   * them. Recorded on drop, consumed by the render that follows.
   */
  #draggedMove = null;

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

    const move =
      options.animateMove && this.#animationsEnabled && !prefersReducedMotion()
        ? options.animateMove
        : null;

    // A captured piece has to be photographed BEFORE the squares repaint,
    // because the repaint is what erases it. Cheap, and only on captures.
    const capturedGhost = move?.isCapture ? this.#detachCaptured(move) : null;

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

    if (move) this.#animateMove(move, capturedGhost);

    // Consumed by this render whether or not it carried the drag's move, so a
    // drop that turned out to be illegal cannot suppress a later animation.
    this.#draggedMove = null;
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
   *
   * Runs after the position has already been rendered, so it is purely
   * cosmetic and can never desynchronise the board from the game state: if
   * every animation here were deleted the game would still be correct, only
   * blunter. That is what makes it safe to be this eager about starting it.
   *
   * @param {object} move The move descriptor from the engine.
   * @param {?HTMLElement} capturedGhost The captured piece, lifted out of the
   *   render by #detachCaptured, to fade out under the arriving piece.
   */
  #animateMove(move, capturedGhost) {
    if (capturedGhost) this.#fadeOut(capturedGhost);

    // The player dragged this piece here themselves, so it is already exactly
    // where they put it. Sending it back to the origin to travel again undoes
    // their own gesture and reads as the board lagging behind the pointer. The
    // castling rook below still slides — they never touched that one.
    if (this.#draggedMove !== `${move.from}|${move.to}`) {
      this.#slide(move.from, move.to);
    }

    // Castling moves two pieces; the rook slides as well.
    if (move.isCastle) {
      const rank = move.color === WHITE ? '1' : '8';
      if (move.isKingsideCastle) this.#slide(`h${rank}`, `f${rank}`);
      else this.#slide(`a${rank}`, `d${rank}`);
    }
  }

  /**
   * Move a piece visually from `from` to `to`.
   *
   * A FLIP: the piece has already been painted at its destination, and this
   * plays back the jump it just made, from the offset it came from.
   */
  #slide(from, to) {
    const fromEntry = this.#squares.get(from);
    const toEntry = this.#squares.get(to);
    if (!fromEntry || !toEntry || !toEntry.piece.textContent) return;

    const fromRect = fromEntry.el.getBoundingClientRect();
    const toRect = toEntry.el.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    if (!dx && !dy) return;

    this.#run(toEntry.piece, to, [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' },
    ]);
  }

  /** Fade a captured piece out from under the piece landing on top of it. */
  #fadeOut(ghost) {
    const remove = () => ghost.remove();
    const animation = this.#run(
      ghost,
      null,
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.72)' },
      ],
      { duration: Math.round(ANIMATION_MS * CAPTURE_FADE_RATIO), easing: 'ease-in' },
    );
    if (!animation) {
      remove();
      return;
    }
    animation.addEventListener('finish', remove);
    animation.addEventListener('cancel', remove);
  }

  /**
   * Play one effect on one element.
   *
   * Uses the Web Animations API rather than a CSS transition toggled inside
   * requestAnimationFrame. Those look equivalent and are not: a rAF callback
   * runs BEFORE that frame's style recalculation, so the browser is free never
   * to observe the starting transform and to coalesce both writes into the
   * final value. The piece then teleports with no animation at all — not
   * always, just whenever the frames happen to line up that way, which is
   * exactly the intermittent "sometimes it jumps" this replaces. Explicit
   * keyframes cannot be collapsed like that, so the slide runs on the very
   * next frame, every time.
   *
   * It also retires the cleanup timer the old version needed. With
   * `fill: "none"` the element reverts to its stylesheet transform the moment
   * the effect ends, leaving no inline styles to strip later — and so no stale
   * timeout left to fire mid-slide during a fast exchange and cut the next
   * animation short.
   */
  #run(element, key, keyframes, options = {}) {
    // jsdom and pre-2018 browsers have no WAAPI. Skipping is the correct
    // fallback: this is decoration over a board that is already correct.
    if (typeof element.animate !== 'function') return null;

    // Cancel any slide already landing on this square — see #running.
    if (key !== null) this.#running.get(key)?.cancel();

    element.classList.add('piece--moving');

    let animation;
    try {
      animation = element.animate(keyframes, {
        duration: ANIMATION_MS,
        easing: ANIMATION_EASING,
        fill: 'none',
        ...options,
      });
    } catch {
      // Has `animate`, rejected the effect. Leave the piece where it already
      // correctly is.
      element.classList.remove('piece--moving');
      return null;
    }

    if (key !== null) this.#running.set(key, animation);

    const settle = () => {
      // Identity check, because `cancel` is delivered asynchronously: by the
      // time it arrives a replacement slide may already own this square, and
      // stripping the class then would drop that piece back beneath its
      // neighbours halfway through its own animation.
      if (key !== null && this.#running.get(key) !== animation) return;
      if (key !== null) this.#running.delete(key);
      element.classList.remove('piece--moving');
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', settle);

    return animation;
  }

  /**
   * Lift the piece that is about to be captured out of the render, so it can
   * fade independently while the capturing piece slides onto its square.
   *
   * Must run before the board repaints — the clone is taken from the live
   * element while it still shows the captured piece. Cloning rather than
   * rebuilding keeps it pixel-identical: same glyph, same colour rules, same
   * container-relative font size.
   *
   * @returns {?HTMLElement} The detached ghost, already placed in the DOM.
   */
  #detachCaptured(move) {
    // En passant is the one capture whose victim is not on the destination
    // square: the pawn stands beside the capturer, back on the origin's rank.
    const square = move.isEnPassant ? `${move.to[0]}${move.from[1]}` : move.to;
    const entry = this.#squares.get(square);
    if (!entry || !entry.piece.textContent) return null;

    // A ghost from an earlier capture on this square should be gone by now,
    // but animations are paused while a tab is in the background — so one can
    // still be sitting here after a spell away. Never stack two.
    entry.el.querySelectorAll('.piece--captured').forEach((stale) => stale.remove());

    const ghost = entry.piece.cloneNode(true);
    ghost.classList.add('piece--captured');
    ghost.setAttribute('aria-hidden', 'true');
    entry.el.append(ghost);
    return ghost;
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
        // Note it before activating: if this drop is a legal move the render
        // it triggers must not slide the piece back over the path the player
        // just dragged it along. See #draggedMove.
        this.#draggedMove = `${drag.square}|${dropSquare}`;
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
