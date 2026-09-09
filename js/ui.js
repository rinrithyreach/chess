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
  UI_STYLES,
  LOCKED_CONTROLS,
  isControlLocked,
  TOAST_MS,
  warn,
} from './config.js';

// See TEXT_PRESENTATION in board.js: without it these can render as colour
// emoji, which ignore CSS `color` and make white pieces paint black.
const VS = '\uFE0E';
const PIECE_GLYPHS = {
  k: `♚${VS}`, q: `♛${VS}`, r: `♜${VS}`, b: `♝${VS}`, n: `♞${VS}`, p: `♟${VS}`,
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
  #lastFocused = null;
  #confirmResolver = null;
  #historyExpanded = false;

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
      'btn-setup-back', 'form-new-game', 'input-white', 'input-black',
      'btn-game-menu', 'btn-game-settings',
      'card-top', 'card-bottom', 'top-name', 'top-color', 'top-turn',
      'bottom-name', 'bottom-color', 'bottom-turn',
      'board', 'status', 'status-text', 'status-badge',
      'btn-undo', 'btn-flip', 'btn-resign',
      'history-panel', 'btn-history-toggle', 'history-list', 'history-count',
      'modal-promotion', 'promotion-choices',
      'modal-confirm', 'confirm-title', 'confirm-text', 'btn-confirm-ok', 'btn-confirm-cancel',
      'modal-gameover', 'gameover-icon', 'gameover-title', 'gameover-result',
      'gameover-detail', 'btn-rematch', 'btn-gameover-new', 'check-swap-colors',
      'modal-settings', 'set-sound', 'set-coords', 'set-animations', 'set-autoflip',
      'theme-picker',
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

    // Look & feel picker. Every listed style is selectable.
    const stylePicker = this.#dom['style-picker'];
    if (stylePicker) {
      stylePicker.innerHTML = '';
      UI_STYLES.forEach((style) => {
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

  render(snapshot) {
    const { state } = snapshot;
    if (!state) return;
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
      this.#dom['room-bar-code'].textContent = online.roomCode ?? '------';
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
  #renderPlayers({ state, orientation }) {
    const bottomColor = orientation === 'black' ? BLACK : WHITE;
    const topColor = bottomColor === WHITE ? BLACK : WHITE;

    const apply = (prefix, color) => {
      const name = this.#dom[`${prefix}-name`];
      const colorEl = this.#dom[`${prefix}-color`];
      const turnEl = this.#dom[`${prefix}-turn`];
      const card = this.#dom[`card-${prefix === 'top' ? 'top' : 'bottom'}`];

      if (name) name.textContent = state.players[color]?.name ?? '';
      if (colorEl) colorEl.textContent = color === WHITE ? 'White' : 'Black';

      const avatar = card?.querySelector('.player-card__avatar');
      if (avatar) avatar.dataset.color = color;

      const isTurn = state.turn === color && !state.isGameOver;
      if (turnEl) turnEl.hidden = !isTurn;
      card?.classList.toggle('is-active', isTurn);
    };

    apply('top', topColor);
    apply('bottom', bottomColor);
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

    // A cancelled confirmation must still settle its promise.
    if (name === 'confirm' && this.#confirmResolver) {
      const resolve = this.#confirmResolver;
      this.#confirmResolver = null;
      resolve(false);
    }
    if (name === 'promotion') this.#controller.cancelPromotion();

    this.#lastFocused?.focus?.();
    this.#lastFocused = null;
  }

  isModalOpen() {
    return this.#openModal !== null;
  }

  /**
   * Custom confirmation dialog. Resolves true/false.
   * The OK button is disabled once clicked, so a double tap cannot fire the
   * action twice.
   */
  confirm({ title, text, confirmLabel = 'Confirm', tone = 'default' }) {
    return new Promise((resolve) => {
      // Settle any dialog that is somehow still open.
      if (this.#confirmResolver) {
        this.#confirmResolver(false);
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

    this.openModal('gameover');
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

    this.#dom.board?.setAttribute('data-theme', settings.boardTheme);
    document.documentElement.setAttribute('data-ui-style', settings.uiStyle ?? 'classic');
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

  #attachListeners() {
    // --- Menu screen ---
    this.#dom['btn-new-game']?.addEventListener('click', () => this.#call('onNewGameScreen'));
    this.#dom['btn-continue-game']?.addEventListener('click', () => this.#call('onContinue'));
    this.#dom['btn-menu-settings']?.addEventListener('click', () => this.openModal('settings'));

    // --- Setup screen ---
    this.#dom['btn-setup-back']?.addEventListener('click', () => this.showScreen('menu'));
    this.#dom['form-new-game']?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#call('onStartGame', {
        whiteName: this.#dom['input-white']?.value ?? '',
        blackName: this.#dom['input-black']?.value ?? '',
      });
    });

    // --- Online: mode toggle reveals the room controls ---
    this.#dom['form-new-game']?.addEventListener('change', (event) => {
      if (event.target.name !== 'mode') return;
      const isOnline = event.target.value === 'online';
      if (this.#dom['online-fields']) this.#dom['online-fields'].hidden = !isOnline;
      // The two-name form and the Start button only apply to local games.
      if (this.#dom['btn-start-game']) this.#dom['btn-start-game'].hidden = isOnline;
      const localFields = this.#dom['form-new-game']?.querySelectorAll('.field:not(.field--modes)');
      localFields?.forEach((field, index) => {
        if (index < 2) field.hidden = isOnline;
      });
    });

    this.#dom['btn-create-room']?.addEventListener('click', () =>
      this.#call('onCreateRoom', this.#dom['input-online-name']?.value ?? ''));

    this.#dom['btn-join-room']?.addEventListener('click', () =>
      this.#call('onJoinRoom', {
        code: this.#dom['input-room-code']?.value ?? '',
        name: this.#dom['input-online-name']?.value ?? '',
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

    // --- Game over ---
    this.#dom['btn-rematch']?.addEventListener('click', () => {
      this.closeModal('gameover');
      this.#call('onRematch', this.#dom['check-swap-colors']?.checked ?? true);
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
