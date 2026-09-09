/**
 * app.js
 * Composition root: builds the controller, board and UI, then wires them.
 *
 * This is the only module that knows about all three layers. Keeping the
 * wiring here means the board never calls the engine, and the engine never
 * touches the DOM.
 */

import { GameController, EVENT } from './game-controller.js';
import { LocalSession } from './sessions/local-session.js';
import { Board } from './board.js';
import { UI } from './ui.js';
import * as storage from './storage.js';
import sound from './sound.js';
import {
  WHITE,
  GAME_MODE,
  DEBUG,
  ANIMATION_MS,
  uiStyleNeedsWebgl,
  log,
  warn,
} from './config.js';
import { isFirebaseConfigured, firebaseConfigError } from './firebase-config.js';

async function boot() {
  const boardEl = document.getElementById('board');
  if (!boardEl) {
    warn('Board element missing — cannot start');
    return;
  }

  // Phase 1 uses the local session. Phase 2 swaps this single line for a
  // FirebaseSession; nothing below changes.
  const controller = new GameController(new LocalSession());
  const ui = new UI(controller);

  /**
   * The board renderer currently on screen.
   *
   * Reassignable, because the two boards are alternatives rather than layers:
   * the flat one is a DOM grid, the 3D one owns a GPU context, and they cannot
   * both hold the same element. Everything below talks to whichever is
   * mounted through the one contract they share, so nothing else in this file
   * needs to know which it is.
   */
  let board = new Board(boardEl);
  let boardStyle = 'classic';

  await controller.init();

  // A move waiting to be animated on the next render.
  let pendingAnimation = null;

  // Online transitions we need to notice between renders.
  let wasWaiting = false;
  let opponentWasConnected = true;

  // -----------------------------------------------------------------------
  // Controller -> views
  // -----------------------------------------------------------------------

  controller.on(EVENT.CHANGE, (snapshot) => {
    // The mounted renderer follows the setting itself, rather than being
    // swapped by whichever call site happened to change it. Restoring saved
    // settings, a settings-panel tap and the console helper are then all the
    // same path, and none of them can leave the board disagreeing with the
    // style the player has chosen. A no-op when it already matches.
    applyBoardStyle(snapshot.settings.uiStyle);

    board.setOrientation(snapshot.orientation);
    board.setShowCoordinates(snapshot.settings.showCoordinates);
    board.setAnimationsEnabled(snapshot.settings.animations);
    board.render(snapshot, { animateMove: pendingAnimation });
    pendingAnimation = null;
    ui.render(snapshot);
    handleOnlineTransitions(snapshot);
  });

  /**
   * Watch for the room-level events that change which screen the player sees:
   * an opponent joining, dropping out, or coming back.
   */
  function handleOnlineTransitions(snapshot) {
    const online = snapshot.state?.online;

    // Not online, or online but not actually seated in a room — for example
    // right after a failed join. Without this guard the presence check below
    // would fire "opponent disconnected" for a room we were never in.
    if (!online || !online.roomCode || !online.myColor) {
      wasWaiting = false;
      opponentWasConnected = true;
      return;
    }

    // Opponent joined — leave the waiting screen and start playing.
    if (wasWaiting && !online.waitingForOpponent) {
      ui.showScreen('game');
      ui.toast(`${online.opponentName ?? 'Opponent'} joined`);
      sound.play('move');
    }
    wasWaiting = online.waitingForOpponent;

    // Presence changes, but only once the game is actually under way.
    if (!online.waitingForOpponent && !snapshot.state.isGameOver) {
      if (opponentWasConnected && !online.opponentConnected) {
        ui.showOpponentLeft();
      } else if (!opponentWasConnected && online.opponentConnected) {
        ui.closeOpponentLeft();
        ui.toast(`${online.opponentName ?? 'Opponent'} reconnected`);
      }
      opponentWasConnected = online.opponentConnected;
    }

    // A draw offer we made, answered by the opponent, closes our own dialog.
    if (!online.drawOfferFrom) ui.closeDrawOffer();
  }

  /**
   * Swap in the Firebase session provider.
   * This is the whole of the Phase 2 integration as far as the app is
   * concerned — the board, UI and controller are untouched.
   */
  async function goOnline() {
    if (controller.isOnline()) return { ok: true };
    if (!isFirebaseConfigured()) {
      return { ok: false, error: firebaseConfigError() };
    }
    try {
      // Imported lazily so local play never fetches the Firebase SDK.
      const { FirebaseSession } = await import('./sessions/firebase-session.js');
      await controller.useSession(new FirebaseSession());
      return { ok: true };
    } catch (error) {
      warn('Could not start online session', error);
      return { ok: false, error: error.message ?? 'Could not connect' };
    }
  }

  /** Return to local play after an online game. */
  async function goLocal() {
    if (!controller.isOnline()) return;
    await controller.useSession(new LocalSession());
  }

  /**
   * Pick a saved game back up.
   *
   * Shared by the menu's Continue button and the resume dialog, so the two
   * cannot drift — in particular over the online case, which is the one with
   * a real difference in it.
   */
  async function continueSavedGame() {
    sound.unlock();
    const info = controller.getSavedGameInfo();

    // An online game resumes by rejoining its room, not by replaying a
    // local copy — the room is authoritative and has probably moved on.
    if (info?.mode === GAME_MODE.ONLINE && info.roomCode) {
      const started = await goOnline();
      if (!started.ok) {
        ui.toast(started.error ?? 'Online play unavailable', 'error');
        return;
      }
      const rejoined = await controller.rejoinRoom(info.roomCode);
      if (rejoined.ok) ui.showScreen('game');
      else ui.refreshContinueButton();
      return;
    }

    // A saved game carries the mode it was played in, so resuming has to put
    // the matching provider back. Restore a bot game onto a plain
    // LocalSession and the bot's pieces simply become the player's — the
    // position is right and the opponent has quietly gone.
    if (info?.mode === GAME_MODE.BOT) {
      const { BotSession } = await import('./sessions/bot-session.js');
      await controller.useSession(new BotSession());
    } else {
      await controller.useSession(new LocalSession());
    }

    const result = await controller.continueGame();
    if (result.ok) ui.showScreen('game');
    else ui.refreshContinueButton();
  }

  /**
   * Did this page arrive by reload, rather than a fresh visit or a link?
   *
   * Wrapped because the modern entry and the deprecated fallback have both
   * been missing somewhere: `getEntriesByType` is absent in jsdom, and
   * `performance.navigation` is gone from newer browsers. Anything unclear
   * counts as "not a reload", which simply leaves the Continue button as the
   * only way back in — the behaviour before this existed.
   */
  function wasReloaded() {
    try {
      const [entry] = performance.getEntriesByType?.('navigation') ?? [];
      if (entry) return entry.type === 'reload';
      return performance.navigation?.type === 1;
    } catch {
      return false;
    }
  }

  /**
   * After a refresh, offer the game back in the app's own dialog.
   *
   * This is what a refresh can actually be given. A styled confirmation
   * BEFORE the page goes is not possible for anyone: a page cannot render its
   * own UI during `beforeunload`, and browsers substitute fixed wording of
   * their own for anything it supplies. So the dialog is put on the other
   * side of the reload, where the app is in charge of it — and it is more
   * useful there anyway, since it offers to restore the game rather than
   * merely warning about it.
   *
   * Only after an actual reload. On a first visit the Continue button is
   * enough, and a dialog in front of every visitor who once left a game
   * unfinished would be nagging rather than helpful.
   *
   * Three answers, because the question has three. Continue picks the game
   * back up, New Game starts another, and Exit Game leaves it alone — which
   * was always possible by pressing Escape or tapping outside, but only if you
   * knew to. On a phone, an unlabelled way out is no way out, so it gets a
   * button. Nothing is discarded by it: the save stays, and the toast says so,
   * because a button called Exit that quietly threw a game away would be a
   * cruel reading of the word.
   */
  async function offerResumeAfterReload() {
    if (!wasReloaded() || !controller.hasSavedGame()) return;

    const info = controller.getSavedGameInfo();
    const moves = info?.moveCount ?? 0;
    const choice = await ui.confirm({
      title: 'Resume your game?',
      text: info
        ? `${info.white} vs ${info.black} — ${moves} ${moves === 1 ? 'move' : 'moves'} played`
        : 'You have a game in progress.',
      confirmLabel: 'Continue',
      cancelLabel: 'New Game',
      altLabel: 'Exit Game',
      altValue: 'exit',
      // Dismissing points at Exit rather than New Game: a stray tap on the
      // backdrop should not be the thing that puts a game behind you.
      dismissValue: 'exit',
    });

    if (choice === true) {
      await continueSavedGame();
    } else if (choice === false) {
      ui.showScreen('setup');
    } else {
      // Already on the menu — the reload put us there — so exiting is simply
      // staying, with the Continue button still holding the game.
      ui.showScreen('menu');
      ui.refreshContinueButton();
      ui.toast('Game saved — continue it any time');
    }
  }

  controller.on(EVENT.MOVE, ({ move }) => {
    // Captured here and consumed by the CHANGE render that follows, so the
    // animation always runs against the already-updated position.
    pendingAnimation = move;
  });

  controller.on(EVENT.PROMOTION, (payload) => ui.showPromotion(payload));

  controller.on(EVENT.GAME_OVER, (snapshot) => {
    // Let the mating move finish landing before the modal covers the board —
    // otherwise the player never sees the move that ended the game.
    //
    // Derived from the animation rather than a round number, so it tracks the
    // slide instead of drifting out of step with it. The old fixed 420ms left
    // a fifth of a second of dead air after the piece had already settled.
    window.setTimeout(() => ui.showGameOver(snapshot), ANIMATION_MS + 120);
  });

  controller.on(EVENT.TOAST, ({ message, tone }) => ui.toast(message, tone));

  controller.on(EVENT.DRAW_OFFER, async ({ from, to, remote }) => {
    // Online the offer arrives over the network and gets its own dialog, which
    // stays up until answered. Locally both players share the device, so a
    // plain confirmation aimed at the opponent is enough.
    if (remote) {
      const snapshot = controller.getSnapshot();
      ui.showDrawOffer({ fromName: snapshot.state?.online?.opponentName });
      return;
    }

    const offerer = from === WHITE ? 'White' : 'Black';
    const receiver = to === WHITE ? 'White' : 'Black';
    const accepted = await ui.confirm({
      title: `${offerer} offers a draw`,
      text: `${receiver}, do you accept?`,
      confirmLabel: 'Accept',
    });
    if (accepted) await controller.acceptDraw();
    else await controller.declineDraw();
  });

  // -----------------------------------------------------------------------
  // Board -> controller
  // -----------------------------------------------------------------------

  function wireBoard() {
    board.onSquareActivate((square) => {
      sound.unlock();
      controller.selectSquare(square);
    });
  }
  wireBoard();

  /**
   * Mount the board renderer the chosen style calls for.
   *
   * Loading three.js is deferred to the moment a player actually picks the 3D
   * board, and never happens for anyone who does not: it is by far the largest
   * thing the app can load, and making every player on every visit pay for a
   * skin most will never open would be a poor trade for a game whose whole
   * point is that it starts instantly.
   *
   * A refused WebGL context is treated as a normal outcome, not an error. Some
   * devices and hardened browser profiles simply will not grant one, and the
   * honest response is to say so and stay on a board that works.
   */
  async function applyBoardStyle(styleId) {
    const wanted = uiStyleNeedsWebgl(styleId) ? styleId : 'classic';
    if (wanted === boardStyle) return true;

    if (wanted === 'classic') {
      board.dispose?.();
      board = new Board(boardEl);
      boardStyle = 'classic';
      wireBoard();
      repaint();
      return true;
    }

    try {
      const { Board3D } = await import('./board-3d.js');
      board.dispose?.();
      boardEl.innerHTML = '';
      board = new Board3D(boardEl);
      boardStyle = wanted;
      wireBoard();
      repaint();
      return true;
    } catch (error) {
      warn('3D board unavailable, staying on the flat board', error);
      // Whatever half-built state the attempt left behind, replace it with a
      // board that definitely works before telling the player.
      boardEl.innerHTML = '';
      board = new Board(boardEl);
      boardStyle = 'classic';
      wireBoard();
      controller.updateSettings({ uiStyle: 'classic' });
      ui.syncSettings(controller.getSettings());
      repaint();
      ui.toast('This device cannot run the 3D board', 'error');
      return false;
    }
  }

  /** Push the current snapshot at whichever board is mounted. */
  function repaint() {
    const snapshot = controller.getSnapshot();
    board.setOrientation(snapshot.orientation);
    board.setShowCoordinates(snapshot.settings.showCoordinates);
    board.setAnimationsEnabled(snapshot.settings.animations);
    board.render(snapshot);
    ui.render(snapshot);
  }

  // -----------------------------------------------------------------------
  // UI -> controller
  // -----------------------------------------------------------------------

  ui.bind({
    onNewGameScreen: () => {
      ui.showScreen('setup');
      document.getElementById('input-white')?.focus();
    },

    onStartGame: async ({ mode, whiteName, blackName }) => {
      sound.unlock();

      // The mode picks the session provider, and that is the whole of the
      // difference between these games. Everything downstream — board, UI,
      // controller — is the same code either way.
      // A fresh provider every time, rather than reusing whatever the last
      // game left mounted. BotSession extends LocalSession, so `instanceof`
      // cannot tell them apart, and starting a two-player game on a session
      // that still answers as the bot is exactly the bug that invites.
      if (mode === GAME_MODE.BOT) {
        // Imported lazily: the search and its tables are dead weight for
        // anyone who only ever plays another person.
        const { BotSession } = await import('./sessions/bot-session.js');
        await controller.useSession(new BotSession());
        await controller.newGame({ whiteName, mode: GAME_MODE.BOT });
      } else {
        await controller.useSession(new LocalSession());
        await controller.newGame({ whiteName, blackName });
      }
      ui.showScreen('game');
    },

    onContinue: () => continueSavedGame(),

    // --- Online room handlers ---

    onCreateRoom: async (name) => {
      sound.unlock();
      const started = await goOnline();
      if (!started.ok) {
        ui.toast(started.error ?? 'Online play unavailable', 'error');
        return;
      }
      const result = await controller.createRoom({ name });
      if (result.ok) ui.showWaitingRoom(result.roomCode);
    },

    onJoinRoom: async ({ code, name }) => {
      sound.unlock();
      if (!code?.trim()) {
        ui.toast('Enter a room code', 'warn');
        return;
      }
      const started = await goOnline();
      if (!started.ok) {
        ui.toast(started.error ?? 'Online play unavailable', 'error');
        return;
      }
      const result = await controller.joinRoom(code, { name });
      if (result.ok) ui.showScreen('game');
    },

    onCancelRoom: async () => {
      await controller.leaveRoom();
      await goLocal();
      ui.showScreen('menu');
      ui.refreshContinueButton();
    },

    onCopyRoomCode: async (code) => {
      const copied = await copyText(code);
      ui.toast(copied ? 'Room code copied' : 'Could not copy code',
        copied ? 'info' : 'error');
    },

    onAcceptDraw: () => controller.acceptDraw(),
    onDeclineDraw: () => controller.declineDraw(),

    onUndo: () => controller.undo(),

    onFlip: () => controller.flipBoard(),


    onResign: async () => {
      const snapshot = controller.getSnapshot();
      const color = snapshot.state?.turn;
      const name = color === WHITE ? 'White' : 'Black';
      const confirmed = await ui.confirm({
        title: `${name} resigns?`,
        text: `${color === WHITE ? 'Black' : 'White'} will win the game.`,
        confirmLabel: 'Resign',
        tone: 'danger',
      });
      if (confirmed) await controller.resign(color);
    },

    onRestart: async () => {
      ui.closeModal('menu');
      const confirmed = await ui.confirm({
        title: 'Restart this game?',
        text: 'The board, move history and result will be reset. Player names are kept.',
        confirmLabel: 'Restart',
        tone: 'danger',
      });
      if (confirmed) await controller.restart();
    },

    onRematch: (swapColors) => controller.rematch(swapColors),


    onLeaveGame: async () => {
      ui.closeModal('menu');
      const online = controller.isOnline();
      const confirmed = await ui.confirm({
        title: online ? 'Leave this room?' : 'Return to main menu?',
        text: online
          ? 'Your opponent will see you disconnect. You can rejoin with the same room code.'
          : 'Your game is saved and can be continued later.',
        confirmLabel: online ? 'Leave Room' : 'Main Menu',
      });
      if (!confirmed) return;

      if (online) {
        await controller.leaveRoom();
        await goLocal();
      }
      ui.showScreen('menu');
      ui.refreshContinueButton();
    },

    onPromotionChoice: (piece) => controller.completePromotion(piece),

    onSettingChange: (patch) => {
      const settings = controller.updateSettings(patch);
      ui.syncSettings(settings);
      if (Object.prototype.hasOwnProperty.call(patch, 'sound')) {
        sound.unlock();
        ui.toast(settings.sound ? 'Sound enabled' : 'Sound disabled');
      }
    },

  });

  // -----------------------------------------------------------------------
  // Initial paint
  // -----------------------------------------------------------------------

  ui.syncSettings(controller.getSettings());
  ui.refreshContinueButton();
  ui.setOnlineAvailable(isFirebaseConfigured(), firebaseConfigError());
  ui.showScreen('menu');

  // Restore the board the player last chose. Deliberately not awaited: the
  // menu should be interactive immediately, and the 3D board mounts itself
  // when its module arrives rather than holding up the first paint.
  applyBoardStyle(controller.getSettings().uiStyle);

  // Private browsing or blocked storage: the game is fully playable, but it
  // cannot be resumed after a refresh. Say so once rather than failing quietly.
  if (!storage.isAvailable()) {
    ui.toast('Storage unavailable — this game will not be saved', 'warn');
  }

  // Audio contexts must be created from a user gesture.
  const unlockOnce = () => sound.unlock();
  document.addEventListener('pointerdown', unlockOnce, { once: true });
  document.addEventListener('keydown', unlockOnce, { once: true });

  // Offer the game back after a refresh, in the app's own dialog. Last,
  // because it opens a modal over the menu the lines above have just put up.
  offerResumeAfterReload();

  if (DEBUG) {
    // Handy console access while developing; never referenced by app code.
    // `board` is a getter because the renderer is swapped when the player
    // changes style — a captured reference would go stale on the first swap
    // and quietly hand back a board that is no longer on screen.
    window.chessArena = {
      controller,
      ui,
      get board() { return board; },
      get boardStyle() { return boardStyle; },
    };
    log('DEBUG mode on — window.chessArena available');
  }
}

/** Clipboard write with a fallback for non-secure contexts. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (error) {
    warn('Clipboard unavailable', error);
    return false;
  }
}

// Surface unexpected failures instead of dying silently.
window.addEventListener('error', (event) => warn('Uncaught error:', event.message));
window.addEventListener('unhandledrejection', (event) => warn('Unhandled rejection:', event.reason));

boot().catch((error) => {
  console.error('[chess] Fatal startup error', error);
});
