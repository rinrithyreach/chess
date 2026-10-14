/**
 * board-3d.js
 * A WebGL chessboard, drop-in interchangeable with the DOM one in board.js.
 *
 * It implements exactly the same public contract — constructor(root),
 * onSquareActivate, setOrientation, render — plus
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
 * A move dot: how big it is drawn, and how far from the middle of its square
 * a press on it reaches, both in squares. The reach is a little wider than
 * the dot, for a finger, and well short of the square's edge. See #dotOnRay.
 */
const DOT = { radius: 0.17, reach: 0.25 };

/**
 * How much of the canvas the board is fitted across.
 *
 * Nearly all of it. This was 0.96, a comfortable hair of room all round, and
 * on a phone that hair is 8px a side of board the player does not get — on a
 * canvas that already runs to the edges of the screen, where the board is as
 * wide as it can ever be and every pixel left over is a pixel off a square.
 * What is left is enough to keep the rim's antialiased edge off the last row
 * of pixels and no more.
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
  classic: { light: '#f9e4b7', dark: '#b97a4f', rim: '#94603f' },
  blueberry: { light: '#e9f3ff', dark: '#79a8e8', rim: '#4f7cc2' },
  strawberry: { light: '#fff1ea', dark: '#f0919b', rim: '#c9636f' },
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
  // The part of a move dot a piece stands in front of, drawn over the piece:
  // the selection's blue, which reads on a black piece, a white one and gold.
  // The flat board has no such thing, nothing there standing in front of
  // anything. See #syncMarkers.
  legalThrough: { color: 0x35aaf7, opacity: 0.9 },
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
 * point shows against whichever tile is behind it. `eye` is the knight's,
 * and is dark on both sides: a horse with pale eyes is not a friendly one.
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
    shaft: '#a9aec4', blade: '#7f859d', eye: '#4d5166',
  },
  b: {
    body: '#65646f', accent: '#7cc474', trim: '#f7b93a', alt: '#83828f',
    shaft: '#4d4c57', blade: '#a9a8b4', eye: '#2d2c34',
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
 * Tall: a king is a square and two thirds high on a foot less than one
 * across. The first clay set was squat, on the reasoning that clay slumps and
 * that a tall back rank hides the pawns in front of it. Both are true and it
 * was still the wrong call — from 56 degrees a squat piece is mostly the top
 * of its own foot, and six kinds of disc are hard to tell apart. Standing up,
 * each piece shows its side, which is where a rook's teeth and a queen's
 * crown actually are.
 *
 * Then it was too tall, the other way. The king was nearly two squares high
 * and the queen 1.69, and on a phone that was "too much tall, hard to click
 * the board": a tall piece is drawn over the squares behind it, and a press
 * meant for one of those lands on the piece. So the long middle of each tall
 * piece was shortened — the king's stem by 0.3, the queen's by 0.21, the
 * bishop's robe by 0.12, the knight's pedestal by 0.08, the pawn's skirt by
 * 0.1 — and nothing else: the crowns, rings and balls above came down whole,
 * so they keep their shapes. The rook was left alone. On a 390px phone, over
 * every move in seven real positions, a press missed the square it was meant
 * for 8.3% of the time at Fit and 6.1% at Large; now 6.4% and 3.7%, and the
 * nine squares at Fit that could only be hit on less than half of themselves
 * are none. Taking
 * more off the king and queen was tried, from their crowns as well, and
 * squashed the crowns while hardly helping: what is left of the misses is
 * the body of the piece standing right in front of a square, not its top.
 *
 * What the height costs is paid for in two places. A back-rank piece stands
 * in front of the foot of the pawn behind it, so a pointer has to mean the
 * piece it is on rather than the tile under it: see #squareOnRay. And the
 * camera has to leave room above the far rank: see #cameraSeat.
 *
 * The order still runs pawn, rook, knight, bishop, queen, king, which is what
 * makes them tell apart at a glance.
 */
const PIECE_HEIGHT = { p: 0.98, r: 1.27, n: 1.3, b: 1.38, q: 1.48, k: 1.65 };

/**
 * The picture the board draws of a piece for the page around it. See
 * pieceSprite().
 *
 * One picture, for two places: the row of taken pieces on a player's card,
 * and the four choices in the promotion picker. Both line pieces up to be
 * read side by side, so in both the piece stands, its foot on the bottom of
 * the frame, and a row of the pictures is a row of pieces on one floor.
 *
 * The frame is the queen's. She is the tallest piece either place can show —
 * a king is never taken and a pawn never becomes one — and a frame with room
 * for a king would only make everything in it smaller. 192 pixels, because
 * the picker shows it at 72 and a phone has three pixels to each of the
 * page's.
 *
 * There were two. The other was for the taken pieces while they stood in
 * slim columns beside the board: a smaller picture, framed to the king,
 * with the piece floating in the middle of it because a column has no
 * floor. The columns went and it went with them.
 */
const PORTRAIT = { size: 192, tallest: 'q' };

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
 * A limb: a bar of clay rolled out along a line, fatter in one place and
 * thinner in another, and pressed a little flat.
 *
 * Each station is [x, y, deep, wide]: where the middle of the bar is, in the
 * plane the piece is drawn in, and half its thickness there — `deep` in that
 * plane, across the line of the bar, and `wide` out of it, towards the
 * viewer. The bar passes smoothly through every station and so does its
 * thickness. Both ends are closed.
 *
 * It is what a lathe cannot make. Every other piece in the set is turned
 * about its own axis and a horse's neck has none: it leans, it arches, and
 * the head comes off it at an angle. Stacked balls and cylinders were how
 * the knight was first made, and it showed every join.
 */
function limb(stations, around, along) {
  const line = new THREE.CatmullRomCurve3(
    stations.map(([x, y]) => new THREE.Vector3(x, y, 0)),
  );
  const girth = new THREE.CatmullRomCurve3(
    stations.map(([, , deep, wide]) => new THREE.Vector3(deep, wide, 0)),
  );

  const position = [];
  for (let i = 0; i <= along; i += 1) {
    // Both curves are read by the same fraction of the way through the
    // stations, not by distance, so a thickness stays with its station.
    const t = i / along;
    const at = line.getPoint(t);
    const heading = line.getTangent(t);
    const { x: deep, y: wide } = girth.getPoint(t);
    for (let k = 0; k < around; k += 1) {
      const angle = (k / around) * Math.PI * 2;
      const across = Math.cos(angle) * deep;
      position.push(
        at.x - heading.y * across,
        at.y + heading.x * across,
        Math.sin(angle) * wide,
      );
    }
  }
  const first = line.getPoint(0);
  const last = line.getPoint(1);
  position.push(first.x, first.y, 0, last.x, last.y, 0);

  const index = [];
  for (let i = 0; i < along; i += 1) {
    for (let k = 0; k < around; k += 1) {
      const a = i * around + k;
      const b = i * around + ((k + 1) % around);
      index.push(a, b, a + around, b, b + around, a + around);
    }
  }
  const start = (along + 1) * around;
  const final = along * around;
  for (let k = 0; k < around; k += 1) {
    const next = (k + 1) % around;
    index.push(start, next, k, start + 1, final + k, final + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The knight: a horse's neck and head, in the parts they are made of.
 *
 * Drawn in profile, facing -X, with every number in squares. Black's knights
 * are turned about with the rest of Black's pieces (see #makePiece), so the
 * two sides' horses face opposite ways along the rank.
 *
 * The neck and the head are a limb each, and that is the difference from
 * the knight this replaces, which was a cylinder, three stretched balls and
 * a capsule: a cranium, a jaw and a muzzle that each showed where they
 * stopped, with a neck that entered its pedestal on a hard sawn edge. It had
 * been built for a camera that looked nearly straight down, when the plan
 * view was all there was to recognise a knight by. The pieces have since
 * been stood up and are seen from the side as much as from above, and from
 * the side it was a lump with a ball on the front of it.
 *
 * What is kept from that version is its one sound idea. The muzzle still
 * reaches forward past the edge of the foot, because from above that
 * overhang is what says "knight"; and the mane is still stepped rather than
 * smooth, because one smooth ridge down the back of a neck is a handle.
 *
 * The parts are returned by the pigment they take.
 */
function knightSolids(seg) {
  const around = Math.max(10, seg >> 1);
  const squash = (geometry, [sx, sy, sz], lean, [x, y, z]) => geometry
    .scale(sx, sy, sz)
    .rotateZ(lean)
    .translate(x, y, z);

  const coat = [
    // The neck. Broad where it leaves the pedestal, which is the chest, and
    // arched at the back, narrowing to the poll.
    limb([
      [0.0, 0.36, 0.25, 0.215],
      [0.03, 0.56, 0.235, 0.2],
      [0.07, 0.78, 0.2, 0.18],
      [0.065, 0.97, 0.168, 0.158],
      [0.02, 1.09, 0.13, 0.13],
    ], around, 12),
    // The head: from the back of the skull, forward and down to the nose.
    // Deepest at the cheek and a good third narrower at the muzzle — a head
    // the same depth all the way along is a dog's.
    limb([
      [0.14, 1.085, 0.085, 0.095],
      [0.055, 1.105, 0.155, 0.148],
      [-0.07, 1.085, 0.178, 0.156],
      [-0.2, 1.015, 0.152, 0.136],
      [-0.31, 0.945, 0.128, 0.12],
      [-0.4, 0.89, 0.12, 0.116],
      [-0.455, 0.855, 0.085, 0.09],
    ], around, 16),
    // The cheek, slung under the eye: the round of a horse's jaw.
    squash(new THREE.SphereGeometry(1, around, 10), [0.16, 0.165, 0.152], 0.5, [-0.04, 0.985, 0]),
    // Ears, pricked and a little apart.
    ...[1, -1].map((hand) => new THREE.ConeGeometry(0.064, 0.17, 10)
      .rotateX(hand * 0.22)
      .rotateZ(0.2)
      .translate(0.05, 1.3, hand * 0.09)),
  ];

  // The mane: a crest of tufts down the back of the neck, each overlapping
  // the one below, and a forelock between the ears.
  const tuft = (x, y, lean, size) => squash(
    new THREE.SphereGeometry(1, 12, 8), [0.105 * size, 0.07 * size, 0.062], lean, [x, y, 0],
  );
  const mane = [
    tuft(0.165, 1.185, -0.75, 1),
    tuft(0.235, 1.065, -1.1, 1.08),
    tuft(0.265, 0.93, -1.4, 1.12),
    tuft(0.265, 0.79, -1.65, 1.1),
    tuft(0.245, 0.655, -1.85, 1.02),
    tuft(0.215, 0.535, -2.0, 0.9),
    squash(new THREE.SphereGeometry(1, 12, 8), [0.1, 0.055, 0.06], 0.35, [-0.03, 1.265, 0]),
  ];

  const eyes = [1, -1].map((hand) => new THREE.SphereGeometry(0.034, 10, 8)
    .translate(-0.115, 1.125, hand * 0.136));

  return { coat, mane, eyes };
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
 * number would have made eggs of the heads and hoops of the rings. Taking
 * height back out was done the same way round, from the long middle of each
 * piece only: see PIECE_HEIGHT.
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
      const { coat, mane, eyes } = knightSolids(seg);
      return [
        ['body', lump(0.4, 0.4, 0, 0.11, 0.05, seg)],
        ['body', lump(0.31, 0.275, 0.09, 0.32, 0.04, seg)],
        // The band every piece above a rook wears, here as a collar.
        ['trim', ring(0.25, 0.052, 0.33, seg)],
        // Modelled standing on the pedestal as it was, 0.08 taller.
        ...coat.map((g) => ['alt', g.translate(0, -0.08, 0)]),
        ...mane.map((g) => ['accent', g.translate(0, -0.08, 0)]),
        ...eyes.map((g) => ['eye', g.translate(0, -0.08, 0)]),
      ];
    }

    case 'b':
      return [
        ['body', lump(0.38, 0.38, 0, 0.1, 0.045, seg)],
        ['alt', lump(0.3, 0.185, 0.085, 0.66, 0.04, seg)],
        ['trim', ring(0.205, 0.054, 0.68, seg)],
        // The mitre is a tall egg. Without the height a bishop is a pawn.
        ['body', turned([
          [0, 0.68], [0.185, 0.7], [0.245, 0.86], [0.21, 1.06], [0.105, 1.22], [0, 1.265],
        ], seg)],
        ['trim', ball(0.072, 1.308, seg)],
      ];

    case 'q':
      return [
        ['body', lump(0.41, 0.41, 0, 0.11, 0.05, seg)],
        ['accent', lump(0.335, 0.21, 0.09, 0.65, 0.045, seg)],
        ['trim', ring(0.235, 0.058, 0.67, seg)],
        ['body', turned([
          [0, 0.66], [0.19, 0.68], [0.205, 0.81], [0.26, 1.05], [0.298, 1.19], [0.304, 1.25], [0, 1.28],
        ], seg)],
        ['trim', ring(0.275, 0.047, 1.265, seg)],
        // Points stand on the crown's ring rather than sunk into it, so they
        // read as a coronet instead of lumps.
        ...around(7, 0.275, () => new THREE.ConeGeometry(0.07, 0.2, 10).translate(0, 1.375, 0))
          .map((g) => ['trim', g]),
        ['body', ball(0.165, 1.29, seg)],
        ['trim', ball(0.058, 1.422, seg)],
      ];

    case 'k':
      return [
        ['body', lump(0.425, 0.425, 0, 0.11, 0.05, seg)],
        ['accent', lump(0.347, 0.224, 0.09, 0.64, 0.045, seg)],
        ['trim', ring(0.244, 0.062, 0.66, seg)],
        ['body', turned([
          [0, 0.65], [0.204, 0.67], [0.222, 0.8], [0.27, 1.02],
          [0.305, 1.16], [0.311, 1.235], [0.249, 1.295], [0, 1.31],
        ], seg)],
        ['trim', ring(0.293, 0.045, 1.235, seg)],
        // The cross is rolled, not cut: two short sausages, pressed together.
        // Big for the piece it stands on, because from above it is most of
        // what says which of the two tall pieces this one is.
        ['trim', new THREE.CapsuleGeometry(0.066, 0.25, 4, 12).translate(0, 1.459, 0)],
        ['trim', new THREE.CapsuleGeometry(0.066, 0.2, 4, 12).rotateZ(Math.PI / 2).translate(0, 1.49, 0)],
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
          [0, 0.08], [0.262, 0.085], [0.24, 0.18], [0.165, 0.36], [0.128, 0.52], [0, 0.56],
        ], seg)],
        ['body', lump(0.185, 0.185, 0.5, 0.575, 0.032, seg)],
        ['accent', ball(0.192, 0.788, seg)],
        ['shaft', new THREE.CylinderGeometry(0.03, 0.034, 0.92, 10).translate(reach, 0.54, 0)],
        // A leaf, not a needle: a point thin enough to be sharp is thin
        // enough to vanish at the size a pawn is drawn on a phone.
        ['blade', turned([[0, 0.96], [0.092, 1.04], [0.072, 1.12], [0.026, 1.23], [0, 1.29]], 12)
          .translate(reach, 0, 0)],
      ];
    }
  }
}

/**
 * Colour a list of [pigment, lump] pairs and press them into one geometry.
 *
 * Each lump is filled with its pigment as a vertex colour, then all of them
 * are concatenated. A `THREE.Color` built from a CSS string is already in the
 * linear working space, which is what a vertex colour is read as. The
 * pieces are made this way, and so are the animals on the lawn.
 */
function bake(recipe, pigments) {
  const lumps = recipe.map(([role, geometry]) => {
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

/** One piece, baked: its recipe in its side's clay. */
function bakePiece(type, side, segments) {
  return bake(pieceRecipe(type, segments), CLAY[side] ?? CLAY.w);
}

// ---------------------------------------------------------------------------
// The animals on the lawn
// ---------------------------------------------------------------------------

/*
   A ginger cat, a puppy in a blue collar and a green parrot, who run about on
   the grass round the game. Asked for as cute animals with animation, then as
   clay ones that run about the grass, and then as "all animal clay styles
   like chess styles" — so they are made exactly as the pieces are: lumps of
   clay with their pigments baked in as vertex colours, in the pieces' one
   matt clay, under the pieces' light.

   They are not drawn in the board's scene, which ends at the rim, and the
   grass they run on is the page round it. Each is drawn here, through the
   board's own renderer, into a strip of frames — a run and a rest — and the
   page plays the frames. See critterSheet(), and "The animals on the lawn"
   in style.css and meadow.js.

   Built standing on the ground at y = 0, facing +x, about one unit tall. The
   parts that move are their own groups, each turned about its own joint: a
   hip, a shoulder, the root of a tail, the neck.
*/

/** Their clay. Roles as for the pieces: see CLAY. */
const CRITTER_CLAY = {
  cat: {
    body: '#f6a35c', cream: '#fff1dc', pink: '#f6a99a', nose: '#ee7d8b',
    eye: '#2b1a10', shine: '#ffffff', cheek: '#f58f85',
  },
  dog: {
    body: '#e6b97f', patch: '#c48a52', ear: '#8a5a36', cream: '#fff6ea',
    nose: '#2b1a10', eye: '#2b1a10', shine: '#ffffff', tongue: '#f5848f', cheek: '#f39a8a',
    collar: '#3ba3f0', tag: '#ffb92e',
  },
  parrot: {
    body: '#5fc45e', belly: '#c3e877', wing: '#3f9e45', blue: '#3ba3f0',
    beak: '#ffb92e', jaw: '#d9862a', crest: '#ff7a45', face: '#fff8ec',
    cheek: '#ff8f7f', eye: '#2b1a10', shine: '#ffffff', leg: '#f09a3e',
  },
};

/**
 * How many frames each loop has, and how big a frame is, in pixels.
 *
 * A run is ten frames, played in about a third of a second: fast enough to be
 * a run. A rest is twenty-four, played over three and a half seconds, which
 * is stop-motion pace — what a clay animal is supposed to move at — and
 * mostly still. A frame is drawn at about three times the size the page
 * shows it on a phone, and the page scales it down, which is what smooths
 * its edges.
 */
const CRITTER_FRAMES = { run: 10, rest: 24 };
const CRITTER_FRAME = { width: 192, height: 154 };

/**
 * How each animal is framed: how many units of height its frame holds, and
 * where across it the frame is centred. As close as each will go. The cat and
 * the dog stand about a unit high and never leave the ground; the parrot
 * hops, and needs the room over its head.
 */
const CRITTER_VIEW = {
  cat: { tall: 1.12, x: -0.04 },
  dog: { tall: 1.12, x: -0.03 },
  parrot: { tall: 1.3, x: 0.0 },
};

/**
 * An egg of clay: a ball pressed to three radii, turned about its own middle
 * (`turn`, radians about x and about z) and set at `at`.
 */
const egg = ([rx, ry, rz], [x, y, z], seg, turn = {}) =>
  new THREE.SphereGeometry(1, seg, Math.max(8, seg >> 1))
    .scale(rx, ry, rz)
    .rotateX(turn.x ?? 0)
    .rotateZ(turn.z ?? 0)
    .translate(x, y, z);

/** A roll of clay along a few points: a tail, a leg. */
const roll = (points, radius, seg) => new THREE.TubeGeometry(
  new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z))),
  24, radius, Math.max(8, seg >> 1), false,
);

/** A leg hanging from its hip at the origin: a roll down to a paw. */
const leg = (length, radius, paw, seg) => [
  ['body', roll([[0, 0.02, 0], [0.005, -length / 2, 0], [0.01, -length, 0]], radius, seg)],
  ['body', egg([radius, radius, radius], [0, 0.02, 0], seg)],
  [paw, egg([radius * 1.3, radius * 0.8, radius * 1.15], [radius * 0.35, -length - radius * 0.3, 0], seg)],
];

/**
 * What each animal is made of: the lumps that do not move, and each moving
 * part as its joint (`at`, relative to whatever it hangs from) and its own
 * lumps around that joint.
 */
function critterModel(kind, seg) {
  if (kind === 'parrot') {
    return {
      body: [
        ['body', egg([0.2, 0.3, 0.2], [0, 0.42, 0], seg, { z: -0.22 })],
        ['belly', egg([0.13, 0.22, 0.155], [0.09, 0.4, 0], seg)],
      ],
      head: {
        at: [0.06, 0.68, 0],
        lumps: [
          ['body', egg([0.17, 0.17, 0.17], [0.03, 0.1, 0], seg)],
          ['face', egg([0.09, 0.1, 0.13], [0.11, 0.11, 0], seg)],
          ['cheek', egg([0.04, 0.026, 0.03], [0.13, 0.03, 0.1], seg)],
          ['cheek', egg([0.04, 0.026, 0.03], [0.13, 0.03, -0.1], seg)],
          ['crest', new THREE.ConeGeometry(0.04, 0.13, seg).rotateZ(0.5).translate(-0.05, 0.29, 0)],
          ['crest', new THREE.ConeGeometry(0.04, 0.13, seg).rotateZ(0.15).translate(0.01, 0.3, 0)],
          ['beak', new THREE.ConeGeometry(0.055, 0.15, seg).rotateZ(-Math.PI / 2 - 0.7).translate(0.21, 0.07, 0)],
          ['jaw', egg([0.045, 0.03, 0.04], [0.17, 0.02, 0], seg)],
        ],
      },
      eyes: {
        at: [0.15, 0.14, 0],
        lumps: [
          ['eye', egg([0.034, 0.044, 0.03], [0, 0, 0.088], seg)],
          ['eye', egg([0.034, 0.044, 0.03], [0, 0, -0.088], seg)],
          ['shine', egg([0.013, 0.013, 0.013], [0.016, 0.018, 0.112], seg)],
          ['shine', egg([0.013, 0.013, 0.013], [0.016, 0.018, -0.112], seg)],
        ],
      },
      tail: {
        at: [-0.13, 0.24, 0],
        lumps: [
          ['wing', egg([0.05, 0.2, 0.035], [-0.09, -0.14, -0.025], seg, { z: -0.5 })],
          ['blue', egg([0.055, 0.22, 0.04], [-0.11, -0.165, 0.02], seg, { z: -0.6 })],
        ],
      },
      legs: [
        { name: 'fn', at: [0.03, 0.17, 0.06], lumps: [['leg', roll([[0, 0, 0], [0.005, -0.08, 0], [0.01, -0.15, 0]], 0.02, seg)], ['leg', egg([0.05, 0.018, 0.035], [0.03, -0.16, 0], seg)]] },
        { name: 'bn', at: [0.0, 0.17, -0.06], lumps: [['leg', roll([[0, 0, 0], [0.005, -0.08, 0], [0.01, -0.15, 0]], 0.02, seg)], ['leg', egg([0.05, 0.018, 0.035], [0.03, -0.16, 0], seg)]] },
      ],
      wings: [-1, 1].map((side) => ({
        side,
        at: [-0.03, 0.6, side * 0.165],
        lumps: [
          ['wing', egg([0.1, 0.25, 0.05], [-0.06, -0.19, 0], seg, { z: -0.3 })],
          ['blue', egg([0.06, 0.1, 0.053], [-0.106, -0.344, 0], seg, { z: -0.3 })],
        ],
      })),
    };
  }

  const dog = kind === 'dog';
  const body = dog
    ? [
      ['body', egg([0.37, 0.23, 0.22], [0, 0.44, 0], seg)],
      ['patch', egg([0.15, 0.13, 0.222], [-0.13, 0.5, 0], seg)],
      ['cream', egg([0.27, 0.13, 0.18], [0.05, 0.35, 0], seg)],
      ['body', egg([0.17, 0.19, 0.18], [0.27, 0.53, 0], seg)],
      ['collar', new THREE.TorusGeometry(0.155, 0.03, 8, 28).rotateX(Math.PI / 2).rotateZ(-0.7).translate(0.31, 0.58, 0)],
      ['tag', egg([0.035, 0.035, 0.02], [0.42, 0.48, 0.0], seg)],
    ]
    : [
      ['body', egg([0.36, 0.22, 0.21], [0, 0.43, 0], seg)],
      ['cream', egg([0.26, 0.13, 0.17], [0.05, 0.34, 0], seg)],
      ['body', egg([0.16, 0.18, 0.17], [0.27, 0.52, 0], seg)],
    ];

  const head = dog
    ? {
      at: [0.34, 0.65, 0],
      lumps: [
        ['body', egg([0.24, 0.22, 0.23], [0.1, 0.14, 0], seg)],
        ['patch', egg([0.08, 0.08, 0.07], [0.26, 0.21, 0.12], seg)],
        ['cream', egg([0.13, 0.1, 0.14], [0.3, 0.05, 0], seg)],
        ['nose', egg([0.045, 0.035, 0.05], [0.43, 0.09, 0], seg)],
        ['cheek', egg([0.04, 0.025, 0.03], [0.26, 0.06, 0.17], seg)],
        ['cheek', egg([0.04, 0.025, 0.03], [0.26, 0.06, -0.17], seg)],
      ],
    }
    : {
      at: [0.34, 0.63, 0],
      lumps: [
        ['body', egg([0.25, 0.22, 0.24], [0.12, 0.14, 0], seg)],
        ['cream', egg([0.1, 0.075, 0.13], [0.31, 0.06, 0], seg)],
        ['nose', egg([0.03, 0.022, 0.035], [0.4, 0.1, 0], seg)],
        ['cheek', egg([0.04, 0.025, 0.03], [0.27, 0.07, 0.17], seg)],
        ['cheek', egg([0.04, 0.025, 0.03], [0.27, 0.07, -0.17], seg)],
        ['body', new THREE.ConeGeometry(0.085, 0.17, seg).rotateZ(0.2).translate(0.06, 0.38, -0.13)],
        ['pink', new THREE.ConeGeometry(0.05, 0.11, seg).rotateZ(0.2).translate(0.085, 0.36, -0.13)],
      ],
    };

  return {
    body,
    head,
    eyes: {
      at: dog ? [0.31, 0.19, 0] : [0.34, 0.18, 0],
      lumps: [
        ['eye', egg([0.038, 0.055, 0.034], [0, 0, 0.095], seg)],
        ['eye', egg([0.038, 0.055, 0.034], [0, 0, -0.095], seg)],
        ['shine', egg([0.016, 0.016, 0.016], [0.02, 0.022, 0.122], seg)],
        ['shine', egg([0.016, 0.016, 0.016], [0.02, 0.022, -0.122], seg)],
      ],
    },
    // The cat's near ear, on its own so that it can twitch.
    ear: dog ? null : {
      at: [0.06, 0.3, 0.13],
      lumps: [
        ['body', new THREE.ConeGeometry(0.085, 0.17, seg).rotateZ(0.2).translate(0, 0.08, 0)],
        ['pink', new THREE.ConeGeometry(0.05, 0.11, seg).rotateZ(0.2).translate(0.025, 0.06, 0)],
      ],
    },
    // The dog's ears hang from the top of his head, both together.
    ears: dog ? {
      at: [0.06, 0.3, 0],
      lumps: [
        ['ear', egg([0.065, 0.16, 0.04], [-0.03, -0.12, 0.215], seg, { x: -0.12 })],
        ['ear', egg([0.065, 0.16, 0.04], [-0.03, -0.12, -0.215], seg, { x: 0.12 })],
      ],
    } : null,
    tongue: dog ? {
      at: [0.36, -0.01, 0],
      lumps: [['tongue', egg([0.035, 0.05, 0.04], [0, -0.04, 0], seg)]],
    } : null,
    tail: dog
      ? {
        at: [-0.34, 0.53, 0],
        lumps: [
          ['body', roll([[0.04, -0.02, 0], [-0.07, 0.07, 0], [-0.1, 0.19, 0], [-0.07, 0.29, 0]], 0.042, seg)],
          ['body', egg([0.042, 0.042, 0.042], [-0.07, 0.29, 0], seg)],
        ],
      }
      : {
        at: [-0.32, 0.5, 0],
        lumps: [
          ['body', roll([[0.04, -0.02, 0], [-0.1, 0.05, 0], [-0.2, 0.2, 0], [-0.18, 0.38, 0], [-0.1, 0.46, 0]], 0.045, seg)],
          ['cream', egg([0.05, 0.05, 0.05], [-0.1, 0.46, 0], seg)],
        ],
      },
    legs: [
      ['fn', 0.21, 0.11], ['ff', 0.21, -0.11], ['bn', -0.22, 0.11], ['bf', -0.22, -0.11],
    ].map(([name, x, z]) => ({ name, at: [x, 0.34, z], lumps: leg(0.3, dog ? 0.06 : 0.055, 'cream', seg) })),
  };
}

/**
 * Where every moving part is, in one frame of one loop. Angles in radians.
 *
 * The run: legs in diagonal pairs, as a trot; two bounces of the body to a
 * stride; the tail streaming. The parrot hops instead, once a loop, wings
 * going. The rest: mostly nothing, which is the point of it, with a swish or
 * a wag, a blink, an ear, a tilt of the head, each at its own place in the
 * loop. Its last frame is the plain pose, which is the one a device asking
 * for less motion is left showing.
 */
function critterPose(kind, loop, frame) {
  const pose = { lift: 0, nod: 0, tilt: 0, tail: 0, ear: 0, ears: 0, tongue: 1, blink: 1, wings: 0, legs: {} };
  if (loop === 'run') {
    const phase = (frame / CRITTER_FRAMES.run) * Math.PI * 2;
    if (kind === 'parrot') {
      const hop = Math.sin((frame / CRITTER_FRAMES.run) * Math.PI);
      pose.lift = 0.13 * hop;
      pose.wings = 0.35 + 0.35 * Math.sin(phase * 2);
      pose.tail = -0.2 * hop;
      pose.nod = -0.08 * hop;
      pose.legs = { fn: 0.35 * hop, bn: 0.35 * hop };
      return pose;
    }
    const stride = 0.6 * Math.sin(phase);
    pose.legs = { fn: stride, bf: stride, ff: -stride, bn: -stride };
    pose.lift = 0.035 * Math.abs(Math.sin(phase));
    pose.nod = -0.05 * Math.sin(phase * 2);
    pose.tail = kind === 'dog' ? 0.45 * Math.sin(phase * 2) : -0.2 + 0.2 * Math.sin(phase);
    pose.ears = 0.2 * Math.sin(phase * 2);
    if (kind === 'dog') pose.tongue = 1.35;
    return pose;
  }

  const wave = (from, to, beats) => (frame >= from && frame <= to
    ? Math.sin(((frame - from) / (to - from)) * Math.PI * beats)
    : 0);
  if (kind === 'cat') {
    pose.tail = 0.32 * wave(0, 10, 2);
    if (frame === 12 || frame === 13) pose.ear = 0.35;
    pose.tilt = 0.14 * wave(15, 21, 1);
    if (frame === 18) pose.blink = 0.12;
  } else if (kind === 'dog') {
    pose.tail = 0.5 * wave(0, 8, 4);
    if (frame <= 8) pose.tongue = frame % 2 ? 1.3 : 1;
    pose.tilt = -0.16 * wave(10, 18, 1);
    pose.ears = 0.12 * wave(10, 18, 1);
    if (frame === 20) pose.blink = 0.12;
  } else {
    pose.nod = 0.18 * wave(3, 9, 3);
    if (frame === 14) pose.blink = 0.12;
    pose.tail = 0.15 * wave(10, 13, 1);
    pose.wings = 0.7 * wave(18, 21, 1);
  }
  return pose;
}

/**
 * How far each animal's head is turned toward the camera, in radians. It
 * runs side-on, which is the only way a run can be seen, and looks at you
 * while it does — which is where a face is, and a face is what makes it cute.
 */
const LOOK = -0.75;

/**
 * The finished strips of frames, by animal, for as long as the page is open.
 * Kept here rather than on a board, because a board can be taken down and
 * put up again — a change of style — and the animals should not be drawn
 * twice for it.
 */
const CRITTER_SHEETS = new Map();

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
  /** Animals waiting to be drawn, and how far each has got. See critterSheet(). */
  #critterJobs = [];
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
  /** The board's own surface, which the move dots lie on. See #dotOnRay. */
  #boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_Y);

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
  /**
   * How far the pieces are leaning away from the camera, now, in degrees.
   *
   * A zoom level's `lean`, or on the way from one level's to the next while
   * the camera swings between them. See BOARD_ZOOM_LEVELS for what it is for
   * and #standPiece for how it is put on.
   */
  #lean = 0;
  /**
   * How far down its frame the picture has been slid, as a fraction of the
   * frame's height. See #cameraSeat, which decides it, and #slideView.
   */
  #drop = 0;
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
  /** The targets with nothing on them, which are marked by a dot. */
  #dots = new Set();

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
    // board does — and further again where the piece leans as well, by as
    // much as the zoom level that leans them most puts a king's head over.
    const lean = Math.max(...BOARD_ZOOM_LEVELS.map((level) => level.lean ?? 0));
    const s = HALF + RIM + 1.1 + Math.sin(THREE.MathUtils.degToRad(lean)) * PIECE_HEIGHT.k;
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
   * Draw the tiles into one canvas texture.
   *
   * Each square is painted as a tile pressed into the tray: a face with
   * rounded corners, and around it the rolled edge where the tile turns down
   * into the gap. That edge is lit from one side and shaded on the other, and
   * which side is fixed in the texture rather than worked out per view — the
   * key light does not move when the camera does, so neither does the side of
   * a tile it falls on. It is what makes sixty-four flat quads read as
   * sixty-four separate tiles, at a thousandth of the cost of modelling them.
   *
   * Nothing else is painted on them. The coordinates — a to h along the
   * near edge, 1 to 8 up the left — were painted here too, and the texture
   * was drawn again on every flip so that they faced whoever was reading
   * them. They were removed at the player's request, "on board remove
   * 123456789 and letter", and with them the redraw on a flip and the
   * second redraw once the page's typeface had loaded. The texture now
   * changes only with the theme.
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

    const texture = new THREE.CanvasTexture(canvas);
    /*
       Linear, not nearest.

       Nearest was the right call when a square was one flat colour: it kept
       the boundary between two fields perfectly crisp. Now that each tile
       carries a drawn edge, nearest samples that fine detail into hard
       stair-steps. Anisotropy is what keeps the far rank crisp at this
       camera angle — without it the tiles' edges smear into mush a couple of
       ranks out.
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
   *
   * The answer is a place to sit and a `drop`: how far the picture is slid
   * down its frame from there. The camera looks at the middle of the board,
   * and the middle of the board is not the middle of what has to be seen —
   * above the far rank there are the heads of the pieces standing on it, and
   * below the near one only the front of the slab. Where the board fills the
   * frame's height, at Large, that difference is all the room there is: the
   * far king's crown would be the thing the board is shrunk to fit, with the
   * same amount going spare under the near rank. So what has to fit from top
   * to bottom is the picture's height, and the picture is then slid to where
   * it fits. At Fit the board is wide and short in its frame, nothing is
   * near the top or the bottom, and the drop comes out as nothing.
   *
   * @returns {{position: THREE.Vector3, drop: number}}
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
    // Its head is where this level leans it to — away from the camera, which
    // is up the frame. See `lean` in BOARD_ZOOM_LEVELS.
    const lean = THREE.MathUtils.degToRad(level.lean ?? 0);
    const up = PIECE_HEIGHT.k * Math.cos(lean);
    const back = -side * PIECE_HEIGHT.k * Math.sin(lean);
    for (const x of [-stand, stand]) {
      for (const z of [-stand, stand]) {
        corners.push(new THREE.Vector3(x, BOARD_Y + up, z + back));
      }
    }

    // Measured with the picture where the lens puts it, whatever slide the
    // camera is wearing at the moment.
    const probe = this.#camera.clone();
    probe.clearViewOffset();
    let distance = 12;
    let drop = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      probe.position.copy(direction).multiplyScalar(distance);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld(true);
      probe.updateProjectionMatrix();

      let across = 0;
      let top = -Infinity;
      let bottom = Infinity;
      for (const corner of corners) {
        const ndc = corner.clone().project(probe);
        across = Math.max(across, Math.abs(ndc.x));
        top = Math.max(top, ndc.y);
        bottom = Math.min(bottom, ndc.y);
      }
      // Half the picture's height, not its further edge from the middle: it
      // is about to be slid to where it fits.
      const extent = Math.max(across, (top - bottom) / 2);
      if (!Number.isFinite(extent) || extent <= 0) break;

      const correction = extent / FRAME_FILL;
      // No further than it takes to bring the edge that is over back inside.
      // The frame is two units high in these coordinates, hence the halves.
      const over = top / correction - FRAME_FILL;
      const under = bottom / correction + FRAME_FILL;
      drop = over > 0 ? over / 2 : Math.min(0, under) / 2;
      if (Math.abs(correction - 1) < 0.005) break;
      distance *= correction;
    }

    return { position: direction.multiplyScalar(distance), drop };
  }

  /**
   * Slide the picture down a camera's frame by `drop` of the frame's height.
   *
   * Done in the lens, as the offset three.js keeps for drawing one view
   * across several screens, and not by pointing the camera somewhere else.
   * Everything that asks where a thing is drawn or what a press is on asks
   * through the camera's projection, so it all follows without being told;
   * and the camera goes on looking at the middle of the board, which is what
   * a flip swings it round.
   */
  #slideView(camera, drop) {
    // The offset is where the window sits in a taller picture, so it runs
    // the other way from the picture.
    if (drop) camera.setViewOffset(1, 1, 0, -drop, 1, 1);
    else camera.clearViewOffset();
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
    probe.position.copy(seat.position);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld(true);
    this.#slideView(probe, seat.drop);

    // The two bottom corners of the slab on the side nearest the camera, a
    // little in from the ends: the tray's corners are rounded.
    const near = (Math.sign(seat.position.z) || 1) * (HALF + RIM);
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
    const seat = this.#cameraSeat(side);
    const lean = (BOARD_ZOOM_LEVELS[this.#zoom] ?? BOARD_ZOOM_LEVELS[0]).lean ?? 0;
    this.#placeGroundShadow(seat);

    if (!animate || prefersReducedMotion()) {
      this.#camera.position.copy(seat.position);
      this.#camera.lookAt(0, 0, 0);
      this.#setView(seat.drop, lean);
      this.#needsRender = true;
      return;
    }

    this.#cameraSpin = {
      from: this.#camera.position.clone(),
      to: seat.position,
      // The slide and the pieces' lean go with the camera, so that a change
      // of board size is one motion: the view tips up and the pieces stay
      // standing in it. A flip changes neither amount.
      dropFrom: this.#drop,
      dropTo: seat.drop,
      leanFrom: this.#lean,
      leanTo: lean,
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

  /**
   * Put the camera's slide and the pieces' lean where a seat has them.
   *
   * The two things about a view that are not where the camera is. Called
   * after the camera has been put where it is going, because the lean is
   * away from wherever that is: a flip changes neither amount, and still has
   * to turn every piece's lean round the board with the camera, a frame at a
   * time. With no lean there is nothing to turn.
   */
  #setView(drop, lean) {
    if (drop !== this.#drop) {
      this.#drop = drop;
      this.#slideView(this.#camera, drop);
    }
    if (lean !== this.#lean || lean !== 0) {
      this.#lean = lean;
      this.#pieceGroup?.children.forEach((group) => this.#standPiece(group));
    }
  }

  /**
   * Stand a piece the way the board is drawing them: leaning away from the
   * camera by #lean, or bolt upright when that is nothing.
   *
   * Tipped back whole, about a hinge under the middle of its foot. A piece
   * tipped back by as many degrees as the camera has been raised is seen
   * from exactly the angle it was seen from before the camera went up, so
   * it looks as it did: the same height, the same crown, the same everything.
   * That is the whole point of it. See `lean` in BOARD_ZOOM_LEVELS.
   *
   * It was a shear first: each level of the piece slid back and otherwise
   * left alone, which keeps the foot flat on its tile and is the tidier
   * piece of geometry. It also looked wrong. A sheared piece has the height
   * of one seen from the side and the top of one seen from above — a
   * queen's crown a full round ring on a tall body — and the board that had
   * it came back as "tall but not nice", which those round tops are taken
   * to be what was meant. What the hinge costs is the foot, which is no
   * longer flat: its front edge is a tenth of a square off the board and
   * its back edge as far into it. From this high up that is a pixel, under
   * the piece's own shadow.
   *
   * Three things about where it goes. It is on the mesh inside the piece
   * and not on the piece, so that the turn and the scale the rest of this
   * file gives a piece are left alone. It is in the piece's own bearings,
   * so for a black piece, which has been turned about to face the white
   * ones, "away from the camera" is the other way. And the camera's
   * direction is taken across the board only — which way round the board
   * it is, not how high.
   */
  #standPiece(group) {
    const body = group.children[0];
    if (!body) return;
    const { x, z } = this.#camera.position;
    const away = Math.hypot(x, z) || 1;
    // Flat on the board and square across the camera's line of sight, the
    // way round that takes the head away from the camera — and then carried
    // into the piece's own bearings by undoing the turn the piece actually
    // has, read off the piece rather than assumed from its colour.
    const hinge = new THREE.Vector3(-z / away, 0, x / away)
      .applyQuaternion(group.quaternion.clone().invert());
    body.matrixAutoUpdate = false;
    body.matrix.makeRotationAxis(hinge, THREE.MathUtils.degToRad(this.#lean));
    body.matrixWorldNeedsUpdate = true;
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
   * For the taken pieces on the players' cards, which were Unicode glyphs
   * and so were the one place in the app still showing a flat chess set next
   * to a solid one. This builds the real piece — the same baked lumps, the
   * same clay and the same soft key light — and reads it back as an image,
   * so a captured knight is the knight that was on the board rather than a
   * different artist's idea of one. The promotion picker shows the same
   * picture, of the four pieces a pawn can become. See PORTRAIT.
   *
   * Rendered once per piece and cached: ten pictures in a game, kings never
   * being asked for.
   *
   * Drawn through a render target rather than the visible canvas, so the live
   * frame is never disturbed and no second WebGL context is created — browsers
   * cap those per page, and this board already has to be careful about it.
   *
   * @returns {string|null} a PNG data URL, or null if it could not be drawn.
   */
  pieceSprite(type, color) {
    if (this.#disposed || !this.#renderer || !THREE) return null;
    const { size, tallest } = PORTRAIT;
    const key = `${color}${type}`;
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
        tile: the contrast comes from behind it. On a card or in the picker
        there is no tile, and a charcoal piece is one flat shape. Lighting it
        from behind and above draws a bright edge around the silhouette,
        which is how the shape survives at this size — the same reason a
        cinematographer puts a light behind a dark subject.

        Stronger for black than white, because too much rim on a white piece
        only blows the highlight out.
      */
      const rim = new THREE.DirectionalLight(0xffffff, color === 'b' ? 2.4 : 0.6);
      rim.position.set(0.6, 2.0, -2.4);
      scene.add(rim);

      group = this.#makePiece({ type, color });
      // Shadows need a floor to land on, and there is none here.
      group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      scene.add(group);

      // Centre the piece on the origin from side to side, so the camera can
      // simply look at it, and put its foot where the tallest piece's foot
      // would be: every piece then has its feet on the same line of its
      // picture, and a row of the pictures is a row of pieces on one floor.
      const box = new THREE.Box3().setFromObject(group);
      const centre = box.getCenter(new THREE.Vector3());
      centre.y = box.min.y + PIECE_HEIGHT[tallest] / 2;
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
        destroys the set: a pawn is two thirds of a queen's height, so
        filling the frame with it renders a pawn the same size as a queen,
        and a row of taken pieces stops reading as chess pieces at all.
        Sizing to the queen once means a pawn is the fraction of her it is on
        the board, and a rook is shorter than she is.

        A close frame: the queen's height and an eighth over. It was two
        thirds over while the set was squat, because a squat piece is nearly
        as wide as it is tall and needed the room at the sides. A tall one
        does not, and in a frame that loose it is a sliver in the middle of
        an empty tile. The knight is the broad one, at nine tenths of a
        square from muzzle to mane, and that is still under half of this.
      */
      const radius = PIECE_HEIGHT[tallest] / 2;
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
   * the first thing taken. No kings, which never are. The promotion picker
   * shows the same pictures, so these ten are all of them.
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

  /**
   * One of the animals on the lawn, drawn in clay as a strip of frames.
   *
   * Resolves with `{ url, columns, rows, run, rest, width, height }`: a
   * picture of every frame side by side, the run along the top row and the
   * rest along the bottom one, `columns` frames wide; or null, if it could
   * not be drawn. The page plays it (see "The animals on the lawn" in
   * style.css): the frames are the movement, and only running along the
   * grass is left to the page, which is the part it does for free.
   *
   * Why frames, and not the animal itself moving in a scene of its own: the
   * grass the animals run on is the page, outside this board's canvas, and a
   * canvas of their own would be a second WebGL context — browsers allow a
   * page few — drawing all the time. Drawn once, here, through the board's
   * renderer and its own clay and light, they are the same stuff as the
   * pieces and cost nothing after.
   *
   * Drawn a frame at a time, with a pause between, and never while anything
   * on the board is moving: thirty-four frames each, and a frame is a render
   * and a read back off the GPU. Kept for the page's lifetime; see
   * CRITTER_SHEETS.
   */
  critterSheet(kind) {
    if (!CRITTER_CLAY[kind]) return Promise.resolve(null);
    const kept = CRITTER_SHEETS.get(kind);
    if (kept?.board === this) return kept.promise;
    // Being drawn by a board that has since been taken down — the style
    // changed, or its context was lost — which gives up on it unfinished.
    // This one takes over if it does.
    if (kept) {
      return kept.promise.then((sheet) => sheet ?? (this.#disposed ? null : this.critterSheet(kind)));
    }

    const promise = new Promise((resolve) => {
      this.#critterJobs.push({ kind, frame: 0, resolve });
      if (this.#critterJobs.length === 1) setTimeout(() => this.#drawCritters(), 400);
    });
    CRITTER_SHEETS.set(kind, { promise, board: this });
    // A sheet this board could not finish is forgotten, so that it can be
    // tried again. See #drawCritters.
    promise.then((sheet) => {
      if (!sheet && CRITTER_SHEETS.get(kind)?.promise === promise) CRITTER_SHEETS.delete(kind);
    });
    return promise;
  }

  /** Draw the next frame of the first animal waiting, then come back. */
  #drawCritters() {
    const job = this.#critterJobs[0];
    if (!job) return;
    if (this.#disposed || !this.#renderer) {
      this.#critterJobs.splice(0).forEach((waiting) => {
        waiting.rig?.dispose();
        waiting.target?.dispose();
        waiting.resolve(null);
      });
      return;
    }

    const busy = this.#animations.length > 0 || this.#cameraSpin || this.#drag || this.#warmFrames > 0;
    if (busy) {
      setTimeout(() => this.#drawCritters(), 250);
      return;
    }

    try {
      this.#drawCritterFrame(job);
    } catch (error) {
      warn('Could not draw an animal', error);
      this.#critterJobs.shift();
      job.rig?.dispose();
      job.target?.dispose();
      job.resolve(null);
      setTimeout(() => this.#drawCritters(), 60);
      return;
    }

    const total = CRITTER_FRAMES.run + CRITTER_FRAMES.rest;
    if (job.frame < total) {
      setTimeout(() => this.#drawCritters(), 30);
      return;
    }

    // Done: hand the strip over as a picture, and start on the next animal.
    this.#critterJobs.shift();
    job.rig.dispose();
    job.target.dispose();
    const { width, height } = CRITTER_FRAME;
    const sheet = {
      columns: job.columns, rows: 2, run: CRITTER_FRAMES.run, rest: CRITTER_FRAMES.rest, width, height,
    };
    const finish = (url) => job.resolve(url ? { ...sheet, url } : null);
    if (typeof job.canvas.toBlob === 'function') {
      job.canvas.toBlob((blob) => finish(blob ? URL.createObjectURL(blob) : null), 'image/png');
    } else {
      finish(job.canvas.toDataURL('image/png'));
    }
    setTimeout(() => this.#drawCritters(), 60);
  }

  /**
   * Draw one frame of an animal into its strip.
   *
   * The first frame also builds what every frame needs: the animal, the
   * scene and light it stands in — the portraits' light, as the pieces in
   * the picker have — the camera, and the strip itself.
   *
   * The camera is a little in front of the animal's side and a little
   * above, so that a face can be seen as well as a run; and it does not
   * shrink with distance, because every frame of every animal has to stand
   * on the same line of grass at the same size.
   */
  #drawCritterFrame(job) {
    const { width, height } = CRITTER_FRAME;
    if (!job.rig) {
      job.rig = this.#critterRig(job.kind);
      job.columns = Math.max(CRITTER_FRAMES.run, CRITTER_FRAMES.rest);
      job.canvas = document.createElement('canvas');
      job.canvas.width = width * job.columns;
      job.canvas.height = height * 2;
      job.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
      job.target.texture.colorSpace = THREE.SRGBColorSpace;
      job.pixels = new Uint8Array(width * height * 4);

      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xf3e8d2, 1.6));
      const key = new THREE.DirectionalLight(0xfffbf4, 2.1);
      key.position.set(-1.4, 2.4, 2.2);
      const fill = new THREE.DirectionalLight(0xe8f0ff, 0.45);
      fill.position.set(2.2, 1.2, 1.6);
      const rim = new THREE.DirectionalLight(0xffffff, 0.8);
      rim.position.set(0.6, 2.0, -2.4);
      scene.add(key, fill, rim, job.rig.root);
      job.scene = scene;

      // How much of the animal's world the frame holds, with its feet a
      // little above the frame's bottom edge: see CRITTER_VIEW.
      const view = CRITTER_VIEW[job.kind];
      const wide = view.tall * (width / height);
      const camera = new THREE.OrthographicCamera(-wide / 2, wide / 2, view.tall / 2, -view.tall / 2, 0.1, 20);
      const toward = new THREE.Vector3(0.34, 0.3, 1).normalize();
      // The feet stand this far above the bottom of the frame, in units.
      const footroom = 0.07;
      const level = Math.hypot(toward.x, toward.z);
      const target = new THREE.Vector3(view.x, (view.tall / 2 - footroom) / level, 0);
      camera.position.copy(target).addScaledVector(toward, 6);
      camera.lookAt(target);
      job.camera = camera;
    }

    const loop = job.frame < CRITTER_FRAMES.run ? 'run' : 'rest';
    const index = loop === 'run' ? job.frame : job.frame - CRITTER_FRAMES.run;
    job.rig.pose(critterPose(job.kind, loop, index));

    const renderer = this.#renderer;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(job.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(job.scene, job.camera);
    renderer.readRenderTargetPixels(job.target, 0, 0, width, height, job.pixels);
    renderer.setRenderTarget(previous);

    // WebGL reads bottom-up; a canvas is top-down. As in pieceSprite().
    const image = new ImageData(width, height);
    for (let row = 0; row < height; row += 1) {
      const from = (height - 1 - row) * width * 4;
      image.data.set(job.pixels.subarray(from, from + width * 4), row * width * 4);
    }
    job.canvas.getContext('2d').putImageData(image, index * width, (loop === 'run' ? 0 : 1) * height);
    job.frame += 1;
  }

  /**
   * One animal, built from critterModel() in the pieces' clay, with a
   * handle on every part that moves and a pose() that sets them all.
   *
   * Its geometry is its own — it is drawn and done with, unlike a piece's,
   * which is shared and cached — and dispose() frees it. The material is
   * the pieces' and is not.
   */
  #critterRig(kind) {
    const spec = critterModel(kind, this.#richDetail ? 24 : 16);
    const pigments = CRITTER_CLAY[kind];
    const material = this.#pieceMaterial();
    const geometries = [];
    const mesh = (lumps) => {
      const geometry = bake(lumps, pigments);
      geometries.push(geometry);
      return new THREE.Mesh(geometry, material);
    };

    const root = new THREE.Group();
    const lift = new THREE.Group();
    root.add(lift);
    lift.add(mesh(spec.body));
    const part = (piece, parent) => {
      if (!piece) return null;
      const group = new THREE.Group();
      group.position.set(...piece.at);
      group.add(mesh(piece.lumps));
      parent.add(group);
      return group;
    };
    const head = part(spec.head, lift);
    const eyes = part(spec.eyes, head);
    const ear = part(spec.ear, head);
    const ears = part(spec.ears, head);
    const tongue = part(spec.tongue, head);
    const tail = part(spec.tail, lift);
    const legs = spec.legs.map((piece) => ({ name: piece.name, group: part(piece, lift) }));
    const wings = (spec.wings ?? []).map((piece) => ({ side: piece.side, group: part(piece, lift) }));

    return {
      root,
      pose(p) {
        lift.position.y = p.lift;
        head.rotation.set(p.tilt, LOOK, p.nod);
        eyes.scale.y = p.blink;
        if (ear) ear.rotation.z = p.ear;
        if (ears) ears.rotation.z = p.ears;
        if (tongue) tongue.scale.y = p.tongue;
        tail.rotation.z = p.tail;
        legs.forEach(({ name, group }) => { group.rotation.z = p.legs[name] ?? 0; });
        wings.forEach(({ side, group }) => { group.rotation.x = -side * p.wings; });
      },
      dispose() {
        geometries.forEach((geometry) => geometry.dispose());
      },
    };
  }

  render(snapshot, options = {}) {
    const { state, view } = snapshot;
    if (!state || this.#disposed) return;

    if (snapshot.settings?.boardTheme && snapshot.settings.boardTheme !== this.#theme) {
      this.#theme = snapshot.settings.boardTheme;
      this.#refreshBoardTexture();
    }

    // Nothing turns this off. Not the device's reduced-motion preference —
    // see prefersReducedMotion() for why — and not a setting of the game's
    // own, which there was and no longer is.
    const move = options.animateMove ?? null;

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
    this.#dots = new Set((view?.legalTargets ?? [])
      .filter((target) => !target.isCapture).map((target) => target.to));

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
        // Turned to face the other side as it is made, and before it is
        // stood: the lean is worked out from which way the piece is turned.
        //
        // The turn used to be given further down, with the position, to a
        // piece that is not being animated — and a piece that has just moved
        // is a new one, made here, that IS being animated. So every black
        // piece crossed the board facing White's way and stayed like that
        // until something else redrew the board: a knight looking backwards,
        // a pawn with its spear in the other hand. With a lean it was worse
        // than backwards. The lean was put on for a piece that had been
        // turned, on one that had not, so it tipped towards the camera
        // instead of away, and at Large a black piece bowed as it moved.
        group.rotation.y = group.userData.faces === -1 ? Math.PI : 0;
        this.#standPiece(group);
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
      marker.material.depthFunc = THREE.LessEqualDepth;
      marker.renderOrder = 0;
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
      marker.scale.setScalar(target.isCapture ? 0.92 : DOT.radius * 2);

      /*
        And the part of a dot a piece is standing in front of, drawn over that
        piece. A tall piece covers the square beyond it — the selected piece
        most of all, whose own head is drawn over the middle of the square
        straight past it — and a dot nobody can see is a move nobody knows is
        there. A press there means the move: see #dotOnRay.

        Only that part, by drawing it where the depth test fails: where
        something nearer the eye is already drawn, which on a dot lying on the
        board is exactly a piece in front of it. And in the selection's blue,
        because the dot's own colour is chosen against its tile, and a brown
        dot faint enough for a cream tile is nothing at all on a black crown.
      */
      if (!target.isCapture) {
        const through = place(target.to, HIGHLIGHT.legalThrough, 0.01, 'disc');
        through.scale.setScalar(DOT.radius * 2);
        through.material.depthFunc = THREE.GreaterDepth;
        through.renderOrder = 1;
      }
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
      this.#setView(
        spin.dropFrom + (spin.dropTo - spin.dropFrom) * k,
        spin.leanFrom + (spin.leanTo - spin.leanFrom) * k,
      );
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
   * Before any of that, the move dots. They are drawn over the pieces, so a
   * press on one is that move whatever stands in front of it: see #dotOnRay.
   *
   * `carried` is a piece in the player's hand. It is left out, or every drop
   * would land on the piece being dropped. A hand that is already holding a
   * piece is not picking up another, so only a square that piece may move to
   * counts, and nothing stands in its way.
   */
  #squareOnRay(carried = null) {
    const dot = this.#dotOnRay();
    if (dot) return dot;

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
   * The square whose move dot the line of sight is on, if it is on one.
   *
   * Reported as "I still can't click this front board", with a picture of
   * the black queen selected: the square straight past her was a move, and
   * her own crown was drawn over the middle of it, dot and all. A press
   * there met the queen first, and a press on the selected piece puts it
   * down — so the move took a press on the strip of that square showing
   * either side of her, and the obvious press let go of her instead. Only
   * 40% of that square answered to its own move. The same is true, less
   * badly, of any square behind a tall piece of your own.
   *
   * The dots are drawn over the pieces now, and this is the other half: the
   * line of sight is followed to the board itself, through whatever stands
   * on it, and if it lands within reach of a dot, that is the press. Where
   * a dot is drawn, a press means that move — the same rule as everywhere
   * else on this board, that what is drawn under the pointer is what was
   * pressed. The reach is a little wider than the dot and no more, so the
   * head of a piece standing in front of a move is still that piece's
   * everywhere off the dot.
   */
  #dotOnRay() {
    if (!this.#dots.size) return null;
    const ground = this.#raycaster.ray.intersectPlane(this.#boardPlane, new THREE.Vector3());
    if (!ground) return null;
    const square = this.#worldToSquare(ground);
    if (!square || !this.#dots.has(square)) return null;
    const middle = this.#squareToWorld(square);
    return Math.hypot(ground.x - middle.x, ground.z - middle.z) <= DOT.reach ? square : null;
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
      lean: this.#lean,
      drop: this.#drop,
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
        // On the axis as it is drawn, which leans: see #standPiece.
        const lean = THREE.MathUtils.degToRad(this.#lean);
        const up = height * 0.8 * Math.cos(lean);
        const away = Math.hypot(this.#camera.position.x, this.#camera.position.z) || 1;
        const back = (-height * 0.8 * Math.sin(lean)) / away;
        const ndc = group.position.clone()
          .add(new THREE.Vector3(this.#camera.position.x * back, up, this.#camera.position.z * back))
          .project(this.#camera);
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
