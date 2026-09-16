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
  BACKGROUNDS,
  DEFAULT_BACKGROUND,
  resolveBackground,
  EMOTES,
  emote,
  CHAT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  EMOTE_BUBBLE_MS,
  FRIEND_CODE_LENGTH,
  PRESENCE,
  BOARD_ZOOM_LEVELS,
  clampBoardZoom,
  GAME_MODE,
  BOT_LEVELS,
  DEFAULT_BOT_LEVEL,
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
// Small, pure and free of any engine, so the rules card and the power bar can
// be built from the same table the variant's rules are written against —
// rather than from a second copy of them kept in step by hand.
import {
  ELEMENTS,
  ELEMENT_ORDER,
  SLOT_CANDIDATES,
  SLOT_SIZE,
  SUPERS,
  CONTESTED_SLOTS,
  defaultLoadout,
} from './elemental.js';

/**
 * The second line of a row in the powers panel: who holds it, and why you can
 * or cannot press it.
 *
 * One line and one function, because the answers are mutually exclusive and
 * the order they are tested in IS the explanation: "all spent" beats "nothing
 * in reach", which beats "one a turn". Spread across the render loop as
 * ternaries, that order stops being visible and starts being an accident.
 *
 * It has to stay SHORT. The row is one line with an ellipsis at 320px wide,
 * and a line that reads "Pawn · ready, or when it cap…" is worse than a
 * shorter one that finishes its sentence — which is why Fire and Lightning
 * say only "on capture" when they have nothing in reach, and leave the rest
 * of the story to the row's own description.
 */
function powerLine(info, entry, { mine, used }) {
  if (!mine) return info.piece;
  if (!entry || !entry.squares.length) return `${info.piece} · all spent`;
  if (entry.blockedBy === 'void') return `${info.piece} · silenced`;
  if (entry.blockedBy) return `${info.piece} · held shut`;
  if (used) return `${info.piece} · one power a turn`;
  if (!entry.ready.length) {
    return `${info.piece} · ${info.onCapture ? 'on capture' : 'nothing in reach'}`;
  }
  return `${info.piece} · ready`;
}

/** A blank friend code, drawn the same way a blank room code is. */
const FRIEND_CODE_BLANK = '-'.repeat(FRIEND_CODE_LENGTH);

/**
 * How long ago, in the roughest terms that are still useful.
 *
 * Deliberately coarse. "Last seen 3 minutes ago" and "last seen 4 minutes
 * ago" are the same fact — that they just missed you — and a readout that
 * changes every minute invites watching it, which is not a thing a friends
 * list should invite.
 */
function describeSince(at) {
  if (!at) return 'Offline';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 120) return 'Last seen just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `Last seen ${days} day${days === 1 ? '' : 's'} ago`;
}

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

  /**
   * What was open underneath the confirmation.
   *
   * `#openModal` is one slot, which held for as long as dialogs never
   * overlapped. A confirmation breaks that by design: it is always raised
   * from on top of something — the friends sheet, the game menu, the
   * settings — and opening it overwrote the name of whatever it covered.
   * Settling it then set the slot to null, so the page scroll came back
   * under a sheet that was still open and a later `closeModal()` with no
   * argument had nothing to close.
   *
   * One deep rather than a stack, because one is the depth the app actually
   * uses: nothing raises a confirmation from on top of a confirmation.
   */
  #confirmUnder = null;
  #lastFocused = null;
  #confirmResolver = null;
  /** What dismissing the confirmation resolves to — see confirm(). */
  #confirmDismiss = false;
  #confirmAltValue = 'alt';
  #historyExpanded = false;

  /**
   * Whether the seven-power panel is open, and its rows once built.
   *
   * Closed to start with: the bar above it answers the common question on its
   * own, and the panel is the one you open when you want to plan rather than
   * move. The choice is deliberately NOT remembered across games — it costs
   * one tap to reopen, and a panel that is already open on move one hides the
   * bottom of the board before anybody has asked it to.
   */
  #powersOpen = false;
  #powerRows = null;

  /**
   * The elements this side is bringing, while the New Game form is open.
   *
   * Held here rather than read back off the chips, because the chips are the
   * picture and this is the fact: a slot that is one short has to be able to
   * say so, and counting ticked buttons would make the answer depend on a
   * render having happened.
   */
  #loadout = new Set(defaultLoadout());

  /** Built once — the chips must not be replaced under a thumb mid-tap. */
  #loadoutBuilt = false;

  /** Which elements the game in progress contains. Null until a turn is ours. */
  #carried = null;

  /** Which card is currently showing a name box, if either. */
  #renaming = null;

  /**
   * The last thing render() was given.
   *
   * Kept for one reason: opening the powers panel changes nothing about the
   * game, so no change event is coming to repaint it with. Rather than route
   * a view-only tap out through the controller and back, the toggle repaints
   * itself from here.
   */
  #lastSnapshot = null;

  /**
   * Messages that have arrived since the sheet was last open.
   *
   * Counted here rather than derived from the log, because "unread" is a
   * fact about this screen and nothing else knows it — the room has no idea
   * whether anybody is looking.
   */
  #unread = 0;

  /**
   * The ids of the log as it was last painted, joined.
   *
   * Chat is repainted from render(), which runs on every move, every
   * tick that changes a card, and every settings change. Rebuilding the list
   * each time would throw away the scroll position mid-conversation, so the
   * whole render is skipped unless the log has actually changed.
   */
  #chatPainted = '';

  /**
   * The room the chat panel is currently showing.
   *
   * Unread is a fact about one conversation, and a conversation is a room.
   * Without this, joining a second game would open with a count left over
   * from the first, pointing at messages that are no longer there.
   */
  #chatRoom = null;

  /** Whether chat is switched on, remembered from the last render. */
  #chatOn = true;

  /**
   * Which card each colour is on, as of the last render.
   *
   * An emote lands on its sender's card, and which card that is depends on
   * board orientation — which flips on a rematch, on Auto Flip, and on the
   * Flip button. Read from the render that already worked it out rather than
   * worked out again here from a different source.
   */
  #cardSide = { w: 'bottom', b: 'top' };

  /** Per-card timer that takes an emote back off again. */
  #emoteTimers = { top: null, bottom: null };

  /** The last social snapshot, kept so a re-render needs no round trip. */
  #social = null;

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
      'btn-rename-top', 'btn-rename-bottom',
      'input-rename-top', 'input-rename-bottom',
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
      'bot-fields', 'bot-picker',
      'opponent-fields', 'opponent-picker', 'opponent-bot-hint',
      'mode-elemental', 'elemental-fields', 'elements-list',
      'loadout-list', 'loadout-count', 'loadout-hint',
      'powerbar', 'power-glyph', 'power-name', 'power-hint', 'btn-power',
      'powerbar-super', 'super-name', 'super-hint', 'btn-super',
      'btn-powers-toggle', 'powers-list',
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
      // Chat, emotes and friends
      'set-chat', 'btn-chat', 'chat-unread',
      'modal-chat', 'chat-log', 'chat-empty', 'emote-bar',
      'chat-form', 'chat-input', 'btn-chat-send',
      'top-emote', 'bottom-emote',
      'btn-menu-friends', 'friends-badge',
      'modal-friends', 'input-my-name', 'my-code', 'btn-copy-friend-code',
      'friends-status', 'form-add-friend', 'input-friend-code', 'btn-add-friend',
      'invites-section', 'invites-list',
      'requests-section', 'requests-list', 'friends-list', 'friends-empty',
      'btn-invite-friend',
      'style-picker',
    ];
    ids.forEach((id) => {
      this.#dom[id] = el(id);
    });
  }

  #buildDynamic() {
    // The emote row, from the one list that defines what an emote is. The
    // glyph is decoration and the label is the name: a screen reader hears
    // "Send Good game", not a codepoint.
    const emotes = this.#dom['emote-bar'];
    if (emotes) {
      emotes.innerHTML = '';
      EMOTES.forEach(({ id, glyph, label }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'emote';
        button.dataset.emote = id;
        button.setAttribute('aria-label', `Send ${label}`);
        button.title = label;
        button.innerHTML = '<span class="emote__glyph" aria-hidden="true"></span>';
        button.querySelector('.emote__glyph').textContent = glyph;
        emotes.append(button);
      });
    }

    // Both caps come from config so that a message can never be typed that
    // the room would then refuse, and a code box can never hold more than a
    // code. Set here rather than in the markup for the same reason the room
    // code field is: the markup cannot import a constant.
    this.#dom['chat-input']?.setAttribute('maxlength', String(CHAT_MAX_LENGTH));
    this.#dom['input-friend-code']?.setAttribute('maxlength', String(FRIEND_CODE_LENGTH));

    // Every box a name can be typed into, from one number. The markup
    // cannot import the constant, so the four attributes over in index.html
    // are a fallback for a page whose scripts have not run, rather than the
    // source — and the two rename boxes have no attribute at all, because
    // they are only ever filled by a script that has.
    ['input-white', 'input-black', 'input-online-name', 'input-my-name',
      'input-rename-top', 'input-rename-bottom']
      .forEach((id) => this.#dom[id]?.setAttribute('maxlength', String(NAME_MAX_LENGTH)));

    // How long an emote bubble lasts is one number, and both halves of it
    // read this: the animation from here, and the timer that hides the
    // bubble from the constant directly.
    document.documentElement.style.setProperty('--emote-bubble', `${EMOTE_BUBBLE_MS}ms`);
    if (this.#dom['my-code']) this.#dom['my-code'].textContent = FRIEND_CODE_BLANK;

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

      // A picker that needs a seat to carry the picture offers itself only
      // while seats actually do. Better no control than a control that
      // quietly does nothing — and the decision is read from the same flag
      // the session writes seats by, so the form and the room cannot disagree
      // about it. Keyed on the markup rather than on the slot, because the
      // friends panel shares that slot and is NOT gated by it: a profile row
      // is a different write with its own rules.
      if (node.dataset.avatarRequires === 'seat-pictures' && !ONLINE_AVATARS) {
        node.hidden = true;
        return;
      }

      // A list per slot, because one picture can have more than one control
      // onto it: your profile picture is offered both on the online form and
      // in the friends panel, and setting it in either has to show in both.
      if (!this.#avatarPickers.has(slot)) this.#avatarPickers.set(slot, []);
      this.#avatarPickers.get(slot).push(node);

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

    // Difficulty. Same shape as every other picker here: one list in
    // config.js decides what exists, and the markup holds none of it.
    const levels = this.#dom['bot-picker'];
    if (levels) {
      levels.innerHTML = '';
      BOT_LEVELS.forEach((level) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'time-option';
        button.dataset.level = level.id;
        button.setAttribute('role', 'radio');
        const chosen = level.id === DEFAULT_BOT_LEVEL;
        button.setAttribute('aria-checked', String(chosen));
        if (chosen) button.classList.add('is-active');
        button.innerHTML =
          `<span class="time-option__label">${level.label}</span>`
          + `<span class="time-option__name">${level.hint}</span>`;
        // The hint is decoration beside the name for a sighted reader and
        // the whole of what the button means for anybody else, so it is
        // said once, joined up.
        button.setAttribute('aria-label', `${level.label} — ${level.hint}`);
        levels.append(button);
      });
    }

    // The elemental rules card. Built from the same table the rules
    // themselves are written against, so an element cannot end up described
    // here as one thing and implemented as another.
    const elements = this.#dom['elements-list'];
    if (elements) {
      elements.innerHTML = '';
      ELEMENT_ORDER.forEach((id) => {
        const element = ELEMENTS[id];
        const item = document.createElement('li');
        item.className = 'element';
        item.dataset.element = id;
        // The super goes on the card as well as in the bar. The bar can only
        // tell you about a piece you have already picked up, and the card is
        // where the variant is learned — a second power per element that is
        // only ever discovered by selecting the right piece is a feature most
        // players would never find.
        const over = SUPERS[id];
        item.innerHTML =
          `<span class="element__glyph" aria-hidden="true">${element.emoji}</span>` +
          '<span class="element__body">' +
          `<span class="element__name">${element.piece} — ${element.power}</span>` +
          `<span class="element__desc">${element.blurb}</span>` +
          (over
            ? '<span class="element__super">'
              + `<span class="element__supername">✦ ${over.power}</span>`
              + `<span class="element__superdesc">${over.blurb}</span>`
              + '</span>'
            : '') +
          '</span>';
        elements.append(item);
      });
    }

    // After the card, not before: the first paint greys the rows the loadout
    // left out, and it cannot grey rows that have not been made yet.
    this.#buildLoadout();

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
    const elemental = mode === GAME_MODE.ELEMENTAL;

    if (this.#dom['online-fields']) this.#dom['online-fields'].hidden = !online;
    // Difficulty is asked only where it is answerable. The Elemental bot
    // takes no level — there is no picker for it, and a game that silently
    // used whatever this one was left on would be a choice nobody made.
    if (this.#dom['bot-fields']) this.#dom['bot-fields'].hidden = !bot;
    if (this.#dom['elemental-fields']) this.#dom['elemental-fields'].hidden = !elemental;
    // Elemental is the one mode that asks who you are playing, being the one
    // that can be played either way round on this device.
    if (this.#dom['opponent-fields']) {
      this.#dom['opponent-fields'].hidden = !elemental;
    }
    if (this.#dom['btn-start-game']) this.#dom['btn-start-game'].hidden = online;

    const nameFields = this.#dom['form-new-game']
      ?.querySelectorAll('.field:not(.field--modes)');
    // Elemental asks for a second name only when a second person is going
    // to type one in.
    const soloVariant = elemental && this.#selectedOpponent() === 'bot';
    nameFields?.forEach((field, index) => {
      if (index === 0) field.hidden = online;  // your own name
      else if (index === 1) {                  // the opponent's
        field.hidden = online || bot || soloVariant;
      }
    });
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
    this.#lastSnapshot = snapshot;
    this.#renderZoomControl(snapshot.settings);
    this.#renderPlayers(snapshot);
    this.#renderStatus(snapshot);
    this.#renderHistory(state);
    this.#renderControls(snapshot);
    this.#renderPowerBar(snapshot);
    this.#renderPowers(snapshot);
    this.#chatOn = snapshot.settings?.chat !== false;
    this.#renderOnline(state);
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

    // Hidden outright when chat is switched off, rather than shown and
    // refusing: a button that is there is a promise that pressing it does
    // something.
    const chatButton = this.#dom['btn-chat'];
    if (chatButton) chatButton.hidden = !online.roomCode || !this.#chatOn;

    if (online.roomCode !== this.#chatRoom) {
      this.#chatRoom = online.roomCode;
      this.#unread = 0;
      this.#chatPainted = '';
    }

    this.#renderChat(state);
    this.#renderUnread();
  }

  // -----------------------------------------------------------------------
  // Chat and emotes
  // -----------------------------------------------------------------------

  /**
   * Paint the log, but only when it has actually changed.
   *
   * See #chatPainted: this runs from render(), which runs constantly, and
   * rebuilding the list would reset the scroll position of a conversation
   * somebody is in the middle of reading.
   */
  #renderChat(state) {
    const log = this.#dom['chat-log'];
    if (!log) return;

    const messages = state.online?.chat ?? [];
    const painted = messages.map((message) => message.id).join(',');
    if (painted === this.#chatPainted) return;
    this.#chatPainted = painted;

    log.innerHTML = '';
    messages.forEach((message) => log.append(this.#chatRow(message, state)));
    if (this.#dom['chat-empty']) this.#dom['chat-empty'].hidden = messages.length > 0;

    // Newest last, so the bottom is where the conversation is.
    log.scrollTop = log.scrollHeight;
  }

  /**
   * One message.
   *
   * Built out of nodes and written with textContent. It has to be: the body
   * of a text message is the one string in this app that another person
   * chose, and innerHTML anywhere on this path would be a way to put markup
   * on somebody else's screen. An emote is looked up rather than printed,
   * so an id that is not on the list draws nothing at all.
   */
  #chatRow(message, state) {
    const row = document.createElement('li');
    row.className = 'chat__row';
    row.dataset.who = message.mine ? 'me' : 'them';

    const who = document.createElement('span');
    who.className = 'chat__who';
    who.textContent = state.players?.[message.color]?.name ?? '';
    who.title = who.textContent;

    const body = document.createElement('span');
    if (message.kind === 'emote') {
      const found = emote(message.body);
      body.className = 'chat__emote';
      body.textContent = found?.glyph ?? '';
      body.setAttribute('aria-label', found?.label ?? 'Emote');
    } else {
      body.className = 'chat__body';
      body.textContent = message.body;
    }

    row.append(who, body);
    return row;
  }

  /**
   * React to messages the controller has just noticed.
   *
   * The log itself is painted by the render that follows this — what happens
   * here is only the two things a render cannot do: pop the emote onto a
   * card, and count what has not been read.
   */
  onChatMessages(messages = []) {
    if (!this.#chatOn) return;

    // The bubble goes on a player card, and while the sheet is open the
    // cards are behind it — so it popped UNDER the panel with about six
    // pixels of itself showing past the bottom edge. Which it did every
    // single time anybody sent one, because the emote row lives in the
    // sheet: there is no way to send an emote with the sheet shut, so the
    // sender has never once seen their own bubble land, only a sliver of
    // it poking out from behind the panel.
    //
    // An emote already has a place to appear while the sheet is up: the
    // log row this same message just drew, attributed and permanent. The
    // bubble is for the other case, when somebody is looking at the board
    // instead. One or the other, never a glimpse of both.
    if (!this.isChatOpen()) {
      messages.forEach((message) => {
        if (message.kind === 'emote') this.showEmote(message.color, message.body);
      });
    }

    if (this.isChatOpen()) return;
    const incoming = messages.filter((message) => !message.mine).length;
    if (!incoming) return;
    this.#unread += incoming;
    this.#renderUnread();
  }

  /**
   * Put an emote on the sender's card for EMOTE_BUBBLE_MS.
   *
   * The class is removed and forced through a reflow before being added
   * again, so a second emote replays the animation instead of sitting still
   * because the class was already there.
   */
  showEmote(color, id) {
    const found = emote(id);
    if (!found) return;

    const side = this.#cardSide[color] ?? 'top';
    const node = this.#dom[`${side}-emote`];
    if (!node) return;

    node.textContent = found.glyph;
    node.hidden = false;
    node.classList.remove('is-popping');
    void node.offsetWidth;
    node.classList.add('is-popping');

    window.clearTimeout(this.#emoteTimers[side]);
    this.#emoteTimers[side] = window.setTimeout(() => {
      node.classList.remove('is-popping');
      node.hidden = true;
    }, EMOTE_BUBBLE_MS);
  }

  /**
   * Is the sheet up? Decides whether an arrival is news or already on screen.
   *
   * Asked of the sheet rather than of `#openModal`, because a confirmation
   * raised over the chat takes that slot for as long as it is up — and a
   * message arriving in that window is not news. You are looking straight
   * at the log it lands in.
   */
  isChatOpen() {
    return this.#dom['modal-chat'] ? !this.#dom['modal-chat'].hidden : false;
  }

  #renderUnread() {
    const badge = this.#dom['chat-unread'];
    if (!badge) return;
    badge.hidden = this.#unread === 0;
    badge.textContent = this.#unread > 9 ? '9+' : String(this.#unread);
  }

  /** Open the sheet, and treat everything in it as read. */
  openChat() {
    this.#unread = 0;
    this.#renderUnread();
    this.openModal('chat');
    // openModal focuses the first control, which here is the close button.
    // The box is what you came for.
    this.#dom['chat-input']?.focus();
    const log = this.#dom['chat-log'];
    if (log) log.scrollTop = log.scrollHeight;
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

  #renderPlayers({ state, orientation, controllable = [] }) {
    const bottomColor = orientation === 'black' ? BLACK : WHITE;
    const topColor = bottomColor === WHITE ? BLACK : WHITE;
    const taken = this.#readCaptures(state.verboseMoves);

    const apply = (prefix, color) => {
      const name = this.#dom[`${prefix}-name`];
      const colorEl = this.#dom[`${prefix}-color`];
      const turnEl = this.#dom[`${prefix}-turn`];
      const card = this.#dom[`card-${prefix === 'top' ? 'top' : 'bottom'}`];

      // The card is one line with an ellipsis, and a name is now allowed to
      // be long enough to reach it. The title carries the whole thing, so a
      // clipped name can still be read rather than merely noticed.
      if (name) {
        const full = state.players[color]?.name ?? '';
        name.textContent = full;
        name.title = full;
      }

      // Offered on any seat this device may act for, which is the same
      // question as "may I move these pieces" and so is asked of the session
      // rather than worked out from the mode. Online that is one seat; against
      // a bot it is yours and not the bot's; in local two-player it is both,
      // and both cards get a pencil.
      //
      // It follows the COLOUR rather than the position, because Flip can put
      // your seat at the top of the screen.
      const rename = this.#dom[`btn-rename-${prefix}`];
      if (rename) {
        const mine = controllable.includes(color);
        rename.hidden = !mine || Boolean(state.isGameOver);
        // A box still open when the card stops being yours — a rematch
        // swapping the colours — would be writing to somebody else's seat.
        if (rename.hidden) this.#stopRenaming(prefix);
      }
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

    // Kept for showEmote(), which needs to know whose card is where and
    // must not work it out from a second source that could disagree.
    this.#cardSide = bottomColor === WHITE
      ? { [WHITE]: 'bottom', [BLACK]: 'top' }
      : { [WHITE]: 'top', [BLACK]: 'bottom' };
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

  /**
   * The elemental power bar.
   *
   * Four things it can be saying, and the order they are checked in is the
   * order they matter: a power is being aimed, a power is ready, the piece you
   * have picked up has one that goes off by itself, or nothing is selected.
   *
   * The bar exists at all only in a game that has an `elemental` block, so
   * every other mode leaves this after one line.
   */
  #renderPowerBar(snapshot) {
    const bar = this.#dom.powerbar;
    if (!bar) return;

    const { state, view } = snapshot;
    const on = Boolean(state.elemental) && !state.isGameOver;
    bar.hidden = !on;
    if (!on) return;

    const button = this.#dom['btn-power'];
    const glyph = this.#dom['power-glyph'];
    const name = this.#dom['power-name'];
    const hint = this.#dom['power-hint'];

    const say = (emoji, title, detail, action = null, mood = null) => {
      if (glyph) glyph.textContent = emoji;
      if (name) name.textContent = title;
      if (hint) hint.textContent = detail;
      if (button) {
        button.hidden = !action;
        if (action) button.textContent = action;
      }
      bar.dataset.state = mood ?? (action ? 'ready' : 'idle');
    };

    // The super line, decided before the bar's own state is: while a power
    // is being aimed there is exactly one thing to do, and offering a second
    // button beside "Cancel" would be offering a way deeper into a mode the
    // player is trying to leave.
    this.#renderSuperRow(view?.aiming ? null : this.#controller.getSelectedSuper?.() ?? null,
      state.elemental?.powerUsed);

    // Aiming. The bar becomes the way out of it, because the player is now in
    // a mode, and a mode with no visible exit is a trap.
    if (view?.aiming) {
      const aimed = ELEMENTS[view.aiming.element];
      say(aimed.emoji, view.aiming.name, 'Tap a highlighted square', 'Cancel', 'aiming');
      return;
    }

    const power = this.#controller.getSelectedPower?.() ?? null;
    if (!power) {
      const spent = state.elemental.powerUsed;
      // Short enough to survive a 320px screen whole. The hint is one line
      // with an ellipsis by design, and the All powers button beside it took
      // room the longer wordings used to have — a hint that reads "Select one
      // of your pie…" is worse than a shorter one that finishes its sentence.
      say('🜁', 'Powers', spent ? 'One power a turn' : 'Select a piece');
      return;
    }

    const element = ELEMENTS[power.element];
    if (power.blockedBy === 'void') {
      say(element.emoji, power.info.power, 'The Void has it by the throat');
      return;
    }
    if (power.blockedBy) {
      say(element.emoji, power.info.power, 'Their Light bishop holds it shut');
      return;
    }
    // Nothing in reach, on a power that also goes off by itself. Saying so
    // matters: the piece is not idle, it is one square away from being
    // frightening, and it may not need the charge at all to get there.
    //
    // Four words, because this line is one line with an ellipsis and there
    // are only about twenty characters of it at 320px wide. "Fires free when
    // this piece captures" was the first try and arrived as "Fires free when
    // this piec…", which says less than nothing.
    if (!power.ready && power.info.onCapture) {
      say(element.emoji, power.info.power, 'Free on a capture');
      return;
    }
    if (state.elemental.powerUsed) {
      say(element.emoji, power.info.power, 'One power a turn');
      return;
    }
    if (!power.ready) {
      say(element.emoji, power.info.power, 'Nothing in reach');
      return;
    }
    say(element.emoji, power.info.power, element.blurb, 'Use');
  }

  /**
   * The super line under the bar.
   *
   * Shown only when there is one to fire — a line that is always there and
   * usually refuses is worse than one that appears when it means something,
   * and this is a bar that has to fit four other controls at 320px.
   *
   * The hint is the price, every time, because the price is the whole of what
   * makes a super a decision. "Costs your move" is three words and is the
   * only thing a player needs to know before pressing it.
   */
  #renderSuperRow(power, powerUsed) {
    const row = this.#dom['powerbar-super'];
    if (!row) return;

    const ready = Boolean(power) && power.ready && !power.blockedBy && !powerUsed;
    row.hidden = !ready;
    if (!ready) return;

    const name = this.#dom['super-name'];
    const hint = this.#dom['super-hint'];
    if (name) name.textContent = power.info.power;
    if (hint) hint.textContent = 'Costs your move';
    row.dataset.element = power.element;
  }

  /**
   * Which colour is sitting on a given card right now.
   *
   * #cardSide is built by #renderPlayers from the orientation and is the one
   * place that mapping lives, so asking it here keeps a second copy of
   * "who is where" from drifting out of step with the first.
   */
  #colorOnCard(prefix) {
    return Object.keys(this.#cardSide ?? {}).find((c) => this.#cardSide[c] === prefix) ?? null;
  }

  /**
   * Swap the name on a card for a box holding the same name.
   *
   * Deliberately not a modal. A name is one short string and the card is
   * already showing it: putting the box where the name was means the player
   * is editing the thing they tapped, in the place they tapped it, rather
   * than reading a dialog about it.
   */
  #startRenaming(prefix) {
    const input = this.#dom[`input-rename-${prefix}`];
    const line = this.#dom[`${prefix}-name`]?.parentElement;
    if (!input || !line) return;

    input.value = this.#dom[`${prefix}-name`]?.textContent ?? '';
    line.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
    this.#renaming = prefix;
  }

  /** Put the name back, whether it changed or not. */
  #stopRenaming(prefix = this.#renaming) {
    if (!prefix) return;
    const input = this.#dom[`input-rename-${prefix}`];
    const line = this.#dom[`${prefix}-name`]?.parentElement;
    if (input) input.hidden = true;
    if (line) line.hidden = false;
    if (this.#renaming === prefix) this.#renaming = null;
  }

  /**
   * The seven powers, open.
   *
   * The power bar above can only ever speak about the piece in hand, which is
   * the wrong half of the question before you have picked one up: "what do I
   * still have" is not answerable from a board where a charge is a glyph the
   * size of a fingernail and you have to know by heart which element each
   * piece carries. This is that answer, and it is also the rules card — the
   * one on the New Game form goes out of reach the moment the game starts.
   *
   * Seven rows, always, spent ones greyed rather than dropped. The list is
   * read mid-game with a thumb already moving, and a row that vanishes when
   * its last piece dies takes the five below it up a place.
   */
  #renderPowers(snapshot) {
    const list = this.#dom['powers-list'];
    const toggle = this.#dom['btn-powers-toggle'];
    if (!list || !toggle) return;

    const { state } = snapshot;
    const on = Boolean(state.elemental) && !state.isGameOver;
    toggle.hidden = !on;
    if (!on) {
      list.hidden = true;
      return;
    }

    list.hidden = !this.#powersOpen;
    toggle.setAttribute('aria-expanded', String(this.#powersOpen));
    if (!this.#powersOpen) return;

    if (!this.#powerRows) this.#buildPowerRows(list);

    // Empty while the other side is to move — getArsenal() is gated the same
    // way getPower() is. The rows stay up regardless: somebody reading what
    // Vines does while the bot thinks should not have the panel blink out
    // from under them.
    const held = new Map(
      this.#controller.getArsenal().map((row) => [row.element, row]),
    );
    const mine = held.size > 0;
    const used = Boolean(state.elemental.powerUsed);

    // Which elements this game contains at all. Read off the board rather
    // than off the loadout, because the board is the thing that knows: a game
    // restored from a save has a loadout the panel never saw chosen, and a
    // hand-loaded position has none.
    //
    // Only settled while it is your turn, since getArsenal() is empty on the
    // other side's. Held from the last turn it was known, so the panel does
    // not shed half its rows every time the bot thinks.
    if (mine) {
      this.#carried = new Set(
        this.#controller.getArsenal().filter((row) => row.carried).map((row) => row.element),
      );
    }

    ELEMENT_ORDER.forEach((id) => {
      const info = ELEMENTS[id];
      const row = this.#powerRows.get(id);
      if (!row) return;

      // A row for a power nobody brought is a promise the board cannot keep.
      // Hidden rather than greyed: "all spent" and "never here" are different
      // things and only one of them is worth a line.
      const carried = !this.#carried || this.#carried.has(id);
      row.li.hidden = !carried;
      if (!carried) return;

      const entry = held.get(id) ?? null;
      const count = entry ? entry.squares.length : null;
      const ready = Boolean(
        entry && !used && !entry.blockedBy && entry.ready.length,
      );

      // Blank at nought rather than "×0", which would sit next to a row
      // already saying "all spent" and add nothing but noise.
      row.count.textContent = count ? `×${count}` : '';
      row.item.dataset.ready = String(ready);

      // Enabled whenever it is your turn, even when the power cannot fire —
      // the refusals say something worth hearing ("their Light bishop holds
      // it shut", "needs that piece next to something") and a
      // disabled row cannot say anything at all on a screen with no hover.
      row.item.disabled = !mine;
      row.who.textContent = powerLine(info, entry, { mine, used });
      row.item.setAttribute(
        'aria-label',
        `${info.name} — ${info.power}. ${info.detail}`,
      );
    });

    this.#powerRows.get('note').hidden = mine;
  }

  /**
   * Build the seven rows once and keep them.
   *
   * Not re-created on every render: the panel repaints on every published
   * state, and replacing the element under a thumb mid-tap loses the tap.
   */
  #buildPowerRows(list) {
    this.#powerRows = new Map();
    list.textContent = '';

    ELEMENT_ORDER.forEach((id) => {
      const info = ELEMENTS[id];

      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'powers__item';
      item.dataset.power = id;
      item.title = info.detail;

      const glyph = document.createElement('span');
      glyph.className = 'powers__glyph';
      glyph.textContent = info.emoji;
      glyph.setAttribute('aria-hidden', 'true');

      const bodyEl = document.createElement('span');
      bodyEl.className = 'powers__body';

      const name = document.createElement('span');
      name.className = 'powers__name';
      name.textContent = info.power;

      const who = document.createElement('span');
      who.className = 'powers__who';

      const count = document.createElement('span');
      count.className = 'powers__count';

      bodyEl.append(name, who);
      item.append(glyph, bodyEl, count);
      li.append(item);
      list.append(li);

      this.#powerRows.set(id, { li, item, who, count });
    });

    const note = document.createElement('li');
    note.className = 'powers__note';
    note.textContent = 'Your powers appear here on your turn.';
    list.append(note);
    this.#powerRows.set('note', note);
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
    // Escape comes through here rather than through #settleConfirm, so the
    // thing underneath has to be handed back on this path too.
    if (this.#openModal === name) {
      this.#openModal = name === 'confirm' ? this.#confirmUnder : null;
    }
    if (name === 'confirm') this.#confirmUnder = null;
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
      // Remembered BEFORE the open, which is what overwrites it.
      this.#confirmUnder = this.#openModal;
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
    if (this.#openModal === 'confirm') this.#openModal = this.#confirmUnder;
    this.#confirmUnder = null;
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

    this.openModal('gameover');
  }

  /** Which difficulty the form is offering. */
  #selectedBotLevel() {
    const active = this.#dom['bot-picker']?.querySelector('.time-option.is-active');
    return active?.dataset.level ?? DEFAULT_BOT_LEVEL;
  }

  /**
   * Who the Elemental game is against: 'bot' or 'human'.
   *
   * The picker it reads is styled as a `.time-option` because it was built
   * beside the time controls and shares their look. The time controls have
   * gone; the class stays, being what this picker is drawn with.
   */
  /**
   * The loadout picker: which elements this side is bringing.
   *
   * There are seventeen elements and sixteen pieces, so somebody has to be
   * left behind, and this is where that is decided. Only the CONTESTED slots
   * get a chooser — the ones with more elements than squares — which today is
   * the pawns and only the pawns. Everything on the back rank is settled and
   * is shown in the rules card below rather than as a row of chips that cannot
   * be unticked, because a control with exactly one legal state is not a
   * control, it is a label pretending to be one.
   *
   * Built once, from the same table the game reads. Add a second queen element
   * to ELEMENTS and a queen chooser appears here on its own.
   */
  #buildLoadout() {
    const list = this.#dom['loadout-list'];
    if (!list || this.#loadoutBuilt) return;
    this.#loadoutBuilt = true;
    list.textContent = '';

    this.#loadout = new Set(defaultLoadout());

    CONTESTED_SLOTS.forEach((slot) => {
      SLOT_CANDIDATES[slot].forEach((id) => {
        const element = ELEMENTS[id];
        const over = SUPERS[id];

        const li = document.createElement('li');
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'loadout__chip';
        chip.dataset.element = id;
        chip.dataset.slot = slot;
        // The rule and its super, on the control itself. This is the moment a
        // player decides between them and it is the only moment they can, so
        // making them read the card underneath first would be asking them to
        // choose and then explaining what they chose.
        chip.title = `${element.detail}\n\n✦ ${over.power}: ${over.detail}`;

        const glyph = document.createElement('span');
        glyph.className = 'loadout__glyph';
        glyph.textContent = element.emoji;
        glyph.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'loadout__name';
        name.textContent = element.name;

        const power = document.createElement('span');
        power.className = 'loadout__power';
        power.textContent = element.power;

        chip.append(glyph, name, power);
        li.append(chip);
        list.append(li);
      });
    });

    list.addEventListener('click', (event) => {
      const chip = event.target.closest('.loadout__chip');
      if (chip) this.#toggleLoadout(chip.dataset.element, chip.dataset.slot);
    });

    this.#paintLoadout();
  }

  /**
   * Tick or untick one element.
   *
   * Untick freely; tick only while the slot has room. The alternative — ticking
   * a ninth pawn element and having the picker silently drop one of the eight
   * already chosen — would mean a player's own earlier choice disappearing
   * under their thumb with nothing to say which one went.
   */
  #toggleLoadout(id, slot) {
    if (!id || !ELEMENTS[id]) return;

    if (this.#loadout.has(id)) {
      this.#loadout.delete(id);
    } else {
      const taken = SLOT_CANDIDATES[slot].filter((other) => this.#loadout.has(other)).length;
      if (taken >= SLOT_SIZE[slot]) {
        this.toast(`Eight ${slot === 'pawn' ? 'pawns' : 'pieces'} — drop one first`);
        return;
      }
      this.#loadout.add(id);
    }

    this.#paintLoadout();
  }

  /** Draw the chips, and say how many are still to be chosen. */
  #paintLoadout() {
    const list = this.#dom['loadout-list'];
    const count = this.#dom['loadout-count'];
    if (!list) return;

    let short = 0;
    CONTESTED_SLOTS.forEach((slot) => {
      const taken = SLOT_CANDIDATES[slot].filter((id) => this.#loadout.has(id)).length;
      short += SLOT_SIZE[slot] - taken;
    });

    list.querySelectorAll('.loadout__chip').forEach((chip) => {
      const on = this.#loadout.has(chip.dataset.element);
      chip.dataset.on = String(on);
      chip.setAttribute('aria-pressed', String(on));
    });

    // Said as what is left to do rather than as what has been done, because
    // the only number that changes what the player does next is the shortfall.
    if (count) {
      count.textContent = short > 0
        ? `Choose ${short} more`
        : 'Ready — the one you left out sits this match out';
      count.dataset.short = String(short > 0);
    }

    // The rules card greys the elements not coming, so the list below the
    // picker is always a list of what this game actually contains.
    const elements = this.#dom['elements-list'];
    elements?.querySelectorAll('.element').forEach((row) => {
      const id = row.dataset.element;
      const contested = CONTESTED_SLOTS.includes(ELEMENTS[id]?.slot);
      row.dataset.out = String(contested && !this.#loadout.has(id));
    });
  }

  /**
   * The elements this game will be played with.
   *
   * A short loadout is filled in rather than refused: normalizeLoadout() tops
   * every slot up from the elements that were not picked, so a player who
   * ticks nothing gets the default sixteen and a game rather than a form that
   * will not submit.
   */
  #selectedLoadout() {
    return [...(this.#loadout ?? new Set(defaultLoadout()))];
  }

  #selectedOpponent() {
    const active = this.#dom['opponent-picker']?.querySelector('.time-option.is-active');
    return active?.dataset.opponent ?? 'bot';
  }

  // -----------------------------------------------------------------------
  // Profile pictures
  // -----------------------------------------------------------------------

  /** Show the remembered picture, if any, in each seat's picker. */
  syncAvatars(avatars = {}) {
    this.#avatarPickers.forEach((nodes, slot) => {
      nodes.forEach((node) => this.#showAvatar(node, avatars[slot]));
    });
  }

  /**
   * Paint every control onto one slot's picture.
   *
   * The reason this exists rather than each handler painting the node it was
   * fired from: the profile picture has two controls, and a picture chosen in
   * the friends panel that did not appear on the online form would look like
   * two different pictures rather than one.
   */
  #showAvatarFor(slot, avatar) {
    this.#avatarPickers.get(slot)?.forEach((node) => this.#showAvatar(node, avatar));
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

  /**
   * The picture chosen for a seat, or null. Read straight off the preview.
   *
   * The first control is enough: every control onto a slot is repainted
   * together by #showAvatarFor, so they cannot be showing different pictures.
   */
  #avatarFor(slot) {
    const [node] = this.#avatarPickers.get(slot) ?? [];
    const src = node?.querySelector('.avatar-picker__img')?.getAttribute('src');
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
      'set-chat': 'chat',
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
  // Friends
  // -----------------------------------------------------------------------

  /**
   * The name this device plays online under, put in both boxes that hold it.
   *
   * Two boxes, one name: the New Game form asks for it before a room, and
   * the friends panel shows it as who you are. Whichever one was not just
   * typed into follows the other, so the next room is never created under a
   * name the player thought they had changed.
   */
  setOnlineName(name) {
    const value = name ?? '';
    [this.#dom['input-online-name'], this.#dom['input-my-name']].forEach((input) => {
      if (input && document.activeElement !== input) input.value = value;
    });
  }

  /** Empty the add-a-friend box, once the request in it has gone. */
  clearFriendCodeInput() {
    const input = this.#dom['input-friend-code'];
    if (input) input.value = '';
  }

  /**
   * Whether the Friends button is on the menu at all.
   *
   * Hidden rather than disabled when there is no Firebase project: a
   * disabled button is a promise of a feature that is coming, and for a copy
   * of this app with no project behind it, it is not.
   */
  setFriendsAvailable(available) {
    const button = this.#dom['btn-menu-friends'];
    if (button) button.hidden = !available;
    // The same panel reached from the waiting screen, which is where you
    // are standing when the friend you invited has not answered.
    const inviting = this.#dom['btn-invite-friend'];
    if (inviting) inviting.hidden = !available;
  }

  /** Whether the friends sheet is the thing being looked at. Asked of the
   *  sheet, for the reason isChatOpen is: a confirmation on top of it does
   *  not close it, and a list that stops repainting while one is up comes
   *  back stale. */
  isFriendsOpen() {
    return this.#dom['modal-friends'] ? !this.#dom['modal-friends'].hidden : false;
  }

  /**
   * Draw everything in the friends panel from one social snapshot.
   *
   * Called on every change, including while the panel is shut — the badge on
   * the menu is part of this render, and it is the only way a request is ever
   * noticed.
   */
  renderSocial(social) {
    if (!social) return;
    this.#social = social;

    const badge = this.#dom['friends-badge'];
    if (badge) {
      // A request and an invite both mean somebody is waiting on you, and
      // they sit behind the same button — so they share one count rather
      // than growing a second badge beside the first.
      const waiting = social.requests.length + (social.invites?.length ?? 0);
      badge.hidden = waiting === 0;
      badge.textContent = waiting > 9 ? '9+' : String(waiting);
    }

    if (this.#dom['my-code']) {
      this.#dom['my-code'].textContent = social.code ?? FRIEND_CODE_BLANK;
    }

    // Never while it is being typed in: a render landing mid-word would
    // take the rest of the name with it.
    const nameInput = this.#dom['input-my-name'];
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = social.name ?? '';
    }

    // Your picture is deliberately NOT painted from here, unlike your name
    // and your code.
    //
    // Storage is what both of them read: syncAvatars() paints the pickers at
    // startup, and choosing a picture writes storage and tells the hub in the
    // same breath, so the two cannot drift. Painting it from hub state as
    // well looks tidier and is a bug: the hub loads the picture inside
    // #connect, AFTER awaiting Firebase, so until that round trip lands — or
    // for ever, on a device that cannot reach it — `social.avatar` is null.
    // Rendering that null wipes the picture off both pickers the moment the
    // panel opens, which is exactly what it did.

    const status = this.#dom['friends-status'];
    if (status) {
      const message = social.error ?? (social.ready ? null : 'Connecting…');
      status.hidden = !message;
      status.textContent = message ?? '';
      status.dataset.tone = social.error ? 'error' : 'info';
    }

    this.#renderInvites(social);
    this.#renderRequests(social);
    this.#renderFriends(social);
  }

  /**
   * Invitations to a game, at the top of the panel.
   *
   * First because they are the only thing here that expires. A friend
   * request can be answered tomorrow; the room behind an invite is open
   * now, with somebody sitting in it watching the door.
   */
  #renderInvites(social) {
    const list = this.#dom['invites-list'];
    const section = this.#dom['invites-section'];
    if (!list) return;

    const invites = social.invites ?? [];
    if (section) section.hidden = invites.length === 0;
    list.innerHTML = '';

    invites.forEach((invite) => {
      const row = document.createElement('li');
      row.className = 'friend friend--invite';
      row.dataset.uid = invite.uid;

      const body = document.createElement('span');
      body.className = 'friend__body';
      const name = document.createElement('span');
      name.className = 'friend__name';
      // Clipped rather than wrapped, like the player cards, and for the same
      // reason carrying the whole thing on the title: a row that shares its
      // width with two buttons cuts a long name short, and a name you can
      // see has been cut but cannot read is worse than one that fits.
      name.textContent = invite.name;
      name.title = invite.name;
      const note = document.createElement('span');
      note.className = 'friend__note';
      note.textContent = 'Wants to play now';
      body.append(name, note);

      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn btn--primary btn--tiny';
      join.dataset.action = 'join';
      join.textContent = 'Join';
      join.setAttribute('aria-label', `Join ${invite.name}`);

      const ignore = document.createElement('button');
      ignore.type = 'button';
      ignore.className = 'btn btn--ghost btn--tiny';
      ignore.dataset.action = 'ignore';
      ignore.textContent = 'Ignore';
      ignore.setAttribute('aria-label', `Ignore ${invite.name}`);

      row.append(this.#friendFace(invite.avatar ?? null), body, join, ignore);
      list.append(row);
    });
  }

  #renderRequests(social) {
    const list = this.#dom['requests-list'];
    const section = this.#dom['requests-section'];
    if (!list) return;

    if (section) section.hidden = social.requests.length === 0;
    list.innerHTML = '';

    social.requests.forEach((request) => {
      const row = document.createElement('li');
      row.className = 'friend';
      row.dataset.uid = request.uid;

      const body = document.createElement('span');
      body.className = 'friend__body';
      const name = document.createElement('span');
      name.className = 'friend__name';
      name.textContent = request.name;
      name.title = request.name;
      const note = document.createElement('span');
      // Not friend__status: that carries a presence dot, and a request has
      // no presence. It also has to share the row with two buttons, so it
      // is the one label here that cannot afford to wrap.
      note.className = 'friend__note';
      note.textContent = 'Sent you a request';
      body.append(name, note);

      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'btn btn--primary btn--tiny';
      accept.dataset.action = 'accept';
      accept.textContent = 'Accept';
      accept.setAttribute('aria-label', `Accept ${request.name}`);

      const decline = document.createElement('button');
      decline.type = 'button';
      decline.className = 'btn btn--ghost btn--tiny';
      decline.dataset.action = 'decline';
      decline.textContent = 'Decline';
      decline.setAttribute('aria-label', `Decline ${request.name}`);

      row.append(this.#friendFace(null), body, accept, decline);
      list.append(row);
    });
  }

  #renderFriends(social) {
    const list = this.#dom['friends-list'];
    if (!list) return;

    const empty = this.#dom['friends-empty'];
    if (empty) empty.hidden = social.friends.length > 0;
    list.innerHTML = '';

    social.friends.forEach((friend) => {
      const row = document.createElement('li');
      row.className = 'friend';
      row.dataset.uid = friend.uid;

      const body = document.createElement('span');
      body.className = 'friend__body';
      const name = document.createElement('span');
      name.className = 'friend__name';
      name.textContent = friend.name;
      name.title = friend.name;

      const status = document.createElement('span');
      status.className = 'friend__status';
      // Three states, not two: a friend whose presence has not arrived yet
      // is not offline, and saying so would be a guess dressed as a fact.
      status.dataset.state = friend.known ? friend.state : 'unknown';
      if (!friend.known) {
        status.textContent = 'Checking…';
      } else if (friend.state === PRESENCE.PLAYING) {
        status.textContent = 'In a game';
      } else if (friend.state === PRESENCE.ONLINE) {
        status.textContent = 'Online';
      } else {
        status.textContent = describeSince(friend.since);
      }
      body.append(name, status);

      const waiting = social.sent.includes(friend.uid);
      if (waiting) {
        const pending = document.createElement('span');
        pending.className = 'friend__pending';
        pending.textContent = 'Pending';
        body.append(pending);
      }

      // Asking somebody to play is what a list of friends is for, so it
      // is the one control on the row that carries a word rather than a
      // glyph. Refused rather than hidden when it cannot work: a button
      // that says why is worth more than a gap where one used to be.
      const invite = document.createElement('button');
      invite.type = 'button';
      invite.className = 'btn btn--primary btn--tiny friend__invite';
      invite.dataset.action = 'invite';

      const asked = (social.invited ?? []).includes(friend.uid);
      const away = friend.known && friend.state === PRESENCE.OFFLINE;
      invite.textContent = asked ? 'Invited' : 'Invite';
      invite.disabled = asked || away;
      invite.setAttribute('aria-label', asked
        ? `${friend.name} has been invited`
        : `Invite ${friend.name} to play`);
      if (away) invite.title = 'They are not online right now';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn friend__remove';
      remove.dataset.action = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${friend.name}`);

      row.append(this.#friendFace(friend.avatar), body, invite, remove);
      list.append(row);
    });
  }

  /**
   * A friend's picture, or the king glyph.
   *
   * Validated here for the same reason a seat picture is: this is the last
   * point before a string somebody else wrote becomes an img src.
   */
  #friendFace(avatar) {
    const wrap = document.createElement('span');
    wrap.className = 'friend__avatar';
    wrap.setAttribute('aria-hidden', 'true');

    if (isAvatar(avatar)) {
      const image = document.createElement('img');
      image.className = 'friend__photo';
      image.alt = '';
      image.src = avatar;
      wrap.append(image);
    } else {
      const glyph = document.createElement('span');
      glyph.className = 'friend__glyph';
      glyph.textContent = '♚\uFE0E';
      wrap.append(glyph);
    }
    return wrap;
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
    this.#avatarPickers.forEach((nodes, slot) => {
      nodes.forEach((node) => {
        const file = node.querySelector('.avatar-picker__file');
        const button = node.querySelector('.avatar-picker__btn');
        const clear = node.querySelector('.avatar-picker__clear');

        button?.addEventListener('click', () => file?.click());

        clear?.addEventListener('click', () => {
          this.#showAvatarFor(slot, null);
          this.#call('onAvatarChange', { slot, avatar: null });
          this.toast('Picture removed');
          button?.focus();
        });

        file?.addEventListener('change', async () => {
          const [picked] = file.files ?? [];
          // Cleared straight away, so choosing the same file twice still fires
          // a change event — otherwise re-picking after a failure does nothing
          // at all, which reads as the app ignoring you.
          file.value = '';
          if (!picked) return;

          // Only the control being used says it is working. The other control
          // onto the same picture is on a screen nobody is looking at, and a
          // spinner there would be for an audience of none.
          node.classList.add('is-busy');
          const result = await fileToAvatar(picked);
          node.classList.remove('is-busy');

          if (!result.ok) {
            this.toast(result.error, 'error');
            return;
          }

          this.#showAvatarFor(slot, result.avatar);
          this.#call('onAvatarChange', { slot, avatar: result.avatar });
        });
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
        opponent: this.#selectedOpponent(),
        botLevel: this.#selectedBotLevel(),
        loadout: this.#selectedLoadout(),
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

    // --- Chat and emotes ---
    this.#dom['btn-chat']?.addEventListener('click', () => {
      this.openChat();
      this.#call('onOpenChat');
    });

    this.#dom['chat-form']?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = this.#dom['chat-input'];
      const body = input?.value ?? '';
      if (!body.trim()) return;
      // Cleared before the send resolves, because the send is a round trip
      // and a box that empties when the network says so feels broken. A
      // refusal comes back as a toast with the message in it.
      if (input) input.value = '';
      this.#call('onSendChat', { body });
    });

    this.#dom['emote-bar']?.addEventListener('click', (event) => {
      const button = event.target.closest('.emote');
      if (!button) return;
      this.#call('onSendEmote', { id: button.dataset.emote });
    });

    // --- Friends ---
    this.#dom['btn-menu-friends']?.addEventListener('click', () => {
      this.openModal('friends');
      this.#call('onOpenFriends');
    });

    this.#dom['btn-invite-friend']?.addEventListener('click', () => {
      this.openModal('friends');
      this.#call('onOpenFriends');
    });

    this.#dom['form-add-friend']?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = this.#dom['input-friend-code'];
      this.#call('onAddFriend', { code: input?.value ?? '' });
    });

    // Same cleaning as the room-code field: upper case, code characters only.
    this.#dom['input-friend-code']?.addEventListener('input', (event) => {
      const cleaned = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned !== event.target.value) event.target.value = cleaned;
    });

    this.#dom['btn-copy-friend-code']?.addEventListener('click', () => {
      this.#call('onCopyFriendCode', this.#social?.code ?? null);
    });

    // A rename lands on blur and on Enter, not on every keystroke: each one
    // is a write, and a friends list is not the place to publish a name
    // letter by letter.
    const rename = () => this.#call('onRenameMe', {
      name: this.#dom['input-my-name']?.value ?? '',
    });
    this.#dom['input-my-name']?.addEventListener('change', rename);
    this.#dom['input-my-name']?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.target.blur();
    });

    // One delegated handler for all three lists: the rows differ in what
    // they offer, not in how an offer is answered.
    ['invites-list', 'requests-list', 'friends-list'].forEach((id) => {
      this.#dom[id]?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const uid = button.closest('.friend')?.dataset.uid;
        if (!uid) return;
        const actions = {
          accept: 'onAcceptRequest',
          decline: 'onDeclineRequest',
          remove: 'onRemoveFriend',
          invite: 'onInviteFriend',
          join: 'onAcceptInvite',
          ignore: 'onDeclineInvite',
        };
        const handler = actions[button.dataset.action];
        if (handler) this.#call(handler, { uid });
      });
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
    // One button, two jobs, decided by what the bar is currently saying:
    // start aiming a power, or stop aiming one. Both are the same gesture
    // from the player's side — "this power" and "not this power" — so they
    // share the control rather than putting a second one beside it that is
    // hidden nine tenths of the time.
    this.#dom['btn-super']?.addEventListener('click', () => {
      this.#call('onCastSuper');
    });

    this.#dom['btn-power']?.addEventListener('click', () => {
      this.#call(this.#dom.powerbar?.dataset.state === 'aiming'
        ? 'onCancelPower'
        : 'onUsePower');
    });

    // Renaming a player mid-game. Both cards are wired; only the ones this
    // device may act for ever show their button.
    ['top', 'bottom'].forEach((prefix) => {
      this.#dom[`btn-rename-${prefix}`]?.addEventListener('click', () => {
        this.#startRenaming(prefix);
      });

      const input = this.#dom[`input-rename-${prefix}`];
      // Commits on blur and on Enter, the same as the friends panel, and for
      // the same reason: each one is a write that the other player sees, and
      // a name should not be published letter by letter.
      input?.addEventListener('change', () => {
        const value = input.value;
        // Read off the card rather than remembered, because Flip and a
        // rematch both move a colour from one card to the other and a
        // remembered one would rename whoever is standing there now.
        const color = this.#colorOnCard(prefix);
        this.#stopRenaming(prefix);
        this.#call('onRenameSeat', { color, name: value });
      });
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
        if (event.key !== 'Escape') return;
        // Escape abandons the edit, so the box must not then commit on the
        // way out — put the old value back before blurring.
        event.preventDefault();
        event.stopPropagation();
        input.value = this.#dom[`${prefix}-name`]?.textContent ?? '';
        input.blur();
        this.#stopRenaming(prefix);
      });
      input?.addEventListener('blur', () => this.#stopRenaming(prefix));
    });

    this.#dom['btn-powers-toggle']?.addEventListener('click', () => {
      this.#powersOpen = !this.#powersOpen;
      // Repainted here rather than waited for: nothing about the game has
      // changed, so there is no change event on its way.
      if (this.#lastSnapshot) this.#renderPowers(this.#lastSnapshot);
    });

    // Delegated: the seven rows are rebuilt at most once per game, but they do
    // not exist at all until the panel is first opened, and a listener each
    // would have to be attached from inside the render.
    this.#dom['powers-list']?.addEventListener('click', (event) => {
      const item = event.target.closest?.('.powers__item');
      if (!item || item.disabled) return;
      this.#call('onCastPower', item.dataset.power);
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
      'set-chat': 'chat',
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
    ['bot-picker', 'opponent-picker'].forEach((id) => {
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
      if (event.key !== 'Escape') return;

      // Aiming a power is a mode with nothing on screen dimmed, so Escape has
      // to get out of it — and it has to do so before the modal handling
      // below, because there is usually no modal open at the time.
      if (!this.#openModal && this.#dom.powerbar?.dataset.state === 'aiming') {
        this.#call('onCancelPower');
        return;
      }
      if (!this.#openModal) return;

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
