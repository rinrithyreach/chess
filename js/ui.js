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
  UI_STYLES,
  SELECTABLE_UI_STYLES,
  DEFAULT_UI_STYLE,
  TOAST_MS,
  warn,
} from './config.js';
import { fileToAvatar, isAvatar } from './avatar.js';
import { ROOM_CODE_LENGTH, ONLINE_AVATARS } from './firebase-config.js';

/** A blank friend code, drawn the same way a blank room code is. */
const FRIEND_CODE_BLANK = '-'.repeat(FRIEND_CODE_LENGTH);

/** The New Game form's name boxes that remember a seat's name, by seat. */
const NAME_INPUTS = { p2: 'input-black' };

/**
 * Every box holding your own name: Player 1 on the form, the online form's,
 * and the Friends panel's. One name, so they always show the same thing.
 */
const MY_NAME_INPUTS = ['input-white', 'input-online-name', 'input-my-name'];

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

  /**
   * A press is under way: a finger or a button has gone down and the click it
   * ends in has not been seen yet.
   *
   * And `#strayClick` says a dialog opened in the middle of one. A press that
   * began before a dialog existed cannot be an answer to it, but the browser
   * does not know that — it aims the click a touch ends in at whatever is
   * under the finger by then, which is the dialog. That click is swallowed.
   * See #watchPresses.
   */
  #pressing = false;
  #strayClick = false;
  #pressTimer = null;

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

  /**
   * Which card each colour is on, as of the last render.
   *
   * An emote lands on its sender's card, and which card that is depends on
   * board orientation — which flips on a rematch and on the Flip button.
   * Read from the render that already worked it out rather than worked out
   * again here from a different source.
   */
  #cardSide = { w: 'bottom', b: 'top' };

  /** Per-card timer that takes an emote back off again. */
  #emoteTimers = { top: null, bottom: null };

  /** The timer that takes each toast on screen back off again, by node. */
  #toastTimers = new Map();

  /** Whether an open dialog is following the visual viewport: see #followViewport. */
  #viewportWatched = false;

  /** Where the page was scrolled when the first dialog opened. */
  #scrollBefore = 0;

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
   * cards fall back to Unicode glyphs there. See setPieceSprites().
   */
  #pieceSprite = null;

  /**
   * Bumped whenever the sprite source changes.
   *
   * Part of the pile's cache key. Without it, swapping renderers mid-game would
   * leave the cards showing whichever form they were built with: the pieces
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
      'btn-picture-top', 'btn-picture-bottom', 'file-picture-top', 'file-picture-bottom',
      'top-taken', 'bottom-taken',
      'board', 'board-area', 'status', 'status-text', 'status-badge',
      'btn-flip', 'btn-resign', 'btn-zoom', 'zoom-label',
      'history-panel', 'btn-history-toggle', 'history-list', 'history-count',
      'modal-promotion', 'promotion-choices',
      'modal-confirm', 'confirm-title', 'confirm-text', 'confirm-actions',
      'btn-confirm-ok', 'btn-confirm-cancel', 'btn-confirm-alt',
      'modal-gameover', 'gameover-icon', 'gameover-title', 'gameover-result',
      'gameover-detail', 'btn-rematch', 'btn-gameover-new',
      'modal-settings', 'set-sound',
      'theme-picker', 'bg-picker',
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
      'btn-chat', 'chat-unread',
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
        // The figure is empty until a pawn promotes: what goes in it depends
        // on whose pawn, and on which board is mounted. See showPromotion().
        button.innerHTML =
          '<span class="promotion__figure"></span>' +
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

    // Background picker. Same shape as the board themes above, and for the
    // same reason: one list in config.js decides what exists, so a background
    // is a block of CSS and a row in that list, with no markup to add here.
    //
    // And the same rule as Look & Feel: with one background there is nothing
    // to choose between, so the section hides rather than offering a
    // radiogroup of one. A second row in BACKGROUNDS brings it back.
    const backgrounds = this.#dom['bg-picker'];
    if (backgrounds) {
      const offerAChoice = BACKGROUNDS.length > 1;
      const section = backgrounds.closest('.setting');
      if (section) section.hidden = !offerAChoice;

      backgrounds.innerHTML = '';
      (offerAChoice ? BACKGROUNDS : []).forEach((background) => {
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

    if (this.#dom['online-fields']) this.#dom['online-fields'].hidden = !online;
    if (this.#dom['btn-start-game']) this.#dom['btn-start-game'].hidden = online;

    const nameFields = this.#dom['form-new-game']
      ?.querySelectorAll('.field:not(.field--modes)');
    nameFields?.forEach((field, index) => {
      if (index === 0) field.hidden = online;  // your own name
      else if (index === 1) {                  // the opponent's
        field.hidden = online || bot;
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
   * Hand the cards a way to draw a real piece, or take it away.
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
    // For the layout: at Fit the 3D board leaves lawn above and below itself
    // in its box, and the desktop layout draws the cards in over it.
    if (this.#dom['board-area']) this.#dom['board-area'].dataset.zoom = zoom.id;

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

    // Chat and emotes are always on in a room: there is no switch for them.
    const chatButton = this.#dom['btn-chat'];
    if (chatButton) chatButton.hidden = !online.roomCode;

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
    // With a keyboard on the desk the box is what you came for. Not on a
    // touch screen: focusing it there opens the phone's keyboard over the
    // conversation and the emotes before you have read anything, and a tap
    // on the box opens it when you do want to type.
    if (!window.matchMedia?.('(pointer: coarse)').matches) this.#dom['chat-input']?.focus();
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
   * Draw the pieces one player has taken, at the end of that player's card.
   *
   * Only the pieces. There was a number after them, the material lead —
   * "+7" on the card of whoever was ahead, by the textbook values — and it
   * was removed: the row says what was taken, and how much that is worth is
   * the player's to weigh.
   *
   * A row of the pieces themselves, stood up side by side: strongest first,
   * each kind together, a pawn overlapping the pawn before it the way a row
   * of them does on a table. Each is a slot narrower than its picture — the
   * picture is square and a piece is tall and thin, so most of its width is
   * air — and the slots give way before the row is allowed to push the card
   * wider. See .player-card__taken in style.css.
   *
   * They were two columns laid over the edges of the board, 14px wide, in
   * the margin the camera happens to leave there: free, and the size of a
   * margin. A rook in one was a mark a few pixels across, tucked behind the
   * piece above it. The card has the room the board does not.
   *
   * The row is rebuilt only when its contents actually change. render() runs
   * on every move and this is the one part of the card that holds a dozen
   * nodes, so a blind rebuild would churn the DOM twice a move for a row
   * that usually has not changed at all.
   */
  #renderCaptures(prefix, taken, color) {
    const row = this.#dom[`${prefix}-taken`];
    if (!row) return;

    const mine = taken[color] ?? [];

    // Strongest first, which is also how a pile is read at a glance.
    const sorted = [...mine].sort(
      (a, b) => CAPTURE_ORDER.indexOf(a) - CAPTURE_ORDER.indexOf(b),
    );
    // The colour is part of the key, not just the pieces.
    //
    // A card belongs to whichever player is at that end of the board, and a
    // flip swaps them. When both piles happen to hold the same pieces — after
    // an even trade, which is common — a key of pieces alone is unchanged
    // across the flip, the early return fires, and the card keeps the previous
    // player's pile: the right shapes in the wrong colour.
    const key = `${color}|${sorted.join('')}|${this.#spriteEpoch}`;
    if (row.dataset.key === key) return;
    row.dataset.key = key;

    // Captured pieces belong to the other side, so they are drawn in the other
    // side's colour — a white player's card holds the black pieces they took.
    const theirColor = color === WHITE ? BLACK : WHITE;
    row.innerHTML = sorted
      .map((p, index) => {
        // The real piece where the board can draw one, so a captured knight is
        // the knight that was on the board rather than a flat glyph of a
        // different chess set standing next to a solid one.
        const sprite = this.#pieceSprite?.(p, theirColor);
        // The first of each kind stands a little clear of the kind before it.
        const lead = sorted[index - 1] === p ? '' : ' taken--lead';
        // Both forms carry what they represent, so nothing downstream has to
        // infer a captured piece's colour from the shape of its markup.
        const what = `data-color="${theirColor}" data-piece="${p}"`;
        return sprite
          ? `<span class="taken${lead}" ${what}><img class="taken__piece" src="${sprite}" alt=""></span>`
          : `<span class="taken taken--glyph${lead}" ${what}>${PIECE_GLYPHS[p]}</span>`;
      })
      .join('');

    // A count per kind, so a screen reader gets the pile as a sentence rather
    // than as a dozen identical glyph names.
    const counts = new Map();
    sorted.forEach((p) => counts.set(p, (counts.get(p) ?? 0) + 1));
    const spoken = [...counts].map(([p, n]) =>
      `${n} ${PIECE_NAME[p]}${n === 1 ? '' : 's'}`).join(', ');
    row.setAttribute('aria-label', spoken ? `Captured ${spoken}` : '');
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
      const editable = controllable.includes(color) && !state.isGameOver;
      const rename = this.#dom[`btn-rename-${prefix}`];
      if (rename) {
        rename.hidden = !editable;
        // A box still open when the card stops being yours — a rematch
        // swapping the colours — would be writing to somebody else's seat.
        if (rename.hidden) this.#stopRenaming(prefix);
      }
      // The picture, by the same rule — except online when seats carry no
      // pictures at all, where a button that changes nothing is worse than
      // none.
      const repicture = this.#dom[`btn-picture-${prefix}`];
      if (repicture) repicture.hidden = !editable || (Boolean(state.online) && !ONLINE_AVATARS);
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

  #renderControls({ state }) {
    const online = state.online;
    // Online, the board is only live once both seats are filled.
    const inactive = Boolean(state.isGameOver) || Boolean(online?.waitingForOpponent);

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

  /**
   * Keep an open dialog over what can actually be seen.
   *
   * A phone's keyboard does not shrink the page: it covers the bottom of it,
   * and the browser slides the page up to show the box being typed in. A
   * dialog centred on the whole screen then has its top pushed off the top
   * of what is visible — the chat lost its title, its close button and the
   * conversation the moment you started typing. So while a dialog is open,
   * the visual viewport (the part above the keyboard) is copied into two
   * properties that .modal is placed by. With no keyboard they are simply
   * the whole screen.
   */
  #followViewport = () => {
    const view = window.visualViewport;
    if (!view) return;
    // The conversation is what gives way to the keyboard. Left alone, it
    // keeps its scroll position as it shrinks and the newest message — the
    // one being answered — slides out under the emotes. Kept at the bottom
    // if it was there; somebody reading further up is left where they are.
    const log = this.#dom['chat-log'];
    const atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    const root = document.documentElement.style;
    root.setProperty('--vv-top', `${view.offsetTop}px`);
    root.setProperty('--vv-h', `${view.height}px`);
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  #watchViewport(on) {
    const view = window.visualViewport;
    if (!view) return;
    if (on) {
      if (this.#viewportWatched) return;
      this.#viewportWatched = true;
      // Where the page was, to put it back: a phone can leave it slid up
      // after the keyboard has gone.
      this.#scrollBefore = window.scrollY;
      this.#followViewport();
      view.addEventListener('resize', this.#followViewport);
      view.addEventListener('scroll', this.#followViewport);
      return;
    }
    if (!this.#viewportWatched) return;
    this.#viewportWatched = false;
    view.removeEventListener('resize', this.#followViewport);
    view.removeEventListener('scroll', this.#followViewport);
    const root = document.documentElement.style;
    root.removeProperty('--vv-top');
    root.removeProperty('--vv-h');
    if (window.scrollY !== this.#scrollBefore) window.scrollTo(0, this.#scrollBefore);
  }

  openModal(name) {
    const modal = this.#dom[`modal-${name}`];
    if (!modal) return;

    this.#lastFocused = document.activeElement;
    this.#watchViewport(true);
    modal.hidden = false;
    // Opened by a press that is still going on: its click is not for us.
    if (this.#pressing) this.#strayClick = true;
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
    if (!this.#openModal) {
      document.body.classList.remove('is-modal-open');
      this.#watchViewport(false);
    }

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
   * Keep a dialog from being answered by the press that opened it.
   *
   * The boards act when a finger lifts, so a tap that completes a promotion
   * opens the picker under the finger — and a browser follows a touch with a
   * click, aimed at whatever is there by then. The boards cancel that click
   * where it is made, which is the fix (see the touchend listener in
   * board-3d.js). This is the spare, for a browser that sends the click
   * anyway, and for whatever opens a dialog from a press next.
   *
   * It counts presses rather than reading a clock. A press starts at
   * pointerdown, or touchstart where there are no pointer events, and is
   * over when its click has gone by. A dialog that opens in between marks
   * the click still to come as a stray, and that one click is stopped before
   * anything hears it. A new press clears the mark: whatever click follows
   * that was meant.
   *
   * What it cannot do is swallow a real answer, which matters more than what
   * it catches. A tap or a mouse click always begins with a press, and a
   * press clears the mark. Enter, Space and `click()` arrive with a detail
   * of zero and are never touched. And the mark does not outlive the press
   * by more than a moment, so nothing that clicks without pressing — a
   * screen reader's activate, say — can walk into one left lying about.
   *
   * mousedown is deliberately not a press. After a touch the browser sends
   * one for compatibility, between the touch and its click, and counting it
   * would clear the mark just before the click it was set for.
   */
  #watchPresses() {
    const began = () => {
      clearTimeout(this.#pressTimer);
      this.#pressing = true;
      this.#strayClick = false;
    };
    // The click a touch ends in can trail it — by a third of a second where
    // the browser waits to see whether a second tap is coming. Past that it
    // is not coming at all.
    const ended = () => {
      clearTimeout(this.#pressTimer);
      this.#pressTimer = setTimeout(() => {
        this.#pressing = false;
        this.#strayClick = false;
      }, 700);
    };
    const quietly = { capture: true, passive: true };
    ['pointerdown', 'touchstart'].forEach((type) => document.addEventListener(type, began, quietly));
    ['pointerup', 'pointercancel', 'touchend', 'touchcancel']
      .forEach((type) => document.addEventListener(type, ended, quietly));

    document.addEventListener('click', (event) => {
      const stray = this.#strayClick;
      clearTimeout(this.#pressTimer);
      this.#pressing = false;
      this.#strayClick = false;
      if (stray && event.detail > 0 && event.target.closest?.('.modal')) {
        event.stopPropagation();
        event.preventDefault();
      }
    }, { capture: true });
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
    if (!this.#openModal) {
      document.body.classList.remove('is-modal-open');
      this.#watchViewport(false);
    }
    this.#lastFocused?.focus?.();
    this.#lastFocused = null;

    resolve?.(value);
  }

  /**
   * Show the promotion picker, with the four pieces in the promoting side's
   * colour.
   *
   * The pieces themselves where the board can draw them: the clay ones that
   * are standing on it, in their own colours, so what is offered is what
   * will arrive. It was four Unicode glyphs in one flat ink, which was the
   * last place a second chess set was still showing next to the real one.
   * Those are the fallback now, for the flat board, which has no piece to
   * photograph.
   *
   * Filled in here rather than once at start-up because both answers change
   * during a game: whose pawn it is, and which board is mounted. The key is
   * the same idea as the cards': nothing is rebuilt when neither has.
   */
  showPromotion({ color }) {
    const choices = this.#dom['promotion-choices'];
    const key = `${color}|${this.#spriteEpoch}`;
    if (choices && choices.dataset.key !== key) {
      choices.dataset.key = key;
      choices.querySelectorAll('.promotion__choice').forEach((button) => {
        const type = button.dataset.piece;
        const figure = button.querySelector('.promotion__figure');
        if (!figure) return;
        const sprite = this.#pieceSprite?.(type, color);
        figure.innerHTML = sprite
          ? `<img class="promotion__piece" src="${sprite}" alt="" data-color="${color}">`
          : `<span class="promotion__glyph" data-color="${color}">${PIECE_GLYPHS[type]}</span>`;
      });
    }
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

  // -----------------------------------------------------------------------
  // Profile pictures
  // -----------------------------------------------------------------------

  /** Show the remembered picture, if any, in each seat's picker. */
  syncAvatars(avatars = {}) {
    this.#avatarPickers.forEach((nodes, slot) => {
      nodes.forEach((node) => this.#showAvatar(node, avatars[slot]));
    });
  }

  /** Put the remembered names back in the New Game form's two boxes. */
  syncNames(names = {}) {
    Object.entries(NAME_INPUTS).forEach(([slot, id]) => {
      const input = this.#dom[id];
      if (input && document.activeElement !== input) input.value = names[slot] ?? '';
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
    if (slot === 'p2') return 'Player 2';
    // Player 1, the online form and Friends all ask for YOUR name, so their
    // picker is your own picture.
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
   * Your name, put in every box that holds it.
   *
   * Three boxes, one name: Player 1 on the New Game form, the online form
   * before a room, and the friends panel as who you are. The ones not just
   * typed into follow, so the next game is never started under a name the
   * player thought they had changed.
   */
  setOnlineName(name) {
    const value = name ?? '';
    MY_NAME_INPUTS.forEach((id) => {
      const input = this.#dom[id];
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

    // Into every box that holds your name, so a name the hub found in the
    // database shows on the New Game form too. Never into the box being
    // typed in (setOnlineName skips it): a render landing mid-word would
    // take the rest of the name with it. No name yet leaves the boxes be.
    if (social.name) this.setOnlineName(social.name);

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

  /**
   * Say something briefly, in a pill at the bottom of the screen.
   *
   * One pill per message. A message already up is not stacked again under
   * itself: pressing the same button twice keeps the pill that is there and
   * starts its time again, even one already fading out. `key` is for a
   * button whose message changes with each press — Flip, Size, Sound — so
   * its pill is brought up to date in place rather than joined by a second.
   */
  toast(message, tone = 'info', key = `${tone}:${message}`) {
    const container = this.#dom.toasts;
    if (!container) return;

    let node = [...container.children].find((child) => child.dataset.key === key);
    if (node) {
      window.clearTimeout(this.#toastTimers.get(node));
    } else {
      node = document.createElement('div');
      node.className = 'toast';
      node.dataset.key = key;
      container.append(node);
    }
    node.dataset.tone = tone;
    // Only when it changed: the container is a live region, and the same
    // words written again would be read out again.
    if (node.textContent !== message) node.textContent = message;

    // Errors are usually actionable setup instructions, so give them time to
    // actually be read rather than the standard acknowledgement duration.
    const duration = tone === 'error' ? TOAST_MS * 3 : TOAST_MS;

    requestAnimationFrame(() => node.classList.add('is-visible'));
    this.#toastTimers.set(node, window.setTimeout(() => {
      node.classList.remove('is-visible');
      this.#toastTimers.set(node, window.setTimeout(() => {
        node.remove();
        this.#toastTimers.delete(node);
      }, 250));
    }, duration));
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
        whiteAvatar: this.#avatarFor('online'),
        blackAvatar: this.#avatarFor('p2'),
      });
    });

    this.#attachAvatarPickers();

    // Every keystroke, not on blur: a phone is often closed straight from
    // the keyboard, and the page is gone before a `change` ever fires.
    Object.entries(NAME_INPUTS).forEach(([slot, id]) => {
      this.#dom[id]?.addEventListener('input', (event) =>
        this.#call('onFormName', { slot, name: event.target.value }));
    });
    // Your name, from Player 1 or the online form: kept on every keystroke,
    // and told to the other boxes and your friends once the box is left.
    ['input-white', 'input-online-name'].forEach((id) => {
      const input = this.#dom[id];
      input?.addEventListener('input', () =>
        this.#call('onFormOnlineName', { name: input.value, published: false }));
      input?.addEventListener('change', () =>
        this.#call('onFormOnlineName', { name: input.value, published: true }));
    });

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
    this.#dom['btn-flip']?.addEventListener('click', () => this.#call('onFlip'));
    this.#dom['btn-resign']?.addEventListener('click', () => this.#call('onResign'));

    // Zoom cycles rather than stepping, so one button covers every level and
    // the row keeps its shape. With two levels that makes it a switch — and
    // the label always says where you are.
    this.#dom['btn-zoom']?.addEventListener('click', () => {
      const current = clampBoardZoom(this.#controller.getSettings().boardZoom);
      const next = (current + 1) % BOARD_ZOOM_LEVELS.length;
      this.#call('onSettingChange', { boardZoom: next });
      this.toast(`Board size: ${BOARD_ZOOM_LEVELS[next].label}`, 'info', 'zoom');
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

      // A new picture for the seat, from the circle on the card.
      const picture = this.#dom[`btn-picture-${prefix}`];
      const file = this.#dom[`file-picture-${prefix}`];
      picture?.addEventListener('click', () => file?.click());
      file?.addEventListener('change', async () => {
        const [picked] = file.files ?? [];
        // Cleared straight away so picking the same file again still fires.
        file.value = '';
        if (!picked) return;

        const face = picture.parentElement;
        face?.classList.add('is-busy');
        const result = await fileToAvatar(picked);
        face?.classList.remove('is-busy');
        if (!result.ok) {
          this.toast(result.error, 'error');
          return;
        }
        // Read off the card now, not when the picker opened: the photo
        // library can stay open across a move, a flip or a rematch.
        this.#call('onSeatPicture', { color: this.#colorOnCard(prefix), avatar: result.avatar });
      });
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
      /*
         The tap that opened the picker cannot arrive here: the boards cancel
         the click a browser sends after a touch, where it is made, and a
         stray one is stopped on the way in. See the touchend listener in
         board-3d.js, and #watchPresses.

         There was a different guard in this handler, and it must not come
         back. It refused any click whose event.timeStamp was earlier than
         the performance.now() taken when the dialog opened — "a press older
         than the dialog". That compares two clocks, and nothing promises
         they agree. Safari on an iPhone has a history of stamping touches
         from the system's event clock, which falls behind the page's while
         the phone sleeps. When it does, every tap in every dialog looks
         older than the dialog and is thrown away, which is a promotion
         picker that cannot be answered or even closed. A guard that can
         swallow a real press is worse than the bug it was a spare for.
      */
      // Close first so the modal cannot accept a second click.
      const modal = this.#dom['modal-promotion'];
      if (modal) {
        modal.classList.remove('is-open');
        modal.hidden = true;
      }
      if (this.#openModal === 'promotion') this.#openModal = null;
      document.body.classList.remove('is-modal-open');
      this.#watchViewport(false);
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

    this.#dom['bg-picker']?.addEventListener('click', (event) => {
      const swatch = event.target.closest('.bg-swatch');
      if (!swatch) return;
      this.#call('onSettingChange', { background: swatch.dataset.bg });
    });

    // --- Global: backdrop clicks and Escape ---
    this.#watchPresses();
    document.addEventListener('click', (event) => {
      const closer = event.target.closest('[data-close]');
      if (closer) this.closeModal(closer.dataset.close);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;

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
