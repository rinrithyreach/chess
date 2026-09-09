/**
 * board-3d.js
 * A WebGL chessboard, drop-in interchangeable with the DOM one in board.js.
 *
 * It implements exactly the same public contract — constructor(root),
 * onSquareActivate, setOrientation, setShowCoordinates, setAnimationsEnabled,
 * render — plus dispose(), because unlike a DOM board this one owns a GPU
 * context that has to be handed back when the player switches skins. app.js
 * swaps between the two knowing nothing about either's internals.
 *
 * Why WebGL and not CSS 3D: an earlier CSS skin (since removed) put the board
 * in a `preserve-3d` transform, and Chromium's compositor then hit-tested
 * against a stale flattened box — `elementFromPoint` reported the wrong square
 * and the board became unplayable. That is not a bug you can style your way
 * out of, and it is the reason that approach was abandoned rather than fixed.
 * Here, picking is done by raycasting against the real geometry, so what you
 * click is by construction what you see.
 *
 * Pieces are generated, not loaded. Chess pieces are surfaces of revolution,
 * which is precisely what LatheGeometry produces, so a profile of a dozen
 * points gives a real turned piece with correct silhouette and shading — no
 * model files, no asset pipeline, nothing to keep in sync with the repo. The
 * knight is the exception (a horse's head is not rotationally symmetric) and
 * is extruded from a 2D outline instead.
 *
 * Performance notes:
 *   - The 64 squares are ONE mesh with a generated chequer texture, not 64
 *     meshes. Highlights are pooled overlay planes. That keeps the whole board
 *     to well under a hundred draw calls, which is what makes it viable on a
 *     phone.
 *   - The render loop is demand-driven: it draws when something actually
 *     changed or an animation is running, and otherwise costs nothing. A
 *     chessboard is static most of the time and a spinning idle loop would eat
 *     battery for no reason.
 */

import * as THREE from './vendor/three.module.js';
import {
  FILES,
  RANKS,
  ANIMATION_MS,
  ANIMATION_EASING,
  CAPTURE_FADE_RATIO,
  WHITE,
  DEBUG,
} from './config.js';
import {
  ALL_SQUARES,
  boardFromFen,
  describeSquare,
} from './board-shared.js';
import { cubicBezierEasing } from './board-shared.js';

/** Shared with the DOM board so a move feels the same on either. */
const ease = cubicBezierEasing(ANIMATION_EASING);

/** Board geometry, in world units: one square is 1×1. */
const SQUARE = 1;
const HALF = 4; // half the board, in squares
const BOARD_Y = 0; // top surface of the playing area
const RIM = 0.42; // border width around the playing area

/**
 * Themes mirror the CSS ones in board.css so the two boards look like the same
 * product. The extra colours (rim, and the two coordinate inks) have no CSS
 * equivalent because a flat board draws its frame in CSS instead.
 */
const THEMES = {
  classic: { light: '#ecd8b6', dark: '#b07d4f', rim: '#6b4a2c', inkOnLight: '#8a6238', inkOnDark: '#ecd8b6' },
  midnight: { light: '#9fb0cc', dark: '#4a5a78', rim: '#2c3549', inkOnLight: '#3d4a63', inkOnDark: '#cdd8ea' },
  wood: { light: '#e8c99b', dark: '#9a6a3d', rim: '#5d3f22', inkOnLight: '#7b5228', inkOnDark: '#f0dcc0' },
};

const HIGHLIGHT = {
  lastMove: { color: 0xe8b44c, opacity: 0.34 },
  selected: { color: 0xe8b44c, opacity: 0.55 },
  check: { color: 0xe5594d, opacity: 0.75 },
  focus: { color: 0x7fb2ff, opacity: 0.5 },
};

const PIECE_MATERIALS = {
  w: { color: 0xf2ede1, roughness: 0.42, metalness: 0.04 },
  b: { color: 0x2a2e39, roughness: 0.46, metalness: 0.06 },
};

/**
 * Piece heights, in squares.
 *
 * Proportioned from a real Staunton set — on a tournament board a king is
 * about 1.67 square-widths tall, a pawn about 0.82 — then scaled down as a
 * group. Full height is correct for a set you look at across a table, but the
 * camera here looks down at 56 degrees, and at true height the back rank hides
 * the rank in front of it. These keep the relative proportions that make the
 * pieces instantly distinguishable while staying short enough to see past.
 */
const PIECE_HEIGHT = { p: 0.72, r: 0.84, n: 0.94, b: 1.02, q: 1.16, k: 1.3 };

/**
 * Lathe profiles: [radius, height] pairs from the base upward, in units where
 * the piece's own height is 1. They are scaled to PIECE_HEIGHT on build, so
 * proportions stay right if a height is retuned.
 */
const PROFILES = {
  p: [
    [0.00, 0.00], [0.30, 0.00], [0.30, 0.06], [0.26, 0.10], [0.17, 0.15],
    [0.14, 0.30], [0.16, 0.42], [0.23, 0.48], [0.20, 0.53], [0.15, 0.58],
    [0.22, 0.70], [0.24, 0.80], [0.20, 0.90], [0.12, 0.97], [0.00, 1.00],
  ],
  r: [
    [0.00, 0.00], [0.34, 0.00], [0.34, 0.07], [0.29, 0.12], [0.22, 0.20],
    [0.20, 0.62], [0.24, 0.68], [0.31, 0.74], [0.31, 0.86], [0.26, 0.86],
    [0.26, 1.00], [0.00, 1.00],
  ],
  // The mitre is a tall cone pinched to a thin stem below a separate finial
  // ball. Without that pinch a bishop is just a taller pawn — which is exactly
  // how the first pass read on the board.
  b: [
    [0.00, 0.00], [0.33, 0.00], [0.33, 0.06], [0.28, 0.11], [0.19, 0.17],
    [0.15, 0.30], [0.19, 0.40], [0.24, 0.45], [0.20, 0.49], [0.14, 0.54],
    [0.20, 0.62], [0.22, 0.70], [0.20, 0.78], [0.15, 0.86], [0.08, 0.92],
    [0.045, 0.94], [0.075, 0.97], [0.05, 0.995], [0.00, 1.00],
  ],
  q: [
    [0.00, 0.00], [0.37, 0.00], [0.37, 0.06], [0.31, 0.11], [0.21, 0.18],
    [0.17, 0.34], [0.20, 0.46], [0.26, 0.51], [0.21, 0.56], [0.17, 0.62],
    [0.25, 0.74], [0.30, 0.82], [0.26, 0.86], [0.30, 0.88], [0.22, 0.92],
    [0.12, 0.95], [0.13, 0.98], [0.00, 1.00],
  ],
  k: [
    [0.00, 0.00], [0.38, 0.00], [0.38, 0.06], [0.32, 0.11], [0.22, 0.18],
    [0.18, 0.36], [0.21, 0.48], [0.27, 0.53], [0.22, 0.58], [0.18, 0.63],
    [0.26, 0.74], [0.30, 0.80], [0.26, 0.84], [0.30, 0.86], [0.20, 0.90],
    [0.16, 0.92], [0.00, 0.92],
  ],
  // The knight's body is only a short pedestal; the head is most of the piece
  // and is extruded separately.
  n: [
    [0.00, 0.00], [0.34, 0.00], [0.34, 0.07], [0.29, 0.12], [0.21, 0.18],
    [0.19, 0.24], [0.23, 0.28], [0.00, 0.28],
  ],
};

/**
 * The knight's head, as a 2D outline traced anticlockwise from the base of the
 * neck, facing left (-X).
 *
 * Extruded and bevelled, the silhouette is what makes it a horse — so it has
 * to actually be one. The first attempt was a rough blob of eighteen points
 * that read as a lump at board size; this one traces the features that
 * identify the piece at a glance even when it is 40 pixels tall: the jaw and
 * muzzle jutting forward, the dish of the nose, two separate ears, and the
 * mane falling down the back of the neck.
 */
const KNIGHT_OUTLINE = [
  [-0.16, 0.00], [-0.20, 0.18], [-0.24, 0.34], [-0.30, 0.48], [-0.36, 0.60],
  [-0.38, 0.70], [-0.30, 0.76], [-0.18, 0.80], [-0.10, 0.88], [-0.13, 1.00],
  [-0.04, 0.92], [0.02, 1.02], [0.08, 0.88], [0.16, 0.72], [0.22, 0.52],
  [0.26, 0.34], [0.24, 0.16], [0.20, 0.00],
];

export class Board3D {
  #root;
  #onSquareActivate = () => {};
  #orientation = 'white';
  #showCoordinates = true;
  #animationsEnabled = true;
  #theme = 'classic';
  #focusedSquare = 'e1';
  #disposed = false;

  // three.js objects
  #renderer = null;
  #scene = null;
  #camera = null;
  #canvas = null;
  #boardMesh = null;
  #boardTexture = null;
  #pieceGroup = null;
  #markerGroup = null;
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();

  // Reusable resources, disposed together in dispose().
  #geometries = new Map();
  #materials = new Map();
  #markerPool = [];
  #pieces = new Map(); // square -> Object3D

  // Animation bookkeeping
  #animations = [];
  #cameraSpin = null;
  #needsRender = true;
  #frame = null;
  #resizeObserver = null;

  // Interaction
  #drag = null;

  /**
   * Cancels every listener this board added, in one call.
   *
   * The flat board and this one attach to the SAME element, and the player can
   * switch between them freely. Leave the old instance listening and one tap
   * reaches two boards: both activate the square, the second undoes the first,
   * and the move silently does nothing.
   */
  #listeners = new AbortController();
  #a11yGrid = null;
  #a11ySquares = new Map();
  #draggedMove = null;

  constructor(rootElement) {
    if (!rootElement) throw new Error('Board root element is required');
    this.#root = rootElement;
    this.#build();
    this.#attachListeners();
    this.#loop();
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
    this.#root.classList.add('board--3d');

    this.#canvas = document.createElement('canvas');
    this.#canvas.className = 'board3d__canvas';
    // The canvas is decoration; the a11y grid below is the real control.
    this.#canvas.setAttribute('aria-hidden', 'true');
    this.#root.append(this.#canvas);

    this.#renderer = new THREE.WebGLRenderer({
      canvas: this.#canvas,
      antialias: true,
      // Transparent, so the board sits in the CSS frame the rest of the app
      // already draws rather than punching a coloured rectangle through it.
      alpha: true,
    });
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.#scene = new THREE.Scene();
    this.#camera = new THREE.PerspectiveCamera(38, 1, 0.5, 60);

    this.#buildLights();
    this.#buildBoard();

    this.#pieceGroup = new THREE.Group();
    this.#markerGroup = new THREE.Group();
    this.#scene.add(this.#pieceGroup, this.#markerGroup);

    this.#buildA11yGrid();
    this.#applyCamera(false);
    this.#resize();

    // The board is sized by CSS (aspect-ratio in the frame), so the canvas has
    // to follow the element rather than the window: a layout change with no
    // resize event — a sidebar appearing, the keyboard opening — still counts.
    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => this.#resize());
      this.#resizeObserver.observe(this.#root);
    }
  }

  #buildLights() {
    // Sky/ground fill, so the underside of a piece is never dead black.
    this.#scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2620, 1.15));

    const key = new THREE.DirectionalLight(0xfff4e2, 2.1);
    key.position.set(-4.5, 9, 4.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    // A tight orthographic frustum around the board keeps shadow texels dense
    // enough to stay crisp at 1024; the default frustum wastes most of them.
    const s = HALF + RIM + 0.5;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    this.#scene.add(key);

    // A dim opposite fill stops the far side of every piece going flat.
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.5);
    fill.position.set(5, 4, -6);
    this.#scene.add(fill);
  }

  #buildBoard() {
    const theme = THEMES[this.#theme] ?? THEMES.classic;

    // The rim: a slab slightly larger than the playing area, so the board has
    // a physical edge to catch the light instead of floating as a flat plane.
    const rimGeo = new THREE.BoxGeometry(
      2 * HALF + 2 * RIM,
      0.5,
      2 * HALF + 2 * RIM,
    );
    const rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.rim),
      roughness: 0.62,
      metalness: 0.05,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = BOARD_Y - 0.25;
    rim.receiveShadow = true;
    this.#scene.add(rim);
    this.#geometries.set('rim', rimGeo);
    this.#materials.set('rim', rimMat);

    // The 64 squares as a single textured plane. See the header note.
    const boardGeo = new THREE.PlaneGeometry(2 * HALF, 2 * HALF);
    this.#boardTexture = this.#makeCheckerTexture();
    const boardMat = new THREE.MeshStandardMaterial({
      map: this.#boardTexture,
      roughness: 0.75,
      metalness: 0.0,
    });
    this.#boardMesh = new THREE.Mesh(boardGeo, boardMat);
    this.#boardMesh.rotation.x = -Math.PI / 2;
    this.#boardMesh.position.y = BOARD_Y + 0.001;
    this.#boardMesh.receiveShadow = true;
    this.#scene.add(this.#boardMesh);
    this.#geometries.set('board', boardGeo);
    this.#materials.set('board', boardMat);
  }

  /**
   * Draw the chequer — and the coordinates — into one canvas texture.
   *
   * The labels are painted into the board rather than floated above it as
   * sprites, which is why this is regenerated when the orientation flips: a
   * label painted on the surface would otherwise be upside down for whichever
   * player is not White. Regenerating is one 2D canvas pass on a rare event,
   * far cheaper than sixteen extra objects in the scene forever.
   */
  #makeCheckerTexture() {
    const theme = THEMES[this.#theme] ?? THEMES.classic;
    const cell = 128;
    const canvas = document.createElement('canvas');
    canvas.width = cell * 8;
    canvas.height = cell * 8;
    const ctx = canvas.getContext('2d');

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        // Texture row 0 is the far side of the board (rank 8 for White).
        const isLight = (row + col) % 2 === 1;
        ctx.fillStyle = isLight ? theme.light : theme.dark;
        ctx.fillRect(col * cell, row * cell, cell, cell);
      }
    }

    if (this.#showCoordinates) {
      const flip = this.#orientation === 'black';
      ctx.font = `700 ${Math.round(cell * 0.2)}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
          const isLight = (row + col) % 2 === 1;
          ctx.fillStyle = isLight ? theme.inkOnLight : theme.inkOnDark;
          ctx.globalAlpha = 0.8;

          // Ranks down the left edge, files along the bottom, of the CURRENT
          // view — which is the opposite edge of the texture when flipped.
          const rankEdge = flip ? col === 7 : col === 0;
          const fileEdge = flip ? row === 0 : row === 7;
          const x = col * cell;
          const y = row * cell;

          if (rankEdge) {
            const rank = flip ? row + 1 : 8 - row;
            ctx.textAlign = 'left';
            ctx.fillText(String(rank), x + cell * 0.08, y + cell * 0.07);
          }
          if (fileEdge) {
            const file = FILES[flip ? 7 - col : col];
            ctx.textAlign = 'right';
            ctx.fillText(file, x + cell * 0.92, y + cell * 0.72);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    const texture = new THREE.CanvasTexture(canvas);
    // Crisp square edges up close, no shimmer at grazing angles far away.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = this.#renderer?.capabilities.getMaxAnisotropy() ?? 1;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  #refreshBoardTexture() {
    const next = this.#makeCheckerTexture();
    const material = this.#materials.get('board');
    this.#boardTexture?.dispose();
    this.#boardTexture = next;
    material.map = next;
    material.needsUpdate = true;

    const theme = THEMES[this.#theme] ?? THEMES.classic;
    this.#materials.get('rim').color.set(theme.rim);
    this.#needsRender = true;
  }

  /**
   * A visually hidden 8×8 grid of real buttons, layered over the canvas.
   *
   * A canvas has no structure for a screen reader and nothing for a keyboard
   * to focus, so all the accessibility work the DOM board does — per-square
   * labels, roving tabindex, arrow-key navigation — would simply be lost when
   * a player switched to this board. These buttons carry it instead. Pointer
   * input deliberately does NOT go through them: under perspective a square is
   * a trapezium, and no rectangle laid over the canvas can match it, so
   * pointers are raycast against the real geometry and these are left to
   * keyboards and assistive tech, which address squares by name anyway.
   */
  #buildA11yGrid() {
    const grid = document.createElement('div');
    grid.className = 'board3d__a11y';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Chessboard');

    ALL_SQUARES.forEach((square) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'board3d__cell';
      button.dataset.square = square;
      button.setAttribute('role', 'gridcell');
      button.tabIndex = -1;
      grid.append(button);
      this.#a11ySquares.set(square, button);
    });

    this.#a11yGrid = grid;
    this.#root.append(grid);
    this.#applyA11yOrder();
  }

  /** Keep DOM order matching what the player sees, as the DOM board does. */
  #applyA11yOrder() {
    const ordered =
      this.#orientation === 'white' ? ALL_SQUARES : [...ALL_SQUARES].reverse();
    const fragment = document.createDocumentFragment();
    ordered.forEach((square) => fragment.append(this.#a11ySquares.get(square)));
    this.#a11yGrid.append(fragment);
  }

  // -----------------------------------------------------------------------
  // Camera and sizing
  // -----------------------------------------------------------------------

  /**
   * Where the camera sits for a given side, at a distance that fits the board.
   *
   * The distance is solved rather than chosen. A hand-picked number can only
   * ever be right for one viewport: the board is square but the space the app
   * gives it is not always, and at a fixed distance a narrow phone crops the
   * near rank clean off — which is exactly what a fixed 7.6 did. So the eight
   * corners of the board's bounding box are projected to clip space and the
   * distance scaled until the widest of them sits inside the frame with a
   * margin. Two or three passes converge, because projected size is very
   * nearly inversely proportional to distance.
   */
  #cameraSeat(side) {
    // A fixed elevation, and the one number here that is a judgement rather
    // than a calculation. Foreshortening means the board projects to roughly
    // sin(elevation) as tall as it is wide, so a low angle leaves a third of a
    // square frame empty; a high one fills it but flattens the board back into
    // the 2D view this style exists to escape. 56 degrees is where the board
    // fills its frame and the pieces still clearly stand up off it.
    const elevation = THREE.MathUtils.degToRad(56);
    const direction = new THREE.Vector3(
      0,
      Math.sin(elevation),
      side * Math.cos(elevation),
    ).normalize();

    const reach = HALF + RIM;
    const corners = [];
    for (const x of [-reach, reach]) {
      for (const z of [-reach, reach]) {
        // Top of the tallest piece, so a king on the back rank is in frame too.
        for (const y of [BOARD_Y - 0.5, BOARD_Y + PIECE_HEIGHT.k]) {
          corners.push(new THREE.Vector3(x, y, z));
        }
      }
    }

    const probe = this.#camera.clone();
    let distance = 12;
    for (let pass = 0; pass < 6; pass += 1) {
      probe.position.copy(direction).multiplyScalar(distance);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld(true);
      probe.updateProjectionMatrix();

      let extent = 0;
      for (const corner of corners) {
        const ndc = corner.clone().project(probe);
        extent = Math.max(extent, Math.abs(ndc.x), Math.abs(ndc.y));
      }
      if (!Number.isFinite(extent) || extent <= 0) break;

      // 0.96 leaves a hair of breathing room so the rim never touches the edge.
      const correction = extent / 0.96;
      if (Math.abs(correction - 1) < 0.005) break;
      distance *= correction;
    }

    return direction.multiplyScalar(distance);
  }

  /**
   * Seat the camera behind the player whose turn the board is showing.
   *
   * The board itself never moves. Rotating the camera instead of the board
   * keeps the lighting fixed in world space, so a flip does not swing every
   * shadow across the table.
   */
  #applyCamera(animate = true) {
    const side = this.#orientation === 'white' ? 1 : -1;
    const target = this.#cameraSeat(side);

    if (!animate || !this.#animationsEnabled || prefersReducedMotion()) {
      this.#camera.position.copy(target);
      this.#camera.lookAt(0, 0, 0);
      this.#needsRender = true;
      return;
    }

    this.#cameraSpin = {
      from: this.#camera.position.clone(),
      to: target,
      start: performance.now(),
      // Longer than a move: the whole view is turning, and at move speed it
      // reads as a glitch rather than a deliberate change of seat.
      duration: ANIMATION_MS * 2.4,
    };
  }

  #resize() {
    if (this.#disposed) return;
    const width = this.#root.clientWidth;
    const height = this.#root.clientHeight;
    if (!width || !height) return;

    // Cap the pixel ratio: a 3x phone screen triples the fragment cost for a
    // difference nobody can see on a board this size.
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();

    // Re-fit for the new aspect. The field of view stays fixed and the
    // distance does the work, so the board keeps the same sense of depth at
    // every size instead of going flat and wide on a narrow screen.
    if (!this.#cameraSpin) this.#applyCamera(false);
    this.#needsRender = true;
  }

  // -----------------------------------------------------------------------
  // Public contract (mirrors board.js)
  // -----------------------------------------------------------------------

  setOrientation(orientation) {
    const next = orientation === 'black' ? 'black' : 'white';
    if (next === this.#orientation) return;
    this.#orientation = next;
    this.#applyCamera(true);
    this.#applyA11yOrder();
    this.#refreshBoardTexture();
  }

  setShowCoordinates(show) {
    if (this.#showCoordinates === Boolean(show)) return;
    this.#showCoordinates = Boolean(show);
    this.#refreshBoardTexture();
  }

  setAnimationsEnabled(enabled) {
    this.#animationsEnabled = Boolean(enabled);
  }

  render(snapshot, options = {}) {
    const { state, view } = snapshot;
    if (!state || this.#disposed) return;

    if (snapshot.settings?.boardTheme && snapshot.settings.boardTheme !== this.#theme) {
      this.#theme = snapshot.settings.boardTheme;
      this.#refreshBoardTexture();
    }

    const move =
      options.animateMove && this.#animationsEnabled && !prefersReducedMotion()
        ? options.animateMove
        : null;

    const board = boardFromFen(state.fen);

    // Take the captured piece out of the scene before the position is applied,
    // exactly as the DOM board lifts the captured glyph before repainting.
    if (move?.isCapture) this.#detachCaptured(move);

    this.#syncPieces(board, move);
    this.#syncMarkers(state, view);
    this.#syncA11y(board, view, state);

    if (move) this.#animateMove(move);

    this.#draggedMove = null;
    this.#needsRender = true;
  }

  /**
   * Give the GPU context and every allocation back.
   *
   * A DOM board can simply be dropped on the floor for the garbage collector.
   * This one cannot: WebGL contexts are a limited per-page resource, and
   * geometries, materials and textures live in GPU memory that no amount of
   * dropping references will reclaim.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.abort();

    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;

    this.#pieces.forEach((piece) => this.#releasePiece(piece));
    this.#pieces.clear();

    this.#geometries.forEach((geometry) => geometry.dispose());
    this.#materials.forEach((material) => material.dispose());
    this.#geometries.clear();
    this.#materials.clear();
    this.#boardTexture?.dispose();

    this.#renderer?.dispose();
    // forceContextLoss frees the driver-side context immediately instead of
    // leaving it for the GC; browsers cap live contexts per page, and skin
    // switching would otherwise walk straight into that ceiling.
    this.#renderer?.forceContextLoss?.();
    this.#renderer = null;

    this.#root.classList.remove('board--3d');
    this.#root.innerHTML = '';
  }

  // -----------------------------------------------------------------------
  // Coordinates
  // -----------------------------------------------------------------------

  /** World position of a square's centre, at board level. */
  #squareToWorld(square) {
    const file = FILES.indexOf(square[0]);
    const rank = RANKS.indexOf(square[1]);
    return new THREE.Vector3(
      (file - 3.5) * SQUARE,
      BOARD_Y,
      (3.5 - rank) * SQUARE,
    );
  }

  /** The square a world position falls on, or null if it is off the board. */
  #worldToSquare(point) {
    const file = Math.floor(point.x / SQUARE + 4);
    const rank = Math.floor(4 - point.z / SQUARE);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return `${FILES[file]}${RANKS[rank]}`;
  }

  // -----------------------------------------------------------------------
  // Pieces
  // -----------------------------------------------------------------------

  /**
   * Build (and cache) the geometry for one piece type.
   * Cached by type only — the two colours differ by material, not by shape.
   */
  #pieceGeometry(type) {
    const key = `piece:${type}`;
    if (this.#geometries.has(key)) return this.#geometries.get(key);

    const height = PIECE_HEIGHT[type] ?? 0.6;
    const points = (PROFILES[type] ?? PROFILES.p).map(
      ([radius, y]) => new THREE.Vector2(radius * SQUARE, y * height),
    );
    const geometry = new THREE.LatheGeometry(points, 28);
    geometry.computeVertexNormals();
    this.#geometries.set(key, geometry);
    return geometry;
  }

  #pieceMaterial(color) {
    const key = `mat:${color}`;
    if (this.#materials.has(key)) return this.#materials.get(key);
    const spec = PIECE_MATERIALS[color] ?? PIECE_MATERIALS.w;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    this.#materials.set(key, material);
    return material;
  }

  /**
   * Assemble one piece.
   *
   * Returns a Group rather than a single mesh: the lathe gives the turned body,
   * and the details that make a piece identifiable at a glance — the rook's
   * crenellations, the king's cross, the knight's head — are separate solids
   * that no surface of revolution can express.
   */
  #makePiece(piece) {
    const group = new THREE.Group();
    const material = this.#pieceMaterial(piece.color);
    const height = PIECE_HEIGHT[piece.type] ?? 0.6;

    const body = new THREE.Mesh(this.#pieceGeometry(piece.type), material);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Detail solids are sized FROM the piece's height, never in absolute units.
    // They were absolute once, and retuning the heights left the rook's
    // crenellations buried inside its own top and the king's cross too small
    // to see — details that do not scale with the piece are details that only
    // look right at one size.
    if (piece.type === 'r') {
      const key = 'geo:crenel';
      const w = height * 0.15;
      if (!this.#geometries.has(key)) {
        this.#geometries.set(key, new THREE.BoxGeometry(w, height * 0.17, w));
      }
      const crenelGeo = this.#geometries.get(key);
      for (let i = 0; i < 6; i += 1) {
        const angle = (i / 6) * Math.PI * 2;
        const merlon = new THREE.Mesh(crenelGeo, material);
        // Sit ON the rim, overlapping it slightly so there is no seam.
        merlon.position.set(
          Math.cos(angle) * 0.235,
          height + height * 0.06,
          Math.sin(angle) * 0.235,
        );
        merlon.rotation.y = -angle;
        merlon.castShadow = true;
        group.add(merlon);
      }
    }

    if (piece.type === 'k') {
      const upKey = 'geo:crossUp';
      const acrossKey = 'geo:crossAcross';
      const bar = height * 0.075;
      if (!this.#geometries.has(upKey)) {
        this.#geometries.set(upKey, new THREE.BoxGeometry(bar, height * 0.3, bar));
        this.#geometries.set(acrossKey, new THREE.BoxGeometry(height * 0.24, bar, bar));
      }
      // The lathe stops at 0.92 of the height, leaving the top of the piece
      // for the cross — so the cross IS the king's last eighth, not an
      // ornament stuck above a finished piece.
      const upright = new THREE.Mesh(this.#geometries.get(upKey), material);
      upright.position.y = height * 1.02;
      upright.castShadow = true;
      const arm = new THREE.Mesh(this.#geometries.get(acrossKey), material);
      arm.position.y = height * 1.08;
      arm.castShadow = true;
      group.add(upright, arm);
    }

    if (piece.type === 'q') {
      const key = 'geo:crownBall';
      if (!this.#geometries.has(key)) {
        this.#geometries.set(key, new THREE.SphereGeometry(height * 0.062, 12, 10));
      }
      const ballGeo = this.#geometries.get(key);
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2;
        const ball = new THREE.Mesh(ballGeo, material);
        // Just outside the crown's widest ring, so they read as points around
        // a coronet rather than lumps sunk into it.
        ball.position.set(
          Math.cos(angle) * 0.315,
          height * 0.9,
          Math.sin(angle) * 0.315,
        );
        ball.castShadow = true;
        group.add(ball);
      }
    }

    if (piece.type === 'n') {
      const key = 'geo:knightHead';
      if (!this.#geometries.has(key)) {
        const shape = new THREE.Shape();
        KNIGHT_OUTLINE.forEach(([x, y], i) => {
          if (i === 0) shape.moveTo(x, y);
          else shape.lineTo(x, y);
        });
        shape.closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, {
          // Deep enough to be a head rather than a plate. At 0.26 the knight
          // rendered as a standing card: the camera looks down at 56 degrees,
          // so a thin extrusion is seen close to edge-on and its silhouette —
          // the only thing that identifies the piece — collapses to a line.
          depth: 0.46,
          bevelEnabled: true,
          bevelThickness: 0.05,
          bevelSize: 0.05,
          bevelSegments: 2,
          curveSegments: 4,
        });
        geometry.center();
        this.#geometries.set(key, geometry);
      }
      // Sized so the head runs from the top of the pedestal to the piece's
      // full height, and no further: scaling it by the height outright made a
      // knight half again as tall as the bishop beside it.
      const head = new THREE.Mesh(this.#geometries.get(key), material);
      head.scale.setScalar(height * 0.86);
      head.position.y = height * 0.58;
      // Tipped back so the profile turns to meet the camera. Straight upright
      // it sits 56 degrees off the view axis and loses nearly half its width
      // to foreshortening; this brings it back to about 35 and costs nothing,
      // since a horse carrying its head tipped back is what a horse does.
      head.rotation.x = -0.36;
      // NOT rotated. The outline is drawn in the XY plane, so the horse's
      // profile already faces the camera down +Z. Turning it a quarter turn to
      // "face the opponent" — which is what a real set does — points the flat
      // face away and shows the player the extrusion edge-on: a featureless
      // slab. The whole reason to extrude a silhouette is that the silhouette
      // is what reads, so it is kept facing the players.
      head.castShadow = true;
      head.receiveShadow = true;
      group.add(head);
      // Black's knights mirror, so the two sides face each other.
      group.userData.faces = piece.color === WHITE ? 1 : -1;
    }

    group.userData.piece = `${piece.color}${piece.type}`;
    return group;
  }

  #releasePiece(group) {
    this.#pieceGroup?.remove(group);
    // Geometries and materials are shared and cached, so only the wrapper is
    // dropped here — disposing them would pull the rug from every other piece.
  }

  /**
   * Bring the scene's pieces into line with the position.
   *
   * Only differences are touched. A piece that did not change is left exactly
   * as it is, including mid-animation, so a re-render provoked by something
   * unrelated (a clock tick, a settings change) cannot restart or stutter a
   * move that is already in flight.
   */
  #syncPieces(board, move) {
    // Remove pieces that are gone or changed identity.
    for (const [square, group] of [...this.#pieces]) {
      const piece = board.get(square);
      const key = piece ? `${piece.color}${piece.type}` : null;
      if (key !== group.userData.piece) {
        this.#releasePiece(group);
        this.#pieces.delete(square);
      }
    }

    // Add or reposition what the position calls for.
    for (const square of ALL_SQUARES) {
      const piece = board.get(square);
      if (!piece) continue;
      let group = this.#pieces.get(square);
      if (!group) {
        group = this.#makePiece(piece);
        this.#pieceGroup.add(group);
        this.#pieces.set(square, group);
      }
      const world = this.#squareToWorld(square);
      // A piece that is about to be animated is placed by the animation.
      const animating = move && move.to === square;
      if (!animating) {
        group.position.set(world.x, BOARD_Y, world.z);
        group.rotation.y = group.userData.faces === -1 ? Math.PI : 0;
        group.scale.setScalar(1);
      } else {
        group.position.y = BOARD_Y;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Highlights
  // -----------------------------------------------------------------------

  /** A flat, board-hugging quad used for every highlight. */
  #makeMarkerMesh() {
    const key = 'geo:marker';
    if (!this.#geometries.has(key)) {
      this.#geometries.set(key, new THREE.PlaneGeometry(SQUARE, SQUARE));
    }
    const mesh = new THREE.Mesh(
      this.#geometries.get(key),
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    this.#markerGroup.add(mesh);
    return mesh;
  }

  #takeMarker() {
    const pooled = this.#markerPool.pop();
    if (pooled) {
      pooled.visible = true;
      return pooled;
    }
    return this.#makeMarkerMesh();
  }

  #syncMarkers(state, view) {
    // Return everything to the pool, then re-place. Markers are a handful of
    // transparent quads; rebuilding them is cheaper than diffing them.
    //
    // The focus marker is deliberately excluded: it is owned by the keyboard,
    // changes on arrow keys between renders, and must not be recycled into a
    // legal-move dot underneath the player.
    this.#markerPool.length = 0;
    this.#markerGroup.children.forEach((child) => {
      if (child === this.#focusMarker) return;
      child.visible = false;
      this.#markerPool.push(child);
    });

    const place = (square, spec, lift) => {
      const marker = this.#takeMarker();
      const world = this.#squareToWorld(square);
      marker.position.set(world.x, BOARD_Y + lift, world.z);
      marker.material.color.setHex(spec.color);
      marker.material.opacity = spec.opacity;
      marker.scale.setScalar(1);
      return marker;
    };

    const lastMove = state.lastMove;
    if (lastMove) {
      place(lastMove.from, HIGHLIGHT.lastMove, 0.004);
      place(lastMove.to, HIGHLIGHT.lastMove, 0.004);
    }
    if (state.checkSquare) place(state.checkSquare, HIGHLIGHT.check, 0.006);
    if (view?.selected) place(view.selected, HIGHLIGHT.selected, 0.008);

    // Legal destinations: a small disc, a wide ring for a capture — the same
    // vocabulary the flat board uses, so the two read identically.
    (view?.legalTargets ?? []).forEach((target) => {
      const marker = place(
        target.to,
        { color: target.isCapture ? 0xe5594d : 0x101319, opacity: target.isCapture ? 0.55 : 0.38 },
        0.01,
      );
      marker.scale.setScalar(target.isCapture ? 0.94 : 0.3);
    });
  }

  #focusVisible = false;
  #focusMarker = null;

  // -----------------------------------------------------------------------
  // Accessibility mirror
  // -----------------------------------------------------------------------

  #syncA11y(board, view, state) {
    const targets = new Map((view?.legalTargets ?? []).map((m) => [m.to, m]));
    this.#a11ySquares.forEach((button, square) => {
      const piece = board.get(square) ?? null;
      button.setAttribute('aria-label', describeSquare(square, piece, targets.get(square)));
      button.setAttribute(
        'aria-selected',
        String(square === view?.selected),
      );
    });
    void state;
  }

  // -----------------------------------------------------------------------
  // Animation
  // -----------------------------------------------------------------------

  /**
   * Lift the captured piece out of the position and let it sink away.
   *
   * The same reasoning as the DOM board's fading ghost: a piece that simply
   * ceases to exist the instant the move lands is the most jarring thing on
   * the board. Here it drops through the surface as it shrinks, which reads as
   * being taken rather than deleted.
   */
  #detachCaptured(move) {
    const square = move.isEnPassant ? `${move.to[0]}${move.from[1]}` : move.to;
    const group = this.#pieces.get(square);
    if (!group) return;
    this.#pieces.delete(square);

    if (!this.#animationsEnabled || prefersReducedMotion()) {
      this.#releasePiece(group);
      return;
    }

    const start = performance.now();
    const duration = ANIMATION_MS * CAPTURE_FADE_RATIO;
    const from = group.position.clone();
    this.#animations.push({
      update: (now) => {
        const t = Math.min(1, (now - start) / duration);
        const k = ease(t);
        group.position.set(from.x, from.y - k * 0.55, from.z);
        group.scale.setScalar(Math.max(0.001, 1 - k * 0.75));
        return t >= 1;
      },
      done: () => this.#releasePiece(group),
    });
  }

  /**
   * Move a piece through the air from its origin to where it now stands.
   *
   * The flat board slides; here the piece is picked up, carried and set down,
   * which is what the extra dimension is actually for. The knight arcs higher
   * than everything else because it is the one piece that jumps.
   */
  #animateMove(move) {
    const carry = (fromSquare, toSquare, lift) => {
      const group = this.#pieces.get(toSquare);
      if (!group) return;

      const from = this.#squareToWorld(fromSquare);
      const to = this.#squareToWorld(toSquare);
      const start = performance.now();

      this.#animations.push({
        key: toSquare,
        update: (now) => {
          const t = Math.min(1, (now - start) / ANIMATION_MS);
          const k = ease(t);
          group.position.x = from.x + (to.x - from.x) * k;
          group.position.z = from.z + (to.z - from.z) * k;
          // A half-sine arc: zero at both ends, highest in the middle, so the
          // piece lands flat on the board rather than dropping onto it.
          group.position.y = BOARD_Y + Math.sin(k * Math.PI) * lift;
          return t >= 1;
        },
        done: () => {
          group.position.set(to.x, BOARD_Y, to.z);
        },
      });
    };

    // A piece the player dragged here is already where they put it; carrying it
    // back to the origin to re-travel undoes their own gesture.
    if (this.#draggedMove !== `${move.from}|${move.to}`) {
      carry(move.from, move.to, move.piece === 'n' ? 0.85 : 0.32);
    }

    if (move.isCastle) {
      const rank = move.color === WHITE ? '1' : '8';
      if (move.isKingsideCastle) carry(`h${rank}`, `f${rank}`, 0.32);
      else carry(`a${rank}`, `d${rank}`, 0.32);
    }
  }

  #loop = () => {
    if (this.#disposed) return;
    this.#frame = requestAnimationFrame(this.#loop);
    const now = performance.now();

    if (this.#cameraSpin) {
      const spin = this.#cameraSpin;
      const t = Math.min(1, (now - spin.start) / spin.duration);
      const k = ease(t);
      // Interpolate around the board rather than straight through it: a linear
      // lerp between two opposite seats passes through the centre, diving the
      // camera through the pieces on the way.
      const angleFrom = Math.atan2(spin.from.z, spin.from.x);
      let delta = Math.atan2(spin.to.z, spin.to.x) - angleFrom;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      const angle = angleFrom + delta * k;
      const radius = Math.hypot(spin.to.x, spin.to.z);
      this.#camera.position.set(
        Math.cos(angle) * radius,
        spin.from.y + (spin.to.y - spin.from.y) * k,
        Math.sin(angle) * radius,
      );
      this.#camera.lookAt(0, 0, 0);
      if (t >= 1) this.#cameraSpin = null;
      this.#needsRender = true;
    }

    if (this.#animations.length) {
      this.#animations = this.#animations.filter((animation) => {
        const finished = animation.update(now);
        if (finished) animation.done?.();
        return !finished;
      });
      this.#needsRender = true;
    }

    if (this.#needsRender && this.#renderer) {
      this.#renderer.render(this.#scene, this.#camera);
      this.#needsRender = false;
    }
  };

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------

  /** Raycast a pointer event onto the board, returning a square or null. */
  #squareFromEvent(event) {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.#pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hits = this.#raycaster.intersectObject(this.#boardMesh, false);
    if (!hits.length) return null;
    this.#lastPick = this.#worldToSquare(hits[0].point);
    return this.#lastPick;
  }

  #attachListeners() {
    const root = this.#root;
    // Every listener carries the abort signal, so dispose() detaches the
    // whole board from the element in one call. See #listeners.
    const on = (target, type, handler) =>
      target.addEventListener(type, handler, { signal: this.#listeners.signal });


    on(root, 'pointerdown', (event) => {
      const square = this.#squareFromEvent(event);
      if (!square) return;
      this.#focusSquare(square, false);

      const isTouch = event.pointerType === 'touch';
      this.#drag = {
        square,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
        // Dragging on mouse/pen only, matching the flat board: on touch,
        // tap-to-move is primary and the page must still be able to scroll.
        eligible: !isTouch && this.#pieces.has(square),
      };
    });

    on(root, 'pointermove', (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId || !drag.eligible) return;

      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) return;
        drag.active = true;
        this.#onSquareActivate(drag.square);
      }

      // Carry the piece under the pointer at a slight lift, so it reads as
      // picked up rather than shoved along the surface.
      const group = this.#pieces.get(drag.square);
      const target = this.#squareFromEvent(event);
      if (group && target) {
        const world = this.#squareToWorld(target);
        group.position.set(world.x, BOARD_Y + 0.5, world.z);
        this.#needsRender = true;
      }
    });

    const finish = (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.#drag = null;

      if (!drag.active) {
        const square = this.#squareFromEvent(event) ?? drag.square;
        if (square) this.#onSquareActivate(square);
        return;
      }

      const dropSquare = this.#squareFromEvent(event);
      // Put the lifted piece back on the board. If the move is legal the
      // render that follows will place it properly; if not, this is what
      // returns it home.
      const group = this.#pieces.get(drag.square);
      if (group) {
        const home = this.#squareToWorld(drag.square);
        group.position.set(home.x, BOARD_Y, home.z);
        this.#needsRender = true;
      }

      if (dropSquare && dropSquare !== drag.square) {
        this.#draggedMove = `${drag.square}|${dropSquare}`;
        this.#onSquareActivate(dropSquare);
      }
    };

    on(root, 'pointerup', finish);
    on(root, 'pointercancel', finish);

    // Keyboard comes through the hidden grid, which owns the focus.
    on(this.#a11yGrid, 'keydown', (event) => {
      const square = event.target?.dataset?.square;
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

    // A keyboard user cannot see a focus ring drawn on a canvas by the browser,
    // because the browser draws it on the hidden button instead. Mirror it into
    // the scene so focus is actually visible.
    on(this.#a11yGrid, 'focusin', (event) => {
      const square = event.target?.dataset?.square;
      if (!square) return;
      this.#focusedSquare = square;
      this.#focusVisible = true;
      this.#redrawFocus();
    });
    on(this.#a11yGrid, 'focusout', () => {
      this.#focusVisible = false;
      this.#redrawFocus();
    });
  }

  /**
   * Repaint just the focus marker.
   *
   * Focus moves on every arrow key, and a full render() needs a snapshot the
   * board does not hold — so the marker is placed directly rather than routed
   * back through the controller for a state change that has not happened.
   */
  #redrawFocus() {
    if (!this.#focusMarker) {
      this.#focusMarker = this.#makeMarkerMesh();
      this.#focusMarker.userData.focus = true;
      this.#focusMarker.material.color.setHex(HIGHLIGHT.focus.color);
      this.#focusMarker.material.opacity = HIGHLIGHT.focus.opacity;
    }
    this.#focusMarker.visible = this.#focusVisible;
    if (this.#focusVisible) {
      const world = this.#squareToWorld(this.#focusedSquare);
      this.#focusMarker.position.set(world.x, BOARD_Y + 0.012, world.z);
    }
    this.#needsRender = true;
  }

  /**
   * A window into the scene, for the console and for tests.
   *
   * Nothing in the app calls this, and it returns null unless DEBUG is on. It
   * exists because everything this board draws lives in a canvas: there is no
   * DOM to inspect, so without a hook like this neither a developer at the
   * console nor a test can see whether the right things are on the board. One
   * accessor rather than a scattering of them keeps that seam small and
   * obvious, and matches the existing `controller.loadFen` console helper.
   */
  debug() {
    if (!DEBUG) return null;
    let meshes = 0;
    this.#scene.traverse((object) => { if (object.isMesh) meshes += 1; });
    const markers = {};
    this.#markerGroup.children.forEach((marker) => {
      if (!marker.visible) return;
      const square = this.#worldToSquare(marker.position);
      const hex = marker.material.color.getHex();
      if (marker === this.#focusMarker) markers.focus = square;
      else if (hex === HIGHLIGHT.check.color) markers.check = square;
      else if (hex === HIGHLIGHT.selected.color && marker.material.opacity > 0.4) {
        markers.selected = square;
      }
    });
    return {
      camera: this.#camera.position.clone(),
      theme: this.#theme,
      orientation: this.#orientation,
      pieces: this.#pieces.size,
      meshes,
      boardMeshes: 1,
      markers,
      lastPick: this.#lastPick,
      focus: { visible: this.#focusVisible, square: this.#focusedSquare },
      animating: this.#animations.length,

      /**
       * Where a square is drawn on screen, in client coordinates.
       *
       * The inverse of what a pointer does, through the same camera — which is
       * what makes it worth having: click where this says a square is, and the
       * raycast must name that same square. Any error in the screen-to-square
       * mapping shows up immediately as a disagreement between the two.
       */
      projectSquare: (square) => {
        const rect = this.#canvas.getBoundingClientRect();
        const ndc = this.#squareToWorld(square).project(this.#camera);
        return {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
      },

      /** Where a piece actually is in the scene, mid-animation included. */
      piecePosition: (square) => {
        const group = this.#pieces.get(square);
        return group ? { x: group.position.x, y: group.position.y, z: group.position.z } : null;
      },
    };
  }

  /** The last square a pointer resolved to. Diagnostic only. */
  #lastPick = null;

  /** Roving tabindex: exactly one square is tabbable at a time. */
  #focusSquare(square, moveFocus) {
    const button = this.#a11ySquares.get(square);
    if (!button) return;
    this.#a11ySquares.get(this.#focusedSquare)?.setAttribute('tabindex', '-1');
    this.#focusedSquare = square;
    button.setAttribute('tabindex', '0');
    if (moveFocus) button.focus();
  }
}

/** Same check, same reason, as the DOM board's. */
function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export default Board3D;
