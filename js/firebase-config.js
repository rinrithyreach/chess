/**
 * firebase-config.js
 * Firebase project configuration for Phase 2 online multiplayer.
 *
 * ---------------------------------------------------------------------------
 * FILL THIS IN WITH YOUR OWN PROJECT'S VALUES
 * ---------------------------------------------------------------------------
 * 1. Create a project at https://console.firebase.google.com
 * 2. Build > Realtime Database > Create Database
 * 3. Build > Authentication > Sign-in method > enable "Anonymous"
 * 4. Project settings > Your apps > Web app > copy the config object here
 * 5. Deploy the security rules in firebase/database.rules.json
 *
 * See the "Phase 2 setup" section of README.md for the full walkthrough.
 *
 * ---------------------------------------------------------------------------
 * IS THIS SECRET?  No.
 * ---------------------------------------------------------------------------
 * A Firebase *web* config is public by design — it ships inside every Firebase
 * web app and identifies the project, it does not authorise access. Anyone can
 * read it from your JavaScript bundle, and that is expected.
 *
 * What actually protects your data is:
 *   - the Realtime Database security rules (firebase/database.rules.json)
 *   - Firebase Authentication
 *   - API key restrictions in the Google Cloud console
 *
 * So do not rely on hiding this file. Do rely on deploying the rules.
 * Never put a service-account key or admin credential in client-side code —
 * those ARE secrets and must never reach the browser.
 */

/**
 * Paste your web app's config object here.
 * Leaving these blank is fine — online play simply stays disabled and the app
 * runs exactly as it did in Phase 1.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDSg-jE5FOw7mg5VIzNljxTcPu_dZBEQoQ',
  authDomain: 'chess-d17bc.firebaseapp.com',

  // Regional database (asia-southeast1). Note this is NOT a firebaseio.com
  // address — only the default US region uses that form. Copy it verbatim.
  databaseURL: 'https://chess-d17bc-default-rtdb.asia-southeast1.firebasedatabase.app',

  projectId: 'chess-d17bc',
  storageBucket: 'chess-d17bc.firebasestorage.app',
  messagingSenderId: '1096851712274',
  appId: '1:1096851712274:web:5e58de9b401982dd7aabcb',

  // measurementId is deliberately omitted: it is only used by Google
  // Analytics, which this app does not load.
};

/**
 * Firebase JS SDK version loaded from Google's CDN.
 * Pinned deliberately: an unpinned SDK can change behaviour without warning.
 */
export const FIREBASE_SDK_VERSION = '12.18.0';

const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

export const FIREBASE_MODULES = {
  app: `${CDN}/firebase-app.js`,
  auth: `${CDN}/firebase-auth.js`,
  database: `${CDN}/firebase-database.js`,
};

/**
 * Point the app at a local Firebase emulator instead of a real project.
 *
 * This is the quickest way to play phone-to-phone without creating a Firebase
 * project at all: run the emulator on your computer, put both phones on the
 * same Wi-Fi, and set `enabled: true`. Data lives only for as long as the
 * emulator runs, and both devices must be on your network.
 *
 * `databaseHost` is null on purpose. Leaving it null makes the app connect to
 * whatever host the page was loaded from — so opening
 * http://192.168.1.50:8000 on a phone talks to the emulator on
 * 192.168.1.50, not to the phone itself. Hardcoding 127.0.0.1 here would mean
 * "this phone" and could never work. Set it only to force a specific address.
 */
export const EMULATOR = {
  enabled: false,
  databaseHost: null, // null = use the host this page came from
  databasePort: 9000,
  authPort: 9099,
  authUrl: null, // null = derived from the host and authPort
  // Any "demo-" id works: Firebase reserves that prefix for emulator-only use,
  // so it can never reach a real project.
  projectId: 'demo-chess-arena',
};

/**
 * Emulator mode can also be turned on for a single visit by adding
 * `?emulator=1` to the URL. That is how you try phone-to-phone play without
 * creating a Firebase project or editing any file — and because it is not
 * baked into the source, a deployed copy can never accidentally ship pointing
 * at a machine on your LAN.
 */
function emulatorRequestedByUrl() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('emulator') === '1';
  } catch {
    return false;
  }
}

export function isEmulatorMode() {
  return EMULATOR.enabled || emulatorRequestedByUrl();
}

/** Which host the emulator is reachable at, from this device's point of view. */
export function emulatorHost() {
  if (EMULATOR.databaseHost) return EMULATOR.databaseHost;
  const fromPage = globalThis.location?.hostname;
  return fromPage && fromPage !== '' ? fromPage : '127.0.0.1';
}

/** Full URL of the Auth emulator. */
export function emulatorAuthUrl() {
  return EMULATOR.authUrl ?? `http://${emulatorHost()}:${EMULATOR.authPort ?? 9099}`;
}

/**
 * The config actually handed to initializeApp().
 * In emulator mode the real values are unnecessary — the SDK only needs
 * well-formed placeholders, because every call is redirected to localhost.
 */
export function resolveFirebaseConfig() {
  if (!isEmulatorMode()) return FIREBASE_CONFIG;
  const projectId = FIREBASE_CONFIG.projectId || EMULATOR.projectId;
  return {
    ...FIREBASE_CONFIG,
    apiKey: FIREBASE_CONFIG.apiKey || 'emulator-api-key',
    projectId,
    authDomain: FIREBASE_CONFIG.authDomain || `${projectId}.firebaseapp.com`,
    databaseURL:
      FIREBASE_CONFIG.databaseURL || `https://${projectId}-default-rtdb.firebaseio.com`,
    appId: FIREBASE_CONFIG.appId || 'emulator-app',
  };
}

/** Room codes avoid characters that are easy to misread aloud or by eye. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

/**
 * Is online play available?
 * The emulator needs only a databaseURL/projectId; a real project needs an
 * apiKey too. Anything missing means the Online option stays disabled rather
 * than failing at connect time with a confusing error.
 */
export function isFirebaseConfigured() {
  // Emulator mode supplies its own placeholders, so no real project is needed.
  if (isEmulatorMode()) return true;
  return Boolean(
    FIREBASE_CONFIG.apiKey &&
      FIREBASE_CONFIG.databaseURL &&
      FIREBASE_CONFIG.projectId,
  );
}

/** Human-readable reason online play is unavailable, or null when it is fine. */
export function firebaseConfigError() {
  if (isFirebaseConfigured()) return null;
  const missing = ['apiKey', 'databaseURL', 'projectId'].filter(
    (key) => !FIREBASE_CONFIG[key],
  );
  return `Firebase is not configured (missing: ${missing.join(', ')})`;
}
