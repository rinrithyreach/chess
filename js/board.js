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
  CAPTURE_FADE_DELAY,
  POWER_CAST_MS,
  POWER_WAVE_STEP_MS,
  WHITE,
} from './config.js';
import {
  ALL_SQUARES,
  boardFromFen,
  describeSquare,
  squareDistance,
  squareShade,
  prefersReducedMotion,
} from './board-shared.js';

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

function renderPieceContent(pieceEl, piece) {
  pieceEl.textContent = PIECE_GLYPHS[piece.type] ?? '';
}

/**
 * The elemental marks.
 *
 * Read off the element and effect ids rather than imported from elemental.js,
 * because this board renders a description it is handed and is not otherwise
 * a client of the variant — and because these are the small corner glyphs,
 * which want to stay a rendering decision belonging to the board.
 *
 * Emoji here rather than the text presentation the pieces use: these are meant
 * to be in colour, and are small enough that shape alone would not tell fire
 * from water.
 */
const ELEMENT_GLYPHS = {
  fire: '🔥',
  water: '💧',
  lightning: '⚡',
  ice: '❄️',
  nature: '🌿',
  shadow: '🌑',
  light: '✨',
};

const EFFECT_GLYPHS = {
  frozen: '🧊',
  shield: '🛡️',
  vines: '🌿',
};

/**
 * Grace between a burst's last keyframe and the element being removed, in ms.
 *
 * Not a look, a safety margin: an animation that has not been given a frame
 * yet — a backgrounded tab, a slow first paint — would otherwise be cut off
 * before it ever started.
 */
const CAST_CLEANUP_GRACE_MS = 320;

/**
 * A fixed, per-square angle for a burst to lean at.
 *
 * A Fire pawn's capture can put the same burst on eight touching squares at
 * once, and eight identical copies of anything read as a texture rather than
 * as eight fires. Leaning each one differently breaks that up.
 *
 * Derived from the square's name rather than drawn at random, so the same
 * power in the same position looks the same every time — which matters for
 * exactly one reason: a random one could not be screenshotted and compared.
 */
function castTilt(square) {
  const seed = (FILES.indexOf(square[0]) * 5 + RANKS.indexOf(square[1]) * 3) % 7;
  return (seed - 3) * 11;
}

export class Board {
  #root;
  #squares = new Map();
  #orientation = 'white';
  #onSquareActivate = () => {};
  #lastRendered = new Map();

  /**
   * Was the last render an elemental one?
   *
   * Only so the pass that CLEARS the layer still happens. Without it, leaving
   * an elemental game for an ordinary one would leave 32 element glyphs on the
   * board — the new game has no elemental block, so nothing would ever run to
   * take them off again.
   */
  #hadElemental = false;
  #animationsEnabled = true;

  /**
   * Timers due to take a power burst back off the board.
   *
   * Held so dispose() can cancel them. Without it, switching to the 3D board
   * while a power is playing leaves a timer holding a reference to a square
   * in a renderer that has already been torn down — and it fires into the
   * detached tree a moment later.
   */
  #casts = new Set();
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

  /**
   * Cancels every listener this board added, in one call.
   *
   * Needed because the board is no longer the only thing that can occupy the
   * board element — the player can switch to the WebGL board and back, and
   * each switch builds a new instance on the same element. Without this the
   * old instance's listeners survive, and a single tap is then delivered to
   * two boards: both call the controller, the square is activated twice, and
   * the selection is toggled straight back off. The move silently does
   * nothing, which is exactly what it looked like.
   */
  #listeners = new AbortController();

  constructor(rootElement) {
    if (!rootElement) throw new Error('Board root element is required');
    this.#root = rootElement;
    this.#build();
    this.#attachListeners();
  }

  /** Detach from the board element so another renderer can take it over. */
  dispose() {
    this.#listeners.abort();
    this.#squares.clear();
    this.#lastRendered.clear();
    this.#running.forEach((animation) => animation.cancel());
    this.#running.clear();
    this.#casts.forEach((timer) => window.clearTimeout(timer));
    this.#casts.clear();
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

      // The elemental layer: a corner glyph for the element or the effect,
      // and a full-square wash for the effect's colour.
      //
      // Two real elements rather than two pseudo-elements, because ::before
      // and ::after on a square are both already spoken for — selected, in
      // check, legal destination, capture ring — and an effect has to be able
      // to show UNDERNEATH all of them rather than instead of whichever one
      // the cascade happened to resolve last.
      //
      // Built for all 64 squares up front and left empty in every game that is
      // not Elemental Chess: two empty spans a square, and this board's "build
      // once, mutate thereafter" rule stays intact.
      const aura = document.createElement('span');
      aura.className = 'square__aura';
      aura.setAttribute('aria-hidden', 'true');

      const mark = document.createElement('span');
      mark.className = 'square__mark';
      mark.setAttribute('aria-hidden', 'true');

      el.append(rankLabel, fileLabel, aura, piece, mark);
      this.#root.append(el);
      this.#squares.set(square, { el, piece, fileLabel, rankLabel, aura, mark });
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

  /**
   * Zoom, deliberately doing nothing.
   *
   * On the 3D board zoom buys two things: bigger squares, and evener ones. A
   * flat grid has neither to sell. It already fills the frame edge to edge —
   * 48px a square on a 412px phone against the 3D board's 35 — and every
   * square is exactly the same size as every other, which is the thing
   * perspective takes away and zoom is there to give back. There is nothing
   * left to spend, so the control is hidden rather than made inert: see
   * canZoom() and ui.setZoomAvailable().
   */
  setZoom() { /* deliberately nothing — see above */ }

  canZoom() {
    return false;
  }

  /**
   * Play a power going off.
   *
   * Everything a power does to the board it does through the state — a frozen
   * piece is frozen in the next snapshot, a burned one is simply gone — and
   * the state arrives with no history, so by the time the board is asked to
   * repaint there is nothing left to say WHICH of the changes was the power.
   * A piece vanishing between two renders looks identical whether it was
   * captured, burned or struck by lightning.
   *
   * This is the missing half: a one-off burst, keyed to the element, on the
   * squares the power actually touched. It is decoration and is treated as
   * such — the board is already correct without it, and it is skipped
   * wholesale when animations are off or the reader has asked for less
   * motion.
   *
   * @param {object} payload {element, from, targets, sweep} — see EVENT.POWER.
   */
  playPower({ element, from = null, targets = [], sweep = false } = {}) {
    if (!element || !this.#squares.size) return;
    if (!this.#animationsEnabled || prefersReducedMotion()) return;

    // The caster burns too. A power with two ends — a king's teleport, a
    // lightning arc — is one event in two places, and showing only the far
    // end leaves the player working out for themselves which of their pieces
    // just spent itself.
    const hit = new Set(targets.filter(Boolean));
    if (from) hit.add(from);

    if (sweep) {
      // Every square but the one it started on gets the plain version: this
      // is sixty-four elements going off at once on whatever phone is to
      // hand, and the full burst carries two animated pseudo-elements each.
      // The bishop's own square keeps them, because that is where the eye is.
      this.#squares.forEach((entry, square) => {
        this.#burst(
          square,
          element,
          squareDistance(from, square) * POWER_WAVE_STEP_MS,
          square !== from,
        );
      });
      return;
    }

    hit.forEach((square) => this.#burst(square, element, 0));
  }

  /**
   * One burst on one square.
   *
   * A real element rather than a class on the square, for the same reason the
   * effect wash is one: a square can be selected, in check, a legal
   * destination and on fire at the same time, and ::before and ::after are
   * both already spoken for. It is also what makes the burst removable — the
   * square it was on outlives it.
   */
  #burst(square, element, delay = 0, wave = false) {
    const entry = this.#squares.get(square);
    if (!entry) return;

    // Never two on one square. A Fire pawn's capture can put a burn on the
    // square it just landed on in the same frame as the move animation, and
    // a burst begun while the tab was in the background can still be sitting
    // here when the player comes back to it.
    entry.el.querySelectorAll('.square__cast').forEach((stale) => stale.remove());

    const cast = document.createElement('span');
    cast.className = 'square__cast';
    cast.dataset.element = element;
    if (wave) cast.dataset.wave = '';
    cast.setAttribute('aria-hidden', 'true');
    // The stylesheet times every keyframe against this, including the ones on
    // the burst's own pseudo-elements — which inherit it from here.
    cast.style.setProperty('--cast-ms', `${POWER_CAST_MS}ms`);
    cast.style.setProperty('--cast-tilt', `${castTilt(square)}deg`);
    if (delay) cast.style.animationDelay = `${delay}ms`;
    entry.el.append(cast);

    // Removed on a timer rather than on animationend, which is not one event
    // but several: the burst animates, and so do its two pseudo-elements, at
    // deliberately different lengths. The first of them to finish would take
    // the other two off the board with it.
    const done = window.setTimeout(() => {
      cast.remove();
      this.#casts.delete(done);
    }, POWER_CAST_MS + delay + CAST_CLEANUP_GRACE_MS);
    this.#casts.add(done);
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

    const board = boardFromFen(state.fen);
    const selected = view?.selected ?? null;
    const targets = new Map((view?.legalTargets ?? []).map((m) => [m.to, m]));
    const lastMove = state.lastMove;

    // Elemental Chess, or nothing at all. Both boards read the description the
    // session builds rather than working the elements out for themselves, so
    // the flat board and the WebGL one cannot disagree about which bishop is
    // which.
    const elemental = state.elemental ?? null;
    const aiming = view?.aiming ?? null;
    const aimTargets = new Set(aiming?.targets ?? []);

    // Five of the six modes have no elemental layer, and this board repaints
    // on every clock tick and every move. Skipping the whole pass once it has
    // been cleared keeps them paying nothing for it — the one render after an
    // elemental game ends still runs, which is the render that clears it.
    const paintElemental = Boolean(elemental) || this.#hadElemental;
    this.#hadElemental = Boolean(elemental);

    this.#squares.forEach((entry, square) => {
      const piece = board.get(square) ?? null;
      this.#renderPiece(entry, piece, square);
      if (paintElemental) this.#renderElemental(entry, square, elemental);

      const target = targets.get(square);
      const el = entry.el;

      // While a power is being aimed the legal-move highlights are wrong —
      // the next tap is not going to be a move — so the board shows what the
      // power can reach instead, and only that.
      el.classList.toggle('is-aim', aimTargets.has(square));
      el.classList.toggle('is-aiming-from', Boolean(aiming) && square === aiming.from);

      el.classList.toggle('is-selected', square === selected);
      el.classList.toggle('is-legal', !aiming && Boolean(target) && !target.isCapture);
      el.classList.toggle('is-capture', !aiming && Boolean(target) && target.isCapture);
      el.classList.toggle(
        'is-last-move',
        Boolean(lastMove) && (square === lastMove.from || square === lastMove.to),
      );
      // Both ends of the move are tinted; only the square it left gets the
      // ring. See .square.is-last-from in board.css for why that matters.
      el.classList.toggle('is-last-from', Boolean(lastMove) && square === lastMove.from);
      el.classList.toggle('is-check', square === state.checkSquare);

      el.setAttribute('aria-label', describeSquare(square, piece, target, elemental && {
        ...elemental.pieces?.[square],
        effect: elemental.marks?.[square] ?? null,
      }));
    });

    if (move) this.#animateMove(move, capturedGhost);

    // Consumed by this render whether or not it carried the drag's move, so a
    // drop that turned out to be illegal cannot suppress a later animation.
    this.#draggedMove = null;
  }

  /**
   * The elemental layer on one square: what the piece is, whether it still
   * has its power, and what is standing on the square.
   *
   * An effect outranks the element, because an effect is temporary and
   * therefore the thing that has just changed — and the element can always be
   * read back off the piece, which cannot become a different one.
   */
  #renderElemental(entry, square, elemental) {
    const { el, mark, aura } = entry;
    if (!mark || !aura) return;

    if (!elemental) {
      if (mark.textContent) mark.textContent = '';
      aura.removeAttribute('data-effect');
      el.removeAttribute('data-element');
      el.classList.remove('is-charged');
      return;
    }

    const effect = elemental.marks?.[square] ?? null;
    const piece = elemental.pieces?.[square] ?? null;

    if (effect) aura.dataset.effect = effect;
    else aura.removeAttribute('data-effect');

    if (piece) el.dataset.element = piece.element;
    else el.removeAttribute('data-element');

    // A charge is shown by lighting the element's own glyph rather than by
    // adding a second mark beside it. An element never changes and a charge is
    // spent exactly once, so one glyph in two states says everything there is
    // to say — and says it without needing another few pixels on a square that
    // is already carrying a piece, a coordinate and up to two highlights.
    el.classList.toggle('is-charged', Boolean(piece?.charged));

    const glyph = effect ? EFFECT_GLYPHS[effect] : (piece ? ELEMENT_GLYPHS[piece.element] : '');
    if (mark.textContent !== glyph) mark.textContent = glyph ?? '';
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

  /**
   * Fade a captured piece out from under the piece landing on top of it.
   *
   * Delayed rather than immediate, and for the same reason the 3D board holds
   * its captured piece: starting both at once empties the square before the
   * capturing piece has crossed it, so the two read as separate events rather
   * than as one displacing the other. The delay and the duration are set to
   * end together — see CAPTURE_FADE_DELAY.
   */
  #fadeOut(ghost) {
    const remove = () => ghost.remove();
    const animation = this.#run(
      ghost,
      null,
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.72)' },
      ],
      {
        duration: Math.round(ANIMATION_MS * CAPTURE_FADE_RATIO),
        delay: CAPTURE_FADE_DELAY,
        easing: 'ease-in',
      },
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
    // Every listener carries the abort signal, so dispose() detaches the
    // whole board from the element in one call. See #listeners.
    const on = (target, type, handler) =>
      target.addEventListener(type, handler, { signal: this.#listeners.signal });

    // Pointer down: begin a tap, and possibly a drag for mouse/pen.
    on(this.#root, 'pointerdown', (event) => {
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

    on(this.#root, 'pointermove', (event) => {
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

    on(this.#root, 'pointerup', finish);
    on(this.#root, 'pointercancel', (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.#drag = null;
      if (drag.active) this.#endDrag(drag);
    });

    // Keyboard: Enter/Space activates, arrows move focus (roving tabindex).
    on(this.#root, 'keydown', (event) => {
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
