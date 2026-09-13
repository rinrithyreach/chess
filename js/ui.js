/**
 * ui.js
 * Everything outside the board: screens, player cards, status, move history,
 * modals, toasts and settings.
 *
 * Holds no game logic. It renders from controller snapshots and turns user
 * input into controller calls.
 */

import {
  WHITE,
  BLACK,
  STATUS,
  BOARD_THEMES,
  GAUNTLET_ROUNDS,
  TIME_CONTROLS,
  DEFAULT_TIME_CONTROL,
  CLOCK_URGENT_MS,
  BACKGROUNDS,
  DEFAULT_BACKGROUND,
  resolveBackground,
  BOARD_ZOOM_LEVELS,
  clampBoardZoom,
  GAME_MODE,
  UI_STYLES,
  SELECTABLE_UI_STYLES,
  DEFAULT_UI_STYLE,
  LOCKED_CONTROLS,
  isControlLocked,
  TOAST_MS,
  warn,
} from './config.js';
import { fileToAvatar, isAvatar } from './avatar.js';
import { ROOM_CODE_LENGTH, ONLINE_AVATARS } from './firebase-config.js';

/** What an empty room code looks like: one dash per character. */
const ROOM_CODE_BLANK = '-'.repeat(ROOM_CODE_LENGTH);

// See TEXT_PRESENTATION in board.js: without it these can render as colour
// emoji, which ignore CSS `color` and make white pieces paint black.
const VS = '\uFE0E';
const PIECE_GLYPHS = {
  k: `♚${VS}`, q: `♛${VS}`, r: `♜${VS}`, b: `♝${VS}`, n: `♞${VS}`, p: `♟${VS}`,
};
/**
 * What each piece is worth, for the running material score.
 *
 * The textbook values. The king is absent on purpose: it is never captured,
 * so it can never appear in a pile.
 */
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Captured pieces read best strongest-first, not in the order they fell. */
const CAPTURE_ORDER = ['q', 'r', 'b', 'n', 'p'];

const PIECE_NAME = {
  q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn',
};

const PROMOTION_PIECES = [
  { type: 'q', name: 'Queen' },
  { type: 'r', name: 'Rook' },
  { type: 'b', name: 'Bishop' },
  { type: 'n', name: 'Knight' },
];

/**
 * A clock reading: m:ss normally, and seconds with a tenth under ten.
 *
 * The switch is not decoration. Above ten seconds the tenths digit changes
 * too fast to read and only flickers; below it, it is the difference between
 * knowing you have time for one more move and guessing.
 *
 * Rounded UP to the tenth, so a clock never shows 0.0 while there is still
 * time on it — the zero is reserved for the flag.
 */
function formatClock(ms) {
  const left = Math.max(0, ms);
  if (left <= 0) return '0.0';
  if (left < CLOCK_URGENT_MS) return (Math.ceil(left / 100) / 10).toFixed(1);

  const seconds = Math.ceil(left / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Query helper that reports missing elements once instead of throwing later. */
function el(id) {
  const node = document.getElementById(id);
  if (!node) warn(`Missing DOM element: #${id}`);
  return node;
}

export class UI {
  #controller;
  #dom = {};
  #openModal = null;
  #lastFocused = null;
  #confirmResolver = null;
  /** What dismissing the confirmation resolves to — see confirm(). */
  #confirmDismiss = false;
  #confirmAltValue = 'alt';
  #historyExpanded = false;

  /**
   * The picker element for each New Game seat, by slot id.
   *
   * Held rather than re-queried because the same three elements are read on
   * every sync and written on every pick, and because the slot ids come from
   * the markup — one place decides which seats exist, and it is the form.
   */
  #avatarPickers = new Map();

  /**
   * Draws one piece as a picture, when the mounted board can.
   *
   * Null on the flat fallback board, which has no geometry to photograph — the
   * trays fall back to Unicode glyphs there. See setPieceSprites().
   */
  #pieceSprite = null;

  /**
   * Bumped whenever the sprite source changes.
   *
   * Part of the tray cache key. Without it, swapping renderers mid-game would
   * leave the trays showing whichever form they were built with: the pieces
   * have not changed, so the key would not either, and the early return would
   * keep glyphs on a 3D board or portraits on a flat one.
   */
  #spriteEpoch = 0;

  constructor(controller) {
    this.#controller = controller;
    this.#cacheDom();
    this.#buildDynamic();
    this.#attachListeners();
  }

  #cacheDom() {
    const ids = [
      'screen-menu', 'screen-setup', 'screen-game',
      'btn-new-game', 'btn-continue-game', 'continue-meta', 'btn-menu-settings',
      'btn-setup-back', 'form-new-game', 'btn-start-game', 'input-white', 'input-black',
      'btn-game-menu', 'btn-game-settings',
      'card-top', 'card-bottom', 'top-name', 'top-color', 'top-turn',
      'bottom-name', 'bottom-color', 'bottom-turn',
      'tray-top', 'tray-bottom', 'top-edge', 'bottom-edge',
      'board', 'board-area', 'status', 'status-text', 'status-badge',
      'btn-undo', 'btn-flip', 'btn-resign', 'btn-zoom', 'zoom-label',
      'history-panel', 'btn-history-toggle', 'history-list', 'history-count',
      'modal-promotion', 'promotion-choices',
      'modal-confirm', 'confirm-title', 'confirm-text', 'confirm-actions',
      'btn-confirm-ok', 'btn-confirm-cancel', 'btn-confirm-alt',
      'modal-gameover', 'gameover-icon', 'gameover-title', 'gameover-result',
      'gameover-detail', 'btn-rematch', 'btn-gameover-new',
      'modal-settings', 'set-sound', 'set-coords', 'set-animations', 'set-autoflip',
      'theme-picker', 'bg-picker',
      'mode-tournament', 'tournament-fields', 'ladder', 'ladder-note', 'btn-ladder-next',
      'mode-speed', 'speed-fields', 'time-picker', 'opponent-picker',
      'top-clock', 'bottom-clock',
      'modal-menu', 'btn-restart', 'btn-leave',
      'toasts',
      // Phase 2 — online
      'screen-waiting', 'mode-online', 'mode-online-label', 'mode-online-desc',
      'online-fields', 'input-online-name', 'btn-create-room',
      'input-room-code', 'btn-join-room', 'btn-cancel-room',
      'room-code-value', 'btn-copy-code',
      'room-bar', 'room-bar-code', 'room-bar-status', 'room-bar-status-text',
      'modal-draw-offer', 'draw-offer-text', 'btn-draw-accept', 'btn-draw-decline',
      'modal-opponent-left', 'btn-leave-room',
      'style-picker',
    ];
    ids.forEach((id) => {
      this.#dom[id] = el(id);
    });
  }

  #buildDynamic() {
    // Promotion choices
    const choices = this.#dom['promotion-choices'];
    if (choices) {
      choices.innerHTML = '';
      PROMOTION_PIECES.forEach(({ type, name }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'promotion__choice';
        button.dataset.piece = type;
        button.setAttribute('aria-label', `Promote to ${name}`);
        button.innerHTML =
          `<span class="promotion__glyph" data-color="w">${PIECE_GLYPHS[type]}</span>` +
          `<span class="promotion__name">${name}</span>`;
        choices.append(button);
      });
    }

    // Look & feel picker, listing only the styles a player may pick — the flat
    // board is still built, but as the fallback for a device that refuses a
    // WebGL context, not as an option.
    //
    // With one style left there is nothing to choose between, so the whole
    // section goes: a radiogroup of one is a control that cannot do anything,
    // and a heading over it only draws the eye to that. Driven from the data
    // rather than deleted, so adding a second selectable style brings the
    // section back with no markup to restore.
    const stylePicker = this.#dom['style-picker'];
    if (stylePicker) {
      const choices = UI_STYLES.filter((style) => SELECTABLE_UI_STYLES.includes(style.id));
      const offerAChoice = choices.length > 1;
      const section = stylePicker.closest('.setting');
      if (section) section.hidden = !offerAChoice;

      stylePicker.innerHTML = '';
      (offerAChoice ? choices : []).forEach((style) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'style-option';
        button.dataset.style = style.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.innerHTML =
          `<span class="style-option__preview" data-style="${style.id}"></span>` +
          `<span class="style-option__name">${style.label}</span>` +
          `<span class="style-option__hint">${style.hint}</span>`;
        stylePicker.append(button);
      });
    }

    // Locked controls: visible, plainly unavailable, and inert. Applied once
    // here rather than on every render, since the lock never changes at
    // runtime — and applying it before the first render means there is no
    // frame in which a locked control looks pressable.
    LOCKED_CONTROLS.forEach((id) => {
      const button = this.#dom[`btn-${id}`];
      if (!button) return;

      // The label is the button's own text, minus the icon span, so it stays
      // correct if a control is ever renamed in the HTML.
      const label = [...button.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .join(' ')
        .trim() || id;

      button.classList.add('btn--locked');
      // aria-disabled rather than `disabled`: the button keeps its place in
      // the tab order and is still announced, so a screen-reader user learns
      // the control is locked instead of it silently vanishing.
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-label', `${label}, locked`);
      button.title = `${label} is locked`;

      const lock = document.createElement('span');
      lock.className = 'btn__lock';
      lock.setAttribute('aria-hidden', 'true');
      lock.textContent = '🔒';
      button.append(lock);
    });

    // Profile-picture pickers. The markup declares which seats have one, via
    // `data-avatar-slot`, so adding a seat to the form is the whole change.
    document.querySelectorAll('.avatar-picker').forEach((node) => {
      const slot = node.dataset.avatarSlot;
      if (!slot) return;

      // The online seat offers a picker only while pictures actually travel.
      // Better no control than a control that quietly does nothing — and the
      // decision is read from the same flag the session writes seats by, so
      // the form and the room cannot disagree about it.
      if (slot === 'online' && !ONLINE_AVATARS) {
        node.hidden = true;
        return;
      }

      this.#avatarPickers.set(slot, node);
      // Stashed on the element so #showAvatar can rewrite the accessible name
      // without having to be told which seat it is looking at.
      node.dataset.avatarWho = this.#avatarWho(slot);
      this.#showAvatar(node, null);
    });

    // Room code length lives in one place, so the field and the placeholders
    // follow it rather than being kept in step by hand. The markup carries a
    // matching default so the form is still right before this runs.
    const codeInput = this.#dom['input-room-code'];
    if (codeInput) codeInput.maxLength = ROOM_CODE_LENGTH;
    if (this.#dom['room-code-value']) {
      this.#dom['room-code-value'].textContent = ROOM_CODE_BLANK;
    }
    if (this.#dom['room-bar-code']) {
      this.#dom['room-bar-code'].textContent = ROOM_CODE_BLANK;
    }

    // Theme picker
    const picker = this.#dom['theme-picker'];
    if (picker) {
      picker.innerHTML = '';
      BOARD_THEMES.forEach((theme) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'theme-swatch';
        button.dataset.theme = theme.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.innerHTML =
          `<span class="theme-swatch__preview" data-theme="${theme.id}"></span>` +
          `<span class="theme-swatch__label">${theme.label}</span>`;
        picker.append(button);
      });
    }

    // Time controls. Same shape as every other picker here: one list in
    // config.js decides what exists, and the markup holds none of it.
    const times = this.#dom['time-picker'];
    if (times) {
      times.innerHTML = '';
      TIME_CONTROLS.forEach((control) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'time-option';
        button.dataset.time = control.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(control.id === DEFAULT_TIME_CONTROL));
        if (control.id === DEFAULT_TIME_CONTROL) button.classList.add('is-active');
        button.innerHTML =
          `<span class="time-option__label">${control.label}</span>` +
          `<span class="time-option__name">${control.name}</span>`;
        // Minutes and seconds spelled out, because "3 + 2" is a notation
        // rather than a phrase and a screen reader should not have to guess.
        const minutes = control.initialMs / 60000;
        const increment = control.incrementMs / 1000;
        button.setAttribute('aria-label',
          `${control.name}, ${minutes} minute${minutes === 1 ? '' : 's'}`
          + (increment ? ` plus ${increment} seconds a move` : ', no increment'));
        times.append(button);
      });
    }

    // The ladder. One row per rung, built once; which row is which state is
    // decided on every render by syncGauntlet().
    const ladder = this.#dom.ladder;
    if (ladder) {
      ladder.innerHTML = '';
      GAUNTLET_ROUNDS.forEach((rung) => {
        const item = document.createElement('li');
        item.className = 'ladder__rung';
        item.dataset.round = String(rung.round);
        item.innerHTML =
          '<span class="ladder__mark" aria-hidden="true"></span>' +
          `<span class="ladder__name">${rung.label}</span>` +
          `<span class="ladder__hint">${rung.hint}</span>` +
          '<span class="ladder__state"></span>';
        ladder.append(item);
      });
    }

    // Background picker. Same shape as the board themes above, and for the
    // same reason: one list in config.js decides what exists, so a background
    // is a block of CSS and a row in that list, with no markup to add here.
    const backgrounds = this.#dom['bg-picker'];
    if (backgrounds) {
      backgrounds.innerHTML = '';
      BACKGROUNDS.forEach((background) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bg-swatch';
        button.dataset.bg = background.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.innerHTML =
          `<span class="bg-swatch__preview" data-bg="${background.id}"></span>` +
          `<span class="bg-swatch__label">${background.label}</span>` +
          `<span class="bg-swatch__hint">${background.hint}</span>`;
        backgrounds.append(button);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Screens
  // -----------------------------------------------------------------------

  showScreen(name) {
    ['menu', 'setup', 'game', 'waiting'].forEach((screen) => {
      this.#dom[`screen-${screen}`]?.classList.toggle('is-active', screen === name);
    });
    window.scrollTo(0, 0);
  }

  /** Which Game Mode radio is currently chosen. */
  #selectedMode() {
    const checked = this.#dom['form-new-game']?.querySelector('input[name="mode"]:checked');
    return checked?.value ?? GAME_MODE.LOCAL;
  }

  /**
   * Show the parts of the setup form the chosen mode actually needs.
   *
   * Each mode asks for something different: two names for a local game, one
   * for a game against the bot (the bot names its own seat), and none at all
   * online, where the room controls take over and there is no Start button
   * because the game begins when somebody joins.
   */
  #applyMode(mode) {
    const online = mode === GAME_MODE.ONLINE;
    const bot = mode === GAME_MODE.BOT;
    const ladder = mode === GAME_MODE.TOURNAMENT;
    const speed = mode === GAME_MODE.SPEED;

    if (this.#dom['online-fields']) this.#dom['online-fields'].hidden = !online;
    if (this.#dom['tournament-fields']) this.#dom['tournament-fields'].hidden = !ladder;
    if (this.#dom['speed-fields']) this.#dom['speed-fields'].hidden = !speed;
    if (this.#dom['btn-start-game']) this.#dom['btn-start-game'].hidden = online;

    const nameFields = this.#dom['form-new-game']
      ?.querySelectorAll('.field:not(.field--modes)');
    // Speed Chess asks for a second name only when a second person is
    // going to type one in.
    const soloSpeed = speed && this.#selectedOpponent() === 'bot';
    nameFields?.forEach((field, index) => {
      if (index === 0) field.hidden = online;  // your own name
      else if (index === 1) {                  // the opponent's
        field.hidden = online || bot || ladder || soloSpeed;
      }
    });

    // The button says what it is about to do. On the ladder that is not a
    // game in general but one particular opponent, and naming them is the
    // difference between a form and a challenge.
    const start = this.#dom['btn-start-game'];
    if (start) {
      const run = this.#controller.getGauntlet?.();
      start.textContent = ladder && run?.opponent
        ? `Play Round ${run.round}: ${run.opponent.label}`
        : 'Start Game';
    }
  }

  /**
   * Show or hide the board-size control.
   *
   * Driven by the mounted renderer rather than by the style setting, because
   * those two can disagree: a device that refuses a WebGL context is given the
   * flat board while the setting still says board3d. What matters is which
   * board is actually on screen, and app.js is the only thing that knows.
   */
  setZoomAvailable(available) {
    const button = this.#dom['btn-zoom'];
    if (button) button.hidden = !available;
  }

  /**
   * Hand the trays a way to draw a real piece, or take it away.
   *
   * Called once per board mount, because it is the mounted renderer that
   * decides whether there is any geometry to photograph.
   */
  setPieceSprites(draw) {
    this.#pieceSprite = typeof draw === 'function' ? draw : null;
    this.#spriteEpoch += 1;
  }

  /** Enable or disable the Online option on the setup screen. */
  setOnlineAvailable(available, reason) {
    const label = this.#dom['mode-online-label'];
    const input = this.#dom['mode-online'];
    const desc = this.#dom['mode-online-desc'];
    if (!label || !input) return;

    label.classList.toggle('mode--disabled', !available);
    input.disabled = !available;
    if (desc) {
      desc.textContent = available ? 'Play on two devices' : 'Needs Firebase setup';
    }
    if (!available && reason) label.title = reason;
  }

  /** Show the room code while waiting for an opponent to join. */
  showWaitingRoom(roomCode) {
    if (this.#dom['room-code-value']) {
      this.#dom['room-code-value'].textContent = roomCode;
    }
    this.showScreen('waiting');
  }

  /** Show or hide "Continue Game" based on whether a resumable save exists. */
  refreshContinueButton() {
    const button = this.#dom['btn-continue-game'];
    if (!button) return;
    const available = this.#controller.hasSavedGame();
    button.hidden = !available;

    const meta = this.#dom['continue-meta'];
    if (available && meta) {
      const info = this.#controller.getSavedGameInfo();
      meta.textContent = info
        ? `${info.white} vs ${info.black} · ${info.moveCount} moves`
        : '';
    }
  }

  // -----------------------------------------------------------------------
  // Game rendering
  // -----------------------------------------------------------------------

  /**
   * The board-size button says where you are as well as what it does.
   *
   * Refreshed from every render as well as from syncSettings, because the
   * setting has more than one way to change — restoring a saved game and the
   * console helper both go through the controller without touching the
   * settings panel, and a button labelled with the previous level is worse
   * than one with no label at all.
   */
  #renderZoomControl(settings = {}) {
    const zoom = BOARD_ZOOM_LEVELS[clampBoardZoom(settings.boardZoom)];
    if (this.#dom['zoom-label']) this.#dom['zoom-label'].textContent = zoom.label;

    // How much empty margin the camera leaves either side of the board depends
    // on the angle, and that is what decides whether the capture trays can sit
    // in it for free. CSS needs to know which level is on — see .board-area
    // in board.css.
    this.#dom['board-area']?.setAttribute('data-zoom', zoom.id);
    // The accessible name carries what pressing it does; the visible label only
    // has room to say where you are now.
    this.#dom['btn-zoom']?.setAttribute(
      'aria-label',
      `Board size: ${zoom.label}. ${zoom.hint}. Press to change.`,
    );
  }

  render(snapshot) {
    const { state } = snapshot;
    if (!state) return;
    this.#renderZoomControl(snapshot.settings);
    this.#renderPlayers(snapshot);
    this.#renderStatus(snapshot);
    this.#renderHistory(state);
    this.#renderControls(snapshot);
    this.#renderOnline(state);
    // Painted here as well as on every tick, so the readouts are right the
    // instant a game appears rather than up to a tenth of a second later.
    this.renderClocks(state);
  }

  /**
   * Online-only chrome: the room bar, connection state and opponent presence.
   * Hidden entirely for local games, so one render path serves both modes.
   */
  #renderOnline(state) {
    const bar = this.#dom['room-bar'];
    const online = state.online;

    if (!bar) return;
    if (!online) {
      bar.hidden = true;
      return;
    }

    bar.hidden = false;
    if (this.#dom['room-bar-code']) {
      this.#dom['room-bar-code'].textContent = online.roomCode ?? ROOM_CODE_BLANK;
    }

    // Connection first, then opponent presence — the more urgent wins.
    let stateName = 'connecting';
    let text = 'Connecting…';

    if (online.connection === 'online') {
      if (online.waitingForOpponent) {
        stateName = 'waiting';
        text = 'Waiting for opponent';
      } else if (!online.opponentConnected) {
        stateName = 'away';
        text = `${online.opponentName ?? 'Opponent'} disconnected`;
      } else {
        stateName = 'live';
        text = online.isMyTurn ? 'Your turn' : 'Opponent’s turn';
      }
    } else if (online.connection === 'offline') {
      stateName = 'offline';
      text = 'Offline — reconnecting';
    }

    const status = this.#dom['room-bar-status'];
    if (status) status.dataset.state = stateName;
    if (this.#dom['room-bar-status-text']) {
      this.#dom['room-bar-status-text'].textContent = text;
    }
  }

  /** Ask the local player whether to accept the opponent's draw offer. */
  showDrawOffer({ fromName }) {
    const text = this.#dom['draw-offer-text'];
    if (text) {
      text.textContent = `${fromName ?? 'Your opponent'} offers a draw.`;
    }
    this.openModal('draw-offer');
  }

  closeDrawOffer() {
    if (this.#openModal === 'draw-offer') this.closeModal('draw-offer');
  }

  showOpponentLeft() {
    if (this.#openModal) return; // never stack on top of another dialog
    this.openModal('opponent-left');
  }

  closeOpponentLeft() {
    if (this.#openModal === 'opponent-left') this.closeModal('opponent-left');
  }

  /**
   * Player cards follow board orientation: the bottom card is always the side
   * shown at the bottom of the board.
   */
  /**
   * Who has taken what, and who is ahead.
   *
   * Derived from the move list rather than by comparing the position against a
   * full starting set, because the position cannot tell you about a promotion:
   * a side that queens a pawn shows one pawn short, which a material diff reads
   * as the opponent having captured it. The history says plainly what was
   * taken, so it stays right.
   *
   * Keyed by the CAPTURING colour, holding the pieces they took — which are the
   * opponent's, and so are drawn in the opponent's colour.
   */
  #readCaptures(verboseMoves) {
    const taken = { [WHITE]: [], [BLACK]: [] };
    (verboseMoves ?? []).forEach((move) => {
      if (move?.captured && taken[move.color]) taken[move.color].push(move.captured);
    });
    return taken;
  }

  /**
   * Draw one player's captured pile, and their lead if they have one.
   *
   * The strip is rebuilt only when its contents actually change. render() runs
   * on every move and this is the one part of the card that holds a dozen
   * nodes, so a blind rebuild would churn the DOM twice a move for a strip
   * that usually has not changed at all.
   */
  #renderCaptures(prefix, taken, color) {
    const strip = this.#dom[`tray-${prefix}`];
    const edgeEl = this.#dom[`${prefix}-edge`];
    if (!strip || !edgeEl) return;

    const mine = taken[color] ?? [];
    const theirs = taken[color === WHITE ? BLACK : WHITE] ?? [];
    const worth = (list) => list.reduce((sum, p) => sum + (PIECE_VALUE[p] ?? 0), 0);
    const edge = worth(mine) - worth(theirs);

    // Strongest first, which is also how a pile is read at a glance.
    const sorted = [...mine].sort(
      (a, b) => CAPTURE_ORDER.indexOf(a) - CAPTURE_ORDER.indexOf(b),
    );
    // The colour is part of the key, not just the pieces.
    //
    // A tray belongs to whichever player is at that end of the board, and a
    // flip swaps them. When both piles happen to hold the same pieces — after
    // an even trade, which is common — a key of pieces alone is unchanged
    // across the flip, the early return fires, and the tray keeps the previous
    // player's pile: the right shapes in the wrong colour.
    const key = `${color}|${sorted.join('')}|${edge}|${this.#spriteEpoch}`;
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;

    // Captured pieces belong to the other side, so they are drawn in the other
    // side's colour — a white player's tray holds the black pieces they took.
    const theirColor = color === WHITE ? BLACK : WHITE;
    strip.innerHTML = sorted
      .map((p) => {
        // The real piece where the board can draw one, so a captured knight is
        // the knight that was on the board rather than a flat glyph of a
        // different chess set standing next to a solid one.
        const sprite = this.#pieceSprite?.(p, theirColor);
        // Both forms carry what they represent, so nothing downstream has to
        // infer a captured piece's colour from the shape of its markup.
        return sprite
          ? `<img class="capture capture--piece" src="${sprite}" alt=""`
            + ` data-color="${theirColor}" data-piece="${p}">`
          : `<span class="capture" data-color="${theirColor}" data-piece="${p}">`
            + `${PIECE_GLYPHS[p]}</span>`;
      })
      .join('');

    // A count per kind, so a screen reader gets the pile as a sentence rather
    // than as a dozen identical glyph names.
    const counts = new Map();
    sorted.forEach((p) => counts.set(p, (counts.get(p) ?? 0) + 1));
    const spoken = [...counts].map(([p, n]) =>
      `${n} ${PIECE_NAME[p]}${n === 1 ? '' : 's'}`).join(', ');
    strip.setAttribute('aria-label', spoken ? `Captured ${spoken}` : '');

    edgeEl.hidden = edge <= 0;
    if (edge > 0) edgeEl.textContent = `+${edge}`;
  }

  #renderPlayers({ state, orientation }) {
    const bottomColor = orientation === 'black' ? BLACK : WHITE;
    const topColor = bottomColor === WHITE ? BLACK : WHITE;
    const taken = this.#readCaptures(state.verboseMoves);

    const apply = (prefix, color) => {
      const name = this.#dom[`${prefix}-name`];
      const colorEl = this.#dom[`${prefix}-color`];
      const turnEl = this.#dom[`${prefix}-turn`];
      const card = this.#dom[`card-${prefix === 'top' ? 'top' : 'bottom'}`];

      if (name) name.textContent = state.players[color]?.name ?? '';
      if (colorEl) colorEl.textContent = color === WHITE ? 'White' : 'Black';

      const avatar = card?.querySelector('.player-card__avatar');
      if (avatar) avatar.dataset.color = color;
      this.#renderCardPhoto(card, state.players[color]?.avatar);
      this.#renderCaptures(prefix, taken, color);

      const isTurn = state.turn === color && !state.isGameOver;
      if (turnEl) turnEl.hidden = !isTurn;
      card?.classList.toggle('is-active', isTurn);
    };

    apply('top', topColor);
    apply('bottom', bottomColor);
  }

  /**
   * Put a player's picture on their card, or fall back to the king glyph.
   *
   * Validated here as well as at every other boundary. This is the last point
   * before a value becomes an `img src`, and online that value came off the
   * network — so it is checked where it is used rather than only where it was
   * received.
   *
   * `src` is only assigned when it actually changes. render() runs on every
   * move, and reassigning the same data URL restarts the decode: the card
   * would blink once per move for the whole game.
   */
  #renderCardPhoto(card, avatar) {
    const photo = card?.querySelector('.player-card__photo');
    const glyph = card?.querySelector('.player-card__glyph');
    if (!photo || !glyph) return;

    const usable = isAvatar(avatar);
    if (usable) {
      if (photo.getAttribute('src') !== avatar) photo.setAttribute('src', avatar);
    } else {
      photo.removeAttribute('src');
    }
    photo.hidden = !usable;
    glyph.hidden = usable;
  }

  #renderStatus({ state }) {
    const text = this.#dom['status-text'];
    const badge = this.#dom['status-badge'];
    if (!text || !badge) return;

    const turnName = state.turn === WHITE ? 'White' : 'Black';

    if (state.isGameOver && state.result) {
      text.textContent = state.result.label;
      badge.hidden = false;
      badge.textContent = state.result.detail;
      badge.dataset.tone = state.result.winner ? 'win' : 'draw';
    } else {
      text.textContent = `${turnName}'s Turn`;
      const inCheck = state.status === STATUS.CHECK;
      badge.hidden = !inCheck;
      if (inCheck) {
        badge.textContent = 'Check';
        badge.dataset.tone = 'check';
      }
    }

    this.#dom.status?.classList.toggle('is-over', Boolean(state.isGameOver));
  }

  /** Render SAN history as numbered pairs: "1. e4 e5". */
  #renderHistory(state) {
    const list = this.#dom['history-list'];
    const count = this.#dom['history-count'];
    if (!list) return;

    const moves = state.moves ?? [];
    if (count) {
      count.textContent = `${moves.length} ${moves.length === 1 ? 'move' : 'moves'}`;
    }

    list.innerHTML = '';
    for (let i = 0; i < moves.length; i += 2) {
      const item = document.createElement('li');
      item.className = 'history__row';
      const number = Math.floor(i / 2) + 1;
      // The whitespace between spans keeps the row readable when the text is
      // selected or read aloud, since the grid gaps are purely visual.
      item.innerHTML =
        `<span class="history__num">${number}.</span> ` +
        `<span class="history__san">${moves[i]}</span> ` +
        `<span class="history__san">${moves[i + 1] ?? ''}</span>`;
      list.append(item);
    }

    // Keep the latest move in view.
    if (this.#historyExpanded) list.scrollTop = list.scrollHeight;
  }

  #renderControls({ state }) {
    const online = state.online;
    // Online, the board is only live once both seats are filled.
    const inactive = Boolean(state.isGameOver) || Boolean(online?.waitingForOpponent);

    // Locked controls are skipped: their appearance and title are set once at
    // build time, and re-deriving them from game state here would overwrite
    // the lock with an ordinary enabled/disabled button.
    const undo = this.#dom['btn-undo'];
    if (undo && !isControlLocked('undo')) {
      undo.disabled = !state.canUndo;
      undo.title = online ? 'Undo is not available in online games' : '';
    }
    if (this.#dom['btn-resign']) this.#dom['btn-resign'].disabled = inactive;

    // Restart resets the position unilaterally, which has no meaning across
    // two devices — Rematch (mutually agreed) replaces it online.
    const restart = this.#dom['btn-restart'];
    if (restart) restart.hidden = Boolean(online);

    const leave = this.#dom['btn-leave'];
    if (leave) leave.textContent = online ? 'Leave Room' : 'Main Menu';
  }

  // -----------------------------------------------------------------------
  // Modals
  // -----------------------------------------------------------------------

  openModal(name) {
    const modal = this.#dom[`modal-${name}`];
    if (!modal) return;

    this.#lastFocused = document.activeElement;
    modal.hidden = false;
    // Force a frame so the CSS transition runs from the hidden state.
    requestAnimationFrame(() => modal.classList.add('is-open'));
    this.#openModal = name;
    document.body.classList.add('is-modal-open');

    const focusTarget = modal.querySelector(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusTarget?.focus();
  }

  closeModal(name = this.#openModal) {
    const modal = this.#dom[`modal-${name}`];
    if (!modal) return;

    modal.classList.remove('is-open');
    modal.hidden = true;
    if (this.#openModal === name) this.#openModal = null;
    if (!this.#openModal) document.body.classList.remove('is-modal-open');

    // A cancelled confirmation must still settle its promise. What a dismissal
    // means is the caller's to decide: for a two-button dialog it is "no", but
    // a dialog with a third way out usually has a safer outcome than either.
    if (name === 'confirm' && this.#confirmResolver) {
      const resolve = this.#confirmResolver;
      this.#confirmResolver = null;
      resolve(this.#confirmDismiss);
    }
    if (name === 'promotion') this.#controller.cancelPromotion();

    this.#lastFocused?.focus?.();
    this.#lastFocused = null;
  }

  isModalOpen() {
    return this.#openModal !== null;
  }

  /**
   * Custom confirmation dialog.
   *
   * Resolves true for the confirm button and false for the cancel button. Pass
   * `altLabel` and a third button appears, resolving `altValue` — for the
   * questions that genuinely have three answers rather than two. Callers that
   * ask nothing extra are unaffected and still get a plain true/false.
   *
   * `dismissValue` is what closing the dialog without choosing resolves to
   * (Escape, the backdrop, the close button). It defaults to false — "no" —
   * which is right for a yes/no question, but a three-way dialog should
   * usually point it at whichever outcome changes the least.
   *
   * The OK button is disabled once clicked, so a double tap cannot fire the
   * action twice.
   */
  confirm({
    title,
    text,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    altLabel = null,
    altValue = 'alt',
    dismissValue = false,
    tone = 'default',
  }) {
    return new Promise((resolve) => {
      // Settle any dialog that is somehow still open.
      if (this.#confirmResolver) {
        this.#confirmResolver(this.#confirmDismiss);
        this.#confirmResolver = null;
      }

      if (this.#dom['confirm-title']) this.#dom['confirm-title'].textContent = title;
      if (this.#dom['confirm-text']) this.#dom['confirm-text'].textContent = text ?? '';

      const ok = this.#dom['btn-confirm-ok'];
      if (ok) {
        ok.textContent = confirmLabel;
        ok.disabled = false;
        ok.dataset.tone = tone;
      }

      // Reset every time: the label is per-dialog, so a previous caller's
      // wording must not leak into the next one that does not set it.
      const cancel = this.#dom['btn-confirm-cancel'];
      if (cancel) cancel.textContent = cancelLabel;

      const alt = this.#dom['btn-confirm-alt'];
      if (alt) {
        alt.hidden = !altLabel;
        alt.disabled = false;
        if (altLabel) alt.textContent = altLabel;
      }

      // Three buttons do not fit a row on a phone, so a three-way dialog
      // stacks with the confirm button on top. The nodes are reordered rather
      // than positioned with CSS `order`, so what a screen reader announces
      // and what Tab visits stay in the same sequence as what is on screen.
      const actions = this.#dom['confirm-actions'];
      if (actions && ok && cancel && alt) {
        actions.classList.toggle('modal__actions--stack', Boolean(altLabel));
        if (altLabel) actions.append(ok, cancel, alt);
        else actions.append(cancel, ok, alt);
      }

      this.#confirmAltValue = altValue;
      this.#confirmDismiss = dismissValue;
      this.#confirmResolver = resolve;
      this.openModal('confirm');
    });
  }

  #settleConfirm(value) {
    const resolve = this.#confirmResolver;
    this.#confirmResolver = null;
    const ok = this.#dom['btn-confirm-ok'];
    if (ok) ok.disabled = true;

    const modal = this.#dom['modal-confirm'];
    if (modal) {
      modal.classList.remove('is-open');
      modal.hidden = true;
    }
    if (this.#openModal === 'confirm') this.#openModal = null;
    if (!this.#openModal) document.body.classList.remove('is-modal-open');
    this.#lastFocused?.focus?.();
    this.#lastFocused = null;

    resolve?.(value);
  }

  /** Show the promotion picker, with glyphs in the promoting side's colour. */
  showPromotion({ color }) {
    const choices = this.#dom['promotion-choices'];
    choices?.querySelectorAll('.promotion__glyph').forEach((glyph) => {
      glyph.dataset.color = color;
    });
    this.openModal('promotion');
  }

  showGameOver({ state }) {
    if (!state?.result) return;
    const { result } = state;

    const title = this.#dom['gameover-title'];
    const resultEl = this.#dom['gameover-result'];
    const detail = this.#dom['gameover-detail'];
    const icon = this.#dom['gameover-icon'];

    const isDraw = result.winner === null;
    if (title) title.textContent = isDraw ? 'Draw' : result.detail;
    if (resultEl) resultEl.textContent = isDraw ? result.detail : result.label;
    if (detail) {
      detail.textContent = isDraw
        ? 'Neither side can claim a win.'
        : `${result.detail} · ${state.moves.length} moves played`;
    }
    if (icon) {
      icon.textContent = isDraw ? '½' : `♛${VS}`;
      icon.dataset.color = result.winner ?? '';
    }

    this.#renderLadderOutcome(state);
    this.openModal('gameover');
  }

  // -----------------------------------------------------------------------
  // The clock
  // -----------------------------------------------------------------------

  /** Which time control the form is offering. */
  #selectedTimeControl() {
    const active = this.#dom['time-picker']?.querySelector('.time-option.is-active');
    return active?.dataset.time ?? DEFAULT_TIME_CONTROL;
  }

  /** Who the Speed Chess game is against: 'bot' or 'human'. */
  #selectedOpponent() {
    const active = this.#dom['opponent-picker']?.querySelector('.time-option.is-active');
    return active?.dataset.opponent ?? 'bot';
  }

  /**
   * Paint both clocks, and nothing else.
   *
   * Separate from render() because it is called ten times a second: a full
   * render rebuilds the history list, both capture trays and every card, all
   * to change four characters. This touches the two readouts and stops.
   */
  renderClocks(state) {
    const clock = state?.clock ?? null;
    const orientation = this.#controller.getOrientation();
    const topColor = orientation === 'white' ? BLACK : WHITE;

    [['top-clock', topColor], ['bottom-clock', topColor === WHITE ? BLACK : WHITE]]
      .forEach(([id, color]) => {
        const node = this.#dom[id];
        if (!node) return;
        if (!clock) {
          node.hidden = true;
          return;
        }

        const left = clock.remaining[color] ?? 0;
        node.hidden = false;
        node.textContent = formatClock(left);
        // Running is not the same as "your turn": between the game starting
        // and White's first move neither clock runs, and neither should look
        // like it is bleeding.
        node.classList.toggle('is-running', clock.running === color);
        node.classList.toggle('is-urgent', left <= CLOCK_URGENT_MS);
        node.classList.toggle('is-flagged', left <= 0);
      });
  }

  // -----------------------------------------------------------------------
  // The tournament ladder
  // -----------------------------------------------------------------------

  /**
   * Turn the end of a ladder game into the one thing to do next.
   *
   * Rematch is swapped out rather than left beside this. On a ladder the
   * next game is never "the same again": it is the next rung, this rung
   * once more, or the bottom — and a Rematch button sitting next to that is
   * a second answer to a question that has one. (It would also swap
   * colours, and the ladder is built on the human playing White.)
   */
  #renderLadderOutcome(state) {
    const next = this.#dom['btn-ladder-next'];
    const rematch = this.#dom['btn-rematch'];
    const detail = this.#dom['gameover-detail'];
    const ladder = state?.mode === GAME_MODE.TOURNAMENT;

    if (next) next.hidden = !ladder;
    if (rematch) rematch.hidden = ladder;
    if (!ladder || !next) return;

    // Read AFTER the controller has settled the result, so this is where the
    // player now stands rather than where they stood before the last move.
    const run = this.#controller.getGauntlet();
    const played = GAUNTLET_ROUNDS.find((rung) => rung.round === state.gauntletRound);
    const winner = state.result?.winner ?? null;
    const beat = winner === WHITE;
    const drew = winner === null;

    const label = (round) => {
      const rung = GAUNTLET_ROUNDS.find((r) => r.round === round);
      return rung ? `Round ${round}: ${rung.label}` : `Round ${round}`;
    };

    let playRound = run.round;
    let text = `Play ${label(run.round)}`;
    let story = '';

    if (beat && run.complete) {
      playRound = 1;
      text = 'Climb it again';
      story = `${played?.label ?? 'The Champion'} beaten — that is the whole ladder.`;
    } else if (beat) {
      story = `${played?.label ?? 'Beaten'} beaten. ${label(run.round)} next.`;
    } else if (drew) {
      playRound = state.gauntletRound;
      text = `Replay ${label(state.gauntletRound)}`;
      story = `A draw holds ${played?.label ?? 'them'} but does not beat them.`;
    } else {
      text = `Start again: ${label(1)}`;
      story = run.best > 0
        ? `${played?.label ?? 'They'} won. Back to the bottom — your best is still round ${run.best}.`
        : `${played?.label ?? 'They'} won. Back to the bottom.`;
    }

    next.textContent = text;
    next.dataset.round = String(playRound);
    if (detail) detail.textContent = story;
  }

  /**
   * Show where the player stands.
   *
   * Three states per rung, and the wording matters more than it looks:
   * "beaten" is a fact about the past that a lost run must not erase, while
   * "locked" is about now. That is why a rung can read as beaten and locked
   * at the same time after a defeat — the record stands, the road back does
   * not.
   */
  syncGauntlet(run) {
    if (!run) return;

    this.#dom.ladder?.querySelectorAll('.ladder__rung').forEach((item) => {
      const round = Number(item.dataset.round);
      const beaten = round <= run.best;
      const current = round === run.round;

      item.classList.toggle('is-beaten', beaten);
      item.classList.toggle('is-current', current);
      item.classList.toggle('is-locked', !beaten && !current);

      const state = item.querySelector('.ladder__state');
      if (state) {
        state.textContent = beaten ? 'beaten' : current ? 'next' : 'locked';
      }
      const mark = item.querySelector('.ladder__mark');
      if (mark) mark.textContent = beaten ? '✓' : String(round);

      // The row a screen reader lands on should say the same three things
      // the sighted reader sees, in one go rather than as three fragments.
      const name = item.querySelector('.ladder__name')?.textContent ?? '';
      item.setAttribute('aria-label',
        `Round ${round}, ${name}: ${beaten ? 'beaten' : current ? 'next to play' : 'locked'}`);
    });

    const note = this.#dom['ladder-note'];
    if (note) {
      if (run.complete) {
        note.textContent = 'You have beaten the whole ladder. Play it again from the top.';
      } else if (run.best > 0) {
        note.textContent = `Best so far: round ${run.best} of ${run.length}.`
          + ' Lose and you start again from the bottom.';
      } else {
        note.textContent = 'Win to move up. Lose and you start again from the bottom;'
          + ' a draw means the round is replayed.';
      }
    }

    // The start button names the next opponent, and the run just changed it.
    if (this.#selectedMode() === GAME_MODE.TOURNAMENT) {
      this.#applyMode(GAME_MODE.TOURNAMENT);
    }
  }

  // -----------------------------------------------------------------------
  // Profile pictures
  // -----------------------------------------------------------------------

  /** Show the remembered picture, if any, in each seat's picker. */
  syncAvatars(avatars = {}) {
    this.#avatarPickers.forEach((node, slot) => {
      this.#showAvatar(node, avatars[slot]);
    });
  }

  /**
   * Paint one picker, and say in its accessible name what pressing it does.
   *
   * The label has to change with the state: a button that says "Add a picture"
   * when there already is one is telling a screen-reader user the opposite of
   * what the sighted user can see.
   */
  #showAvatar(node, avatar) {
    const image = node.querySelector('.avatar-picker__img');
    const glyph = node.querySelector('.avatar-picker__glyph');
    const clear = node.querySelector('.avatar-picker__clear');
    const button = node.querySelector('.avatar-picker__btn');
    const usable = isAvatar(avatar);

    if (image) {
      if (usable) image.setAttribute('src', avatar);
      else image.removeAttribute('src');
      image.hidden = !usable;
    }
    if (glyph) glyph.hidden = usable;
    if (clear) clear.hidden = !usable;
    node.classList.toggle('has-photo', usable);

    if (button) {
      const who = node.dataset.avatarWho ?? 'this player';
      button.setAttribute(
        'aria-label',
        usable ? `Change the profile picture for ${who}` : `Add a profile picture for ${who}`,
      );
    }
  }

  /** What a picker's seat is called, for its accessible name. */
  #avatarWho(slot) {
    if (slot === 'p1') return 'Player 1';
    if (slot === 'p2') return 'Player 2';
    // The online form asks for YOUR name, so its picker is your own picture.
    return 'yourself';
  }

  /** The picture chosen for a seat, or null. Read straight off the preview. */
  #avatarFor(slot) {
    const image = this.#avatarPickers.get(slot)?.querySelector('.avatar-picker__img');
    const src = image?.getAttribute('src');
    return isAvatar(src) ? src : null;
  }

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------

  syncSettings(settings) {
    const map = {
      'set-sound': 'sound',
      'set-coords': 'showCoordinates',
      'set-animations': 'animations',
      'set-autoflip': 'autoFlip',
    };
    Object.entries(map).forEach(([id, key]) => {
      const input = this.#dom[id];
      if (input) input.checked = Boolean(settings[key]);
    });

    this.#dom['theme-picker']?.querySelectorAll('.theme-swatch').forEach((swatch) => {
      const active = swatch.dataset.theme === settings.boardTheme;
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-checked', String(active));
    });

    this.#dom['style-picker']?.querySelectorAll('.style-option').forEach((option) => {
      const active = option.dataset.style === settings.uiStyle;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-checked', String(active));
    });

    // Resolved rather than written straight through: an unknown id would match
    // no block and leave the page on whatever was there before, which reads as
    // the setting having done nothing.
    const background = resolveBackground(settings.background ?? DEFAULT_BACKGROUND);
    this.#dom['bg-picker']?.querySelectorAll('.bg-swatch').forEach((swatch) => {
      const active = swatch.dataset.bg === background;
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-checked', String(active));
    });

    this.#renderZoomControl(settings);
    this.#dom.board?.setAttribute('data-theme', settings.boardTheme);
    document.documentElement.setAttribute('data-ui-style', settings.uiStyle ?? DEFAULT_UI_STYLE);
    document.documentElement.setAttribute('data-bg', background);
  }

  // -----------------------------------------------------------------------
  // Toasts
  // -----------------------------------------------------------------------

  toast(message, tone = 'info') {
    const container = this.#dom.toasts;
    if (!container) return;

    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.tone = tone;
    node.textContent = message;
    container.append(node);

    // Errors are usually actionable setup instructions, so give them time to
    // actually be read rather than the standard acknowledgement duration.
    const duration = tone === 'error' ? TOAST_MS * 3 : TOAST_MS;

    requestAnimationFrame(() => node.classList.add('is-visible'));
    window.setTimeout(() => {
      node.classList.remove('is-visible');
      window.setTimeout(() => node.remove(), 250);
    }, duration);
  }

  // -----------------------------------------------------------------------
  // Listeners
  // -----------------------------------------------------------------------

  /** Register handlers supplied by app.js. */
  bind(handlers) {
    this.handlers = handlers;
  }

  #call(name, ...args) {
    this.handlers?.[name]?.(...args);
  }

  /**
   * Wire every profile-picture picker on the form.
   *
   * One loop rather than three sets of handlers, because the three seats
   * differ only in which slot they write to. The file input is opened from
   * the button in front of it — a bare file input can show neither a preview
   * nor a way to take the picture back off.
   */
  #attachAvatarPickers() {
    this.#avatarPickers.forEach((node, slot) => {
      const file = node.querySelector('.avatar-picker__file');
      const button = node.querySelector('.avatar-picker__btn');
      const clear = node.querySelector('.avatar-picker__clear');

      button?.addEventListener('click', () => file?.click());

      clear?.addEventListener('click', () => {
        this.#showAvatar(node, null);
        this.#call('onAvatarChange', { slot, avatar: null });
        this.toast('Picture removed');
        button?.focus();
      });

      file?.addEventListener('change', async () => {
        const [picked] = file.files ?? [];
        // Cleared straight away, so choosing the same file twice still fires a
        // change event — otherwise re-picking after a failure does nothing at
        // all, which reads as the app ignoring you.
        file.value = '';
        if (!picked) return;

        node.classList.add('is-busy');
        const result = await fileToAvatar(picked);
        node.classList.remove('is-busy');

        if (!result.ok) {
          this.toast(result.error, 'error');
          return;
        }

        this.#showAvatar(node, result.avatar);
        this.#call('onAvatarChange', { slot, avatar: result.avatar });
      });
    });
  }

  #attachListeners() {
    // --- Menu screen ---
    this.#dom['btn-new-game']?.addEventListener('click', () => this.#call('onNewGameScreen'));
    this.#dom['btn-continue-game']?.addEventListener('click', () => this.#call('onContinue'));
    this.#dom['btn-menu-settings']?.addEventListener('click', () => this.openModal('settings'));

    // --- Setup screen ---
    this.#dom['btn-setup-back']?.addEventListener('click', () => this.showScreen('menu'));
    this.#dom['form-new-game']?.addEventListener('submit', (event) => {
      event.preventDefault();
      const mode = this.#selectedMode();

      // Online has no Start: the game begins when somebody joins, so the room
      // buttons are the only way in. Hiding the button is not enough on its
      // own — a hidden submit button is still the form's default button, so
      // Enter in the room-code field would submit anyway, and a submit online
      // starts a two-player game on the wrong session. Refuse it here.
      if (mode === GAME_MODE.ONLINE) return;

      this.#call('onStartGame', {
        mode,
        whiteName: this.#dom['input-white']?.value ?? '',
        blackName: this.#dom['input-black']?.value ?? '',
        whiteAvatar: this.#avatarFor('p1'),
        blackAvatar: this.#avatarFor('p2'),
        timeControl: this.#selectedTimeControl(),
        opponent: this.#selectedOpponent(),
      });
    });

    this.#attachAvatarPickers();

    // --- Mode toggle: each mode needs a different part of this form ---
    this.#dom['form-new-game']?.addEventListener('change', (event) => {
      if (event.target.name !== 'mode') return;
      this.#applyMode(event.target.value);
    });

    this.#dom['btn-create-room']?.addEventListener('click', () =>
      this.#call('onCreateRoom', {
        name: this.#dom['input-online-name']?.value ?? '',
        avatar: this.#avatarFor('online'),
      }));

    this.#dom['btn-join-room']?.addEventListener('click', () =>
      this.#call('onJoinRoom', {
        code: this.#dom['input-room-code']?.value ?? '',
        name: this.#dom['input-online-name']?.value ?? '',
        avatar: this.#avatarFor('online'),
      }));

    // Room codes are always upper case, and only ever contain code characters.
    this.#dom['input-room-code']?.addEventListener('input', (event) => {
      const cleaned = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned !== event.target.value) event.target.value = cleaned;
    });
    this.#dom['input-room-code']?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.#call('onJoinRoom', {
        code: this.#dom['input-room-code']?.value ?? '',
        name: this.#dom['input-online-name']?.value ?? '',
        avatar: this.#avatarFor('online'),
      });
    });

    this.#dom['btn-cancel-room']?.addEventListener('click', () => this.#call('onCancelRoom'));
    this.#dom['btn-copy-code']?.addEventListener('click', () =>
      this.#call('onCopyRoomCode', this.#dom['room-code-value']?.textContent ?? ''));

    this.#dom['btn-draw-accept']?.addEventListener('click', () => {
      this.closeDrawOffer();
      this.#call('onAcceptDraw');
    });
    this.#dom['btn-draw-decline']?.addEventListener('click', () => {
      this.closeDrawOffer();
      this.#call('onDeclineDraw');
    });
    this.#dom['btn-leave-room']?.addEventListener('click', () => {
      this.closeOpponentLeft();
      this.#call('onLeaveGame');
    });

    // --- Game header ---
    this.#dom['btn-game-menu']?.addEventListener('click', () => this.openModal('menu'));
    this.#dom['btn-game-settings']?.addEventListener('click', () => this.openModal('settings'));

    // --- Controls ---
    // Routed through one helper so the lock is enforced in a single place. A
    // locked control is aria-disabled rather than `disabled`, so the browser
    // still delivers its click — from a tap and from Enter or Space on a
    // focused button alike — and this is what refuses to act on it.
    const control = (id, action) => {
      this.#dom[`btn-${id}`]?.addEventListener('click', () => {
        if (isControlLocked(id)) {
          this.toast(`${this.#dom[`btn-${id}`].title}`, 'warn');
          return;
        }
        this.#call(action);
      });
    };
    control('undo', 'onUndo');
    control('flip', 'onFlip');
    control('resign', 'onResign');

    // Zoom cycles rather than stepping, so one button covers every level and
    // the row keeps its shape. Three steps is few enough that wrapping round
    // from the largest back to the smallest is quicker than hunting for a
    // second button — and the label always says where you are.
    this.#dom['btn-zoom']?.addEventListener('click', () => {
      const current = clampBoardZoom(this.#controller.getSettings().boardZoom);
      const next = (current + 1) % BOARD_ZOOM_LEVELS.length;
      this.#call('onSettingChange', { boardZoom: next });
      this.toast(`Board size: ${BOARD_ZOOM_LEVELS[next].label}`);
    });
    this.#dom['btn-restart']?.addEventListener('click', () => this.#call('onRestart'));
    this.#dom['btn-leave']?.addEventListener('click', () => this.#call('onLeaveGame'));

    // --- History ---
    this.#dom['btn-history-toggle']?.addEventListener('click', () => {
      this.#historyExpanded = !this.#historyExpanded;
      this.#dom['history-panel']?.classList.toggle('is-expanded', this.#historyExpanded);
      this.#dom['btn-history-toggle']?.setAttribute('aria-expanded', String(this.#historyExpanded));
      if (this.#historyExpanded) {
        const list = this.#dom['history-list'];
        if (list) list.scrollTop = list.scrollHeight;
      }
    });

    // --- Promotion (delegated) ---
    this.#dom['promotion-choices']?.addEventListener('click', (event) => {
      const choice = event.target.closest('.promotion__choice');
      if (!choice) return;
      // Close first so the modal cannot accept a second click.
      const modal = this.#dom['modal-promotion'];
      if (modal) {
        modal.classList.remove('is-open');
        modal.hidden = true;
      }
      if (this.#openModal === 'promotion') this.#openModal = null;
      document.body.classList.remove('is-modal-open');
      this.#call('onPromotionChoice', choice.dataset.piece);
    });

    // --- Confirm ---
    this.#dom['btn-confirm-ok']?.addEventListener('click', () => this.#settleConfirm(true));
    this.#dom['btn-confirm-cancel']?.addEventListener('click', () => this.#settleConfirm(false));
    this.#dom['btn-confirm-alt']?.addEventListener('click', () =>
      this.#settleConfirm(this.#confirmAltValue));

    // --- Game over ---
    this.#dom['btn-rematch']?.addEventListener('click', () => {
      this.closeModal('gameover');
      this.#call('onRematch');
    });
    this.#dom['btn-ladder-next']?.addEventListener('click', (event) => {
      this.closeModal('gameover');
      this.#call('onLadderNext', { round: Number(event.currentTarget.dataset.round) });
    });

    this.#dom['btn-gameover-new']?.addEventListener('click', () => {
      this.closeModal('gameover');
      this.#call('onNewGameScreen');
    });

    // --- Settings ---
    const settingInputs = {
      'set-sound': 'sound',
      'set-coords': 'showCoordinates',
      'set-animations': 'animations',
      'set-autoflip': 'autoFlip',
    };
    Object.entries(settingInputs).forEach(([id, key]) => {
      this.#dom[id]?.addEventListener('change', (event) => {
        this.#call('onSettingChange', { [key]: event.target.checked });
      });
    });

    this.#dom['style-picker']?.addEventListener('click', (event) => {
      const option = event.target.closest('.style-option');
      if (!option) return;
      this.#call('onSettingChange', { uiStyle: option.dataset.style });
    });

    this.#dom['theme-picker']?.addEventListener('click', (event) => {
      const swatch = event.target.closest('.theme-swatch');
      if (!swatch) return;
      this.#call('onSettingChange', { boardTheme: swatch.dataset.theme });
    });

    // Both pickers behave the same way and neither belongs to the
    // controller: what is chosen here is not a setting and not game state
    // until a game actually starts with it.
    ['time-picker', 'opponent-picker'].forEach((id) => {
      this.#dom[id]?.addEventListener('click', (event) => {
        const option = event.target.closest('.time-option');
        if (!option) return;
        this.#dom[id].querySelectorAll('.time-option').forEach((node) => {
          const active = node === option;
          node.classList.toggle('is-active', active);
          node.setAttribute('aria-checked', String(active));
        });
        // The opponent decides whether the second name box is any use.
        if (id === 'opponent-picker') this.#applyMode(this.#selectedMode());
      });
    });

    this.#dom['bg-picker']?.addEventListener('click', (event) => {
      const swatch = event.target.closest('.bg-swatch');
      if (!swatch) return;
      this.#call('onSettingChange', { background: swatch.dataset.bg });
    });

    // --- Global: backdrop clicks and Escape ---
    document.addEventListener('click', (event) => {
      const closer = event.target.closest('[data-close]');
      if (closer) this.closeModal(closer.dataset.close);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.#openModal) return;

      // Dismissing a draw offer must actually answer it, otherwise the offer
      // would sit unanswered in the room with no way to raise it again.
      if (this.#openModal === 'draw-offer') {
        this.closeDrawOffer();
        this.#call('onDeclineDraw');
        return;
      }

      // The promotion modal is dismissible: cancelling simply abandons the move.
      this.closeModal(this.#openModal);
    });
  }
}

export default UI;
