/**
 * board-3d.js
 * A WebGL chessboard, drop-in interchangeable with the DOM one in board.js.
 *
 * It implements exactly the same public contract — constructor(root),
 * onSquareActivate, setOrientation, setAnimationsEnabled, render — plus
 * dispose(), because unlike a DOM board this one owns a GPU context that has
 * to be handed back when the player switches skins. app.js swaps between the
 * two knowing nothing about either's internals.
 *
 * Why WebGL and not CSS 3D: an earlier CSS skin (since removed) put the board
 * in a `preserve-3d` transform, and Chromium's compositor then hit-tested
 * against a stale flattened box — `elementFromPoint` reported the wrong square
 * and the board became unplayable. That is not a bug you can style your way
 * out of, and it is the reason that approach was abandoned rather than fixed.
 * Here, picking is done by raycasting against the real geometry, so what you
 * click is by construction what you see.
 *
 * Pieces are generated, not loaded, and they are clay: each one is a stack of
 * rounded lumps — a foot, a body, a band, whatever it wears on top — lathed
 * from a few numbers apiece and pressed into one mesh. No model files, no
 * asset pipeline, nothing to keep in sync with the repo. The knight is the
 * exception (a horse's head is not a surface of revolution) and is assembled
 * from a handful of primitive solids instead. See pieceRecipe.
 *
 * Performance notes:
 *   - The 64 squares are ONE mesh with a generated tile texture, not 64
 *     meshes, and each piece is one mesh whose colours are baked into its
 *     vertices, all sharing one material. Highlights are pooled overlay
 *     planes. That keeps the whole board to well under a hundred draw calls,
 *     which is what makes it viable on a phone.
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
  CAPTURE_FADE_DELAY,
  CARRY_LIFT,
  CARRY_LIFT_KNIGHT,
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
  squareShade,
  cubicBezierEasing,
  prefersReducedMotion,
} from './board-shared.js';

/** Shared with the DOM board so a move feels the same on either. */
const ease = cubicBezierEasing(ANIMATION_EASING);

/** Board geometry, in world units: one square is 1×1. */
const SQUARE = 1;
const HALF = 4; // half the board, in squares
const BOARD_Y = 0; // top surface of the playing area
const RIM = 0.2; // the tray's lip around the playing area
/** How thick the tray is. The camera fit reserves room for its underside. */
const TRAY_DEPTH = 0.5;

/** How high a piece rides while the pointer is carrying it. */
const DRAG_LIFT = 0.5;

/**
 * How much of the canvas the board is fitted across.
 *
 * Nearly all of it. This was 0.96, a comfortable hair of room all round, and
 * on a phone that hair is 8px a side of board the player does not get — on a
 * canvas that already runs to the edges of the screen, where the board is as
 * wide as it can ever be and every pixel left over is a pixel off a square.
 * What is left is enough to keep the rim's antialiased edge off the last row
 * of pixels and no more. The trays of taken pieces stand in the margin this
 * leaves at the default zoom, so the two numbers move together: see the
 * tray's width in style.css.
 */
const FRAME_FILL = 0.985;

/**
 * Board palettes, the same values the flat board uses in board.css so the two
 * boards look like one product. `rim` is the tray the tiles sit in and has no
 * CSS equivalent, because a flat board draws its frame in CSS instead.
 *
 * These are the colours a player should SEE, not albedos pre-compensated for
 * the lighting. They were darkened once on that reasoning, the exposure was
 * lowered in the same pass, and the two compounded into a board rendering at
 * 39% of its own dark squares. The compensation belongs in the lights and the
 * exposure, which are one place for the whole scene, and those were set by
 * sampling rendered pixels against these values. See the note in #build.
 */
const THEMES = {
  classic: { light: '#f9e4b7', dark: '#b97a4f', rim: '#94603f', inkOnLight: '#b97a4f', inkOnDark: '#f9e4b7' },
  blueberry: { light: '#e9f3ff', dark: '#79a8e8', rim: '#4f7cc2', inkOnLight: '#5f8fd4', inkOnDark: '#e9f3ff' },
  strawberry: { light: '#fff1ea', dark: '#f0919b', rim: '#c9636f', inkOnLight: '#dc7480', inkOnDark: '#fff1ea' },
};

/**
 * Highlight colours, mirrored by the --hl-* tokens in board.css so the two
 * boards say the same thing the same way.
 *
 * Selection is blue and the last move is yellow, where both used to be one
 * gold. Gold was chosen against a dark page and a wood board; on cream tiles
 * it is the colour of the tile. Blue is the one hue neither square of any
 * palette is close to, so the square you are holding reads on both.
 */
const HIGHLIGHT = {
  lastMove: { color: 0xffd338, opacity: 0.5 },
  lastFrom: { color: 0xf59f00, opacity: 0.95 },
  selected: { color: 0x35aaf7, opacity: 0.62 },
  check: { color: 0xff4f4f, opacity: 0.8 },
  focus: { color: 0x7a5cff, opacity: 0.5 },
  // A move dot has to read on both tiles, and no one colour does: brown
  // vanishes into the dark tile and cream into the light one.
  legal: { color: 0x4a2f1b, opacity: 0.34 },
  legalOnDark: { color: 0xfff3d6, opacity: 0.6 },
  capture: { color: 0xff4f4f, opacity: 0.7 },
};

/**
 * Clay pigments.
 *
 * A piece is modelled the way a clay one is made: several lumps pressed
 * together, and the lumps are not all the same colour. `body` is the side's
 * own clay. `accent` is the band that says which side a piece is on even when
 * the body is in shadow — peach for White, green for Black. `trim` is the
 * gold on the pieces that wear something: a ring, a crown, a cross. `alt` is
 * a second neutral, for the knight's head and the bishop's robe, which would
 * otherwise be one flat silhouette in the body colour. `shaft` and `blade`
 * are the pawn's spear, and they swap between the sides: a pale shaft with a
 * darker point for White, a dark shaft with a pale point for Black, so the
 * point shows against whichever tile is behind it.
 *
 * It is ONE material. Clay is clay whatever the pigment, so the colours are
 * baked into the geometry as vertex colours and every piece on the board is
 * a single mesh drawn with a single shared material. Thirty-two draw calls
 * for the whole set, where a piece assembled from separately coloured meshes
 * would be three or four each.
 */
const CLAY = {
  w: {
    body: '#fbf6ee', accent: '#f8b6a0', trim: '#f7b93a', alt: '#c3c7d8',
    shaft: '#a9aec4', blade: '#7f859d',
  },
  b: {
    body: '#65646f', accent: '#7cc474', trim: '#f7b93a', alt: '#83828f',
    shaft: '#4d4c57', blade: '#a9a8b4',
  },
};

/**
 * Matt, but not chalk. At 1.0 a rounded lump has no highlight at all and reads
 * as a flat disc of colour; a little sheen is what shows it is round.
 */
const CLAY_ROUGHNESS = 0.78;

/**
 * Piece heights, in squares — the top of each recipe below. For the pawn that
 * is its head; the point of its spear stands a third of a square higher.
 *
 * Tall: a king is nearly two squares high on a foot less than one across,
 * which is about what a tournament set is. The first clay set was two thirds
 * of this, squat on the reasoning that clay slumps and that a tall back rank
 * hides the pawns in front of it. Both are true and it was still the wrong
 * call — from 56 degrees a squat piece is mostly the top of its own foot, and
 * six kinds of disc are hard to tell apart. Standing up, each piece shows its
 * side, which is where a rook's teeth and a queen's crown actually are.
 *
 * What the height costs is paid for in two places. A back-rank piece now
 * stands in front of the foot of the pawn behind it, so a pointer has to mean
 * the piece it is on rather than the tile under it: see #squareOnRay. And the
 * camera has to leave room above the far rank: see #cameraSeat.
 *
 * The order still runs pawn, rook, knight, bishop, queen, king, which is what
 * makes them tell apart at a glance.
 */
const PIECE_HEIGHT = { p: 1.08, r: 1.27, n: 1.4, b: 1.5, q: 1.69, k: 1.95 };

/**
 * Concatenate several already-positioned geometries into one.
 *
 * three.js ships this as BufferGeometryUtils, which is an addon: this project
 * vendors the core module only, and pulling in a second file to do thirty
 * lines of array copying would be a poor trade. Everything is converted to
 * non-indexed first so the buffers can simply be laid end to end without
 * rewriting index offsets — a few more vertices in exchange for code that has
 * nowhere to go wrong.
 *
 * Colour is carried when every part has one, which is how a piece gets its
 * pigments: see bakePiece.
 */
function mergeGeometries(list) {
  const parts = list.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  const total = parts.reduce((sum, g) => sum + g.attributes.position.count, 0);
  const coloured = parts.every((g) => g.attributes.color);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = coloured ? new Float32Array(total * 3) : null;

  let offset = 0;
  parts.forEach((g, index) => {
    position.set(g.attributes.position.array, offset * 3);
    if (g.attributes.normal) normal.set(g.attributes.normal.array, offset * 3);
    if (color) color.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
    // toNonIndexed made a copy; one that was already non-indexed is the
    // caller's own and is theirs to dispose.
    if (g !== list[index]) g.dispose();
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (color) merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * One lump of clay: a solid of revolution with its edges rolled off.
 *
 * Radius `rb` at the bottom and `rt` at the top, between heights `y0` and
 * `y1`. The rolled edge is the point of it. A cylinder with a hard rim is
 * turned wood or cast plastic; the same cylinder with its corners pressed
 * round is something a thumb made, and every piece here is a stack of these.
 */
function lump(rb, rt, y0, y1, round, segments) {
  const r = Math.min(round, (y1 - y0) / 2, rb, rt);
  const STEPS = 4;
  const points = [new THREE.Vector2(0, y0)];
  for (let i = 0; i <= STEPS; i += 1) {
    const a = (-Math.PI / 2) * (1 - i / STEPS);
    points.push(new THREE.Vector2(rb - r + Math.cos(a) * r, y0 + r + Math.sin(a) * r));
  }
  for (let i = 0; i <= STEPS; i += 1) {
    const a = (Math.PI / 2) * (i / STEPS);
    points.push(new THREE.Vector2(rt - r + Math.cos(a) * r, y1 - r + Math.sin(a) * r));
  }
  points.push(new THREE.Vector2(0, y1));
  return new THREE.LatheGeometry(points, segments);
}

/**
 * A freer shape, turned from a handful of [radius, height] points.
 *
 * The points are joined by a spline rather than straight lines, so a profile
 * of six numbers comes out as a soft bulb instead of a stack of cones — and
 * retuning a piece means moving one of six points, not thirty.
 */
function turned(profile, segments) {
  const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
  const points = curve.getPoints(profile.length * 3);
  // A spline through a point on the axis can swing just past it.
  points.forEach((p) => { p.x = Math.max(0, p.x); });
  return new THREE.LatheGeometry(points, segments);
}

const ball = (radius, y, segments) =>
  new THREE.SphereGeometry(radius, Math.max(10, segments >> 1), Math.max(8, segments >> 2))
    .translate(0, y, 0);

/** A rolled ring, lying flat: the gold band a clay piece wears. */
const ring = (radius, tube, y, segments) =>
  new THREE.TorusGeometry(radius, tube, 8, segments)
    .rotateX(Math.PI / 2)
    .translate(0, y, 0);

/**
 * The knight's head, assembled from solids.
 *
 * Two earlier attempts extruded a horse's silhouette and neither read as a
 * horse on the board, for the same reason: the silhouette lives in a vertical
 * plane, and this camera looks down at it from between 56 and 70 degrees. A
 * vertical plane seen from 56 degrees keeps about half its height on screen;
 * from 70 it keeps a third. The profile is the part you cannot see, which
 * makes it the wrong place to put the identity of the piece.
 *
 * What identifies a knight from above is the plan view: a cranium with two
 * ears behind it and a muzzle projecting forward, clear of the base. So the
 * head is built as those parts — a neck, a cranium, a jaw, a muzzle, two ears
 * — each a primitive, positioned in world units rather than fractions of
 * anything, because a horse's head has proportions and they are not the
 * piece's proportions. The mane is returned separately because it is a
 * different colour of clay.
 *
 * Everything faces -X. Black's knights are mirrored by the group's
 * userData.faces, so the two sides look at each other.
 *
 * Segment counts are deliberately modest. A knight's head is about a fortieth
 * of a phone screen and the merge is non-indexed, so every segment here is
 * paid for in duplicated vertices.
 */
function knightSolids() {
  const place = (geometry, position, rotation, scale) => geometry.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotation ?? [0, 0, 0]))),
      new THREE.Vector3(...(scale ?? [1, 1, 1])),
    ),
  );

  const head = [
    // Rises out of the pedestal and leans forward, as a horse's neck does.
    // Thicker than a horse's: a thin neck is the first thing clay would lose.
    place(new THREE.CylinderGeometry(0.175, 0.24, 0.42, 16, 1), [-0.035, 0.45, 0], [0, 0, 0.22]),
    // The skull, stretched hard along X. A horse's skull is long: at anything
    // near round, it and the muzzle read as a ball with a snout stuck on.
    place(new THREE.SphereGeometry(0.2, 16, 12), [-0.115, 0.745, 0], null, [1.42, 1, 0.95]),
    // The cheek and jaw, slung below and behind. Without it the head is a
    // ball with a snout on it, which is a dog.
    place(new THREE.SphereGeometry(0.5, 12, 8), [-0.13, 0.615, 0], [0, 0, 0.22], [0.4, 0.28, 0.29]),
    // Muzzle, projecting forward and only slightly down. It is what puts the
    // nose out past the edge of the base, and that overhang is the whole of
    // what says "knight" when you are looking straight down at the board.
    place(new THREE.CapsuleGeometry(0.118, 0.17, 4, 12), [-0.335, 0.69, 0], [0, 0, 1.76], [1, 1, 0.95]),
    // Ears, splayed slightly apart and swept back. Fat upright cones make a
    // rabbit; these are short and rounded off.
    place(new THREE.ConeGeometry(0.06, 0.18, 8), [0.03, 0.975, 0.085], [0.2, 0, -0.36]),
    place(new THREE.ConeGeometry(0.06, 0.18, 8), [0.03, 0.975, -0.085], [-0.2, 0, -0.36]),
  ];

  // The mane: three flattened lobes stepping down the back of the neck. One
  // smooth ridge reads as a handle, and the steps are what make it hair.
  const mane = [
    { y: 0.85, x: 0.125, s: [0.15, 0.16, 0.115] },
    { y: 0.675, x: 0.185, s: [0.16, 0.175, 0.122] },
    { y: 0.49, x: 0.205, s: [0.15, 0.17, 0.115] },
  ].map((lobe) => place(new THREE.SphereGeometry(0.5, 10, 7), [lobe.x, lobe.y, 0], [0, 0, -0.2], lobe.s));

  // The head keeps the numbers it was modelled at and is then set on its
  // pedestal whole: a little larger, and a fifth of a square higher. Retyping
  // every position for a taller piece would be thirty chances to bend a head
  // that already reads as a horse.
  [...head, ...mane].forEach((solid) => solid.scale(1.12, 1.12, 1.12).translate(0, 0.21, 0));

  return { head, mane };
}

/**
 * What each piece is made of: a list of [pigment, lump] pairs, in squares.
 *
 * Every piece stands on the same kind of foot — a wide rolled disc, which is
 * what stops a tall clay piece falling over — and then stacks whatever makes
 * it that piece. What tells them apart at a glance is deliberately not
 * subtle: the pawn is a ball on a skirt with a spear stood beside it, the
 * rook has teeth, the bishop a gold ball on a tall egg, the queen a ring of
 * gold points, the king a cross.
 *
 * The heights are a tall set's and the widths are still a squat one's. That
 * is on purpose. Stretching a piece upward while its rings, balls and feet
 * stay the size they were keeps a ball a ball; scaling the whole thing by one
 * number would have made eggs of the heads and hoops of the rings.
 *
 * Returned as fresh geometries for bakePiece to colour, merge and dispose.
 */
function pieceRecipe(type, seg) {
  const around = (count, radius, make) => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return make().translate(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  });

  switch (type) {
    case 'r':
      return [
        ['body', lump(0.4, 0.4, 0, 0.11, 0.05, seg)],
        ['accent', lump(0.315, 0.285, 0.09, 0.46, 0.04, seg)],
        ['body', lump(0.275, 0.268, 0.43, 0.8, 0.03, seg)],
        // A second band under the battlements. One band low down is hidden
        // by whatever stands in front of the rook; this one never is.
        ['accent', lump(0.294, 0.294, 0.765, 0.9, 0.04, seg)],
        // A cup rather than a cap: the wall goes up, over, and back down
        // inside, so from above the top is a ring with a hollow in it.
        ['body', turned([
          [0, 0.87], [0.3, 0.875], [0.354, 0.94], [0.354, 1.06],
          [0.32, 1.1], [0.245, 1.095], [0.215, 1.04], [0, 1.03],
        ], seg)],
        ...around(6, 0.282, () => lump(0.072, 0.072, 1.06, 1.27, 0.03, 12)).map((g) => ['body', g]),
      ];

    case 'n': {
      const { head, mane } = knightSolids();
      return [
        ['body', lump(0.4, 0.4, 0, 0.11, 0.05, seg)],
        ['body', lump(0.3, 0.25, 0.09, 0.53, 0.04, seg)],
        ...head.map((g) => ['alt', g]),
        ...mane.map((g) => ['accent', g]),
      ];
    }

    case 'b':
      return [
        ['body', lump(0.38, 0.38, 0, 0.1, 0.045, seg)],
        ['alt', lump(0.3, 0.185, 0.085, 0.78, 0.04, seg)],
        ['trim', ring(0.205, 0.054, 0.8, seg)],
        // The mitre is a tall egg. Without the height a bishop is a pawn.
        ['body', turned([
          [0, 0.8], [0.185, 0.82], [0.245, 0.98], [0.21, 1.18], [0.105, 1.34], [0, 1.385],
        ], seg)],
        ['trim', ball(0.072, 1.428, seg)],
      ];

    case 'q':
      return [
        ['body', lump(0.41, 0.41, 0, 0.11, 0.05, seg)],
        ['accent', lump(0.335, 0.21, 0.09, 0.86, 0.045, seg)],
        ['trim', ring(0.235, 0.058, 0.88, seg)],
        ['body', turned([
          [0, 0.87], [0.19, 0.89], [0.205, 1.02], [0.26, 1.26], [0.298, 1.4], [0.304, 1.46], [0, 1.49],
        ], seg)],
        ['trim', ring(0.275, 0.047, 1.475, seg)],
        // Points stand on the crown's ring rather than sunk into it, so they
        // read as a coronet instead of lumps.
        ...around(7, 0.275, () => new THREE.ConeGeometry(0.07, 0.2, 10).translate(0, 1.585, 0))
          .map((g) => ['trim', g]),
        ['body', ball(0.165, 1.5, seg)],
        ['trim', ball(0.058, 1.632, seg)],
      ];

    case 'k':
      return [
        ['body', lump(0.425, 0.425, 0, 0.11, 0.05, seg)],
        ['accent', lump(0.347, 0.224, 0.09, 0.94, 0.045, seg)],
        ['trim', ring(0.244, 0.062, 0.96, seg)],
        ['body', turned([
          [0, 0.95], [0.204, 0.97], [0.222, 1.1], [0.27, 1.32],
          [0.305, 1.46], [0.311, 1.535], [0.249, 1.595], [0, 1.61],
        ], seg)],
        ['trim', ring(0.293, 0.045, 1.535, seg)],
        // The cross is rolled, not cut: two short sausages, pressed together.
        // Big for the piece it stands on, because from above it is most of
        // what says which of the two tall pieces this one is.
        ['trim', new THREE.CapsuleGeometry(0.066, 0.25, 4, 12).translate(0, 1.759, 0)],
        ['trim', new THREE.CapsuleGeometry(0.066, 0.2, 4, 12).rotateZ(Math.PI / 2).translate(0, 1.79, 0)],
      ];

    default: {
      // The spear stands on the foot at the pawn's left hand, clear of the
      // skirt. It is the one part of any piece that is off the axis, so a
      // pawn has a left and a right: Black's are turned about to face
      // White's, and the two ranks carry their spears on opposite sides of
      // the board. See #makePiece.
      const reach = -0.29;
      return [
        ['body', lump(0.36, 0.36, 0, 0.1, 0.045, seg)],
        ['body', turned([
          [0, 0.08], [0.262, 0.085], [0.24, 0.2], [0.165, 0.42], [0.128, 0.62], [0, 0.66],
        ], seg)],
        ['body', lump(0.185, 0.185, 0.6, 0.675, 0.032, seg)],
        ['accent', ball(0.192, 0.888, seg)],
        ['shaft', new THREE.CylinderGeometry(0.03, 0.034, 1.02, 10).translate(reach, 0.59, 0)],
        // A leaf, not a needle: a point thin enough to be sharp is thin
        // enough to vanish at the size a pawn is drawn on a phone.
        ['blade', turned([[0, 1.06], [0.092, 1.14], [0.072, 1.22], [0.026, 1.33], [0, 1.39]], 12)
          .translate(reach, 0, 0)],
      ];
    }
  }
}

/**
 * Colour a recipe's lumps and press them into one geometry.
 *
 * Each lump is filled with its pigment as a vertex colour, then all of them
 * are concatenated. A `THREE.Color` built from a CSS string is already in the
 * linear working space, which is what a vertex colour is read as.
 */
function bakePiece(type, side, segments) {
  const pigments = CLAY[side] ?? CLAY.w;
  const lumps = pieceRecipe(type, segments).map(([role, geometry]) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    const pigment = new THREE.Color(pigments[role] ?? pigments.body);
    const count = flat.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = pigment.r;
      colors[i * 3 + 1] = pigment.g;
      colors[i * 3 + 2] = pigment.b;
    }
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return flat;
  });
  const baked = mergeGeometries(lumps);
  lumps.forEach((geometry) => geometry.dispose());
  return baked;
}

/** A square with its corners rounded off, centred on the origin. */
function roundedSquare(size, radius) {
  const h = size / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-h + radius, -h);
  shape.lineTo(h - radius, -h);
  shape.quadraticCurveTo(h, -h, h, -h + radius);
  shape.lineTo(h, h - radius);
  shape.quadraticCurveTo(h, h, h - radius, h);
  shape.lineTo(-h + radius, h);
  shape.quadraticCurveTo(-h, h, -h, h - radius);
  shape.lineTo(-h, -h + radius);
  shape.quadraticCurveTo(-h, -h, -h + radius, -h);
  return shape;
}

/** A CSS colour, lightened or darkened by a fraction of full lightness. */
function shade(css, amount) {
  return `#${new THREE.Color(css).offsetHSL(0, 0, amount).getHexString()}`;
}

export class Board3D {
  #root;
  #onSquareActivate = () => {};
  #orientation = 'white';
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

  /** Piece portraits, drawn once each and kept. See pieceSprite(). */
  #spriteCache = new Map();
  #richDetail = true;
  #pieceGroup = null;
  #markerGroup = null;
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();
  /**
   * The level sheet the pointer is followed on while it carries a piece. Its
   * height is set per drag, to the part of the piece in hand: #carriedFoot.
   */
  #dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(BOARD_Y + DRAG_LIFT));

  // Reusable resources, disposed together in dispose().
  #geometries = new Map();
  #materials = new Map();
  #markerPool = [];
  #pieces = new Map(); // square -> Object3D

  // Animation bookkeeping
  #animations = [];
  /**
   * The carry currently running on each square, by destination.
   *
   * Without this an animation could only ever be started, never found again:
   * a second move onto a square that is still receiving one would leave two
   * updates writing to the same piece on the same frame, and `#syncPieces`
   * had no way to tell a piece standing still from one halfway through the
   * air. Both are settled by looking the square up here.
   */
  #moving = new Map(); // square -> animation record
  #cameraSpin = null;
  #needsRender = true;
  #frame = null;
  /**
   * Frames still to be drawn for no reason but to have drawn them.
   *
   * The board draws on demand, so before the first move it has drawn a
   * handful of frames and the code that draws one has never run hot. The
   * first move of every game was then the renderer's warm-up: measured on a
   * slowed-down processor, seven of its first eight frames ran long and the
   * piece covered a fifth of its journey in one step. Half a second of
   * frames nobody is watching for, straight after the board appears, moves
   * that cost to where it does not show.
   */
  #warmFrames = 30;
  #resizeObserver = null;

  // Interaction
  #drag = null;
  /**
   * What a press can do in the position on the board: whose move it is, which
   * of their pieces have one, and where the selected piece may go. Kept from
   * the last render because a pointer needs them and arrives with nothing —
   * see #squareOnRay.
   */
  #turn = WHITE;
  #movable = new Set();
  #targets = new Set();

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
  /** Where the pointer released a piece, so it can be seated from there. */
  #dropPoint = null;
  #zoom = DEFAULT_BOARD_ZOOM;

  constructor(rootElement) {
    if (!rootElement) throw new Error('Board root element is required');
    this.#root = rootElement;
    this.#build();
    this.#attachListeners();
    this.#loop();
    this.#warmPortraits();
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
       Neutral tone mapping, not filmic.

       Some curve is needed: without one, everything above 1.0 clips to flat
       white, and the lit side of a white piece arrives as a bald patch with
       no shape in it. ACES was the curve here while the set was lacquered
       wood, and it suited that — but it buys its highlight roll-off by
       desaturating and darkening everything under it. On this palette that
       turned peach to beige and the green to khaki, which is the one thing a
       clay set cannot afford: its colours ARE the look. The neutral curve
       leaves a colour alone until it is nearly white and only then rolls it
       off, so the pigments arrive as the pigments.

       The exposure and the light intensities in #buildLights were set by
       sampling the rendered pixels against the CSS colours the flat board uses
       for the same theme, until a lit tile matched — not by darkening the
       palette to compensate, which was tried once and compounded.
    */
    this.#renderer.toneMapping = THREE.NeutralToneMapping;
    this.#renderer.toneMappingExposure = 1.0;
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.#richDetail = this.#hasHardwareGpu();

    this.#scene = new THREE.Scene();
    /*
       A long lens: 12 degrees, from forty-four squares away.

       It was 38 degrees from about fifteen, and that was the right lens for a
       squat set. A short lens close to the board sees each rank from a
       different angle — at the old distance the near rank from 68 degrees
       and the far one from 46 — and a piece seen from 68 degrees shows a
       third of its height. With pieces no taller than a tile that hardly
       mattered. With tall ones it meant Black's stood up and White's, the
       ones the player is actually holding, were lids seen from above.

       From this far back the two ranks are within eight degrees of each
       other, so a piece looks the same wherever it stands, and the board is
       drawn nearly square-on: a far square is nine tenths the width of a
       near one, where it was three quarters. The distance is not chosen
       here — #cameraSeat solves it for whatever the lens is.

       The near plane moves out with the camera. Depth precision is spent
       between the two planes in proportion to how close the near one is, and
       a tile sits a thousandth of a square above the tray it is laid on.
    */
    this.#camera = new THREE.PerspectiveCamera(12, 1, 4, 200);

    this.#buildLights();
    this.#buildBoard();
    // The coordinates are drawn in the page's own typeface, which can still
    // be on its way when the first texture is painted. Paint them again once
    // it has landed, or the board keeps the fallback's letters for the game.
    document.fonts?.load?.('700 32px Fredoka')
      .then(() => { if (!this.#disposed) this.#refreshBoardTexture(); })
      .catch(() => { /* the fallback letters are already on the board */ });

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
   * a triangle is nearly free on any GPU made this decade, and a great many
   * CPU instructions without one.
   *
   * Chrome falls back to SwiftShader when it blocklists a driver, so this is a
   * real population, not a hypothetical one. They get the same pieces turned
   * from fewer segments; everyone else gets the round ones.
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
   * Lit like a tabletop in daylight: one soft key, and a great deal of fill.
   *
   * That ratio is the clay look as much as the material is. A hard key over a
   * dark fill is how you light lacquer — it wants a deep shadow for the
   * highlight to stand against. Clay is matt and pale, and the same lighting
   * makes it look like stone. So the sky does most of the work here, the key
   * only models the roundness, and a shadow is a soft tint on the tile rather
   * than a hole in it.
   *
   * The ground colour of the hemisphere is the board's own cream. Light that
   * reaches the underside of a piece has bounced off a tile to get there, and
   * giving it that colour is what keeps the shaded side of a white piece warm
   * instead of grey.
   */
  #buildLights() {
    this.#scene.add(new THREE.HemisphereLight(0xffffff, 0xf3e8d2, 1.6));

    // High, because the pieces are tall. A shadow is as long as the piece is
    // high times how far the light leans, and from the 55 degrees this stood
    // at a king laid a shadow a square and a third long across its
    // neighbours. From 63 it is under a square. The intensity came down with
    // the move, by the ratio of the two cosines, so a tile is lit exactly as
    // it was — see the note on exposure in #build.
    const key = new THREE.DirectionalLight(0xfffbf4, 1.92);
    key.position.set(-3.6, 10, 3.6);
    key.castShadow = true;
    // Stays at 1024, and that is a measured decision rather than a default
    // left alone. 2048 looked marginally cleaner under a piece and cost four
    // times the shadow pass, because the shadow map is re-rendered every time
    // anything on the board moves. The tight frustum below is what keeps 1024
    // sharp enough: it spends every texel on the board rather than on the
    // empty space the default frustum covers.
    key.shadow.mapSize.set(1024, 1024);
    // Wide enough for the top of a king on a corner square: the light leans,
    // so a tall piece at the edge reaches further across its view than the
    // board does.
    const s = HALF + RIM + 1.1;
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
    const fill = new THREE.DirectionalLight(0xe8f0ff, 0.45);
    fill.position.set(5, 4, -6);
    this.#scene.add(fill);
  }

  #buildBoard() {
    const theme = THEMES[this.#theme] ?? THEMES.classic;

    // The tray: a thick slab a little larger than the playing area, with its
    // corners and its edges rolled off. The rolled edge is what catches the
    // light along the front of the board, and it is the difference between a
    // slab of clay and a box.
    const bevel = 0.06;
    const side = 2 * HALF + 2 * RIM;
    const trayGeo = new THREE.ExtrudeGeometry(roundedSquare(side - 2 * bevel, 0.42), {
      depth: TRAY_DEPTH - 2 * bevel,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 4,
      curveSegments: 10,
    });
    // Extruded along +Z: laid flat, then dropped so its top face is the board.
    trayGeo.rotateX(-Math.PI / 2);
    trayGeo.translate(0, BOARD_Y - (TRAY_DEPTH - bevel), 0);
    // No environment and nothing physical: it is a large area of screen, and
    // matt clay has nothing to reflect.
    const trayMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.rim),
      roughness: 0.86,
      metalness: 0.0,
    });
    const tray = new THREE.Mesh(trayGeo, trayMat);
    tray.receiveShadow = true;
    this.#scene.add(tray);
    this.#geometries.set('rim', trayGeo);
    this.#materials.set('rim', trayMat);

    // The 64 squares as a single textured plane. See the header note.
    const boardGeo = new THREE.PlaneGeometry(2 * HALF, 2 * HALF);
    this.#boardTexture = this.#makeCheckerTexture();
    const boardMat = new THREE.MeshStandardMaterial({
      map: this.#boardTexture,
      roughness: 0.86,
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
   * Draw the tiles — and the coordinates — into one canvas texture.
   *
   * Each square is painted as a tile pressed into the tray: a face with
   * rounded corners, and around it the rolled edge where the tile turns down
   * into the gap. That edge is lit from one side and shaded on the other, and
   * which side is fixed in the texture rather than worked out per view — the
   * key light does not move when the camera does, so neither does the side of
   * a tile it falls on. It is what makes sixty-four flat quads read as
   * sixty-four separate tiles, at a thousandth of the cost of modelling them.
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

    const roundedTile = (x, y, size, radius) => {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + size, y, x + size, y + size, radius);
      ctx.arcTo(x + size, y + size, x, y + size, radius);
      ctx.arcTo(x, y + size, x, y, radius);
      ctx.arcTo(x, y, x + size, y, radius);
      ctx.closePath();
    };

    const edge = cell * 0.03;
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        // Texture row 0 is the far side of the board (rank 8 for White), and
        // column 0 is the a-file — so the first tile painted is a8, which is
        // a light square. This test was the other way round for as long as
        // this board existed: a1 came out light and the white queen stood on
        // a dark square. Nothing measured it, because every test asked which
        // square a click landed on and none asked what colour it was.
        const isLight = (row + col) % 2 === 0;
        const base = isLight ? theme.light : theme.dark;
        const x = col * cell;
        const y = row * cell;

        // The rolled edge, shaded: what shows at the far and right-hand
        // sides, which face away from the key light.
        ctx.fillStyle = shade(base, isLight ? -0.1 : -0.075);
        ctx.fillRect(x, y, cell, cell);

        // The same edge, lit: the left and near sides, which face it. Drawn
        // as the tile's own shape nudged toward the light, so the two meet in
        // the corners the way a real rolled edge does.
        ctx.fillStyle = shade(base, isLight ? 0.045 : 0.085);
        roundedTile(x + edge * 0.35, y + edge * 1.65, cell - edge * 2, cell * 0.12);
        ctx.fill();

        // The face.
        ctx.fillStyle = base;
        roundedTile(x + edge, y + edge, cell - edge * 2, cell * 0.12);
        ctx.fill();
      }
    }

    // The coordinates, always. There was a switch for them once; it was only
    // ever left on, so it was taken out.
    const flip = this.#orientation === 'black';
    ctx.font = `700 ${Math.round(cell * 0.21)}px Fredoka, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const isLight = (row + col) % 2 === 0;
        ctx.fillStyle = isLight ? theme.inkOnLight : theme.inkOnDark;
        ctx.globalAlpha = 0.9;

        // Ranks down the left edge, files along the bottom, of the CURRENT
        // view — which is the opposite edge of the texture when flipped.
        const rankEdge = flip ? col === 7 : col === 0;
        const fileEdge = flip ? row === 0 : row === 7;
        if (!rankEdge && !fileEdge) continue;

        /*
           Which edge moves with the view. What the label SAYS does not.

           Flipping swings the camera round to the other side; no square
           goes anywhere, so the tile in texture row 0 is rank 8 whoever is
           looking at it. This used to renumber as well as move — the rank
           nearest a player sitting as Black was labelled 1, on the row
           their own king started on — and drew the glyphs the texture's
           way up, which from that side is upside down. So the label is the
           square's true name, and the cell is turned half a circle before
           it is written so that it faces whoever is reading it.
        */
        ctx.save();
        ctx.translate(col * cell + cell / 2, row * cell + cell / 2);
        if (flip) ctx.rotate(Math.PI);
        if (rankEdge) {
          ctx.textAlign = 'left';
          ctx.fillText(String(8 - row), -cell * 0.4, -cell * 0.41);
        }
        if (fileEdge) {
          ctx.textAlign = 'right';
          ctx.fillText(FILES[col], cell * 0.4, cell * 0.18);
        }
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    /*
       Linear, not nearest.

       Nearest was the right call when a square was one flat colour: it kept
       the boundary between two fields perfectly crisp. Now that each tile
       carries a drawn edge, nearest samples that fine detail into hard
       stair-steps. Anisotropy is what keeps the far rank legible at this
       camera angle — without it the edges and the coordinates smear into mush
       a couple of ranks out.
    */
    texture.magFilter = THREE.LinearFilter;
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
    // Elevation is the zoom. Foreshortening means the board projects to
    // roughly sin(elevation) as tall as it is wide, so a low angle leaves a
    // quarter of a square frame empty and a high one spends that space on the
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
        corners.push(new THREE.Vector3(x, BOARD_Y - TRAY_DEPTH, z));
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

      const correction = extent / FRAME_FILL;
      if (Math.abs(correction - 1) < 0.005) break;
      distance *= correction;
    }

    return direction.multiplyScalar(distance);
  }

  /**
   * Tell the page where the front of the board is drawn, for the shadow
   * under it.
   *
   * The shadow the board lays on the lawn is the page's, not the scene's: a
   * soft bar under the slab's front edge, drawn once by CSS on a layer
   * behind the canvas (see ::after in board-3d.css). It has been both of the
   * other things. A drop-shadow filter on the canvas followed the board's
   * outline for one line of CSS, and a browser runs a filter again every
   * time the canvas changes — every frame of a move, which on Safari means
   * taking the frame back off the GPU to blur it. A sheet in the scene cost
   * nothing and was cut off square at the edge of the canvas, which the
   * board very nearly fills.
   *
   * A layer of its own is neither. It is painted once and then only
   * composited, and it may spill past the canvas. All it needs is to be told
   * where the slab's front corners land, which changes when the camera is
   * seated and never during a move — so that is when this runs, with the
   * seat the camera is going to rather than where it is on the way.
   */
  #placeGroundShadow(seat) {
    const probe = this.#camera.clone();
    probe.position.copy(seat);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld(true);
    probe.updateProjectionMatrix();

    // The two bottom corners of the slab on the side nearest the camera, a
    // little in from the ends: the tray's corners are rounded.
    const near = (Math.sign(seat.z) || 1) * (HALF + RIM);
    const reach = HALF + RIM - 0.25;
    const corners = [-reach, reach]
      .map((x) => new THREE.Vector3(x, BOARD_Y - TRAY_DEPTH, near).project(probe));
    const xs = corners.map((corner) => (corner.x + 1) / 2);
    const percent = (fraction) => `${(fraction * 100).toFixed(2)}%`;

    const { style } = this.#root;
    style.setProperty('--shadow-left', percent(Math.min(...xs)));
    style.setProperty('--shadow-right', percent(1 - Math.max(...xs)));
    style.setProperty('--shadow-bottom', percent((corners[0].y + 1) / 2));
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
    this.#placeGroundShadow(target);

    if (!animate || !this.#animationsEnabled || prefersReducedMotion()) {
      this.#camera.position.copy(target);
      this.#camera.lookAt(0, 0, 0);
      this.#needsRender = true;
      return;
    }

    this.#cameraSpin = {
      from: this.#camera.position.clone(),
      to: target,
      // Set by the first frame that draws it. See the note on time in #loop.
      start: null,
      // Longer than a move once was: the whole view is turning, and at move
      // speed it read as a glitch rather than a deliberate change of seat.
      //
      // A number of its own rather than a multiple of ANIMATION_MS. It was
      // 2.4x a 180ms move, then 1.65x a 260ms one — retuned each time the
      // move changed, only to land on the same 430ms it always took. A flip
      // has no reason to follow the move, so it no longer pretends to.
      duration: 430,
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

  // -----------------------------------------------------------------------
  // Piece portraits
  // -----------------------------------------------------------------------

  /**
   * A small picture of one piece, drawn with the board's own parts.
   *
   * For the captured piles beside the board, which were Unicode glyphs and so
   * were the one place in the app still showing a flat chess set next to a
   * solid one. This builds the real piece — the same baked lumps, the same
   * clay and the same soft key light — and reads it back as an image, so a
   * captured knight is the knight that was on the board rather than a
   * different artist's idea of one.
   *
   * Rendered once per piece and cached. Twelve portraits for a whole game.
   *
   * Drawn through a render target rather than the visible canvas, so the live
   * frame is never disturbed and no second WebGL context is created — browsers
   * cap those per page, and this board already has to be careful about it.
   *
   * @returns {string|null} a PNG data URL, or null if it could not be drawn.
   */
  pieceSprite(type, color, size = 96) {
    if (this.#disposed || !this.#renderer || !THREE) return null;
    const key = `${color}${type}@${size}`;
    if (this.#spriteCache.has(key)) return this.#spriteCache.get(key);

    let target = null;
    let group = null;
    try {
      const scene = new THREE.Scene();
      // The board's own lighting, near enough: a bright sky and a soft key
      // from the same side. See #buildLights for why the fill is so high.
      scene.add(new THREE.HemisphereLight(0xffffff, 0xf3e8d2, 1.6));
      const keyLight = new THREE.DirectionalLight(0xfffbf4, 2.1);
      keyLight.position.set(-1.4, 2.4, 2.2);
      scene.add(keyLight);
      const fill = new THREE.DirectionalLight(0xe8f0ff, 0.45);
      fill.position.set(2.2, 1.2, 1.6);
      scene.add(fill);

      /*
        A rim light, and specifically for the black pieces.

        On the board a black piece is legible because it stands on a pale
        tile: the contrast comes from behind it. In a tray there is no tile,
        and the tray is a dark groove, so a charcoal piece in it is close to a
        piece-shaped hole. Lighting it from behind and above draws a bright
        edge around the silhouette, which is how the shape survives at this
        size — the same reason a cinematographer puts a light behind a dark
        subject.

        Stronger for black than white, because white already separates from
        the tray and too much rim on it only blows the highlight out.
      */
      const rim = new THREE.DirectionalLight(0xffffff, color === 'b' ? 2.4 : 0.6);
      rim.position.set(0.6, 2.0, -2.4);
      scene.add(rim);

      group = this.#makePiece({ type, color });
      // Shadows need a floor to land on, and there is none here.
      group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      scene.add(group);

      // Centre the piece on the origin so the camera can simply look at it.
      const box = new THREE.Box3().setFromObject(group);
      const centre = box.getCenter(new THREE.Vector3());
      group.position.sub(centre);

      const fov = 28;
      const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
      // A hair above eye level: enough to see the piece is a solid of
      // revolution rather than a silhouette, not so much that it foreshortens
      // into a lid seen from above.
      //
      /*
        ONE frame for the whole set, sized to the tallest piece — not to each
        piece's own box.

        Framing every piece to fill its own square is the obvious thing and it
        destroys the set: a pawn is barely half a king's height, so filling the
        frame with it renders a pawn the same size as a king, and the pile
        stops reading as chess pieces at all. Sizing to the king once means a
        pawn occupies the fraction of the frame it actually occupies on the
        board.

        A close frame: the king's height and an eighth over. It was two
        thirds over while the set was squat, because a squat king is nearly as
        wide as it is tall and needed the room at the sides. A tall one does
        not, and in a frame that loose it is a sliver in the middle of an
        empty tile. The knight is the broad one, at about one square from
        muzzle to mane, and that is still under half of this.
      */
      const radius = PIECE_HEIGHT.k / 2;
      const distance = (radius / Math.tan(THREE.MathUtils.degToRad(fov) / 2)) * 1.12;
      camera.position.copy(new THREE.Vector3(0, 0.2, 1).normalize().multiplyScalar(distance));
      camera.lookAt(0, 0, 0);

      target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
      target.texture.colorSpace = THREE.SRGBColorSpace;

      const previousTarget = this.#renderer.getRenderTarget();
      this.#renderer.setRenderTarget(target);
      this.#renderer.setClearColor(0x000000, 0);
      this.#renderer.clear();
      this.#renderer.render(scene, camera);

      const pixels = new Uint8Array(size * size * 4);
      this.#renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      this.#renderer.setRenderTarget(previousTarget);

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(size, size);
      // WebGL reads bottom-up; a canvas is top-down. Copy row by row in
      // reverse rather than flipping with a transform, which would resample.
      for (let row = 0; row < size; row += 1) {
        const from = (size - 1 - row) * size * 4;
        image.data.set(pixels.subarray(from, from + size * 4), row * size * 4);
      }
      ctx.putImageData(image, 0, 0);
      const url = canvas.toDataURL('image/png');

      this.#spriteCache.set(key, url);
      return url;
    } catch (error) {
      warn('Could not draw a piece portrait', error);
      this.#spriteCache.set(key, null);
      return null;
    } finally {
      // The geometries and materials are the board's and are shared — only the
      // render target belongs to this call.
      target?.dispose();
      if (group) group.parent?.remove(group);
    }
  }

  /**
   * Draw the portraits before anyone needs one.
   *
   * A portrait is drawn the first time its piece is captured, and drawing
   * one is not quick: a shader program the board has not used before, a
   * frame read back off the GPU, a PNG encoded. That all happened inside
   * the move that made the capture — 118ms of it on a slowed-down
   * processor, at the very start of the animation, which is a capture that
   * visibly sticks before it goes.
   *
   * So they are drawn ahead, one at a time with a pause between, and never
   * while something on the board is moving. Pawns first: a pawn is usually
   * the first thing taken. No kings, which never are.
   */
  #warmPortraits() {
    const queue = ['p', 'n', 'b', 'r', 'q'].flatMap((type) => [[type, 'w'], [type, 'b']]);
    const next = () => {
      if (this.#disposed || !queue.length) return;
      const busy = this.#animations.length > 0 || this.#cameraSpin || this.#drag || this.#warmFrames > 0;
      if (!busy) this.pieceSprite(...queue.shift());
      setTimeout(next, busy ? 250 : 80);
    };
    setTimeout(next, 600);
  }

  render(snapshot, options = {}) {
    const { state, view } = snapshot;
    if (!state || this.#disposed) return;

    if (snapshot.settings?.boardTheme && snapshot.settings.boardTheme !== this.#theme) {
      this.#theme = snapshot.settings.boardTheme;
      this.#refreshBoardTexture();
    }

    // Only the game's own Animations setting turns this off, not the device's
    // reduced-motion preference — see prefersReducedMotion() for why.
    const move = options.animateMove && this.#animationsEnabled ? options.animateMove : null;

    const board = boardFromFen(state.fen);

    // Take the captured piece out of the scene before the position is applied,
    // exactly as the DOM board lifts the captured glyph before repainting.
    if (move?.isCapture) this.#detachCaptured(move);

    this.#syncPieces(board, move);
    this.#syncMarkers(state, view);
    this.#syncA11y(board, view, state);
    this.#turn = state.turn;
    this.#movable = new Set(snapshot.movable ?? []);
    this.#targets = new Set((view?.legalTargets ?? []).map((target) => target.to));

    if (move) this.#animateMove(move);

    this.#draggedMove = null;
    this.#dropPoint = null;
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
    this.#animations = [];
    this.#moving.clear();

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
    ['--shadow-left', '--shadow-right', '--shadow-bottom']
      .forEach((name) => this.#root.style.removeProperty(name));
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
   * Build (and cache) one piece, already in its colours.
   *
   * Cached by side as well as by type. The pigments are baked into the
   * geometry, so a white rook and a black one are two buffers of the same
   * shape rather than one shape drawn with two materials — twelve geometries
   * for a whole set, built on first use.
   */
  #pieceGeometry(type, color) {
    const key = `piece:${color}${type}`;
    if (this.#geometries.has(key)) return this.#geometries.get(key);

    // 32 segments where there is a GPU to draw them, 20 without. Below that
    // the foot of a king is visibly a polygon against a pale tile, which is
    // the detail that says "generated" out loud. The whole set is on the
    // order of a hundred thousand triangles, and the board draws on demand
    // rather than every frame, so this costs nothing while nobody is moving.
    const geometry = bakePiece(type, color, this.#richDetail ? 32 : 20);
    this.#geometries.set(key, geometry);
    return geometry;
  }

  /** The one clay every piece is made of. The colour is in the geometry: see CLAY. */
  #pieceMaterial() {
    const key = 'mat:clay';
    if (this.#materials.has(key)) return this.#materials.get(key);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: CLAY_ROUGHNESS,
      metalness: 0.0,
    });
    this.#materials.set(key, material);
    return material;
  }

  /**
   * Assemble one piece.
   *
   * One mesh in a Group. The group is what everything else moves, mirrors and
   * measures, and it is kept even though it now holds a single child: a piece
   * was several meshes once and the rest of this file addresses it by its
   * wrapper, which is the part that did not have to change.
   */
  #makePiece(piece) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      this.#pieceGeometry(piece.type, piece.color),
      this.#pieceMaterial(),
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Black's pieces are turned about, so the two sides face each other. It
    // shows on the two that have a front: a knight looks at the knight
    // opposite, and a pawn's spear is in the same hand whichever side it is on.
    group.userData.faces = piece.color === WHITE ? 1 : -1;

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
      // A piece that is about to be animated is placed by the animation —
      // and so is one already in the air from an earlier move, which is what
      // #moving is consulted for. Without that second test this method's own
      // promise ("a piece that did not change is left exactly as it is") was
      // untrue: every unrelated re-render, including the opponent's reply
      // arriving mid-flight, wrote your piece back down onto the board. The
      // draw only ever came out right because the loop happens to update the
      // animations again before it renders.
      const animating = (move && move.to === square) || this.#moving.has(square);
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

  /**
   * Highlight shapes, cached and shared.
   *
   * `square` fills the cell; `ring` is the empty circle that marks the square
   * a piece came from; `disc` is the dot on a square a piece may move to and
   * `halo` the wide ring round one it may capture on. They are separate
   * geometries rather than one quad with a texture because a ring drawn in a
   * texture would need a transparent bitmap per theme and would soften as the
   * camera came down; real geometry stays a crisp circle at every zoom level.
   */
  #markerGeometry(shape) {
    const key = `geo:marker:${shape}`;
    if (!this.#geometries.has(key)) {
      if (shape === 'ring') {
        // Radii chosen to match the flat board's ring, which is drawn as a
        // gradient stop at 27–33% of the square.
        this.#geometries.set(key, new THREE.RingGeometry(SQUARE * 0.27, SQUARE * 0.33, 40));
      } else if (shape === 'disc') {
        this.#geometries.set(key, new THREE.CircleGeometry(SQUARE * 0.5, 36));
      } else if (shape === 'halo') {
        this.#geometries.set(key, new THREE.RingGeometry(SQUARE * 0.34, SQUARE * 0.5, 44));
      } else {
        this.#geometries.set(key, new THREE.PlaneGeometry(SQUARE, SQUARE));
      }
    }
    return this.#geometries.get(key);
  }

  /** A flat, board-hugging mesh used for every highlight. */
  #makeMarkerMesh() {
    const mesh = new THREE.Mesh(
      this.#markerGeometry('square'),
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

    // Markers come out of one pool, so the shape is set on the way out rather
    // than being a property of the mesh: a quad recycled as a ring is the same
    // object with a different geometry.
    const place = (square, spec, lift, shape = 'square') => {
      const marker = this.#takeMarker();
      const world = this.#squareToWorld(square);
      marker.position.set(world.x, BOARD_Y + lift, world.z);
      marker.geometry = this.#markerGeometry(shape);
      marker.material.color.setHex(spec.color);
      marker.material.opacity = spec.opacity;
      marker.scale.setScalar(1);
      return marker;
    };

    const lastMove = state.lastMove;
    if (lastMove) {
      place(lastMove.from, HIGHLIGHT.lastMove, 0.004);
      place(lastMove.to, HIGHLIGHT.lastMove, 0.004);
      // The ring on top of the from-square's tint, lifted clear of it. Tinting
      // both ends says a move happened; only the ring says which way it went.
      place(lastMove.from, HIGHLIGHT.lastFrom, 0.005, 'ring');
    }
    if (state.checkSquare) place(state.checkSquare, HIGHLIGHT.check, 0.006);
    if (view?.selected) place(view.selected, HIGHLIGHT.selected, 0.008);

    // Legal destinations: a small disc, a wide ring for a capture — the same
    // vocabulary the flat board uses, so the two read identically.
    (view?.legalTargets ?? []).forEach((target) => {
      const onDark = squareShade(target.to) === 'dark';
      const marker = place(
        target.to,
        target.isCapture
          ? HIGHLIGHT.capture
          : (onDark ? HIGHLIGHT.legalOnDark : HIGHLIGHT.legal),
        0.01,
        target.isCapture ? 'halo' : 'disc',
      );
      marker.scale.setScalar(target.isCapture ? 0.92 : 0.34);
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

    if (!this.#animationsEnabled) {
      this.#releasePiece(group);
      return;
    }

    // Held until the piece taking it is nearly there, then displaced — the
    // two motions end on the same frame. See CAPTURE_FADE_DELAY. Counted
    // from the same first frame as the piece taking it, which is what keeps
    // that true: see the note on time in #loop.
    let start = null;
    const duration = ANIMATION_MS * CAPTURE_FADE_RATIO;
    const from = group.position.clone();
    this.#animations.push({
      update: (now) => {
        start ??= now + CAPTURE_FADE_DELAY;
        if (now < start) return false;
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
   * Put a piece down on the square it belongs to, from wherever it is now.
   *
   * Used when a drag ends without a move — released off the board, or onto a
   * square the piece cannot legally reach. Nothing re-renders in that case,
   * so this is the only thing that returns it, and it used to do so by
   * assignment: the piece vanished from under the pointer and reappeared on
   * its square in the same frame. A refusal is worth animating precisely
   * because it is a refusal — the piece is seen to go back.
   */
  #settlePiece(square, origin = null) {
    const group = this.#pieces.get(square);
    if (!group) return;
    const home = this.#squareToWorld(square);

    if (!this.#animationsEnabled) {
      group.position.copy(home);
      this.#needsRender = true;
      return;
    }

    // Where the piece is NOW is not good enough. Releasing over a square the
    // piece cannot reach still counts as touching that square, so the app
    // re-renders to clear the selection — and that render puts the piece back
    // on its home square before this ever runs. The caller therefore reads
    // the held position before it activates anything, and hands it in here.
    const from = origin ?? group.position.clone();
    // Apply the first frame now rather than leaving it to the loop. Between
    // creating an animation and its first tick there is one frame in which
    // the piece is wherever the last render left it — on its home square —
    // and a settle that starts by flashing the piece to its destination is
    // not a settle.
    group.position.copy(from);
    this.#needsRender = true;

    let start = null;
    this.#startCarry(square, {
      update: (now) => {
        start ??= now;
        const t = Math.min(1, (now - start) / ANIMATION_MS);
        const k = ease(t);
        group.position.lerpVectors(from, home, k);
        return t >= 1;
      },
      done: () => group.position.copy(home),
    });
  }

  /**
   * Register a carry as THE carry for its destination square.
   *
   * A square can only be receiving one piece at a time, so a second carry
   * onto one that is still animating replaces the first rather than joining
   * it — two updates writing to the same piece on the same frame is a fight
   * whose winner is decided by array order, which is no way to decide it.
   * Cancelling means the earlier flight's `done` never runs, so it cannot
   * snap the piece back to a destination that is no longer where it is going.
   */
  #startCarry(square, animation) {
    this.#moving.get(square)?.cancel();
    let cancelled = false;
    const record = {
      cancel: () => { cancelled = true; },
      update: (now) => cancelled || animation.update(now),
      done: () => {
        if (this.#moving.get(square) === record) this.#moving.delete(square);
        if (!cancelled) animation.done?.();
      },
    };
    this.#moving.set(square, record);
    this.#animations.push(record);
  }

  /**
   * Move a piece through the air from its origin to where it now stands.
   *
   * The flat board slides; here the piece is picked up, carried and set down,
   * which is what the extra dimension is actually for. The knight arcs higher
   * than everything else because it is the one piece that jumps.
   *
   * `origin` overrides where the flight starts, for the one case where the
   * square is the wrong answer: a piece the player dropped somewhere between
   * two squares has to be seated from where their hand left it.
   */
  #animateMove(move) {
    const carry = (fromSquare, toSquare, lift, origin = null) => {
      const group = this.#pieces.get(toSquare);
      if (!group) return;

      const from = origin ?? this.#squareToWorld(fromSquare);
      const to = this.#squareToWorld(toSquare);
      // The piece starts at the origin, from this frame — see #settlePiece.
      // #syncPieces has just placed it on the destination square, and it must
      // not be drawn there even once before it sets off.
      group.position.copy(from);

      let start = null;

      this.#startCarry(toSquare, {
        update: (now) => {
          start ??= now;
          const t = Math.min(1, (now - start) / ANIMATION_MS);
          const k = ease(t);
          group.position.x = from.x + (to.x - from.x) * k;
          group.position.z = from.z + (to.z - from.z) * k;
          // A half-sine arc over the TRAVEL, so the top of it is above the
          // middle of the move — not above wherever the piece happens to be
          // when half the time has gone.
          //
          // Both were tried. Driving the arc from the clock instead puts its
          // apex at the midpoint of the flight, which sounds right and is
          // not: the travel curve has spent 81% of the distance by then, so
          // the whole descent gets squeezed into the last fifth of the path
          // and the piece drops onto its square rather than being set on it.
          // Measured off a live trace, six of seventeen frames were spent
          // falling almost vertically over e4.
          //
          // Driving it from `k` cannot do that, because the arc is then a
          // function of position: half the height at a quarter of the way and
          // at three quarters, apex over the middle, whatever the timing. All
          // the easing decides is when the piece reaches that midpoint, and
          // ANIMATION_EASING is picked partly for that — see its note.
          //
          // The height is two terms, and the first is zero for every ordinary
          // move: a flight that begins on a square begins at board height. It
          // is not zero for a piece released from the pointer above the
          // board, which has to come down as it goes across rather than drop
          // first and slide after.
          group.position.y = BOARD_Y
            + (from.y - BOARD_Y) * (1 - k)
            + Math.sin(k * Math.PI) * lift;
          return t >= 1;
        },
        done: () => {
          group.position.set(to.x, BOARD_Y, to.z);
        },
      });
    };

    // A piece the player dragged here is already where they put it; carrying
    // it back to the origin to re-travel undoes their own gesture. But it was
    // dropped wherever their pointer happened to be, which is only rarely the
    // middle of a square, so it still has to be seated — a short settle from
    // the hand to the centre, rather than the teleport this used to be.
    if (this.#draggedMove === `${move.from}|${move.to}`) {
      if (this.#dropPoint) carry(move.from, move.to, 0, this.#dropPoint);
    } else {
      carry(move.from, move.to, move.piece === 'n' ? CARRY_LIFT_KNIGHT : CARRY_LIFT);
    }

    if (move.isCastle) {
      const rank = move.color === WHITE ? '1' : '8';
      if (move.isKingsideCastle) carry(`h${rank}`, `f${rank}`, CARRY_LIFT);
      else carry(`a${rank}`, `d${rank}`, CARRY_LIFT);
    }
  }

  /*
     Time, here, is the frame's own.

     `frameTime` is the instant the browser began this frame, and it steps
     by exactly one frame each time. performance.now() read inside the
     callback is that plus however long the browser took to get round to
     calling it, which is different every frame — so a piece timed by it
     moves by slightly unequal amounts on equal frames, and that unevenness
     is what the eye calls stutter even when no frame was dropped.

     And every motion counts from the first frame that draws it, not from
     the moment it was asked for. A move is asked for in the middle of the
     busiest task the app has — the engine, the save, the sound, the cards —
     and whatever that task took used to be spent out of the animation
     before a single frame of it had been seen: the piece began its journey
     already part of the way along. Now the first frame it is drawn in is
     its first frame.
  */
  #loop = (frameTime) => {
    if (this.#disposed) return;
    this.#frame = requestAnimationFrame(this.#loop);
    const now = typeof frameTime === 'number' ? frameTime : performance.now();

    if (this.#warmFrames > 0) {
      this.#warmFrames -= 1;
      this.#needsRender = true;
    }

    if (this.#cameraSpin) {
      const spin = this.#cameraSpin;
      spin.start ??= now;
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

  /** Aim the raycaster through a point on the page. False if there is no canvas to aim at. */
  #aim(clientX, clientY) {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this.#pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    return true;
  }

  /** The square a pointer event means, or null. See #squareOnRay for "means". */
  #squareFromEvent(event) {
    if (!this.#aim(event.clientX, event.clientY)) return null;
    this.#lastPick = this.#squareOnRay();
    return this.#lastPick;
  }

  /**
   * Which square the raycaster's line of sight means.
   *
   * This used to be one line: wherever the line met the board. That is right
   * for a piece no taller than its tile is deep, and wrong for a tall one. A
   * pawn's head is drawn most of a square beyond its own foot, over the tile
   * behind it, so a press on the head — which is where anyone presses a pawn —
   * landed on that empty tile and selected nothing. With a king it is worse:
   * its cross is drawn over the foot of the pawn standing beyond it.
   *
   * So the pieces are asked first, and the answer is the first thing along
   * the line of sight that the press could mean: each piece the line passes
   * through, nearest the eye first — what is drawn under the pointer is what
   * was pressed — and then the tile the line ends on.
   *
   * "Could mean" is a square the selected piece may move to, or one holding a
   * piece that has a move — the two things a press can do. That test is what
   * makes a tall piece something you can reach past. A piece you can neither
   * take nor move is not what you were aiming at, so the press goes through
   * it to whatever is behind: at the start of every game the king's cross is
   * drawn over the middle of the e-pawn's tile, the king has nowhere to go,
   * and a press there is the pawn's.
   *
   * With one exception, and it is the one that matters. A press that has
   * landed on one of the mover's own pieces is never passed on as a MOVE to
   * a tile behind it. It may well have been meant for that piece — the player
   * need not know it is pinned — and guessing wrong the other way plays a
   * move nobody chose, which online cannot be taken back. Picking up the
   * wrong piece costs one more press; so behind an own piece only another
   * piece to pick up is looked for, never somewhere to go.
   *
   * When nothing could be meant the answer is still what was pressed, because
   * the controller clears the selection on a press that means nothing and it
   * needs a square to be told about.
   *
   * `carried` is a piece in the player's hand. It is left out, or every drop
   * would land on the piece being dropped. A hand that is already holding a
   * piece is not picking up another, so only a square that piece may move to
   * counts, and nothing stands in its way.
   */
  #squareOnRay(carried = null) {
    const tile = this.#raycaster.intersectObject(this.#boardMesh, false)[0];
    const inSight = this.#piecesOnRay(carried);
    if (tile) {
      const ground = this.#worldToSquare(tile.point);
      if (ground && !inSight.includes(ground)) inSight.push(ground);
    }

    let mayMove = true;
    const meant = (square) => (mayMove && this.#targets.has(square))
      || (!carried && this.#movable.has(square));

    for (const square of inSight) {
      if (meant(square)) return square;
      const own = this.#pieces.get(square)?.userData.piece[0] === this.#turn;
      if (own && !carried) mayMove = false;
    }
    return inSight[0] ?? null;
  }

  /**
   * The squares of the pieces the line of sight passes through, nearest first.
   *
   * Tested against the pieces' own triangles rather than a box or a cylinder
   * standing in for them. A stand-in is cheaper and it is wrong exactly where
   * it matters: the pawn you can see beside a king's cross is inside any
   * cylinder drawn round that king. A press is one ray, three.js rejects most
   * pieces on their bounding spheres, and this runs when a button goes down
   * or comes up — not on every pointer move.
   *
   * Exact, and so not forgiving: a press a few pixels off a pawn's neck is a
   * press on the tile behind it. Widening each piece to catch those was
   * tried and taken out. Seen from this angle the middle of an empty tile is
   * a twentieth of a square above the head of the pawn in front of it, so
   * any margin worth having round the head swallows the middle of that tile,
   * and a board where pressing an empty square picks up a pawn is worse than
   * one where a near miss has to be pressed again.
   */
  #piecesOnRay(carried) {
    // A position written since the last frame has not reached the matrices a
    // raycast reads, and a press can arrive between the two.
    this.#pieceGroup.updateMatrixWorld(true);

    const owners = new Map();
    this.#pieces.forEach((group, square) => {
      if (group !== carried) owners.set(group.children[0], square);
    });

    const squares = [];
    for (const hit of this.#raycaster.intersectObjects([...owners.keys()], false)) {
      const square = owners.get(hit.object);
      if (!squares.includes(square)) squares.push(square);
    }
    return squares;
  }

  /**
   * Where on a piece the pointer took hold of it, measured from its foot.
   *
   * A piece used to be carried by its foot whatever part of it was pressed,
   * which nobody noticed while a piece was shorter than a tile. Take a tall
   * king by its cross that way and the whole king jumps a square and a half
   * up the screen to put its foot under the pointer. Remembering the hold
   * keeps the part that was pressed under the pointer for as long as it is
   * carried, which is all "picking something up" means.
   *
   * Read from the same line of sight that chose the piece: where it meets the
   * piece itself, or, for a piece chosen by its tile, where it meets the
   * board.
   */
  #holdOn(group) {
    const hit = this.#raycaster.intersectObject(group, true)[0]?.point
      ?? this.#raycaster.intersectObject(this.#boardMesh, false)[0]?.point;
    return hit ? hit.clone().sub(group.position) : new THREE.Vector3();
  }

  /**
   * Where a carried piece's foot belongs, for the pointer and the hold on it.
   *
   * The pointer is followed on an invisible level sheet rather than on the
   * board, because a piece being carried is ABOVE the board, and because the
   * answer has to be continuous: snapping a held piece to the middle of
   * whatever square it is over makes a drag a sequence of jumps. The sheet
   * is at the height of the part being held, so that part stays under the
   * pointer; the foot is then the hold's distance away from it.
   */
  #carriedFoot(event, hold) {
    if (!this.#aim(event.clientX, event.clientY)) return null;
    this.#dragPlane.constant = -(BOARD_Y + DRAG_LIFT + hold.y);
    const hit = new THREE.Vector3();
    if (!this.#raycaster.ray.intersectPlane(this.#dragPlane, hit)) return null;
    return hit.set(hit.x - hold.x, BOARD_Y + DRAG_LIFT, hit.z - hold.z);
  }

  /**
   * The square a carried piece is being held over, as the player sees it.
   *
   * Not the square straight down from it. The piece is in the air and the
   * camera is to one side, so its foot is drawn over a tile further back than
   * the one beneath it — and the tile it is drawn over is the one the player
   * has lined it up with. So the line of sight is taken through the foot and
   * asked the same question a press is.
   */
  #squareUnder(foot, carried) {
    const seen = foot.clone().project(this.#camera);
    this.#pointer.set(seen.x, seen.y);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    this.#lastPick = this.#squareOnRay(carried);
    return this.#lastPick;
  }

  #attachListeners() {
    const root = this.#root;
    // Every listener carries the abort signal, so dispose() detaches the
    // whole board from the element in one call. See #listeners.
    const on = (target, type, handler) =>
      target.addEventListener(type, handler, { signal: this.#listeners.signal });

    /*
       A tap is finished when the finger lifts: pointerup, below, has already
       activated the square. The browser does not know that. It follows every
       touch with a click of its own, and it decides what that click landed on
       AFTER our handler has run — so when the tap completes a promotion and
       the picker opens under the finger, the click goes to the picker. Mostly
       it hit the backdrop, which cancels: the picker closed in the instant it
       opened and a pawn could not promote at all. Sometimes it hit one of the
       four pieces, and promoted to whichever happened to be there.

       A mouse never did this. Its click goes to where the button went down
       and came up, which is the board — so this worked on every desktop and
       failed on every phone, and no test driven by a mouse could see it.

       Cancelling touchend is how a page says "this touch is dealt with": no
       compatibility mouse events and no click follow it. Scrolling is not
       affected — that is settled on touchstart and touchmove — and the
       touchend that ends a scroll is not cancelable, hence the check.
       Nothing inside the board listens for a click, so nothing is lost.
    */
    root.addEventListener('touchend', (event) => {
      if (event.cancelable) event.preventDefault();
    }, { signal: this.#listeners.signal, passive: false });

    on(root, 'pointerdown', (event) => {
      const square = this.#squareFromEvent(event);
      if (!square) return;
      this.#focusSquare(square, false);

      const isTouch = event.pointerType === 'touch';
      const group = this.#pieces.get(square);
      this.#drag = {
        square,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
        // Dragging on mouse/pen only, matching the flat board: on touch,
        // tap-to-move is primary and the page must still be able to scroll.
        eligible: !isTouch && Boolean(group),
        // Read now, while the raycaster is still aimed at this press.
        hold: group ? this.#holdOn(group) : null,
        // Where the pointer has the foot, before the rim stops it. See finish.
        foot: null,
      };
    });

    on(root, 'pointermove', (event) => {
      const drag = this.#drag;
      if (!drag || drag.pointerId !== event.pointerId || !drag.eligible) return;

      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) return;
        drag.active = true;
        // Keep hearing about this pointer after it leaves the board. Without
        // the capture a piece carried past the edge and let go there was
        // never let go as far as this board knew: the release went to
        // whatever was under the pointer, and the piece hung in the air at
        // the rim until something else redrew it.
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser has already forgotten. The drag still
          // works for as long as it stays over the board.
        }
        this.#onSquareActivate(drag.square);
      }

      // Carry the piece under the pointer at a slight lift, so it reads as
      // picked up rather than shoved along the surface — and by the part of
      // it that was taken hold of, not by the centre of the square the
      // pointer is over. Those differ by up to half a square across and, for
      // a tall piece held by its head, by more than a square up the screen,
      // which at drag speed is the difference between a piece held in the
      // hand and a piece teleporting between squares one jump behind the
      // cursor.
      const group = this.#pieces.get(drag.square);
      const foot = this.#carriedFoot(event, drag.hold);
      if (group && foot) {
        drag.foot = foot;
        // The sheet is infinite and the board is not. Past the rim the piece
        // is pinned to the edge rather than sent off toward the horizon.
        const edge = HALF + RIM;
        group.position.set(
          Math.min(Math.max(foot.x, -edge), edge),
          foot.y,
          Math.min(Math.max(foot.z, -edge), edge),
        );
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

      const group = this.#pieces.get(drag.square);
      // Read before anything is activated: activating re-renders, and a
      // re-render moves this piece. See #settlePiece.
      const held = group ? group.position.clone() : null;
      // From where the pointer has it rather than where the rim stopped it,
      // so a piece carried off the board is dropped off the board — not on
      // whichever edge square it was pinned beside.
      const dropSquare = drag.foot ? this.#squareUnder(drag.foot, group) : null;

      if (dropSquare && dropSquare !== drag.square) {
        // Where their hand actually let go. If the move is legal the render
        // that follows replaces this piece with one already standing on the
        // destination, and #animateMove seats it from this point instead of
        // letting it appear there.
        this.#dropPoint = held;
        this.#draggedMove = `${drag.square}|${dropSquare}`;
        this.#onSquareActivate(dropSquare);
        // Still the same piece on the same square? Then the move was refused.
        // Put it back rather than leaving it standing where it was dropped.
        if (this.#pieces.get(drag.square) === group) {
          this.#settlePiece(drag.square, held);
        }
        return;
      }

      // Dropped on its own square, or off the board entirely.
      this.#settlePiece(drag.square, held);
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
      // Shape first, then colour, because colour alone is not a name: the
      // capture halo is the same red as the check square, and the from-square
      // ring was once the same gold as the selection. And shape by identity,
      // not by type — the halo is a RingGeometry too, and classifying on the
      // type would report every capture on offer as where the last move left.
      const isShape = (shape) => marker.geometry === this.#geometries.get(`geo:marker:${shape}`);
      if (marker === this.#focusMarker) markers.focus = square;
      else if (isShape('ring')) markers.lastFrom = square;
      else if (!isShape('square')) return; // a move dot or a capture halo
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
       * screenshot, and the interesting claims here — the tiles are not a
       * flat fill, the whole set is one material — are measurable ones.
       */
      detail: {
        rich: this.#richDetail,
        toneMapping: this.#renderer?.toneMapping,
        exposure: this.#renderer?.toneMappingExposure,
        pieceMaterial: this.#materials.get('mat:clay')?.type ?? null,
        anisotropy: this.#boardTexture?.anisotropy ?? 0,
        // The generated tile canvas, so a test can read the pixels back and
        // check the rolled edges are really there rather than trusting the
        // code path.
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

      /**
       * Where a piece is drawn, in client coordinates: a point on its axis
       * four fifths of the way up, which is a pawn's head and a king's crown.
       *
       * Not the same place as its square. A tall piece is drawn most of a
       * square beyond its own foot, and where it is drawn is where a player
       * presses it — so a test that presses the middle of the square is
       * testing something no finger does.
       */
      projectPiece: (square) => {
        const group = this.#pieces.get(square);
        if (!group) return null;
        const rect = this.#canvas.getBoundingClientRect();
        const height = PIECE_HEIGHT[group.userData.piece[1]] ?? PIECE_HEIGHT.p;
        const ndc = group.position.clone().setY(group.position.y + height * 0.8).project(this.#camera);
        return {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
      },

      /** The square a press at this point on the page would mean. Presses nothing. */
      pickAt: (clientX, clientY) => (this.#aim(clientX, clientY) ? this.#squareOnRay() : null),

      /** Where a piece actually is in the scene, mid-animation included. */
      piecePosition: (square) => {
        const group = this.#pieces.get(square);
        return group ? { x: group.position.x, y: group.position.y, z: group.position.z } : null;
      },

      /**
       * A piece's extent in its own coordinates, and how many meshes it took.
       *
       * The knight is the only piece here that is not a surface of revolution,
       * and the only claim about it worth testing is a geometric one: its
       * muzzle has to reach forward past the edge of its base, because that
       * overhang is what identifies it from directly above. A box measurement
       * says that; a screenshot only says it to a person looking at it.
       */
      pieceBounds: (square) => {
        const group = this.#pieces.get(square);
        if (!group) return null;
        const box = new THREE.Box3();
        let meshes = 0;
        group.traverse((object) => {
          if (!object.isMesh) return;
          meshes += 1;
          object.updateWorldMatrix(true, false);
          box.expandByObject(object);
        });
        if (!Number.isFinite(box.min.x)) return null;
        const origin = group.position;
        // Relative to the piece's own square, and un-mirrored, so a black
        // knight measures the same as a white one.
        const face = group.userData.faces === -1 ? -1 : 1;
        const xs = [(box.min.x - origin.x) * face, (box.max.x - origin.x) * face];
        return {
          meshes,
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minZ: box.min.z - origin.z,
          maxZ: box.max.z - origin.z,
          height: box.max.y,
        };
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

export default Board3D;
