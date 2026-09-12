/**
 * avatar.js
 * Turning a picture the player chose into something small enough to keep.
 *
 * A profile picture arrives as whatever the camera roll had: a 12-megapixel
 * JPEG, a screenshot, an 8MB PNG. None of that can be stored — localStorage is
 * a handful of megabytes for the whole origin, and online the picture has to
 * travel through the room document to the other device. So nothing is ever
 * stored as picked. Every picture is cropped to a centred square, scaled to
 * AVATAR_SIZE and re-encoded until it fits AVATAR_MAX_CHARS, which is the only
 * form the rest of the app ever sees.
 *
 * Re-encoding is also what makes the result safe to render. Whatever came in —
 * an SVG with a script in it, a file claiming to be a PNG, a data URL a peer
 * wrote by hand — what comes out is pixels this app drew itself, in a raster
 * format, and isAvatar() is the gate everything else checks before putting one
 * in an `img`.
 */

import { warn } from './config.js';

/** Edge length of the stored square, in pixels. */
export const AVATAR_SIZE = 128;

/**
 * Largest stored data URL, in characters.
 *
 * 128px of photograph lands around 5-8KB as WebP or JPEG, so this is roughly
 * three times the expected size rather than a limit anything normally meets.
 * It matters most online: this same number is the cap in the security rules,
 * and it is what stops a room document being used as free file hosting.
 */
export const AVATAR_MAX_CHARS = 24 * 1024;

/**
 * Edge length and budget for the copy that goes online.
 *
 * Smaller than the stored one, because of where it ends up. Every move is
 * written as a transaction over the whole room document, and the seats are
 * part of that document — so a picture in a seat is not sent once, it is sent
 * again on every move, by both players, for the length of the game. At the
 * stored budget that is a photograph's worth of upload per move on a phone.
 *
 * 96px costs nothing visually: the only place an avatar is ever drawn is a
 * player card, which is 38px at its largest, so even a 3x screen has more
 * pixels than it can use. The 6KB budget is what actually binds, and it is the
 * number the security rules carry too — rules and client have to agree, and
 * the rules are the half that a modified client cannot talk its way past.
 */
export const ONLINE_AVATAR_SIZE = 96;
export const ONLINE_AVATAR_MAX_CHARS = 6 * 1024;

/**
 * Largest file we will even try to decode.
 *
 * Not about storage — nothing this big is ever stored — but about memory. A
 * decoded image costs four bytes a pixel whatever it weighed on disk, so a
 * phone can be pushed over by a file its own gallery opened happily.
 */
export const AVATAR_MAX_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * Exactly what this module produces, and nothing else.
 *
 * Deliberately narrow. `data:` is the only scheme allowed, so no avatar can
 * ever point at a remote server and quietly report who looked at the board.
 * The three raster types are the only ones allowed, so an SVG — which is a
 * document rather than a picture, and can carry script — is never one.
 */
const AVATAR_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Is this a picture this app is willing to render?
 *
 * Checked on the way out of storage AND on the way in from the network, not
 * only where pictures are made. Those are the two paths carrying a value this
 * device did not produce itself.
 */
export function isAvatar(value) {
  return typeof value === 'string'
    && value.length <= AVATAR_MAX_CHARS
    && AVATAR_PATTERN.test(value);
}

/**
 * Encodings to try, best first.
 *
 * WebP before JPEG because at this size it is roughly a third smaller for the
 * same picture, and quality steps down before the format does — a slightly
 * softer WebP beats a crisp JPEG at twice the bytes.
 */
const ENCODINGS = [
  ['image/webp', 0.85],
  ['image/webp', 0.7],
  ['image/webp', 0.55],
  ['image/jpeg', 0.85],
  ['image/jpeg', 0.7],
  ['image/jpeg', 0.55],
  ['image/jpeg', 0.4],
];

/** First encoding that both worked and fits the budget, or null. */
function encode(canvas, budget = AVATAR_MAX_CHARS) {
  for (const [type, quality] of ENCODINGS) {
    let url;
    try {
      url = canvas.toDataURL(type, quality);
    } catch (error) {
      warn('Encoder refused', type, error);
      continue;
    }
    // A browser with no WebP encoder does not fail — it silently returns a
    // PNG, which for a photograph is several times over budget. So the prefix
    // is checked rather than assumed, and the JPEG rows below catch it.
    if (!url.startsWith(`data:${type};base64,`)) continue;
    if (url.length <= budget) return url;
  }
  return null;
}

/**
 * Decode the file to something drawable.
 *
 * createImageBitmap first: it decodes off the main thread, so choosing a large
 * picture does not freeze the screen behind the file dialog. `from-image` is
 * the part that matters — without it a photo taken in portrait arrives on its
 * side, because phones record the rotation in EXIF rather than applying it.
 * The `img` fallback gets that for free; it has been the default for images
 * for years.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari rejects the options bag outright rather than ignoring the
      // part it does not know. Sideways is better than nothing.
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to the element path */
      }
    }
  }
  return decodeViaElement(file);
}

function decodeViaElement(file) {
  const url = URL.createObjectURL(file);
  return loadImage(url).finally(() => URL.revokeObjectURL(url));
}

/** An `img` that has finished decoding `src`, or a rejection. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image could not be decoded'));
    image.src = src;
  });
}

/**
 * Crop to a centred square and scale down to AVATAR_SIZE.
 *
 * By halves rather than in one leap. A single drawImage from a 4000px photo to
 * 128px samples about one source pixel per destination pixel and discards the
 * thousand around it, which is exactly what makes a shrunken photograph look
 * like it has been through a fax machine — hair and fabric turn to speckle.
 * Each halving averages four pixels into one, so nothing is skipped, and three
 * or four extra draws at ever-smaller sizes cost nothing anyone can perceive.
 */
function drawSquare(source, sx, sy, side, size = AVATAR_SIZE) {
  let step = { image: source, x: sx, y: sy, size: side };

  while (step.size > size * 2) {
    const next = Math.max(size, Math.round(step.size / 2));
    const half = document.createElement('canvas');
    half.width = next;
    half.height = next;
    const halfCtx = half.getContext('2d');
    halfCtx.imageSmoothingQuality = 'high';
    halfCtx.drawImage(step.image, step.x, step.y, step.size, step.size, 0, 0, next, next);
    step = { image: half, x: 0, y: 0, size: next };
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Flattened onto white before the picture is drawn. JPEG has no alpha, so a
  // transparent PNG would otherwise come back as a black square. Done for
  // every encoding rather than only that one, so what a player sees does not
  // depend on which encoder their browser happens to have.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(step.image, step.x, step.y, step.size, step.size, 0, 0, size, size);
  return canvas;
}

/**
 * Turn a picked file into a stored avatar.
 *
 * Resolves `{ok: true, avatar}` or `{ok: false, error}` — never throws, and
 * never rejects. Most failures here are something about the file rather than
 * something that went wrong, so each one gets wording the player can act on.
 *
 * @param {File} file
 * @returns {Promise<{ok: true, avatar: string}|{ok: false, error: string}>}
 */
export async function fileToAvatar(file) {
  if (!file) return { ok: false, error: 'No picture chosen' };
  if (file.type && !file.type.startsWith('image/')) {
    return { ok: false, error: 'That file is not a picture' };
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) {
    return { ok: false, error: 'That picture is too big to use' };
  }

  let source;
  try {
    source = await decode(file);
  } catch (error) {
    // The common cause on a desktop browser is an iPhone HEIC, which nothing
    // outside Apple's own stack can read. Naming a format that does work is
    // the difference between a dead end and a next step.
    warn('Could not decode picture', error);
    return { ok: false, error: 'That picture could not be read — try a JPEG or PNG' };
  }

  try {
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) return { ok: false, error: 'That picture could not be read' };

    const side = Math.min(width, height);
    const canvas = drawSquare(
      source,
      Math.round((width - side) / 2),
      Math.round((height - side) / 2),
      side,
    );

    const avatar = encode(canvas);
    if (!avatar) return { ok: false, error: 'That picture could not be saved' };
    return { ok: true, avatar };
  } catch (error) {
    // A canvas can be refused outright — some hardened privacy profiles hand
    // back null from getContext rather than a context.
    warn('Could not process picture', error);
    return { ok: false, error: 'This browser cannot process pictures' };
  } finally {
    // An ImageBitmap holds its pixels until told otherwise; an img does not.
    source.close?.();
  }
}

/**
 * The copy of a stored avatar that goes into a room document.
 *
 * Takes an avatar this module already made — so there is no untrusted file
 * here, no EXIF, nothing to crop — and redraws it at ONLINE_AVATAR_SIZE until
 * it fits ONLINE_AVATAR_MAX_CHARS, which is the same number the security rules
 * carry. A picture over that budget is refused by the rules, and a refused
 * field takes the whole room write with it, so a seat must never be offered
 * one this has not been through.
 *
 * An avatar already inside the budget is returned untouched. The rules measure
 * characters, not pixels, and a 128px picture that already fits is a better
 * picture than the same one put through a second generation of lossy encoding
 * for nothing.
 *
 * Returns null rather than throwing for anything that goes wrong, because
 * every caller wants the same thing when it does: seat the player without a
 * picture rather than fail to seat them.
 *
 * @param {string|null} avatar
 * @returns {Promise<string|null>}
 */
export async function toOnlineAvatar(avatar) {
  if (!isAvatar(avatar)) return null;
  if (avatar.length <= ONLINE_AVATAR_MAX_CHARS) return avatar;

  try {
    const image = await loadImage(avatar);
    const side = Math.min(image.naturalWidth || 0, image.naturalHeight || 0);
    if (!side) return null;
    return encode(drawSquare(image, 0, 0, side, ONLINE_AVATAR_SIZE), ONLINE_AVATAR_MAX_CHARS);
  } catch (error) {
    warn('Could not shrink picture for online play', error);
    return null;
  }
}
