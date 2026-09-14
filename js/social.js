/**
 * social.js
 * Who you are between games: a friend code, a name, who is on your list, and
 * who is about right now.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF FirebaseSession
 * ---------------------------------------------------------------------------
 * A session is a room. It is created when you make or join one, it is torn
 * down when you leave, and everything it knows dies with it — which is right,
 * because a room is a game and a game ends.
 *
 * None of that is true of a friend. A friend list outlives every room, has to
 * be readable from the menu with no game in progress, and has to keep working
 * while a session is being destroyed and rebuilt underneath it. So it is its
 * own object with its own lifetime, sharing only the one thing that must be
 * shared: the Firebase app and the anonymous sign-in, which come from
 * firebase-client.js so that both halves are the same account.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, HONESTLY
 * ---------------------------------------------------------------------------
 * Sign-in is anonymous, so "who you are" is a uid Firebase handed this browser
 * and keeps in local storage. That means:
 *
 *   - clearing site data is the same as deleting the account,
 *   - a second browser, or a phone, is a different person,
 *   - and there is no password, so there is nothing to steal and nothing to
 *     recover.
 *
 * A friend code is a six-character handle claimed once and pointed at that
 * uid, because a uid is 28 characters of base64 and nobody is reading that
 * out loud. The code is a label on the account, not the account.
 *
 * ---------------------------------------------------------------------------
 * WHAT A STRANGER CAN DO
 * ---------------------------------------------------------------------------
 * Anyone signed in can read any profile and any presence record — that is what
 * makes a friend code work at all, since resolving one means reading a
 * stranger's row. Nobody can read your friends, your requests, or anything you
 * have sent. Somebody who guesses your code can put a request in front of you;
 * you decline it and they are gone. See README "Trust model" for the full
 * boundaries, including the one this cannot close.
 */

import {
  PRESENCE,
  VALID_PRESENCE,
  PRESENCE_STALE_MS,
  PRESENCE_HEARTBEAT_MS,
  FRIEND_CODE_LENGTH,
  NAME_MAX_LENGTH,
  MAX_FRIENDS,
  MAX_REQUESTS,
  INVITE_TTL_MS,
  log,
  warn,
} from './config.js';
import { isAvatar, toOnlineAvatar } from './avatar.js';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './firebase-config.js';
import { firebaseReady, explainFirebaseError, isPermissionDenied } from './firebase-client.js';
import * as storage from './storage.js';

/**
 * What a name is allowed to be, before it is anybody else's problem.
 *
 * The cap itself is NAME_MAX_LENGTH in config.js, which is also what the
 * database rules enforce — a second number here could drift from the one the
 * rules were written against, and the first anybody would know of it is a
 * write being refused.
 */
const NAME_MAX = NAME_MAX_LENGTH;

/** Said whenever the rules are the thing standing in the way. */
const RULES_OUT_OF_DATE = 'Friends need the database rules deployed — see firebase/database.rules.json';

/** The same problem, said where friends already work and invites do not. */
const INVITES_OUT_OF_DATE = 'Invites need the database rules deployed — see firebase/database.rules.json';

/**
 * A friend code, from the alphabet room codes use.
 *
 * Deliberately the same alphabet: both get read out loud or typed off a
 * screenshot, so both avoid the characters that are easy to mistake for each
 * other. They are still different things pointing at different kinds of
 * object, which is why the length lives in its own constant.
 */
function generateFriendCode() {
  const bytes = new Uint32Array(FRIEND_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < FRIEND_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise a typed code the way the room-code field does. */
export function normalizeFriendCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .split('')
    .filter((character) => ROOM_CODE_ALPHABET.includes(character))
    .join('')
    .slice(0, FRIEND_CODE_LENGTH);
}

/**
 * Is this shaped like a room code?
 *
 * Asked of a string that arrived over the network and is about to be used
 * to join a game. Nothing terrible happens if it is wrong — a bad code
 * simply finds no room — but a row offering to take you somewhere that
 * cannot exist is worth not drawing at all.
 */
function isRoomCode(value) {
  if (typeof value !== 'string' || value.length !== ROOM_CODE_LENGTH) return false;
  return [...value].every((character) => ROOM_CODE_ALPHABET.includes(character));
}

/** A name we are willing to show, from a record somebody else wrote. */
function safeName(value, fallback = 'Player') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return trimmed || fallback;
}

/**
 * What a presence record actually means, right now.
 *
 * Two things can make somebody offline: saying so, and saying nothing for long
 * enough. The second matters because the first depends on a disconnect handler
 * firing, and a client can die in ways the server never notices — a laptop
 * lid, a tunnel. Showing a friend as online for the rest of the day because of
 * one of those is worse than showing them offline a couple of minutes early.
 */
function readPresence(raw) {
  const at = typeof raw?.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0;
  const claimed = VALID_PRESENCE.includes(raw?.state) ? raw.state : PRESENCE.OFFLINE;
  if (claimed === PRESENCE.OFFLINE) return { state: PRESENCE.OFFLINE, at };
  if (!at || Date.now() - at > PRESENCE_STALE_MS) return { state: PRESENCE.OFFLINE, at };
  return { state: claimed, at };
}

export class SocialHub {
  #sdk = null;
  #db = null;
  #uid = null;

  /** Everything published about this device, mirrored locally. */
  #code = null;
  #name = null;
  #avatar = null;
  #activity = PRESENCE.ONLINE;

  /** The three lists, as the database has them. */
  #friends = new Map();   // uid -> { at }
  #requests = new Map();  // uid -> { name, code, at }
  #sent = new Map();      // uid -> { at }

  /**
   * Invitations to a game.
   *
   * `#invites` is a list this account owns and reads, like the three above.
   * `#invited` is not: nobody can read what they have written into somebody
   * else's inbox, so the only record of an invite this device sent is the
   * one it keeps here. It is what "Invited" on a row is drawn from, and
   * what the withdrawal aims at when the room goes.
   */
  #invites = new Map();   // uid -> { name, room, at }
  #invited = new Map();   // uid -> { room, at }

  /** What we know about other people, filled in by per-friend listeners. */
  #profiles = new Map();  // uid -> { name, avatar, code }
  #presence = new Map();  // uid -> { state, at }
  #watching = new Map();  // uid -> stop()

  #listeners = new Set();
  #detachers = [];
  #heartbeat = null;
  #expiry = null;
  #started = null;
  #ready = false;
  #error = null;
  #stopped = false;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Connect, make sure this device has a code, and start listening.
   *
   * Memoised like firebaseReady(), and for the same reason: the friends panel
   * can be opened, closed and opened again in the time one round trip takes,
   * and three taps must not mean three claims on three different codes.
   */
  start() {
    if (!this.#started) {
      this.#started = this.#connect().catch((error) => {
        this.#started = null;
        this.#error = explainFirebaseError(error);
        this.#publish();
        throw error;
      });
    }
    return this.#started;
  }

  async #connect() {
    const { sdk, db, uid } = await firebaseReady();
    this.#sdk = sdk;
    this.#db = db;
    this.#uid = uid;
    this.#stopped = false;

    // The remembered name and code come first, so the panel has something to
    // show while the round trips below are still in flight.
    const stored = storage.loadProfile();
    this.#name = stored.name;
    this.#code = stored.code;
    this.#avatar = storage.loadAvatars().online ?? null;
    this.#publish();

    await this.#ensureCode();
    await this.#publishProfile();
    await this.#armPresence();
    this.#watchLists();

    this.#ready = true;
    this.#error = null;
    this.#publish();
    log('SocialHub ready as', this.#code);
    return this;
  }

  /**
   * Make sure this device owns a friend code, reusing one wherever possible.
   *
   * Three places might already know it, checked in order of how much they are
   * worth trusting: the profile in the database (authoritative), the copy in
   * local storage (right until site data is cleared), and nowhere, which means
   * claiming a new one. Every path ends by checking `handles/<code>` actually
   * points back at this uid — a code that does not is somebody else's, and
   * handing it out would send friend requests to a stranger.
   */
  async #ensureCode() {
    const { ref, get, runTransaction } = this.#sdk;

    const mine = async (code) => {
      if (!code) return false;
      try {
        const snapshot = await get(ref(this.#db, `handles/${code}`));
        return snapshot.val() === this.#uid;
      } catch (error) {
        warn('Could not read handle', code, error);
        return false;
      }
    };

    let profileCode = null;
    try {
      const snapshot = await get(ref(this.#db, `users/${this.#uid}/profile`));
      const value = snapshot.val();
      if (typeof value?.code === 'string') profileCode = normalizeFriendCode(value.code);
      // The name in the database wins over the one in storage only when there
      // is nothing in storage: a rename typed here has not been published yet.
      if (!this.#name && typeof value?.name === 'string') this.#name = safeName(value.name, null);
    } catch (error) {
      if (isPermissionDenied(error)) throw new Error(RULES_OUT_OF_DATE);
      throw error;
    }

    for (const candidate of [profileCode, this.#code]) {
      if (await mine(candidate)) {
        this.#code = candidate;
        storage.saveProfile({ code: candidate });
        return;
      }
    }

    // Nothing to reuse. Claim one, retrying on the vanishingly unlikely
    // collision but giving up quickly on anything that is not a collision —
    // a rules problem fails every candidate identically.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateFriendCode();
      try {
        const outcome = await runTransaction(
          ref(this.#db, `handles/${candidate}`),
          (current) => (current === null ? this.#uid : undefined),
        );
        if (outcome.committed) {
          this.#code = candidate;
          storage.saveProfile({ code: candidate });
          return;
        }
      } catch (error) {
        warn('Could not claim a friend code', error);
        throw new Error(isPermissionDenied(error) ? RULES_OUT_OF_DATE : explainFirebaseError(error));
      }
    }
    throw new Error('Could not claim a friend code — try again');
  }

  /**
   * Write the row other people read: name, code and picture.
   *
   * The picture goes through the same shrink as a seat picture, because it is
   * the same kind of thing arriving over the same network and the rules cap it
   * the same way. A picture that will not fit is dropped rather than taking
   * the profile with it — a friend list with no faces still works.
   */
  async #publishProfile() {
    if (!this.#uid || !this.#code) return;
    const { ref, set, serverTimestamp } = this.#sdk;

    const profile = {
      name: safeName(this.#name, 'Player'),
      code: this.#code,
      updatedAt: serverTimestamp(),
    };

    const picture = await toOnlineAvatar(this.#avatar).catch(() => null);
    if (isAvatar(picture)) profile.avatar = picture;

    try {
      await set(ref(this.#db, `users/${this.#uid}/profile`), profile);
    } catch (error) {
      if (isAvatar(picture)) {
        // Same shape as a seat that was refused with a picture: try again
        // without it before giving up on the whole row.
        warn('Profile refused with a picture — retrying without it');
        delete profile.avatar;
        try {
          await set(ref(this.#db, `users/${this.#uid}/profile`), profile);
          return;
        } catch (retry) {
          warn('Profile refused', retry);
          throw new Error(isPermissionDenied(retry) ? RULES_OUT_OF_DATE : explainFirebaseError(retry));
        }
      }
      throw new Error(isPermissionDenied(error) ? RULES_OUT_OF_DATE : explainFirebaseError(error));
    }
  }

  /**
   * Say we are here, and arrange to say we are not when the tab dies.
   *
   * onDisconnect is registered server-side, so it fires for a closed laptop as
   * well as for a tapped Back button. The heartbeat is for the case it cannot
   * cover — see PRESENCE_STALE_MS — and is also what moves a friend from
   * "online" to "in a game" without any extra plumbing.
   */
  async #armPresence() {
    const { ref, set, onDisconnect, serverTimestamp } = this.#sdk;
    const presenceRef = ref(this.#db, `users/${this.#uid}/presence`);

    try {
      await onDisconnect(presenceRef).set({ state: PRESENCE.OFFLINE, at: serverTimestamp() });
      await set(presenceRef, { state: this.#activity, at: Date.now() });
    } catch (error) {
      warn('Could not publish presence', error);
      return;
    }

    this.#stopHeartbeat();
    this.#heartbeat = window.setInterval(() => {
      if (this.#stopped) return this.#stopHeartbeat();
      return this.#touchPresence();
    }, PRESENCE_HEARTBEAT_MS);
  }

  #touchPresence() {
    if (!this.#sdk || !this.#uid) return Promise.resolve();
    const { ref, set } = this.#sdk;
    return set(ref(this.#db, `users/${this.#uid}/presence`), {
      state: this.#activity,
      at: Date.now(),
    }).catch((error) => warn('Presence heartbeat failed', error));
  }

  #stopHeartbeat() {
    if (this.#heartbeat === null) return;
    window.clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /**
   * Whether this device is in a game, which is the one thing friends see
   * change without anybody touching the friends panel.
   *
   * Safe to call before start(): the value is remembered and published with
   * the first presence write, so app.js can report a game beginning without
   * first having to ask whether the social side happens to be up.
   */
  setActivity(state) {
    const next = state === PRESENCE.PLAYING ? PRESENCE.PLAYING : PRESENCE.ONLINE;
    if (next === this.#activity) return;

    // Coming out of a game means the room those invites named has gone.
    // Noticed here rather than in the button that left it, for the same
    // reason presence is: there are five ways out of a game and only one
    // of them is a button.
    const left = this.#activity === PRESENCE.PLAYING && next === PRESENCE.ONLINE;
    this.#activity = next;
    if (this.#ready) this.#touchPresence();
    if (left) this.withdrawInvites();
  }

  /** Drop every listener and mark this device away. Survivable — start() again. */
  async stop() {
    this.#stopped = true;
    this.#stopHeartbeat();
    this.#stopExpiry();
    this.#unwatchAll();

    try {
      if (this.#sdk && this.#uid) {
        const { ref, set } = this.#sdk;
        await set(ref(this.#db, `users/${this.#uid}/presence`), {
          state: PRESENCE.OFFLINE,
          at: Date.now(),
        });
      }
    } catch (error) {
      warn('Could not clear presence', error);
    }

    this.#ready = false;
    this.#started = null;
  }

  // -----------------------------------------------------------------------
  // Listening
  // -----------------------------------------------------------------------

  /**
   * The three lists this account owns.
   *
   * Only `friends` fans out into more listeners: a request shows the name it
   * was sent with, so an incoming request needs no lookup, which matters
   * because a stranger's request must not make this device subscribe to a
   * stranger's row.
   */
  #watchLists() {
    const { ref, onValue } = this.#sdk;

    const list = (path, into, after) => {
      const stop = onValue(
        ref(this.#db, `users/${this.#uid}/${path}`),
        (snapshot) => {
          const value = snapshot.val();
          into.clear();
          if (value && typeof value === 'object') {
            Object.entries(value).forEach(([uid, entry]) => into.set(uid, entry ?? {}));
          }
          after?.();
          this.#publish();
        },
        (error) => warn(`Could not read ${path}`, error),
      );
      this.#detachers.push(stop);
    };

    list('friends', this.#friends, () => this.#syncFriendWatchers());
    list('requests', this.#requests);
    list('sent', this.#sent);
    list('invites', this.#invites);
  }

  /**
   * One profile listener and one presence listener per friend, added and
   * removed as the list changes.
   *
   * Rebuilt from the list rather than patched on add/remove, so a friend who
   * leaves cannot leave a listener behind reporting a presence for somebody
   * who is no longer on screen.
   */
  #syncFriendWatchers() {
    const { ref, onValue } = this.#sdk;

    this.#watching.forEach((stop, uid) => {
      if (this.#friends.has(uid)) return;
      stop();
      this.#watching.delete(uid);
      this.#profiles.delete(uid);
      this.#presence.delete(uid);
    });

    this.#friends.forEach((_, uid) => {
      if (this.#watching.has(uid)) return;

      const stopProfile = onValue(ref(this.#db, `users/${uid}/profile`), (snapshot) => {
        const value = snapshot.val() ?? {};
        this.#profiles.set(uid, {
          name: safeName(value.name),
          // Checked here, not downstream: this is a stranger's string on its
          // way to becoming an img src on this device.
          avatar: isAvatar(value.avatar) ? value.avatar : null,
          code: typeof value.code === 'string' ? normalizeFriendCode(value.code) : null,
        });
        this.#publish();
      }, (error) => warn('Could not read a friend profile', error));

      const stopPresence = onValue(ref(this.#db, `users/${uid}/presence`), (snapshot) => {
        this.#presence.set(uid, readPresence(snapshot.val()));
        this.#publish();
      }, (error) => warn('Could not read a friend presence', error));

      this.#watching.set(uid, () => {
        stopProfile();
        stopPresence();
      });
    });
  }

  #unwatchAll() {
    this.#watching.forEach((stop) => {
      try {
        stop();
      } catch (error) {
        warn('detach failed', error);
      }
    });
    this.#watching.clear();

    this.#detachers.forEach((stop) => {
      try {
        stop();
      } catch (error) {
        warn('detach failed', error);
      }
    });
    this.#detachers = [];
  }

  // -----------------------------------------------------------------------
  // What the panel renders
  // -----------------------------------------------------------------------

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  #publish() {
    const state = this.getState();
    this.#scheduleExpiry(state);
    this.#listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        warn('Social listener threw', error);
      }
    });
  }

  /**
   * Wake up when the oldest invite runs out, and repaint.
   *
   * Invites are the only thing in this panel that goes stale while nothing
   * is written. Presence is re-stamped every heartbeat, so a change always
   * arrives to redraw it; nothing at all touches an invite between sending
   * it and it being too old to use. Without this the row would sit there
   * looking live, and Join would reach a room that had already gone.
   *
   * This cannot loop: only deadlines in the future are scheduled, and each
   * firing either removes the entry that caused it or finds it already
   * gone.
   */
  #scheduleExpiry(state) {
    this.#stopExpiry();
    const now = Date.now();
    const deadlines = [
      ...state.invites.map((invite) => invite.at + INVITE_TTL_MS),
      ...[...this.#invited.values()].map((entry) => entry.at + INVITE_TTL_MS),
    ].filter((deadline) => deadline > now);
    if (!deadlines.length) return;

    this.#expiry = window.setTimeout(() => {
      this.#expiry = null;
      this.#sweepInvited();
      this.#publish();
    }, Math.min(...deadlines) - now + 50);
  }

  #stopExpiry() {
    if (this.#expiry === null) return;
    window.clearTimeout(this.#expiry);
    this.#expiry = null;
  }

  /**
   * Take back the invites this device sent that have run out of time.
   *
   * Deleted rather than merely forgotten: the row is sitting in somebody
   * else's inbox where they cannot see it — their client hides anything
   * this old — so forgetting it here would leave it there for good.
   */
  #sweepInvited() {
    const now = Date.now();
    const dead = [...this.#invited.entries()]
      .filter(([, entry]) => now - entry.at >= INVITE_TTL_MS)
      .map(([uid]) => uid);
    if (!dead.length) return;
    dead.forEach((uid) => this.#invited.delete(uid));
    this.#deleteInvites(dead);
  }

  /** One write for however many invites are being taken back. */
  #deleteInvites(targets) {
    if (!this.#ready || !targets.length) return Promise.resolve({ ok: true });
    const { ref, update } = this.#sdk;
    return update(ref(this.#db), Object.fromEntries(
      targets.map((uid) => [`users/${uid}/invites/${this.#uid}`, null]),
    )).then(() => ({ ok: true })).catch((error) => {
      warn('Could not withdraw an invite', error);
      return { ok: false, error: explainFirebaseError(error) };
    });
  }

  isReady() {
    return this.#ready;
  }

  getUid() {
    return this.#uid;
  }

  /**
   * Everything the friends panel draws, already sorted and already safe.
   *
   * Friends come back in the order you would look for them: whoever is about
   * first, then alphabetically, so the useful half of a long list is at the
   * top without anybody having to scroll for it.
   */
  getState() {
    const friends = [...this.#friends.keys()].map((uid) => {
      const profile = this.#profiles.get(uid) ?? {};
      // Whether this friend's presence has actually been delivered yet, as
      // opposed to what it says. See `known` below.
      const heard = this.#presence.has(uid);
      const stored = this.#presence.get(uid) ?? { state: PRESENCE.OFFLINE, at: 0 };
      // Re-read rather than used as stored, because a record goes stale
      // while nothing about it changes — nobody writes "still offline" — and
      // the freshness has to reach the line that is drawn, not just a flag
      // beside it. Reading it once here is what keeps the two agreeing.
      const presence = readPresence(stored);
      return {
        uid,
        name: profile.name ?? 'Player',
        avatar: profile.avatar ?? null,
        code: profile.code ?? null,
        state: presence.state,
        since: presence.at,
        online: presence.state !== PRESENCE.OFFLINE,
        // False until their presence row has been read once. The list
        // arrives before any of it, so without this a friend is announced
        // as offline before anyone has looked — which is a claim, not a
        // default, and it is wrong most often at the worst moment: right
        // after you add somebody, who is by definition at their screen.
        known: heard,
      };
    });

    const rank = { [PRESENCE.PLAYING]: 0, [PRESENCE.ONLINE]: 1, [PRESENCE.OFFLINE]: 2 };
    friends.sort((a, b) => (rank[a.state] - rank[b.state])
      || a.name.localeCompare(b.name));

    // Newest first, then capped: if somebody is flooding an inbox, the cap
    // is what keeps the panel usable, and the newest are the ones worth
    // showing. Nothing here can stop them arriving — see MAX_REQUESTS.
    const requests = [...this.#requests.entries()]
      .map(([uid, entry]) => ({
        uid,
        name: safeName(entry?.name),
        at: typeof entry?.at === 'number' ? entry.at : 0,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_REQUESTS);

    const sent = [...this.#sent.keys()];

    // An invite is the one thing here with a clock on it. Everything that
    // cannot be acted on is dropped rather than drawn: a room code from
    // somebody who is no longer a friend, a code that is not a code, and
    // an invite old enough that the room it names has almost certainly
    // gone. See INVITE_TTL_MS.
    const now = Date.now();
    const invites = [...this.#invites.entries()]
      .map(([uid, entry]) => ({
        uid,
        name: safeName(entry?.name),
        room: typeof entry?.room === 'string' ? entry.room.toUpperCase() : '',
        at: typeof entry?.at === 'number' ? entry.at : 0,
      }))
      .filter((invite) => isRoomCode(invite.room)
        && this.#friends.has(invite.uid)
        && now - invite.at < INVITE_TTL_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_REQUESTS);

    const invited = [...this.#invited.entries()]
      .filter(([, entry]) => now - entry.at < INVITE_TTL_MS)
      .map(([uid]) => uid);

    return {
      ready: this.#ready,
      error: this.#error,
      uid: this.#uid,
      code: this.#code,
      name: this.#name,
      avatar: this.#avatar,
      activity: this.#activity,
      friends,
      requests,
      sent,
      invites,
      invited,
    };
  }

  // -----------------------------------------------------------------------
  // Changing things
  // -----------------------------------------------------------------------

  /**
   * Rename this device.
   *
   * Saved locally first and published second, so the name survives even when
   * the write does not — the panel is not going to tell somebody their name
   * changed and then forget it on the next reload.
   */
  async setName(raw) {
    const name = safeName(raw, '');
    if (!name) return { ok: false, error: 'Pick a name first' };

    this.#name = name;
    storage.saveProfile({ name });
    this.#publish();

    if (!this.#ready) return { ok: true, name };
    try {
      await this.#publishProfile();
      return { ok: true, name };
    } catch (error) {
      return { ok: false, error: error.message ?? 'Could not save that name' };
    }
  }

  /** Follow the picture chosen on the New Game form onto the profile row. */
  async setAvatar(avatar) {
    this.#avatar = isAvatar(avatar) ? avatar : null;
    this.#publish();
    if (!this.#ready) return { ok: true };
    try {
      await this.#publishProfile();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message ?? 'Could not save that picture' };
    }
  }

  /**
   * Ask to be somebody's friend, by code.
   *
   * Everything that can be answered without writing anything is answered
   * first, because each of these has a different thing to say and "request
   * sent" would be wrong for all of them.
   */
  async addFriend(rawCode) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };

    const code = normalizeFriendCode(rawCode);
    if (code.length !== FRIEND_CODE_LENGTH) {
      return { ok: false, error: `A friend code is ${FRIEND_CODE_LENGTH} characters` };
    }
    if (code === this.#code) return { ok: false, error: 'That is your own code' };
    if (this.#friends.size >= MAX_FRIENDS) {
      return { ok: false, error: `You can have ${MAX_FRIENDS} friends` };
    }
    if (this.#sent.size >= MAX_REQUESTS) {
      return { ok: false, error: 'You have too many requests waiting for an answer' };
    }

    const { ref, get, update, serverTimestamp } = this.#sdk;

    let target = null;
    try {
      const snapshot = await get(ref(this.#db, `handles/${code}`));
      target = snapshot.val();
    } catch (error) {
      return { ok: false, error: isPermissionDenied(error) ? RULES_OUT_OF_DATE : explainFirebaseError(error) };
    }

    if (typeof target !== 'string' || !target) {
      return { ok: false, error: 'No player has that code' };
    }
    if (target === this.#uid) return { ok: false, error: 'That is your own code' };
    if (this.#friends.has(target)) return { ok: false, error: 'Already on your list' };
    if (this.#sent.has(target)) return { ok: false, error: 'You have already asked' };

    // They asked us first — accept instead of sending a mirror request that
    // would leave two people each waiting for the other.
    if (this.#requests.has(target)) return this.acceptRequest(target);

    try {
      await update(ref(this.#db), {
        [`users/${target}/requests/${this.#uid}`]: {
          name: safeName(this.#name, 'Player'),
          code: this.#code,
          at: serverTimestamp(),
        },
        [`users/${this.#uid}/sent/${target}`]: { at: serverTimestamp() },
      });

      // Recorded here rather than waited for. The write has landed, so the
      // answer to "have I already asked?" is yes from this moment — and
      // that question is asked again the instant somebody taps Add twice.
      // The listener overwrites this with the server's own stamp shortly.
      this.#sent.set(target, { at: Date.now() });
      this.#publish();

      return { ok: true, uid: target };
    } catch (error) {
      warn('Friend request failed', error);
      return { ok: false, error: isPermissionDenied(error) ? RULES_OUT_OF_DATE : explainFirebaseError(error) };
    }
  }

  /**
   * Accept a request, which is the one operation that writes to somebody
   * else's list.
   *
   * Both sides are written in one update so the friendship cannot end up
   * half-made: a list where they have you and you do not have them is worse
   * than no friendship at all, because neither person can see why. The rules
   * allow the far side only because a request from them is sitting right
   * there — see `friends` in firebase/database.rules.json.
   */
  async acceptRequest(uid) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };
    if (!this.#requests.has(uid)) return { ok: false, error: 'That request is gone' };
    if (this.#friends.size >= MAX_FRIENDS) {
      return { ok: false, error: `You can have ${MAX_FRIENDS} friends` };
    }

    const { ref, update, serverTimestamp } = this.#sdk;
    const name = this.#requests.get(uid)?.name ?? 'Player';

    try {
      await update(ref(this.#db), {
        [`users/${this.#uid}/friends/${uid}`]: { at: serverTimestamp() },
        [`users/${uid}/friends/${this.#uid}`]: { at: serverTimestamp() },
        [`users/${this.#uid}/requests/${uid}`]: null,
        [`users/${uid}/sent/${this.#uid}`]: null,
      });
      return { ok: true, uid, name };
    } catch (error) {
      warn('Could not accept a request', error);
      return { ok: false, error: isPermissionDenied(error) ? RULES_OUT_OF_DATE : explainFirebaseError(error) };
    }
  }

  /** Turn a request down. The sender's copy goes too, so they can ask again. */
  async declineRequest(uid) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };
    const { ref, update } = this.#sdk;
    try {
      await update(ref(this.#db), {
        [`users/${this.#uid}/requests/${uid}`]: null,
        [`users/${uid}/sent/${this.#uid}`]: null,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: explainFirebaseError(error) };
    }
  }

  /** Take back a request nobody has answered. */
  async cancelRequest(uid) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };
    const { ref, update } = this.#sdk;
    try {
      await update(ref(this.#db), {
        [`users/${uid}/requests/${this.#uid}`]: null,
        [`users/${this.#uid}/sent/${uid}`]: null,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: explainFirebaseError(error) };
    }
  }

  /**
   * Put a room in front of a friend.
   *
   * The room has to exist first — this writes a code, not a game — so the
   * caller creates or reuses one and hands it over. Only friends may be
   * invited, which the rules enforce as well as this does: an invite is an
   * offer to join a room somebody else controls, and that is not something
   * a stranger holding your code should be able to put on your screen.
   *
   * One invite per friend, replacing whatever was there: inviting the same
   * person into a second room should leave them with the room you are
   * actually sitting in, not a choice of two.
   */
  async invite(uid, room) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };
    if (!this.#friends.has(uid)) return { ok: false, error: 'Only friends can be invited' };
    if (!isRoomCode(room)) return { ok: false, error: 'No room to invite anyone into' };

    const { ref, set, serverTimestamp } = this.#sdk;
    const friend = this.#profiles.get(uid)?.name ?? 'your friend';

    try {
      await set(ref(this.#db, `users/${uid}/invites/${this.#uid}`), {
        name: safeName(this.#name, 'Player'),
        room,
        // The server's clock rather than this one. Both ends compare this
        // against their own Date.now() to decide whether the invite is
        // still worth anything, and a server stamp leaves one wrong clock
        // in that sum instead of two.
        at: serverTimestamp(),
      });

      // Kept because it cannot be read back: nobody may read another
      // account's inbox, so this map is the only record that the invite
      // exists. Stamped locally, which is all the expiry here needs.
      this.#invited.set(uid, { room, at: Date.now() });
      this.#publish();
      return { ok: true, uid, room, name: friend };
    } catch (error) {
      warn('Could not send an invite', error);
      return {
        ok: false,
        error: isPermissionDenied(error) ? INVITES_OUT_OF_DATE : explainFirebaseError(error),
      };
    }
  }

  /**
   * Take an invite off this list — joined, or not wanted.
   *
   * Dropped locally before the write goes out, because the row has been
   * answered and a list that waits for the network to agree looks stuck.
   */
  async dismissInvite(uid) {
    const had = this.#invites.delete(uid);
    if (had) this.#publish();
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };

    const { ref, set } = this.#sdk;
    try {
      await set(ref(this.#db, `users/${this.#uid}/invites/${uid}`), null);
      return { ok: true };
    } catch (error) {
      warn('Could not clear an invite', error);
      return { ok: false, error: explainFirebaseError(error) };
    }
  }

  /** Withdraw every invite this device has sent. The room has gone. */
  async withdrawInvites() {
    const targets = [...this.#invited.keys()];
    if (!targets.length) return { ok: true };
    this.#invited.clear();
    this.#publish();
    return this.#deleteInvites(targets);
  }

  /** Remove a friend, from both lists. Their copy goes too — see acceptRequest. */
  async removeFriend(uid) {
    if (!this.#ready) return { ok: false, error: 'Not connected yet' };
    const { ref, update } = this.#sdk;
    try {
      await update(ref(this.#db), {
        [`users/${this.#uid}/friends/${uid}`]: null,
        [`users/${uid}/friends/${this.#uid}`]: null,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: explainFirebaseError(error) };
    }
  }
}

export default SocialHub;
