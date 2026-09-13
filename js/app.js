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
  PRESENCE,
  emote,
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

  /**
   * Friends, requests and presence — built the first time anything needs
   * them, which is either opening the panel or going online.
   *
   * Lazily, and for the same reason the Firebase session is: somebody who
   * only plays the bot should never fetch a line of it. Going online counts
   * as needing it even when the panel is never opened, because otherwise a
   * player with friends would appear offline to all of them for the whole
   * game they are visibly in the middle of.
   */
  let social = null;

  async function ensureSocial() {
    if (!isFirebaseConfigured()) return null;
    if (!social) {
      const { SocialHub } = await import('./social.js');
      social = new SocialHub();
      // Subscribing before starting so the panel has a first paint —
      // "Connecting…" — rather than sitting empty through the round trip.
      social.subscribe((state) => ui.renderSocial(state));
    }

    // Before start(), so the very first presence write already says whether
    // there is a game on. The CHANGE that would otherwise carry it can fire
    // while this function is still awaiting its import — and then nothing
    // says it again until the next move.
    reportActivity(controller.getSnapshot());

    try {
      await social.start();
    } catch (error) {
      // Already on screen: the hub reports it through its own state, which
      // the panel renders. Nothing to say twice.
      warn('Friends unavailable', error);
    }

    // And again on the way out, for the room that was created while the
    // sign-in was in flight.
    reportActivity(controller.getSnapshot());
    return social;
  }

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
    board.setZoom(snapshot.settings.boardZoom);
    board.render(snapshot, { animateMove: pendingAnimation });
    pendingAnimation = null;
    ui.render(snapshot);
    // The ladder is on the setup screen rather than this one, so it is
    // repainted here for the next time the player looks at it — a run that
    // moved during the game they just finished must not be stale when they
    // walk back to the form.
    ui.syncGauntlet(snapshot.gauntlet);
    handleOnlineTransitions(snapshot);
    reportActivity(snapshot);
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
   * Tell friends whether this device is in a game.
   *
   * Driven from the room rather than from the button that created it, so
   * every way into and out of a game — created, joined, rejoined after a
   * refresh, left, finished — reports itself without each one having to
   * remember to. setActivity ignores a value it already holds, so calling
   * this on every render costs nothing.
   */
  function reportActivity(snapshot) {
    if (!social) return;
    const inRoom = Boolean(snapshot.state?.online?.roomCode);
    social.setActivity(inRoom ? PRESENCE.PLAYING : PRESENCE.ONLINE);
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
      // Not awaited: a friends list is not worth delaying a game for, and
      // the hub reports its own failures into its own panel.
      ensureSocial().catch((error) => warn('Friends unavailable', error));
      return { ok: true };
    } catch (error) {
      warn('Could not start online session', error);
      return { ok: false, error: error.message ?? 'Could not connect' };
    }
  }

  /**
   * Keep the name and picture used for a room as the name and picture this
   * device is known by.
   *
   * Written straight to storage rather than waiting on the hub, because the
   * hub may not exist yet — and this is the value it reads when it starts.
   */
  function rememberOnlineIdentity(name, avatar) {
    const trimmed = String(name ?? '').trim();
    if (trimmed) storage.saveProfile({ name: trimmed });
    if (!social) return;
    if (trimmed) social.setName(trimmed);
    social.setAvatar(avatar);
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
    // A tournament game is a bot game with a rung attached, so it resumes
    // the same way — and BotSession reads the rung back out of the record,
    // which is what stops a resumed Champion game being finished off by the
    // Novice.
    if (info?.mode === GAME_MODE.BOT || info?.mode === GAME_MODE.TOURNAMENT
        || info?.vsBot) {
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

  // Ten times a second while a clock runs, and nothing else in the app
  // moves — so this repaints the two readouts rather than re-rendering the
  // screen around them.
  controller.on(EVENT.CLOCK, ({ clock }) => ui.renderClocks({ clock }));

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

  /**
   * Something was said in the room.
   *
   * The log itself is painted by the render that follows this — see
   * ui.onChatMessages. What is added here is the part that only makes sense
   * away from the panel: a sound, and a toast carrying what was said, for a
   * player who is looking at the board rather than at the sheet.
   */
  controller.on(EVENT.CHAT, ({ messages }) => {
    ui.onChatMessages(messages);
    if (!controller.getSettings().chat) return;

    const incoming = messages.filter((message) => !message.mine);
    if (!incoming.length || ui.isChatOpen()) return;

    sound.play('move');

    // One toast, for the last thing said: a burst that arrived together is
    // one interruption, not four. Emotes are named rather than drawn, so
    // the notice reads the same whether or not the font has the glyph.
    const last = incoming[incoming.length - 1];
    const who = controller.getSnapshot().state?.online?.opponentName ?? 'Opponent';
    const said = last.kind === 'emote'
      ? (emote(last.body)?.label ?? 'sent an emote')
      : last.body;
    ui.toast(`${who}: ${said}`);
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
    // Called once per mount, which is exactly when what the board can do
    // changes. The flat board has no zoom to sell, so the control goes away
    // with it rather than sitting there doing nothing.
    ui.setZoomAvailable(board.canZoom?.() === true);
    // The capture trays draw real pieces when the mounted board can produce
    // them, and fall back to glyphs on the flat board. Set here, with the
    // other per-mount capabilities, for the same reason: this is the moment
    // what the board can do changes.
    ui.setPieceSprites(
      typeof board.pieceSprite === 'function'
        ? (type, color) => board.pieceSprite(type, color)
        : null,
    );
  }
  wireBoard();

  /**
   * Set when this device refuses a WebGL context.
   *
   * Session-scoped on purpose. The flat board is a fallback now rather than a
   * choice, so a refusal is not written to settings: writing it would strand
   * the player on the flat board for good, with no picker left to climb back
   * out of it. Kept in memory instead, so this visit stops retrying — CHANGE
   * fires on every move, and re-importing three.js to fail again each time
   * would be both slow and a toast per move — while the next visit tries
   * afresh. Refusals are often transient: too many live contexts on the page,
   * a driver reset, a profile the player has since relaxed.
   */
  let webglRefused = false;

  /**
   * Mount the board renderer the chosen style calls for.
   *
   * three.js is still imported lazily rather than bundled into the first
   * paint: the menu is interactive immediately and the 3D board mounts itself
   * when its module arrives, which matters more now that every player loads it
   * rather than only the ones who went looking for it in Settings.
   *
   * A refused WebGL context is treated as a normal outcome, not an error. Some
   * devices and hardened browser profiles simply will not grant one, and the
   * honest response is to say so and stay on a board that works.
   */
  async function applyBoardStyle(styleId) {
    const wanted = uiStyleNeedsWebgl(styleId) && !webglRefused ? styleId : 'classic';
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
      webglRefused = true;
      // Whatever half-built state the attempt left behind, replace it with a
      // board that definitely works before telling the player.
      boardEl.innerHTML = '';
      board = new Board(boardEl);
      boardStyle = 'classic';
      wireBoard();
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
    board.setZoom(snapshot.settings.boardZoom);
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

    onStartGame: async ({
      mode, whiteName, blackName, whiteAvatar, blackAvatar, timeControl, opponent,
    }) => {
      sound.unlock();

      // The mode picks the session provider, and that is the whole of the
      // difference between these games. Everything downstream — board, UI,
      // controller — is the same code either way.
      // A fresh provider every time, rather than reusing whatever the last
      // game left mounted. BotSession extends LocalSession, so `instanceof`
      // cannot tell them apart, and starting a two-player game on a session
      // that still answers as the bot is exactly the bug that invites.
      // The ladder picks its own opponent and its own strength, so it takes
      // the round rather than a second name. Same session as Player vs Bot:
      // one bot, five settings of it.
      if (mode === GAME_MODE.TOURNAMENT) {
        const { BotSession } = await import('./sessions/bot-session.js');
        await controller.useSession(new BotSession());
        await controller.startGauntletRound(undefined, { name: whiteName });
        ui.showScreen('game');
        return;
      }

      if (mode === GAME_MODE.BOT) {
        // Imported lazily: the search and its tables are dead weight for
        // anyone who only ever plays another person.
        const { BotSession } = await import('./sessions/bot-session.js');
        await controller.useSession(new BotSession());
        // Only the human's picture travels: the bot takes the other seat, and
        // bot-session.js builds that seat itself so it cannot inherit one.
        await controller.newGame({ whiteName, whiteAvatar, mode: GAME_MODE.BOT });
      } else {
        // Speed Chess is one of the other two games with a clock on it, so
        // it picks a session the same way they do and then hands over the
        // one thing that differs. Against the bot the second name box was
        // hidden, so there is no second name to pass.
        const speed = mode === GAME_MODE.SPEED;
        const speedBot = speed && opponent !== 'human';

        if (speedBot) {
          const { BotSession } = await import('./sessions/bot-session.js');
          await controller.useSession(new BotSession());
        } else {
          await controller.useSession(new LocalSession());
        }

        await controller.newGame({
          whiteName,
          blackName: speedBot ? undefined : blackName,
          whiteAvatar,
          blackAvatar: speedBot ? null : blackAvatar,
          mode: speed ? GAME_MODE.SPEED : GAME_MODE.LOCAL,
          timeControl: speed ? timeControl : null,
        });
      }
      ui.showScreen('game');
    },

    onContinue: () => continueSavedGame(),

    // --- Online room handlers ---

    onCreateRoom: async ({ name, avatar }) => {
      sound.unlock();
      rememberOnlineIdentity(name, avatar);
      const started = await goOnline();
      if (!started.ok) {
        ui.toast(started.error ?? 'Online play unavailable', 'error');
        return;
      }
      const result = await controller.createRoom({ name, avatar });
      if (result.ok) ui.showWaitingRoom(result.roomCode);
    },

    onJoinRoom: async ({ code, name, avatar }) => {
      sound.unlock();
      if (!code?.trim()) {
        ui.toast('Enter a room code', 'warn');
        return;
      }
      rememberOnlineIdentity(name, avatar);
      const started = await goOnline();
      if (!started.ok) {
        ui.toast(started.error ?? 'Online play unavailable', 'error');
        return;
      }
      const result = await controller.joinRoom(code, { name, avatar });
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

    // --- Chat and emotes ---
    //
    // Both refuse the same way and say so in the same place: a toast over
    // the sheet the message was typed into, which is where the person who
    // typed it is looking.
    onSendChat: async ({ body }) => {
      const result = await controller.sendChat(body);
      if (!result?.ok) ui.toast(result?.error ?? 'Could not send that', 'warn');
    },

    onSendEmote: async ({ id }) => {
      const result = await controller.sendEmote(id);
      if (!result?.ok) ui.toast(result?.error ?? 'Could not send that', 'warn');
    },

    // --- Friends ---

    onOpenFriends: () => ensureSocial(),

    onAddFriend: async ({ code }) => {
      const hub = await ensureSocial();
      if (!hub) return;
      const result = await hub.addFriend(code);
      if (!result.ok) {
        ui.toast(result.error, 'warn');
        return;
      }
      ui.clearFriendCodeInput();
      ui.toast('Request sent');
    },

    onAcceptRequest: async ({ uid }) => {
      const result = await social?.acceptRequest(uid);
      if (result?.ok) ui.toast(`${result.name} is now a friend`);
      else if (result) ui.toast(result.error, 'warn');
    },

    onDeclineRequest: async ({ uid }) => {
      const result = await social?.declineRequest(uid);
      if (result && !result.ok) ui.toast(result.error, 'warn');
    },

    onRemoveFriend: async ({ uid }) => {
      const confirmed = await ui.confirm({
        title: 'Remove this friend?',
        text: 'You will both drop off each other\'s lists. You can add them again with their code.',
        confirmLabel: 'Remove',
        tone: 'danger',
      });
      if (!confirmed) return;
      const result = await social?.removeFriend(uid);
      if (result && !result.ok) ui.toast(result.error, 'warn');
    },

    /**
     * Rename this device, everywhere it is named.
     *
     * The online form and the friends panel are two boxes holding one name,
     * and the one that is not being typed into has to follow — otherwise the
     * next room is created under whichever name the player last happened to
     * type into the other box.
     */
    onRenameMe: async ({ name }) => {
      const hub = await ensureSocial();
      if (!hub) return;
      const result = await hub.setName(name);
      if (!result.ok) {
        ui.toast(result.error, 'warn');
        return;
      }
      ui.setOnlineName(result.name);
    },

    onCopyFriendCode: async (code) => {
      if (!code) {
        ui.toast('No code yet — still connecting', 'warn');
        return;
      }
      const copied = await copyText(code);
      ui.toast(copied ? 'Friend code copied' : 'Could not copy code',
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

    onRematch: () => controller.rematch(),


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

    /**
     * Play the next rung without going back through the form.
     *
     * The name is carried over from the game just finished rather than
     * asked for again: it is the same player, still climbing.
     */
    onLadderNext: async ({ round }) => {
      sound.unlock();
      const name = controller.getSnapshot().state?.players?.[WHITE]?.name;
      const { BotSession } = await import('./sessions/bot-session.js');
      await controller.useSession(new BotSession());
      await controller.startGauntletRound(round, { name });
      ui.showScreen('game');
    },

    // Remembering a picture is not a setting and touches no game state, so it
    // does not go through onSettingChange: nothing needs re-rendering, and a
    // game already under way keeps the picture its players sat down with.
    onAvatarChange: ({ slot, avatar }) => {
      controller.setAvatar(slot, avatar);
      // The online seat and the friends-list face are the same picture, so
      // changing one changes the other. Only when the hub is already up: a
      // picture chosen for a local game must not be what starts a sign-in.
      if (slot === 'online') social?.setAvatar(avatar);
    },

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
  ui.syncAvatars(controller.getAvatars());
  ui.syncGauntlet(controller.getGauntlet());
  ui.refreshContinueButton();
  ui.setOnlineAvailable(isFirebaseConfigured(), firebaseConfigError());
  // Friends need a project behind them in a way local play does not, so the
  // button is simply absent without one rather than disabled.
  ui.setFriendsAvailable(isFirebaseConfigured());
  // The name this device plays under, offered back rather than retyped. Not
  // a network read: it is the copy this device saved the last time it used
  // one, so it is there before anything connects.
  ui.setOnlineName(storage.loadProfile().name);
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
      get social() { return social; },
      ensureSocial,
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
