/**
 * firebase-client.js
 * One Firebase app, one sign-in, shared by everything that needs the network.
 *
 * Named for the client rather than the app because the SDK's own entry point
 * is called firebase-app.js, and two files with the same basename in one
 * project is a trap: anything matching by filename — a service worker rule, a
 * bundler alias, a test that stubs the CDN — hits whichever it sees first.
 * That is not hypothetical; it is what happened here.
 *
 * This exists because the app grew a second thing that talks to Firebase.
 * FirebaseSession is about a room and dies with it; SocialHub is about the
 * person and outlives every room, and both are on screen at once the moment
 * somebody opens the friends panel while a game is running. Two modules each
 * calling initializeApp() would be two apps — Firebase refuses the second by
 * name, and if it did not, they would hold two sockets and two anonymous
 * sign-ins with two different uids, which is the same account being two
 * people.
 *
 * So the bootstrap moved here and became a memoised promise. Whoever asks
 * first pays for the CDN fetch and the sign-in; everybody after that gets the
 * same handle, including callers that arrive while the first is still in
 * flight. Nothing here knows what a room or a friend is.
 *
 * The SDK is still imported lazily. A player who only ever plays the bot must
 * never fetch a line of Firebase, and that is true as long as nothing imports
 * THIS module at the top level of a module that local play loads.
 */

import {
  FIREBASE_MODULES,
  EMULATOR,
  resolveFirebaseConfig,
  isEmulatorMode,
  emulatorHost,
  emulatorAuthUrl,
  isFirebaseConfigured,
  firebaseConfigError,
} from './firebase-config.js';
import { log, warn } from './config.js';

/**
 * Did the rules refuse this write?
 *
 * The SDK reports it as "PERMISSION_DENIED" in some paths and "Permission
 * denied" in others, so both spellings are matched. Worth its own function
 * because it is asked twice: once to explain the failure, and once to decide
 * whether a seat is worth retrying without its picture.
 */
export function isPermissionDenied(error) {
  const message = String(error?.message ?? error ?? '');
  return /permission[\s_]denied/i.test(message) || error?.code === 'PERMISSION_DENIED';
}

/**
 * Turn Firebase's error codes into something a person can act on.
 *
 * A freshly created project fails in the same handful of ways, and the raw
 * SDK messages ("PERMISSION_DENIED", "auth/operation-not-allowed") do not say
 * which setup step was missed. Each of these maps to one concrete fix.
 */
export function explainFirebaseError(error) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? error ?? '');

  if (code === 'auth/operation-not-allowed' || /operation-not-allowed/i.test(message)) {
    return 'Anonymous sign-in is not enabled. Firebase console → Build → Authentication → Sign-in method → Anonymous → Enable.';
  }
  if (code === 'auth/api-key-not-valid' || /api-key-not-valid|invalid.*api key/i.test(message)) {
    return 'That apiKey is not valid. Re-copy it from Project settings → Your apps → Web app.';
  }
  if (code === 'auth/configuration-not-found') {
    return 'Authentication is not set up for this project yet. Enable Anonymous sign-in in the Firebase console.';
  }
  if (isPermissionDenied(error)) {
    // Names the console first. The CLI line was the only instruction here
    // before, which is no help at all to the many people who have a Firebase
    // project but have never installed firebase-tools — and installing it,
    // then logging in, is a far longer road than pasting one file into a page
    // you are already signed in to.
    return 'The database rejected that. Your security rules are out of date — '
      + 'paste firebase/database.rules.json into Realtime Database → Rules in '
      + 'the Firebase console and publish (or run: npx firebase-tools deploy --only database)';
  }
  if (/Cannot parse Firebase url|FIREBASE FATAL ERROR|Can't determine Firebase Database URL/i.test(message)) {
    return 'databaseURL is missing or malformed. Copy it exactly from Realtime Database in the console — regional databases do not end in firebaseio.com.';
  }
  if (/network|offline|Failed to fetch/i.test(message)) {
    return 'Could not reach Firebase. Check the network connection.';
  }
  return message || 'Unknown Firebase error';
}

/** The one live handle, or null before the first successful connect. */
let handle = null;
let pending = null;

/**
 * Load the SDK, start the app, and sign in anonymously. Memoised.
 *
 * A failure clears the memo, so a player who was offline when they first
 * tried gets a real second attempt rather than the first failure replayed
 * forever. A success never clears it: the handle is the app.
 */
export function firebaseReady() {
  if (handle) return Promise.resolve(handle);
  if (!pending) {
    pending = connect().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

async function connect() {
  if (!isFirebaseConfigured()) throw new Error(firebaseConfigError());

  const [appMod, authMod, dbMod] = await Promise.all([
    import(/* @vite-ignore */ FIREBASE_MODULES.app),
    import(/* @vite-ignore */ FIREBASE_MODULES.auth),
    import(/* @vite-ignore */ FIREBASE_MODULES.database),
  ]);

  const sdk = { ...appMod, ...authMod, ...dbMod };
  const app = sdk.initializeApp(resolveFirebaseConfig());
  const auth = sdk.getAuth(app);
  const db = sdk.getDatabase(app);

  if (isEmulatorMode()) {
    // Host is resolved from the page's own address so that a phone on the LAN
    // reaches the computer running the emulator, not itself.
    const host = emulatorHost();
    sdk.connectDatabaseEmulator(db, host, EMULATOR.databasePort);
    sdk.connectAuthEmulator(auth, emulatorAuthUrl(), { disableWarnings: true });
    log('Firebase emulator mode via', host);
  }

  let uid = null;
  try {
    const credential = await sdk.signInAnonymously(auth);
    uid = credential.user.uid;
  } catch (error) {
    // Surface the setup step that was missed, not the raw SDK code.
    warn('Anonymous sign-in failed', error);
    throw new Error(explainFirebaseError(error));
  }

  handle = { sdk, app, auth, db, uid };
  log('Firebase ready, uid', uid);
  return handle;
}

export default firebaseReady;
