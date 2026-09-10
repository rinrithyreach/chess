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
  BOARD_ZOOM_LEVELS,
  DEFAULT_BOARD_ZOOM,
  clampBoardZoom,
  warn,
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
/*
   Board colours for the 3D board.

   Darker than the flat board's equivalents on purpose, and not a mistake to be
   "corrected" back. These are albedos going through a light of roughly 1.5 and
   then filmic tone mapping, not pixels going straight to the screen: the flat
   board's cream arrives at the eye as near-white here, taking the grain with
   it. Tuned by rendering until what comes OUT is the colour the flat board
   shows.
*/
const THEMES = {
  classic: { light: '#c8ab7e', dark: '#7d5530', rim: '#4a3018', inkOnLight: '#6b4a26', inkOnDark: '#e2cba6' },
  midnight: { light: '#77879f', dark: '#33405a', rim: '#1e2536', inkOnLight: '#2b3549', inkOnDark: '#c2cee2' },
  wood: { light: '#c5a271', dark: '#6f4826', rim: '#3f2914', inkOnLight: '#5c3c1c', inkOnDark: '#ecd8bc' },
};

const HIGHLIGHT = {
  lastMove: { color: 0xe8b44c, opacity: 0.34 },
  selected: { color: 0xe8b44c, opacity: 0.55 },
  check: { color: 0xe5594d, opacity: 0.75 },
  focus: { color: 0x7fb2ff, opacity: 0.5 },
};

/**
 * The two piece finishes.
 *
 * Not the same material in two colours. A pale piece is boxwood: fairly matt,
 * lit mostly by the light that scatters just under the surface. A dark piece
 * is ebonised and lacquered, so almost everything you see on it is reflection
 * — which is why it gets the harder coat and the stronger environment. Give
 * them identical finishes and the black pieces read as silhouettes with no
 * shape in them.
 *
 * A sheen lobe was tried here and removed. It is the most expensive term
 * MeshPhysicalMaterial offers, it was applied to all 32 pieces, and beside the
 * clearcoat it was doing nothing anyone could point at.
 */
const PIECE_MATERIALS = {
  w: {
    color: 0xd9cdb6,
    roughness: 0.62,
    metalness: 0.0,
    // A tight coat over a rough body. The contrast between the two is the
    // whole effect: a broad soft highlight on a smooth body just looks pale,
    // which is how the first pass read.
    clearcoat: 0.55,
    clearcoatRoughness: 0.13,
    envMapIntensity: 0.9,
  },
  b: {
    color: 0x1e212a,
    roughness: 0.5,
    metalness: 0.0,
    clearcoat: 0.75,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.4,
  },
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
    [0.00, 0.000], [0.300, 0.000], [0.300, 0.042], [0.288, 0.052],
    [0.286, 0.074], [0.246, 0.104], [0.196, 0.132],
    [0.162, 0.168], [0.148, 0.244], [0.142, 0.322],
    [0.152, 0.396], [0.206, 0.442], [0.226, 0.468],
    [0.228, 0.492], [0.196, 0.514],
    [0.150, 0.548], [0.140, 0.582],
    [0.186, 0.646], [0.226, 0.726], [0.236, 0.802],
    [0.214, 0.880], [0.158, 0.942], [0.084, 0.984], [0.00, 1.000],
  ],
  r: [
    [0.00, 0.000], [0.340, 0.000], [0.340, 0.048], [0.326, 0.058],
    [0.324, 0.082], [0.276, 0.116], [0.232, 0.152],
    [0.212, 0.196], [0.202, 0.320], [0.200, 0.480], [0.206, 0.586],
    [0.238, 0.642], [0.246, 0.672],
    [0.246, 0.700], [0.216, 0.716],
    [0.222, 0.746], [0.296, 0.788], [0.310, 0.812],
    [0.310, 0.874], [0.262, 0.876],
    [0.262, 1.000], [0.00, 1.000],
  ],
  // The mitre is a tall cone pinched to a thin stem below a separate finial
  // ball. Without that pinch a bishop is just a taller pawn — which is exactly
  // how the first pass read on the board.
  b: [
    [0.00, 0.000], [0.330, 0.000], [0.330, 0.042], [0.316, 0.052],
    [0.314, 0.074], [0.268, 0.106], [0.212, 0.140],
    [0.172, 0.176], [0.154, 0.256], [0.150, 0.318],
    [0.164, 0.372], [0.206, 0.412], [0.238, 0.444],
    [0.240, 0.468], [0.208, 0.486],
    [0.156, 0.512], [0.142, 0.546],
    [0.186, 0.596], [0.212, 0.652], [0.222, 0.708],
    [0.210, 0.768], [0.176, 0.826], [0.128, 0.878], [0.082, 0.916],
    [0.048, 0.938], [0.044, 0.948],
    [0.078, 0.964], [0.070, 0.986], [0.036, 0.996], [0.00, 1.000],
  ],
  q: [
    [0.00, 0.000], [0.370, 0.000], [0.370, 0.044], [0.356, 0.054],
    [0.354, 0.078], [0.302, 0.112], [0.240, 0.150],
    [0.190, 0.192], [0.174, 0.286], [0.170, 0.366],
    [0.182, 0.428], [0.230, 0.472], [0.262, 0.502],
    [0.264, 0.526], [0.226, 0.546],
    [0.180, 0.578], [0.168, 0.616],
    [0.216, 0.678], [0.262, 0.740], [0.296, 0.806],
    [0.300, 0.836], [0.258, 0.850],
    [0.264, 0.868], [0.302, 0.884],
    [0.296, 0.906], [0.218, 0.928],
    [0.132, 0.948], [0.120, 0.964], [0.146, 0.978], [0.104, 0.992], [0.00, 1.000],
  ],
  k: [
    [0.00, 0.000], [0.380, 0.000], [0.380, 0.044], [0.366, 0.054],
    [0.364, 0.078], [0.310, 0.112], [0.246, 0.152],
    [0.196, 0.196], [0.180, 0.300], [0.176, 0.388],
    [0.188, 0.446], [0.238, 0.490], [0.272, 0.520],
    [0.274, 0.544], [0.234, 0.564],
    [0.188, 0.598], [0.176, 0.638],
    [0.226, 0.700], [0.272, 0.760], [0.300, 0.812],
    [0.302, 0.838], [0.260, 0.852],
    [0.266, 0.868], [0.300, 0.880],
    [0.292, 0.900], [0.214, 0.914], [0.164, 0.920], [0.00, 0.920],
  ],
  // The knight's body is only a short pedestal; the head is most of the piece
  // and is extruded separately.
  n: [
    [0.00, 0.000], [0.340, 0.000], [0.340, 0.048], [0.326, 0.058],
    [0.324, 0.082], [0.278, 0.114], [0.226, 0.148],
    [0.196, 0.186], [0.188, 0.238],
    [0.212, 0.268], [0.236, 0.292], [0.00, 0.292],
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
/**
 * A tiny seeded PRNG, so generated detail is the same every time.
 *
 * `Math.random` would give a board whose grain reshuffled on every theme
 * change and differed between the two players' screens, which for something
 * meant to look like one physical object is exactly wrong.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNIGHT_OUTLINE = [
  // Throat and jaw, dropping forward to the muzzle.
  [-0.16, 0.00], [-0.21, 0.14], [-0.27, 0.28], [-0.34, 0.42], [-0.40, 0.52],
  // Muzzle: lip, nose, nostril — the part that has to jut, because a head
  // without a muzzle is a lump and reads as one at forty pixels tall.
  [-0.45, 0.585], [-0.455, 0.645], [-0.415, 0.695],
  // The dish above the nostril, then the bridge climbing to the brow. This
  // concave step is the single most horse-like thing in the outline.
  [-0.355, 0.715], [-0.30, 0.775], [-0.245, 0.845], [-0.195, 0.905],
  // Two ears with a notch between them. One ear reads as a horn.
  [-0.19, 1.005], [-0.115, 0.935], [-0.055, 1.055], [0.015, 0.925],
  // The crest of the neck, then the mane stepping down the back in three
  // notches — the detail that stops the back of the head being a plain arc.
  [0.09, 0.865], [0.175, 0.755], [0.135, 0.675], [0.215, 0.575],
  [0.175, 0.485], [0.255, 0.365], [0.24, 0.18], [0.20, 0.00],
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
  #boardRoughness = null;
  #environmentRT = null;
  #environment = null;
  #richDetail = true;
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
  #zoom = DEFAULT_BOARD_ZOOM;

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
    /*
       Filmic tone mapping rather than none.

       Without it, everything above 1.0 clips to flat white: a turned piece's
       highlight arrives as a bald patch with no shape in it, which is most of
       why the first pass read as plastic. ACES rolls those highlights off
       instead, so the brightest part of a curve still shows its curvature. It
       darkens the midtones as a side effect, which is what the exposure and
       the retuned light intensities below are compensating for.
    */
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 0.76;
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.#richDetail = this.#hasHardwareGpu();

    this.#scene = new THREE.Scene();
    this.#camera = new THREE.PerspectiveCamera(38, 1, 0.5, 60);

    this.#buildEnvironment();
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

  /**
   * Is there a GPU behind this context, or is Chromium rasterising in software?
   *
   * Not a guess at how fast the device is — that is unknowable and the wrong
   * question. This is the one distinction that actually changes the arithmetic:
   * a prefiltered cube lookup and a second specular lobe are a texture unit and
   * a few ALU ops on any GPU made this decade, and hundreds of CPU instructions
   * per fragment without one. Measured on this project's own test harness,
   * which runs SwiftShader: the 95th-percentile frame during a move went from
   * 17ms to 200ms with the environment map on, and back to 50ms without it.
   * A real GPU never sees that curve.
   *
   * Chrome falls back to SwiftShader when it blocklists a driver, so this is a
   * real population, not a hypothetical one. They get the same board with the
   * two most fill-hungry refinements left off; everyone else gets the lot.
   *
   * Unknown counts as hardware. The debug extension is absent or masked in
   * plenty of ordinary browsers, and downgrading everyone whose renderer will
   * not identify itself would trade a real loss for an imagined gain.
   */
  #hasHardwareGpu() {
    try {
      const gl = this.#renderer?.getContext?.();
      const info = gl?.getExtension?.('WEBGL_debug_renderer_info');
      if (!gl || !info) return true;
      const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
      return !/swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch {
      return true;
    }
  }

  /**
   * A room for the pieces to reflect.
   *
   * Lights alone give a MeshStandardMaterial diffuse shading and a single
   * specular dot, and nothing else — no sense of a surface having anywhere to
   * be. That is the real reason turned pieces looked like moulded plastic: a
   * polished object reads as polished because you can see the room in it, and
   * there was no room. This builds a small studio — a graded sky, a warm
   * softbox above and to the left where the key light is, a cool one opposite,
   * and a floor bounce — and prefilters it into a cube map that every standard
   * material then samples. It is the largest single change to how the board
   * looks, and it costs one 128px cube generated once.
   *
   * Built from primitives rather than loaded, for the same reason the pieces
   * are: nothing to ship, nothing to keep in sync.
   *
   * Skipped entirely when there is no GPU — see #hasHardwareGpu.
   */
  #buildEnvironment() {
    if (!this.#richDetail) return;

    let generator = null;
    const room = new THREE.Scene();
    const temporary = [];

    try {
      // The sky: a vertical gradient on the inside of a sphere. Warm just
      // above the horizon, cool overhead — the way a lit room actually falls
      // off, and enough variation that a curved surface sweeping through it
      // shows the sweep.
      const sky = document.createElement('canvas');
      sky.width = 4;
      sky.height = 64;
      const skyCtx = sky.getContext('2d');
      const grad = skyCtx.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, '#8fa3c4');
      grad.addColorStop(0.45, '#5c6474');
      grad.addColorStop(0.62, '#453e38');
      grad.addColorStop(1, '#17140f');
      skyCtx.fillStyle = grad;
      skyCtx.fillRect(0, 0, 4, 64);
      const skyTexture = new THREE.CanvasTexture(sky);
      skyTexture.colorSpace = THREE.SRGBColorSpace;

      const domeGeo = new THREE.SphereGeometry(12, 16, 12);
      const domeMat = new THREE.MeshBasicMaterial({
        map: skyTexture,
        side: THREE.BackSide,
      });
      room.add(new THREE.Mesh(domeGeo, domeMat));
      temporary.push(domeGeo, domeMat, skyTexture);

      // The softboxes. Bright emissive-by-basic panels: what a piece's
      // highlight is actually a picture of.
      const panelGeo = new THREE.PlaneGeometry(1, 1);
      temporary.push(panelGeo);
      const panel = (color, intensity, scale, position) => {
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(intensity),
        });
        const mesh = new THREE.Mesh(panelGeo, material);
        mesh.scale.set(scale[0], scale[1], 1);
        mesh.position.set(...position);
        mesh.lookAt(0, 0, 0);
        room.add(mesh);
        temporary.push(material);
      };
      panel('#fff1dc', 2.4, [7, 5], [-5, 8, 5]);   // key, matching the key light
      panel('#cfe0ff', 0.7, [8, 4], [6, 5, -7]);   // cool fill, opposite
      panel('#ffffff', 0.28, [10, 10], [0, -6, 0]); // floor bounce

      generator = new THREE.PMREMGenerator(this.#renderer);
      generator.compileEquirectangularShader?.();
      this.#environmentRT = generator.fromScene(room, 0.03);
      /*
         Assigned per material, NOT as scene.environment.

         scene.environment gives it to everything, and everything includes the
         board — which is by far the largest thing on screen. Profiling said
         that one line was the single most expensive change in this file: the
         95th-percentile frame went from 17ms to 500ms with it, and to 83ms
         without, because every pixel of the board was doing a prefiltered cube
         lookup to gain a sheen nobody was looking for. The pieces are where a
         reflection reads, they cover a small fraction of the canvas, and they
         are what this was for. They get it; the board does not.
      */
      this.#environment = this.#environmentRT.texture;
    } catch (error) {
      // A prefiltered environment is a refinement, not a requirement. If the
      // generator is unavailable the materials fall back to light-only
      // shading, which is exactly how this board looked before.
      warn('Environment map unavailable; using lights only', error);
      this.#environmentRT = null;
      this.#environment = null;
    } finally {
      generator?.dispose();
      temporary.forEach((resource) => resource.dispose?.());
    }
  }

  #buildLights() {
    // Sky/ground fill, so the underside of a piece is never dead black. Lower
    // than it was: the environment now supplies most of the ambient, and
    // leaving both at full strength washed the shading flat again.
    this.#scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2620, 0.26));

    const key = new THREE.DirectionalLight(0xfff4e2, 1.45);
    key.position.set(-4.5, 9, 4.5);
    key.castShadow = true;
    // Stays at 1024, and that is a measured decision rather than a default
    // left alone. 2048 looked marginally cleaner under a piece and cost four
    // times the shadow pass — profiled at a 267ms 95th-percentile frame
    // against 17ms, because the shadow map is re-rendered every time anything
    // on the board moves. The tight frustum below is what keeps 1024 sharp
    // enough: it spends every texel on the board rather than on the empty
    // space the default frustum covers.
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
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.32);
    fill.position.set(5, 4, -6);
    this.#scene.add(fill);
  }

  #buildBoard() {
    const theme = THEMES[this.#theme] ?? THEMES.classic;
    // Generated first: the rim below uses it too, and it never changes with
    // the theme — only the colour laid over it does. Skipped without a GPU:
    // it is one more texture fetch across the largest surface on screen, and
    // the grain is still there in the colour map either way — what is lost is
    // the way it catches the light, not the wood.
    this.#boardRoughness = this.#richDetail ? this.#makeGrainRoughnessTexture() : null;

    // The rim: a slab slightly larger than the playing area, so the board has
    // a physical edge to catch the light instead of floating as a flat plane.
    const rimGeo = new THREE.BoxGeometry(
      2 * HALF + 2 * RIM,
      0.5,
      2 * HALF + 2 * RIM,
    );
    // The border is real wood too, and at the low camera angle its near face
    // is a sixth of what you can see. Flat colour there gave the whole board a
    // painted edge; sharing the squares' grain map makes it part of the same
    // object. Standard rather than physical, and no environment: it is a large
    // area of screen for a refinement that would not show on it.
    const rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.rim),
      roughnessMap: this.#boardRoughness,
      roughness: this.#boardRoughness ? 0.95 : 0.7,
      metalness: 0.0,
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
      // Wood is not uniformly glossy: the grain scatters light where it is
      // open and holds a sheen where it is not. One greyscale map turns a flat
      // plane of two colours into a surface, and it is what makes the board
      // move as the camera does rather than sitting there like paint.
      roughnessMap: this.#boardRoughness,
      roughness: this.#boardRoughness ? 1 : 0.75,
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
    const cell = 160;
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
        // Each square is a separate piece of veneer, so each gets its own
        // grain: its own direction and its own offset. A single grain running
        // across the whole board is the one thing that would make it read as
        // printed rather than made.
        this.#paintGrain(ctx, col * cell, row * cell, cell, (row * 8 + col), isLight);
      }
    }

    // The seam between squares. A real board has an edge there — light catches
    // the join — and one dark pixel of inset is enough to say so, at a
    // thousandth of the cost of modelling 64 bevels.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.26)';
    ctx.lineWidth = Math.max(1, cell * 0.012);
    for (let i = 0; i <= 8; i += 1) {
      const at = i * cell;
      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at, cell * 8);
      ctx.moveTo(0, at);
      ctx.lineTo(cell * 8, at);
      ctx.stroke();
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
    /*
       Linear, not nearest.

       Nearest was the right call when a square was one flat colour: it kept
       the boundary between two fields perfectly crisp. Now that each square
       carries grain and a drawn seam, nearest samples that fine detail into
       hard stair-steps, and the seam line does the crisp-edge job better than
       point sampling ever did. Anisotropy is what keeps the far rank legible
       at this camera angle — without it the grain and the coordinates smear
       into mush a couple of ranks out.
    */
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = this.#renderer?.capabilities.getMaxAnisotropy() ?? 1;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Wood grain for one square, in place.
   *
   * Deterministic from the square's index, so the board looks the same every
   * time it is drawn — a board whose grain reshuffled on every theme change
   * would be visibly wrong. Fine streaks with a slowly wandering centre line,
   * which is what grain is; the alternative, random noise, reads as dirt.
   */
  #paintGrain(ctx, x, y, size, seed, isLight) {
    const rand = mulberry32(seed * 2654435761);
    const across = rand() < 0.5; // half the squares are cut the other way

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    ctx.translate(x + size / 2, y + size / 2);
    if (across) ctx.rotate(Math.PI / 2);
    ctx.translate(-size / 2, -size / 2);

    const lines = 26;
    ctx.lineWidth = size * 0.012;
    for (let i = 0; i < lines; i += 1) {
      const base = (i / lines) * size + rand() * size * 0.02;
      // Dark and light streaks in the same pass: grain is both, and only
      // darkening it makes the square look dirty rather than figured.
      const dark = rand() < 0.62;
      const strength = (isLight ? 0.13 : 0.16) * (0.35 + rand() * 0.65);
      ctx.strokeStyle = dark
        ? `rgba(60, 36, 14, ${strength})`
        : `rgba(255, 236, 200, ${strength * 0.8})`;
      ctx.beginPath();
      ctx.moveTo(0, base);
      const wobble = size * (0.012 + rand() * 0.02);
      ctx.bezierCurveTo(
        size * 0.33, base + wobble,
        size * 0.66, base - wobble,
        size, base + wobble * 0.4,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * A greyscale roughness map matching the grain.
   *
   * Quarter the colour map's resolution on purpose: roughness varies slowly
   * and nobody can see a roughness texel, so this is where to spend less. It
   * is generated once and never regenerated — grain does not change when the
   * theme or the orientation does, only its colour does.
   */
  #makeGrainRoughnessTexture() {
    const cell = 40;
    const canvas = document.createElement('canvas');
    canvas.width = cell * 8;
    canvas.height = cell * 8;
    const ctx = canvas.getContext('2d');

    // Mid-grey base: fairly rough, as a satin lacquer is.
    ctx.fillStyle = '#b4b4b4';
    ctx.fillRect(0, 0, cell * 8, cell * 8);

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const rand = mulberry32((row * 8 + col) * 2654435761);
        const across = rand() < 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(col * cell, row * cell, cell, cell);
        ctx.clip();
        ctx.translate(col * cell + cell / 2, row * cell + cell / 2);
        if (across) ctx.rotate(Math.PI / 2);
        ctx.translate(-cell / 2, -cell / 2);
        ctx.lineWidth = cell * 0.02;
        for (let i = 0; i < 26; i += 1) {
          const base = (i / 26) * cell + rand() * cell * 0.02;
          const dark = rand() < 0.62;
          // Open grain scatters (rougher, lighter here); closed grain holds a
          // sheen (smoother, darker here).
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.22)';
          ctx.beginPath();
          ctx.moveTo(0, base);
          const wobble = cell * (0.012 + rand() * 0.02);
          ctx.bezierCurveTo(
            cell * 0.33, base + wobble,
            cell * 0.66, base - wobble,
            cell, base + wobble * 0.4,
          );
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = this.#renderer?.capabilities.getMaxAnisotropy() ?? 1;
    // Data, not colour: a roughness map must stay linear or the values are
    // silently gamma-shifted and the whole surface reads too glossy.
    texture.colorSpace = THREE.NoColorSpace;
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
    // Elevation is the zoom. Foreshortening means the board projects to
    // roughly sin(elevation) as tall as it is wide, so a low angle leaves a
    // third of a square frame empty and a high one spends that space on the
    // board — see BOARD_ZOOM_LEVELS for why this is the lever rather than a
    // dolly. 56 degrees is the low end: the board fills its width and the
    // pieces clearly stand up off it.
    const level = BOARD_ZOOM_LEVELS[this.#zoom] ?? BOARD_ZOOM_LEVELS[0];
    const elevation = THREE.MathUtils.degToRad(level.elevation);
    const direction = new THREE.Vector3(
      0,
      Math.sin(elevation),
      side * Math.cos(elevation),
    ).normalize();

    // What actually has to be in frame, and nothing more. The board's own body
    // out to the rim, and a king standing on a corner SQUARE — not on the rim
    // corner. That distinction is worth a quarter of the board's size: a rim
    // corner is the nearest point to the camera, so a king's height there is
    // the most magnified thing in the volume, and reserving room for it
    // reserved room for a piece that cannot exist. Fitting the real volume
    // instead grows every square by about a quarter with nothing else changed.
    const reach = HALF + RIM * level.rim; // as much of the rim as this level keeps
    const stand = HALF - 0.5;             // centre of an outermost square
    const corners = [];
    for (const x of [-reach, reach]) {
      for (const z of [-reach, reach]) {
        // The board is a slab: its underside edge is visible from this angle.
        corners.push(new THREE.Vector3(x, BOARD_Y - 0.5, z));
        corners.push(new THREE.Vector3(x, BOARD_Y, z));
      }
    }
    for (const x of [-stand, stand]) {
      for (const z of [-stand, stand]) {
        corners.push(new THREE.Vector3(x, BOARD_Y + PIECE_HEIGHT.k, z));
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

  /**
   * How big the squares are drawn, as an index into BOARD_ZOOM_LEVELS.
   *
   * Animated like a flip, because it is the same motion — the camera swinging
   * to a new seat — and jumping there makes the board look like it reloaded.
   */
  setZoom(level) {
    const next = clampBoardZoom(level);
    if (next === this.#zoom) return;
    this.#zoom = next;
    this.#applyCamera(true);
  }

  /** Whether this renderer has a zoom worth offering. It does. */
  canZoom() {
    return true;
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
    this.#boardRoughness?.dispose();
    // The prefiltered environment is a render target, not a plain texture, and
    // holds GPU memory of its own until it is released.
    this.#environmentRT?.dispose();
    this.#environmentRT = null;
    this.#environment = null;

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
    // 48 segments rather than 28, where there is a GPU to draw them. At 28 the silhouette of a queen against a
    // light square was visibly a polygon, and the highlight running round a
    // turned collar broke into facets — which is the detail that says
    // "generated" out loud. A lathe is cheap: the whole set is still a few
    // tens of thousands of triangles, and the board draws on demand rather
    // than every frame, so this costs nothing while nobody is moving.
    const geometry = new THREE.LatheGeometry(points, this.#richDetail ? 48 : 28);
    geometry.computeVertexNormals();
    this.#geometries.set(key, geometry);
    return geometry;
  }

  #pieceMaterial(color) {
    const key = `mat:${color}`;
    if (this.#materials.has(key)) return this.#materials.get(key);
    const spec = PIECE_MATERIALS[color] ?? PIECE_MATERIALS.w;
    /*
       Physical rather than standard, for the clearcoat.

       A finished chess piece has two surfaces, not one: the wood or resin
       underneath, and a thin lacquer over it. They behave differently — the
       coat reflects the room sharply while the body under it stays soft — and
       a single-lobe material has to average the two into something that looks
       like neither. Clearcoat models them separately, and with the environment
       map now giving it something to reflect it is what reads as "polished"
       instead of "shiny".
    */
    /*
       Physical only where it can be afforded. Without a GPU the clearcoat is
       the second most expensive thing on screen after the environment map, and
       with no environment for it to reflect it has much less to show anyway,
       so the two are dropped together rather than half-kept.
    */
    const Material = this.#richDetail
      ? THREE.MeshPhysicalMaterial
      : THREE.MeshStandardMaterial;
    const material = new Material({
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: spec.metalness,
      ...(this.#richDetail ? {
        clearcoat: spec.clearcoat,
        clearcoatRoughness: spec.clearcoatRoughness,
        envMap: this.#environment,
        envMapIntensity: spec.envMapIntensity,
      } : {}),
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
          // A slab with a hairline bevel is still a slab, and that is exactly
          // what this read as: a flat card standing on a pedestal. Most of the
          // thickness is now in the bevel itself, so the sides of the head are
          // a rounded shoulder rather than a cut edge, and four bevel segments
          // give that shoulder enough steps to catch light instead of banding.
          // Two failures to steer between. Too thin and it is a standing card:
          // the camera looks down, a flat extrusion is seen near edge-on, and
          // the silhouette that identifies the piece collapses to a line. Too
          // much bevel and the shoulder eats the muzzle and the ears, which is
          // the same loss by the opposite route. This is a solid head with a
          // carved edge: most of the width in the extrusion, enough bevel to
          // round it, not enough to sand the features off.
          depth: 0.34,
          bevelEnabled: true,
          bevelThickness: 0.07,
          bevelSize: 0.065,
          bevelSegments: 3,
          curveSegments: 6,
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
      // it loses most of its width to foreshortening — and more now than it
      // used to, because the default board size looks down from 70 degrees
      // rather than 56. Roughly 33 degrees of tip is what keeps the muzzle and
      // the ears readable across the whole zoom range, and costs nothing,
      // since a horse carrying its head tipped back is what a horse does.
      head.rotation.x = -0.58;
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
      zoom: this.#zoom,
      /**
       * What the renderer decided about this device, and what it did with it.
       *
       * Exposed because the alternative is judging the finish by eye from a
       * screenshot, and the interesting claims here — the board surface is not
       * a flat fill, the pieces only carry the expensive material where there
       * is a GPU to draw it — are measurable ones.
       */
      detail: {
        rich: this.#richDetail,
        toneMapping: this.#renderer?.toneMapping,
        exposure: this.#renderer?.toneMappingExposure,
        environment: Boolean(this.#environment),
        pieceMaterial: this.#materials.get('mat:w')?.type ?? null,
        boardRoughnessMap: Boolean(this.#boardRoughness),
        anisotropy: this.#boardTexture?.anisotropy ?? 0,
        // The generated chequer canvas, so a test can read the pixels back and
        // check the grain is really there rather than trusting the code path.
        boardCanvas: this.#boardTexture?.image ?? null,
      },
      richDetail: this.#richDetail,
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
