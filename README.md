# ♛ Chess Arena

A polished, mobile-first chess game that runs entirely in the browser — no
backend, no build step, no framework.

> **CURRENT VERSION — Local Two-Player + Online Multiplayer**
>
> **Phase 1 — Local.** Two players share one device. Full standard chess
> rules, save/resume, move history, undo, resign, draw offers and rematches.
>
> **Phase 2 — Online.** Two players, two devices, synchronised through
> Firebase Realtime Database: room codes, anonymous auth, live move sync,
> presence, reconnect, network draw offers and mutual rematches.
>
> Online play is **off until you add your own Firebase project** — the app
> ships with empty config placeholders and no credentials. Until then it runs
> exactly as it did in Phase 1, and never contacts the network.

---

## Table of contents

- [Technology stack](#technology-stack)
- [Features](#features)
- [Folder structure](#folder-structure)
- [Running locally](#running-locally)
- [Phase 2 setup: your Firebase project](#phase-2-setup-your-firebase-project)
- [Architecture](#architecture)
- [How online play works](#how-online-play-works)
- [Trust model](#trust-model)
- [How chess.js is used](#how-chessjs-is-used)
- [How saving works](#how-saving-works)
- [Testing](#testing)
- [Debug mode](#debug-mode)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)

---

## Technology stack

| Layer | Choice |
| --- | --- |
| Markup | HTML5 |
| Styling | CSS3 (custom properties, grid, `aspect-ratio`, container queries) |
| Logic | Vanilla JavaScript, ES2022 modules |
| Chess rules | [chess.js](https://github.com/jhlywa/chess.js) **1.4.0** (vendored) |
| Online sync | Firebase Realtime Database + Anonymous Auth (**12.18.0**, lazy-loaded from CDN) |
| Persistence | `localStorage` |
| Audio | Web Audio API (synthesised) |
| Build tooling | **None** |

No React, Vue, Angular, jQuery, PHP, Laravel, bundler or Node server. The app
is plain static files. The Firebase SDK is imported dynamically **only** when a
player actually starts an online game, so local play never touches the network.

---

## Features

**Chess rules** — all standard movement, captures, castling (both sides), en
passant, pawn promotion with a piece picker, check, checkmate, stalemate,
insufficient material, threefold repetition, the fifty-move rule, and strict
turn/legality validation. Illegal moves never touch game state.

**Playing** — tap-to-move on every device, plus optional drag-and-drop on
mouse/pen. Selected square, legal-move dots, capture rings, last-move
highlight and a pulsing check indicator.

**Online multiplayer** — create a room, share a six-character code, and play
across two devices. Live move sync, per-device board orientation, opponent
presence, automatic reconnect, draw offers sent over the network, resignation,
and rematches that require both players to agree (and swap colours).

**Game management** — undo (local), restart (local), resign, offer draw,
rematch, board flip, and copy PGN.

**Persistence** — autosave after every meaningful action, and a *Continue
Game* entry point. Local games restore position, history, players, orientation
and undo depth; online games rejoin their room and resync from it.

**Two visual skins** — **Classic** (dark, flat, focused) is the playable look.
**Arcade 3D** (bright casual-game look with the board tilted into perspective,
glossy moulded pieces, garden scenery and chunky cards) is fully built but
shown **locked** under Settings → Look & Feel, with a padlock. To unlock it,
drop `locked: true` from its entry in `UI_STYLES` (`js/config.js`) — nothing
else needs changing. With `DEBUG` on, `?ui=arcade` previews it without
unlocking.

**Interface** — start screen, new-game setup, waiting room with the shareable
code, responsive game screen, settings (look & feel, sound, board theme,
coordinates, animations, auto-flip), custom confirmation modals, toasts, and a
collapsible move history.

**Accessibility** — real `<button>` elements, ARIA labels on every square,
arrow-key board navigation with a roving tabindex, visible focus rings, and
`prefers-reduced-motion` support.

---

## Folder structure

```
chess-game/
├── index.html                    All screens and modals
├── README.md
├── firebase.json                 Rules wiring, hosting, emulator ports
├── .firebaserc                   Emulator project alias (demo-chess-arena)
├── css/
│   ├── style.css                 Design tokens, shell, controls, modals, online UI
│   ├── board.css                 Board, squares, pieces, highlights, themes
│   ├── responsive.css            Mobile → tablet → desktop layouts
│   └── arcade.css                "Arcade 3D" skin (inert unless selected)
├── js/
│   ├── config.js                 Constants, DEBUG flag, logger
│   ├── app.js                    Composition root (entry point)
│   ├── firebase-config.js        YOUR Firebase project config (empty by default)
│   ├── chess-engine.js           Defensive wrapper around chess.js
│   ├── game-controller.js        Orchestration, selection, autosave
│   ├── board.js                  Board rendering and interaction
│   ├── ui.js                     Screens, modals, panels, toasts
│   ├── storage.js                Versioned, validated localStorage
│   ├── sound.js                  Web Audio effects
│   ├── sessions/
│   │   ├── local-session.js      Phase 1 provider — same device
│   │   └── firebase-session.js   Phase 2 provider — two devices
│   └── vendor/
│       └── chess.js              chess.js 1.4.0 ESM build (vendored)
├── firebase/
│   ├── database.rules.json       Security rules (deploy these!)
│   └── README.md                 What the rules do and do not enforce
└── assets/
    ├── pieces/{white,black}/     Optional SVG piece drop-in
    └── sounds/                   Optional .mp3 drop-in
```

---

## Running locally

The app needs a static HTTP server, because ES modules do not load over
`file://`. Any of these work:

```bash
# Python 3
python -m http.server 8000

# Node
npx serve .

# PHP
php -S localhost:8000
```

Then open <http://localhost:8000>. In VS Code, the **Live Server** extension
("Go Live") works too.

There is nothing to install and nothing to build — `chess.js` is vendored at
`js/vendor/chess.js`, so the project also works completely offline.

> **Why vendored instead of a CDN?** A local copy removes CDN outages, version
> drift and offline failure as ways for the game to break, while keeping the
> zero-build requirement. To switch to a CDN, change the import in
> `js/chess-engine.js` to
> `https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js`.

---

## Phase 2 setup: your Firebase project

Online play needs a Firebase project. Until you add one, the **Online
Multiplayer** option stays disabled and everything else works normally.

### 1. Create the project

1. Go to <https://console.firebase.google.com> and create a project.
2. **Build → Realtime Database → Create Database.** Start in *locked mode*;
   the rules in this repo will replace the defaults.
3. **Build → Authentication → Sign-in method → Anonymous → Enable.**

### 2. Add the web config

**Project settings → Your apps → Web app (`</>`)**, register the app, and copy
the config values into `js/firebase-config.js`:

```js
export const FIREBASE_CONFIG = {
  apiKey: 'AIza…',
  authDomain: 'your-project.firebaseapp.com',
  databaseURL: 'https://your-project-default-rtdb.firebaseio.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:abc123',
};
```

> **Is that key a secret?** No. A Firebase *web* config is public by design —
> it ships in every Firebase web app and identifies the project without
> authorising anything. Your data is protected by the security rules, not by
> hiding this file. A **service-account key** is a real secret and must never
> go anywhere near client code.

### 3. Deploy the security rules — do not skip this

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # select your project
firebase deploy --only database
```

The rules in `firebase/database.rules.json` are what stop anyone from writing
to your database. See [`firebase/README.md`](firebase/README.md) for exactly
what they enforce.

### 4. Play

Serve the app, open it on two devices, choose **Online Multiplayer** on both.
One taps **Create Room** and reads out the six-character code; the other types
it in and taps **Join**.

---

## Playing on two phones

There are two ways to get Phone A and Phone B into the same game. Pick by
whether you want to play *right now* or *properly*.

### Option 1 — Same Wi-Fi, no Firebase account (fastest)

Runs the Firebase emulator on your computer. Both phones must be on the same
Wi-Fi, and games last only as long as the emulator is running.

**1. Start the emulator and a web server** (two terminals, from the project
folder):

```bash
firebase emulators:start --only database,auth --project demo-chess-arena
```

```bash
npx http-server -a 0.0.0.0 -p 8000 -c-1
```

`firebase.json` already binds the emulators to `0.0.0.0`, and `-a 0.0.0.0`
does the same for the web server — without those, both only listen to the
computer itself and the phones cannot see them.

**2. Find your computer's Wi-Fi address**

```bash
# Windows
ipconfig | findstr /i "IPv4"
# macOS / Linux
ipconfig getifaddr en0 || hostname -I
```

You want the `192.168.x.x` (or `10.x.x.x`) one for your **Wi-Fi** adapter —
not `127.0.0.1`, and not a VMware/Hyper-V adapter if you have those.

**3. Allow the phones through your firewall.** This is the step that usually
blocks it. On Windows, if your Wi-Fi is set to *Public*, inbound connections
are refused. Set the network to **Private** (Settings → Network & Internet →
Wi-Fi → your network → Private), then allow the ports **for the private
profile only**, in an Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Chess Arena (dev)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8000,9000,9099 -Profile Private
```

Remove it again when you are done:

```powershell
Remove-NetFirewallRule -DisplayName "Chess Arena (dev)"
```

**4. Open this on both phones** — note the `?emulator=1`:

```
http://YOUR-IP:8000/?emulator=1
```

`?emulator=1` switches the app to the emulator for that visit only. Nothing is
saved to the source, so a deployed copy can never accidentally point at your
laptop.

**5. Play.** Phone A: **New Game → Online Multiplayer → Create Room**, and read
out the six-character code. Phone B: **New Game → Online Multiplayer**, type the
code, **Join**. Both boards appear, each showing its own colour at the bottom.

> Both phones must use `?emulator=1`, and the emulator must keep running.
> Stopping it ends every game in progress.

### Option 2 — A real Firebase project (play from anywhere)

No firewall changes, no shared Wi-Fi, and games survive restarts. Follow
[Phase 2 setup](#phase-2-setup-your-firebase-project) above, then deploy the
whole app so the phones just visit a URL:

```bash
firebase deploy          # rules + hosting
```

Hosting is already configured in `firebase.json`. You get a
`https://your-project.web.app` address — open it on both phones, anywhere in
the world, and use the same Create Room / Join flow. Do **not** use
`?emulator=1` here.

### If the phones cannot load the page

| Symptom | Likely cause |
| --- | --- |
| Page never loads | Firewall, or the server is bound to `127.0.0.1` instead of `0.0.0.0` |
| Page loads, Online option greyed out | Missing `?emulator=1`, or no Firebase config |
| Stuck on "Connecting…" | Emulator not reachable — check ports 9000/9099 through the firewall |
| "No room with that code" | The other phone is on a different backend (one has `?emulator=1`, the other does not) |
| Works on one phone only | Phones on different networks, e.g. one on mobile data |
| Opponent joins but the host stays on "Waiting for opponent" | **The two devices are running different builds.** `127.0.0.1` is only ever *that* device, so a phone cannot load it — if one device is on localhost and the other is elsewhere, they are not the same code. Deploy hosting so both use one URL, and hard-refresh. A watchdog re-reads the room every 4s while waiting, so this now self-corrects within a few seconds even so. |

> **Both devices must run the same build.** VS Code Live Preview caches
> JavaScript aggressively, so a device left open across an edit can keep
> running old code indefinitely. `firebase deploy --only hosting` and a single
> shared URL removes the whole class of problem.

---

## Architecture

Data flows one way, and each layer only knows about the one beneath it:

```
        ┌──────────────────────────────┐
        │   board.js   │    ui.js      │   Rendering + input
        └───────┬──────┴───────┬───────┘
                │  intents     │ ▲ snapshots
                ▼              │ │
        ┌──────────────────────────────┐
        │      game-controller.js      │   Selection, promotion flow,
        └──────────────┬───────────────┘   input lock, autosave
                       │
                       ▼
        ┌──────────────────────────────┐
        │      session provider        │   Authoritative game state
        ├───────────────┬──────────────┤
        │ local-session │ firebase-    │   ← the swap point
        │   .js         │  session.js  │
        └───────┬───────┴───────┬──────┘
                │               │
                ▼               ▼
        ┌───────────────┐  ┌──────────────┐
        │ chess-engine  │  │  Firebase    │
        │ (chess.js)    │  │  RTDB + Auth │
        └───────────────┘  └──────────────┘
```

Phase 2 was the test of this design, and it held: adding online play changed
**one line** of wiring in `app.js`, and `board.js`, `ui.js`, `chess-engine.js`
and `storage.js` needed no structural changes at all.

```js
// Local play
await controller.useSession(new LocalSession());
// Online play
await controller.useSession(new FirebaseSession());
```

The controller did need one genuine change, and it was the right one: state
can now arrive from the network as well as from this device, so all reactions
(sound, animation, autosave, the game-over modal) moved into a single
subscription handler that diffs each incoming snapshot. A move you make and a
move your opponent makes now follow exactly the same path.

The rules that keep this maintainable:

- **The board never talks to the engine.** It renders a FEN and reports which
  square was touched. All legality lives below it.
- **The engine never touches the DOM.** It is pure and unit-testable in Node.
- **The DOM is never authoritative.** Game state lives in the session; the DOM
  is a projection of it.
- **The session is the only networking seam.** Phase 2 replaces one line in
  `app.js`.

### Why orientation and settings are *not* session state

Board orientation, sound, theme and animations are per-device display
preferences. In online play each phone orients the board for its own player,
so these belong to the controller, not to the shared game state. Keeping them
out of the session means the session snapshot is exactly what a future
Firebase document would hold.

### Session provider contract

Every provider implements the same shape (see the header comment in
`js/sessions/local-session.js`):

```js
await initialize()
await createGame(config)                    // -> state
await restoreGame(savedRecord)              // -> {ok, state}
await submitMove({ from, to, promotion })   // -> {ok, error?, move?}
await submitAction(action, payload)         // resign|draw|undo|restart|rematch
     subscribeToState(listener)             // -> unsubscribe
     getState()                             // synchronous snapshot
     getControllableColors()                // ['w','b'] locally
     leave() / destroy()
```

Every mutating method is `async` even though local play resolves immediately,
which is precisely why the networked provider dropped in unchanged.

`getControllableColors()` turned out to be the whole of turn ownership online:
it returns both colours locally and only the local player's colour online. The
controller already refused to move a piece whose colour is not in that list, so
"you cannot move your opponent's pieces" needed **no new code** — and
`FirebaseSession` returns `[]` while a room is still waiting for its second
player, which freezes the board for free.

`FirebaseSession` adds a few methods of its own on top of the contract:
`createGame()` returns a room code, plus `joinRoom(code)`, `rejoinRoom(code)`,
`offerDraw()` and `declineDraw()`.

---

## How online play works

### The room document

One Realtime Database node per game, at `rooms/{CODE}`:

```json
{
  "createdAt": 1736300000000,
  "updatedAt": 1736300042000,
  "hostUid": "abc123…",
  "status": "playing",
  "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "pgn": "[Event \"?\"] … 1. e4 e5 *",
  "turn": "w",
  "moves": ["e4", "e5"],
  "lastMove": { "from": "e7", "to": "e5" },
  "result": null,
  "drawOffer": null,
  "rematch": null,
  "players": {
    "w": { "uid": "abc123…", "name": "Alex", "connected": true },
    "b": { "uid": "def456…", "name": "Sam",  "connected": true }
  }
}
```

### Room codes

Six characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `0/O` or `1/I`, so
a code can be read aloud without ambiguity. Generated with
`crypto.getRandomValues` and claimed with a transaction that refuses to
overwrite an existing room, so two devices can never take the same code.

### Playing a move

1. The move is validated locally with chess.js. An illegal tap never reaches
   the network.
2. It is written in a **transaction guarded on the FEN it was based on**. If
   the opponent's move landed first, the guard fails and the transaction
   aborts rather than clobbering it. The local engine rolls back and the
   incoming update re-renders the board.
3. Both devices receive the update through their room subscription and
   **rebuild their engine from the room's PGN**. The room is the single source
   of truth, so clients cannot silently drift apart.

Identity is re-derived from the room the same way: after a rematch swaps seats,
each device reads its own colour back out of `players`, rather than trusting
what it remembered.

### Presence and reconnection

Each device writes `players/{color}/connected = true` and registers an
`onDisconnect` handler that sets it to `false`. That handler lives on Firebase's
servers, so it fires even if the tab is closed or the device loses power — not
just on a clean exit. When a rematch swaps seats, the handler is cancelled and
re-registered on the new seat.

Reconnecting is just rejoining: the room code is saved locally, anonymous auth
persists the same uid across reloads, and **Continue Game** rejoins the room and
resyncs from it. A *different* user cannot take a seat that still belongs to
someone else, so a brief disconnect can't cost you your game.

---

## Trust model

Being straight about this matters more than sounding secure.

**What the security rules enforce.** Only authenticated users can read or
write. Only the two seated players can write to a room. A seat can only be
claimed when empty and only for your own uid. The host never changes. Every
field is type-, pattern- and length-checked, and unknown fields are rejected.
A draw can only be offered in your own name.

**What they cannot enforce.** Database rules cannot run a chess engine, so
they cannot verify that a submitted FEN is a legal continuation. A player
running a modified client could write a legal-looking but illegal position
**for their own turn**.

They still cannot move as their opponent, forge a result, seat themselves
twice, evict anyone, or write fields the schema does not define.

For two friends playing chess this is the ordinary trade-off, and the same one
most client-authoritative multiplayer games make. To close the gap, move move
validation into a Cloud Function that owns the write and have the rules reject
direct client writes to the game fields. That is a Phase 8 concern, and the
session boundary means it would not disturb the UI.

**Rate limiting and cleanup are not implemented.** An authenticated user can
create unlimited rooms, and rooms are never deleted. Before running this
publicly you would want a scheduled cleanup of stale rooms and App Check.

---

## How chess.js is used

chess.js **1.4.0** is the sole authority on legality. No chess rule is
reimplemented anywhere in this project.

`js/chess-engine.js` wraps it for one reason: the chess.js 1.x API throws in
several ordinary situations, and an unhandled throw would break the game.
Behaviours verified against 1.4.0 and handled in the wrapper:

| chess.js behaviour | How the wrapper handles it |
| --- | --- |
| `move()` **throws** on an illegal move | Caught; returns `{ok:false, error}`. Position is provably unchanged. |
| `move()` **throws** if a pawn reaches the back rank without `promotion` | `requiresPromotion()` detects it from the legal-move list *first*, so the picker opens instead. |
| `load()` **throws** on an invalid FEN | `validateFen()` first, then try/catch. |
| `load()` silently **clears move history** | Restores use `loadPgn()` replay instead, preserving undo and repetition history. |
| `loadPgn()` **throws** on unparseable PGN | Caught; returns `{ok:false}`. |
| `isDraw()` is true for *any* draw | `getDrawReason()` probes stalemate → insufficient material → threefold → fifty-move to report the specific reason. |
| `isCapture()` is **false for en passant** (flag `e`, not `c`) | Folded in as `isCapture() \|\| isEnPassant()` so en passant renders a capture ring and plays the capture sound. |
| `header()` is deprecated | Uses `setHeader()` / `getHeaders()`. |
| `Move.flags` is deprecated | Uses `isCapture()`, `isPromotion()`, `isEnPassant()`, `isKingsideCastle()`, `isQueensideCastle()`. |

---

## How saving works

Autosave runs after every move, promotion, undo, restart, resignation, draw,
rematch, board flip and settings change. There is no save button.

Two independent `localStorage` keys are used so a corrupt game never costs you
your preferences:

- `chess-arena:game` — the current game
- `chess-arena:settings` — sound, theme, coordinates, animations, auto-flip

Both records are versioned:

```json
{
  "version": 1,
  "savedAt": 1736300000000,
  "game": {
    "status": "playing",
    "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    "pgn": "[Event \"Chess Arena — Local Game\"] ... 1. e4 e5 *",
    "moves": ["e4", "e5"],
    "lastMove": { "from": "e7", "to": "e5", "...": "..." },
    "players": { "w": { "name": "Alex" }, "b": { "name": "Sam" } },
    "result": null,
    "orientation": "white"
  }
}
```

### PGN is the restore path, FEN is the cross-check

A FEN alone describes the position but carries no history — restoring from one
would silently disable **undo** and break **threefold-repetition** detection.
So the PGN is replayed on load, and the resulting FEN must match the stored
FEN or the record is rejected as corrupt.

### Validation before trust

`storage.js` refuses a saved game unless *all* of these hold: the schema
version matches, the status is a known value, the FEN passes
`validateFen()`, both players exist, the orientation is valid, and the PGN
replays to exactly the stored FEN. Anything else — including unparseable
JSON — is cleared, and the app returns cleanly to the main menu. *Continue
Game* is only offered for a valid, unfinished game.

---

## Testing

### Automated

The app ships with no test dependencies; verification was run from outside the
project across six suites — **478 assertions, all passing, with zero console
errors in every browser and viewport tested**:

| Suite | Assertions | What it covers |
| --- | --- | --- |
| Engine (Node) | 81 | Every rule scenario in the spec, plus error handling |
| App (jsdom) | 129 | Boots the real app, drives it by tap/click, asserts DOM |
| Layout (Chromium) | 145 | 9 viewports: overflow, board geometry, touch targets |
| Interaction (Chromium) | 36 | Real page refresh, drag-and-drop, keyboard, clipboard |
| **Multiplayer (Chromium ×2)** | **71** | **Two devices against the Firebase emulator** |
| Config state | 16 | Online availability, and that the SDK is never fetched for local play |
| Waiting watchdog | 4 | The host's recovery poll runs while waiting and stops when seated |
| Style lock | 15 | Arcade shows a padlock, cannot be selected, and a stored value cannot bypass it |
| **Arcade skin (Chromium)** | **20** | **All 64 tilted squares tappable, 4 viewports, no overflow** |

The multiplayer suite runs two independent browser contexts — two real
anonymous users — against the local Firebase emulator with the production
security rules loaded, and drives everything through the actual UI: create and
join a room, turn ownership, move sync in both directions, network draw offers,
mutual rematch with colour swap, disconnect detection, reconnect-and-resume,
resignation, and rejection of a third player or a bad code.

### Bugs this found

Six real bugs were caught and fixed. Three in Phase 1:

1. **Every modal was an invisible full-screen click trap.** `.modal` sets
   `display: grid`, which silently overrides the `hidden` attribute (only
   `display: none` in the UA stylesheet). The app looked fine but was
   completely unclickable. Fixed with a global `[hidden] { display: none }`.
   Only real hit-testing catches this — jsdom cannot.
2. **The board overflowed on short, wide viewports.** `grid-template-rows:
   repeat(8, 1fr)` carries a min-content floor, so the piece glyphs forced
   squares larger than the board and squashed the bottom ranks to 5px. Fixed
   with `minmax(0, 1fr)`, and by sizing pieces from the board via container
   queries instead of from the viewport.
3. **Drag-and-drop silently swallowed legal moves**, because the origin square
   was activated twice, toggling the selection off before the drop resolved.

And three in Phase 2, none of which would have shown up without two real
clients talking to a real database:

4. **Nobody could join a room.** `runTransaction` invokes its callback
   optimistically against the client's sync cache, and on a cold cache that
   first call receives `null` — which the join logic read as "no such room" and
   aborted. The host never saw it, because its own listener kept its cache
   warm. Fixed by attaching the room listener (and awaiting its first snapshot)
   before transacting. A one-off `get()` does *not* fix this: it does not
   populate the cache transactions consult.
5. **Rematches broke the game.** Swapping seats was written by whichever device
   asked second, so the *other* device kept its old colour, believed it was
   still its turn, and had every move rejected. Fixed by re-deriving your seat
   from the room on every update — the room is authoritative for identity, not
   just position.
6. **A disconnect marked the wrong player away.** `onDisconnect` is bound to a
   specific path, so after a rematch swapped seats it still pointed at the
   player's old seat. Fixed by cancelling and re-registering presence on seat
   change.

A fourth issue was a spurious "Opponent disconnected" modal after a *failed*
join, because the presence check ran even when not seated in a room.

And one from the Arcade skin, which is worth recording because it looks like a
CSS problem and is really an input problem:

7. **A `preserve-3d` board could not be played on.** The natural way to build
   a tilted board is `transform-style: preserve-3d` with each piece
   counter-rotated to stand upright. It renders beautifully — and after the
   first move, taps start landing on the board instead of the square, because
   Chromium routes pointer events through compositor hit-test regions that go
   stale when a child of a 3D context repaints. `document.elementFromPoint`
   kept returning the *correct* square the whole time, so every naive check
   passed. Only actually playing a game through simulated taps caught it. The
   fix was to flatten the transform and fake the upright pieces with a 2D
   `scaleY`, which is visually near-identical and hit-tests normally.

### Manual checklist

| # | Test | Expected |
| --- | --- | --- |
| 1 | e2→e4, then e7→e5 | Both succeed |
| 2 | White moves, then tries another White piece | Rejected — Black's turn |
| 3 | e2→e5 from the start | Rejected |
| 4 | g1→f3 | Succeeds |
| 5 | c1→h6 from the start | Rejected — blocked |
| 6 | Capture a piece | Captured piece disappears |
| 7 | Reach a check | King square glows red, status shows CHECK |
| 8 | `1. f3 e5 2. g4 Qh4#` | "Black Wins", checkmate modal |
| 9 | Kingside castling | King g1, rook f1, h1 empty |
| 10 | Castle through/into check, or after king/rook moved | All rejected |
| 11 | En passant | Legal only immediately; captured pawn removed |
| 12 | Promote to Q / R / B / N | Picker opens; chosen piece appears |
| 13 | Load `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1` | DRAW — Stalemate |
| 14 | Load `7k/8/8/8/8/8/8/K7 w - - 0 1` | DRAW — Insufficient Material |
| 15 | e4, e5, Nf3, then Undo | Knight returns to g1, White to move |
| 16 | Play moves, refresh, Continue Game | Position, history and undo restored |
| 17 | Flip Board | Only orientation changes |
| 18 | Move after checkmate | Rejected |

Positions for tests 9–14 are one tap away via the DEBUG presets below.

### Online checklist (two devices)

| # | Test | Expected |
| --- | --- | --- |
| 19 | Create a room | 6-character code shown, waiting screen |
| 20 | Join with that code | Both devices land on the board automatically |
| 21 | Each device's own colour | Always at the bottom of its own board |
| 22 | Tap an opponent piece | Nothing happens; no move is sent |
| 23 | Move on device A | Appears on B within a moment, with last-move highlight |
| 24 | Offer a draw | Opponent gets an accept/decline dialog |
| 25 | Resign | Both devices show the same result |
| 26 | Rematch | Resets only once *both* ask; colours swap |
| 27 | Close one device's tab | Other shows "disconnected" |
| 28 | Reopen and Continue Game | Rejoins the same seat, game intact |
| 29 | Third person enters the code | "That room is already full" |
| 30 | Enter a nonsense code | "No room with that code" |

---

## Debug mode

`js/config.js`:

```js
export const DEBUG = true;
```

When `true`: namespaced console logging is on, `window.chessArena` exposes the
controller, and the **Game Menu** gains a FEN loader with one-tap presets
(Castling, Promotion, Mate in 1, Stalemate, En passant, K vs K).

When `false`: logging is silent and the developer UI is **never inserted into
the DOM**. Set it to `false` before shipping.

---

## Known limitations

1. **Pieces are Unicode glyphs, not SVG.** They are font vectors, so they stay
   sharp at any density, and the same solid glyph is used for both colours
   (recoloured in CSS) so the two sides match on every platform. Exact shapes
   still vary between operating systems. To swap in artwork, replace
   `renderPieceContent()` in `js/board.js` — it is the single swap point.
2. **Sounds are synthesised**, not recorded. `assets/sounds/` ships empty, so
   there are no 404s. Drop in the six `.mp3` files and flip `USE_SOUND_FILES`
   in `js/sound.js` to use real audio; files that fail to load fall back to
   the synth automatically.
3. **Drag-and-drop is mouse/pen only.** On touch, tap-to-move is the sole
   interaction so that page scrolling keeps working. Tap-to-move is fully
   supported everywhere, including desktop.
4. **Undo has no depth limit and no confirmation, and is local-only.** Either
   player can take back any number of half-moves in a local game. Online it is
   disabled outright: a unilateral take-back would let one player rewind the
   opponent's position. Turning it into an offer the opponent approves is a
   natural next step — it already routes through `submitAction`, so the change
   is confined to the session provider.

10. **Online games have no clock, no rate limiting and no room cleanup.**
    Rooms are never deleted, and an authenticated user can create unlimited
    ones. Before running this publicly, add a scheduled cleanup and App Check.

11. **A disconnected player's seat is held indefinitely.** There is no
    abandonment timeout, so a game whose opponent never returns stays open. You
    can leave the room, but you cannot claim a win.

12. **Move legality is enforced by clients, not the server.** See
    [Trust model](#trust-model) for exactly what that does and does not mean.

13. **The Arcade 3D skin trades tap size for looks.** Perspective makes the far
    ranks smaller: on a 360px-wide phone rank 8 is about 29px tall against 41px
    on rank 1, below the 44px target the Classic skin holds everywhere. Every
    square is still reachable and a full game is playable by tap (verified
    across four viewports), but Classic is the more comfortable choice for
    serious play, which is why it remains the default. The tilt is a single
    `--tilt` value in `css/arcade.css` if you want it flatter.
5. **PGN import is not implemented.** Export and clipboard copy work; the
   engine already exposes `loadPgn()`, so import is a small addition.
6. **No clocks.** Timers are Phase 3.
7. **Draw offers are trust-based**, as they must be when both players share a
   device.
8. **Threefold repetition is auto-claimed**, not offered as a choice. FIDE
   makes it claimable; this app ends the game automatically.
9. **Two modern CSS features are used, both with fallbacks.** `:has()` powers
   one setup-screen highlight (unsupported browsers lose only that highlight),
   and CSS container queries size the pieces and coordinates relative to the
   board. Both are behind `@supports` or degrade harmlessly — the container
   query falls back to a viewport-based `clamp()`. This needs a 2023-or-later
   browser for pixel-perfect piece scaling; everything remains playable
   without it.

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1** | Local chess core — board, rules, local two-player, history, save, responsive UI, controls | ✅ **Complete** |
| **2** | Firebase multiplayer — anon auth, create/join room, room codes, two-device sync, reconnect, presence, rematch, resign, draw offers | ✅ **Complete** |
| **3** | Clocks — 1 / 3 / 5 / 10 / 15 minute | Next |
| **4** | Accounts — username, profile, match history, statistics | Planned |
| **5** | Competitive — ELO, leaderboard, matchmaking, spectators | Planned |
| **6** | AI — opponent, difficulty levels, analysis, hints | Planned |
| **7** | Advanced chess — PGN replay, opening recognition, analysis, blunder detection | Planned |
| **8** | Deployment — server-side move validation (Cloud Functions), App Check, room cleanup, GitHub Pages / Firebase Hosting, mobile testing | Planned |

---

## Licence

`chess.js` is BSD-2-Clause (Jeff Hlywa); its licence header is preserved in
`js/vendor/chess.js`. Application code is yours to use as you see fit.
