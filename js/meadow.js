/**
 * meadow.js
 * The animals on the lawn: a cat and a dog on the grass by the status line,
 * and a parrot along the header.
 *
 * Asked for in three steps: "outside the board should add cute cat, cute dog,
 * cute parrot, have animation", then "make all animation clay style, cute,
 * can run around in grass", then "set all animal clay styles like chess
 * styles". So they are clay, made and lit as the pieces are, and drawn by the
 * 3D board into strips of frames — a run and a rest — which the page plays:
 * see critterSheet() in board-3d.js, and "The animals on the lawn" in
 * style.css. This file hands each animal its strip (dressMeadow), and then
 * decides only WHEN and WHERE: it sends each one off to somewhere else on its
 * strip of grass now and then, turns it to face the way it is going, and lets
 * it rest in between; and it answers a tap with a pat.
 *
 * Where the grass is. On a phone the board runs to both edges of the screen,
 * so there is no lawn beside it at all, and anything that wandered onto the
 * board would stand on squares somebody has to press. The free grass is the
 * strip along the status line and the strip along the header, between its
 * two buttons, and each is a lane: an animal runs along its own and never
 * leaves it.
 *
 * They stay home, and still, for anybody who has asked their device for less
 * motion; they stop to cheer when the game is over; and nothing runs while
 * the page is hidden or the game screen is not the one on show.
 */

import { prefersReducedMotion } from './board-shared.js';

/**
 * How each animal goes about it. Speed in pixels a second; a rest is picked
 * between the two numbers, in milliseconds. `home` is where along its lane it
 * starts, and `facing` which way it looks while it is there: inward, at the
 * words or at the title, rather than off the edge of the screen.
 */
const KINDS = {
  cat: { speed: 105, rest: [1600, 5600], home: 0, facing: 1 },
  dog: { speed: 135, rest: [1100, 4400], home: 1, facing: -1 },
  parrot: { speed: 58, rest: [2400, 6800], home: 0.72, facing: -1 },
};

/** The shortest run worth setting off on, in pixels. */
const SHORTEST_RUN = 56;

/**
 * The heart that floats up from a patted animal. Drawn rather than a ♥
 * character, which some phones paint as a colour emoji.
 */
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21C5 15.6 2 12.4 2 8.4 2 5.4 4.3 3 7.2 3c2 0 3.6 1.1 4.8 2.8C13.2 4.1 14.8 3 16.8 3 19.7 3 22 5.4 22 8.4c0 4-3 7.2-10 12.6Z" fill="#ff6f91" stroke="#c9405f" stroke-width="1.6" stroke-linejoin="round"/></svg>';

const between = ([low, high]) => low + Math.random() * (high - low);

/** True once the game on the board has finished: then they cheer, not run. */
function gameIsOver() {
  return Boolean(document.getElementById('status')?.classList.contains('is-over'));
}

class Critter {
  #el;
  #kind;
  #lane;
  #x = 0;
  #placed = false;
  #timer = null;

  constructor(el) {
    this.#el = el;
    this.#kind = KINDS[el.dataset.pet] ?? KINDS.cat;
    this.#lane = el.parentElement;
    this.#face(this.#kind.facing);
    el.addEventListener('click', () => this.#pat());
    this.#rest();
  }

  /** How far along its lane it can go: the lane's width less its own. */
  #room() {
    return Math.max(0, this.#lane.clientWidth - this.#el.offsetWidth);
  }

  /**
   * Put it somewhere at once, with no run. Used to set it at home the first
   * time its lane has a size, and to bring it back inside when a lane gets
   * narrower under it — a phone turned on its side.
   */
  settle() {
    const room = this.#room();
    if (!room && !this.#lane.clientWidth) return;
    if (!this.#placed) {
      this.#placed = true;
      // From where the stylesheet had it to the same place, by a different
      // road: off its home in CSS, onto --x. Both in one go, so no frame
      // ever has it anywhere else.
      this.#moveTo(room * this.#kind.home, 0);
      this.#el.classList.add('is-placed');
      return;
    }
    if (this.#x > room) this.#moveTo(room, 0);
  }

  #moveTo(x, ms) {
    this.#x = x;
    this.#el.style.setProperty('--run', `${Math.round(ms)}ms`);
    this.#el.style.setProperty('--x', `${x.toFixed(1)}px`);
  }

  #face(direction) {
    this.#el.style.setProperty('--face', String(direction));
  }

  /** Free to set off: drawn, visible, wanted, and the game still going. */
  #free() {
    return this.#el.classList.contains('is-dressed')
      && !document.hidden
      && !prefersReducedMotion()
      && this.#lane.offsetParent !== null
      && !gameIsOver();
  }

  #rest() {
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#run(), between(this.#kind.rest));
  }

  /**
   * Off somewhere else along the lane, at its own speed, facing the way it is
   * going; then a rest. Somewhere at least a short run away, so a run is a
   * run and not a shuffle — unless the lane is too short for one, when it
   * stays where it is.
   */
  #run() {
    this.settle();
    const room = this.#room();
    if (!this.#free() || room < SHORTEST_RUN) {
      this.#rest();
      return;
    }

    let target = this.#x;
    for (let tries = 0; tries < 8 && Math.abs(target - this.#x) < SHORTEST_RUN; tries += 1) {
      target = Math.random() * room;
    }
    if (Math.abs(target - this.#x) < SHORTEST_RUN) {
      this.#rest();
      return;
    }

    const ms = (Math.abs(target - this.#x) / this.#kind.speed) * 1000;
    this.#face(target > this.#x ? 1 : -1);
    this.#el.classList.add('is-running');
    this.#moveTo(target, ms);
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#el.classList.remove('is-running');
      this.#rest();
    }, ms);
  }

  /**
   * A tap is a pat: it hops, and a heart floats up.
   *
   * The hop is restarted rather than queued, so a quick second pat is a
   * second hop and not nothing. The heart is put on the page rather than in
   * the lane, which would clip it, and is placed over the animal where it is
   * at that moment — running or not.
   */
  #pat() {
    const el = this.#el;
    el.classList.remove('is-happy');
    // Reading the layout between the two is what makes the browser see the
    // class come off, and so start the hop again from the beginning.
    void el.getBoundingClientRect();
    el.classList.add('is-happy');
    const done = (event) => {
      if (event.animationName !== 'pet-hop') return;
      el.classList.remove('is-happy');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);

    const box = el.getBoundingClientRect();
    const heart = document.createElement('span');
    heart.className = 'pet-heart';
    heart.setAttribute('aria-hidden', 'true');
    heart.innerHTML = HEART;
    heart.style.left = `${box.left + box.width / 2}px`;
    heart.style.top = `${box.top - 4}px`;
    document.body.append(heart);
    const remove = () => heart.remove();
    heart.addEventListener('animationend', remove);
    // In case no animation ever ends: a page with its animations stopped.
    window.setTimeout(remove, 1500);
  }
}

/**
 * Give each animal its frames, from a board that can draw them.
 *
 * Only the 3D board can: the animals are its clay. Called whenever a board is
 * put up; an animal already dressed keeps what it has — the strips are kept
 * for the page's lifetime — and on the flat board, which has no clay, an
 * animal that was never dressed is simply not shown.
 */
export function dressMeadow(board) {
  if (typeof board?.critterSheet !== 'function') return;
  document.querySelectorAll('.critter:not(.is-dressed)').forEach((el) => {
    board.critterSheet(el.dataset.pet).then((sheet) => {
      if (!sheet || el.classList.contains('is-dressed')) return;
      el.style.setProperty('--sheet', `url("${sheet.url}")`);
      el.classList.add('is-dressed');
    });
  });
}

let hushTimer = null;

/**
 * Hold every animal still for a moment: while a piece is moving on the board,
 * or the board is turning.
 *
 * Whatever they do is painted on the page's own thread, and so is the
 * board's every frame. When they were drawings moved part by part, on a
 * phone-speed processor — four times slowed — a move that ran at 62 frames
 * ran at 50 with them going, which is exactly the uneven move "make moves run
 * evenly" once asked to be rid of; held still, it was 62 again. As clay
 * frames they cost far less, and a frame of a strip held for half a second is
 * not missed, so they still hold. One running along the grass keeps going —
 * that part is the compositor's and free — on the same frame for a moment.
 */
export function hushMeadow(ms) {
  // On the two lanes and not on the page: a class on the page is a restyle of
  // every element on it, in the very frame the move starts.
  const lanes = document.querySelectorAll('.meadow');
  lanes.forEach((lane) => lane.classList.add('is-hushed'));
  window.clearTimeout(hushTimer);
  hushTimer = window.setTimeout(() => {
    lanes.forEach((lane) => lane.classList.remove('is-hushed'));
  }, ms);
}

/**
 * Let the animals out. Called once, when the page is built.
 *
 * Each lane is watched for its size, because the game screen is hidden when
 * the page opens — the lanes have no width until it is shown — and because
 * turning a phone changes how much grass there is.
 */
export function startMeadow(root = document) {
  const lanes = new Map();
  root.querySelectorAll('.critter').forEach((el) => {
    const lane = el.parentElement;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(new Critter(el));
  });

  if (typeof ResizeObserver !== 'function') return;
  const watcher = new ResizeObserver((entries) => {
    entries.forEach((entry) => lanes.get(entry.target)?.forEach((critter) => critter.settle()));
  });
  lanes.forEach((_, lane) => watcher.observe(lane));
}
