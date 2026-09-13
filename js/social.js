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
  MAX_FRIENDS,
  MAX_REQUESTS,
  log,
  warn,
} from './config.js';
import { isAvatar, toOnlineAvatar } from './avatar.js';
import { ROOM_CODE_ALPHABET } from './firebase-config.js';
import { firebaseReady, explainFirebaseError, isPermissionDenied } from './firebase-client.js';
import * as storage from './storage.js';

/** What a name is allowed to be, before it is anybody else's problem. */
const NAME_MAX = 20;

/** Said whenever the rules are the thing standing in the way. */
const RULES_OUT_OF_DATE = 'Friends need the database rules deployed — see firebase/database.rules.json';

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

  /** What we know about other people, filled in by per-friend listeners. */
  #profiles = new Map();  // uid -> { name, avatar, code }
  #presence = new Map();  // uid -> { state, at }
  #watching = new Map();  // uid -> stop()

  #listeners = new Set();
  #detachers = [];
  #heartbeat = null;
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
    this.#activity = next;
    if (this.#ready) this.#touchPresence();
  }

  /** Drop every listener and mark this device away. Survivable — start() again. */
  async stop() {
    this.#stopped = true;
    this.#stopHeartbeat();
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
    this.#listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        warn('Social listener threw', error);
      }
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
