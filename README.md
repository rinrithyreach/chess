# ♛ Chess Arena

A polished, mobile-first chess game that runs entirely in the browser — no
backend, no build step, no framework.

> **CURRENT VERSION — Local Two-Player + Online Multiplayer**
>
> **Phase 1 — Local.** Two players share one device, or one plays the
> built-in bot. Full standard chess rules, save/resume, move history, resign
> and rematches. (Undo is built but locked in the UI; the Draw button has been
> removed — see *Known limitations*.)
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

Both ends of the last move are tinted, and **the square the piece came from
also carries a ring** — an empty circle behind, the piece ahead. Tinting both
ends says a move happened; it does not say which way, and which way is the
thing you want when you look up and someone has moved. Both boards draw the
same ring in the same gold at the same radius.

**Three game modes** — *Local Two Player* (share one device), *Player vs Bot*,
and *Online Multiplayer*. Each is a session provider and nothing else: the
board, the UI and the controller are identical in all three.

**The bot** — negamax with alpha-beta, ordered moves, a quiescence search and
piece-square tables, searching under a time budget rather than to a fixed
depth, so the wait is bounded on a cheap phone and a faster device simply gets
a stronger opponent. It runs in a Web Worker, so the board never freezes while
it thinks. Roughly a novice: it punishes hanging pieces and short tactics, and
will miss deeper combinations. Strength is one number — `BOT_TIME_BUDGET_MS`
in `js/config.js` — which is where difficulty levels would go.

**Online multiplayer** — create a room, share a six-character code, and play
across two devices. Live move sync, per-device board orientation, opponent
presence, automatic reconnect, resignation, and rematches that require both
players to agree (and swap colours). The network draw-offer path is still
implemented and still tested, but with the Draw button gone there is no longer
a way to start one from this build.

**Profile pictures** — each player can put a picture on their seat from the
New Game screen: tap the circle beside a name box and pick one, and it shows
on their player card for the whole game. Optional everywhere — a seat without
one keeps the king glyph it always had.

Nothing is stored as picked. Whatever comes in — a 12-megapixel photo, a
screenshot, an 8MB PNG — is cropped to a centred square, scaled to 128px and
re-encoded (WebP, falling back to JPEG) until it fits a **24KB** budget, which
is roughly three times what a picture of that size actually costs. The scaling
steps down by halves rather than leaping straight to 128px: a single draw from
a 4000px photo throws away the thousand pixels around each one it samples,
which is what makes a shrunken photograph look like it has been through a fax
machine.

The picture is **remembered per seat**, not per name, so it is offered back on
the next New Game rather than having to be hunted down in the camera roll
again. The name is not remembered — a name is eight characters and takes a
moment to retype. A rematch swaps colours, and each player's picture goes with
them.

**Pictures do not travel online, and that is deliberate.** The deployed
security rules end `players/$color` with `"$other": { ".validate": false }` and
know nothing about an `avatar` field, so a seat carrying one is rejected —
taking the whole room write with it, which is the difference between "no
picture" and "cannot create a room at all". `ONLINE_AVATARS` in
`js/firebase-config.js` is the one switch, and the online seat hides its picker
while it is off rather than offering a control that does nothing. Local
two-player and bot games are unaffected. To turn it on: add the `avatar` rule
(it is in git history at commit `2dc721e`), deploy the rules, then flip the
flag — in that order, because a client that sends a field the rules do not know
about cannot create rooms at all.

Wherever a picture *is* read — including one written by a peer on a build that
sends them — it is validated at the point of use, because the rules protect the
*room* and the check on arrival is what protects *this device*. Only `data:`
URLs of `png`, `jpeg` or `webp` are ever rendered: never a remote URL, which
could otherwise report who looked at the board, and never SVG, which is a
document rather than a picture.

**Captured pieces, drawn in 3D** — the piles are the board's own pieces, not
Unicode glyphs. `Board3D.pieceSprite()` builds the real piece — the same lathed
body, the same detail solids, the same clearcoat material — and reads it back
through a render target as an image, so a captured knight is the knight that
was on the board rather than a flat glyph of somebody else's chess set standing
next to a solid one. Twelve portraits, drawn once each and cached, through the
existing WebGL context rather than a second one.

Two things that had to be got right. The portraits are framed to the **tallest
piece in the set**, not to each piece's own box: framing every piece to fill its
own square is the obvious approach and it renders a pawn the same size as a
king, at which point the pile stops reading as chess pieces. And the black
pieces get a **rim light** — on the board they are legible because they stand on
a pale square, and in a tray there is no square, so an unlit black piece on a
dark panel is a piece-shaped hole. Lighting from behind draws the edge that
carries the shape at this size.

The flat fallback board has no geometry to photograph, so there the trays fall
back to the Unicode glyphs.

**Captured pieces, either side of the board** — the pieces each player has
taken sit in a column beside the board: the left one belongs to the player at
the top and fills downward, the right one to the player at the bottom and fills
upward, so a pile always starts at the same edge as the card it belongs to.
Both follow a board flip. The running material lead (`+2`) stays on the card,
next to the name, because that is the part you read at a glance.

The columns are **overlaid, not laid out beside the board**, and that is the
whole trick. The board is square and limited by width, so a column in the flow
costs a pixel off each side of every square — measured at 14%, more than the
full-bleed change had just won back. It does not have to cost anything, because
the canvas is already not full of board: the camera reserves headroom for a
king standing on the far rank, so at the default angle the board is drawn
across 84% of the canvas and the rest is empty either side. 32px of it on a
390px phone, against a 20px column. The tray goes there, free.

That margin narrows as the camera rises, so the board takes real padding at
**Max** alone, where there is none left to borrow. Measured, with the tray
clearing the board at every level:

| Level | Board drawn | Margin per side | Tray | Overlap |
| --- | --- | --- | --- | --- |
| Fit (default) | 321px | 32px | 20px | none |
| Large | 345px | 20px | 20px | none |
| Max | 328px | 8px | 20px | none (board padded) |

The piles come from the **move history**, not from comparing the position
against a full starting set. That distinction is the whole correctness story: a
side that promotes a pawn shows one pawn short, and a material diff reads that
as the opponent having captured it — inventing a capture that never happened
and skewing the score. The history says plainly what was taken. A position
restored from a bare FEN has no history and so shows no piles, which is honest:
nothing knows what was captured to reach it.

A full pile is fifteen pieces and a phone card fits about eight at their
natural width, so the glyphs overlap by a third — the same trick a stack of
poker chips uses. Past that the pile clips and the score does not: the number
is the part you actually need.

**A board that fills the phone** — on mobile the board goes edge to edge. It is
the only square thing on the page and it is limited by WIDTH, not height (the
camera fits the board to whichever axis is tighter, and on a phone that is
always the width), so every pixel of gutter was a pixel off each side of every
square. It breaks out of the page padding rather than removing it, so the cards
and controls keep their margins. On a 390px phone the board went from 348px to
384px: a tenth wider, a fifth more area. Tablets and desktop are untouched —
there the board is capped long before the screen runs out.

**Drawn header icons** — the menu and settings buttons are inline SVG rather
than the `☰` and `⚙` characters. A text glyph is at the mercy of whatever font
the device falls back to: `⚙` lands thin and spindly on most, and as a *colour
emoji* on some, which ignores the CSS `color` entirely and so cannot be tinted
to match the button it sits in or respond to hover. The drawn versions use
`currentColor`, so every state the button already had keeps working with
nothing added. Both are generated shapes rather than an imported icon set, so
there is no third-party licence or attribution attached.

The `←` and `⧉` buttons are still glyphs. `⧉` (U+29C9) is the one with real
risk left in it — font coverage is patchy and it can land as a missing-glyph
box — so it is the next one worth drawing.

**Game management** — restart (local), resign, rematch, board flip, and copy
PGN. The control row is **Undo, Flip, Resign**.

A rematch always swaps colours, with nothing to tick. It used to be an option
in the game-over dialog, which turned out to be an option only some of the
time: the online session swaps seats inside the transaction that resets the
room — agreed by both devices, with nowhere to honour one player's preference
— so the checkbox only ever changed what a *local* game did. Removing it makes
the rule the same everywhere, and it is the ordinary one: whoever had Black has
White next.

**Undo is locked**: built and correct, but shown with a padlock and refused on
tap and on keyboard alike. Remove its id from `LOCKED_CONTROLS`
(`js/config.js`) to restore it — nothing else needs changing.

**The Draw button was removed.** The capability underneath is intact and still
tested: `offerDraw()` is still part of the session contract, and the dialog
that receives an offer still works, so a peer running an older build can still
send one. What is gone is the way to *make* an offer from this build.

**Persistence** — autosave after every meaningful action, and a *Continue
Game* entry point. Local games restore position, history, players, orientation
and undo depth; online games rejoin their room and resync from it.

**Refresh mid-game** and the app's own dialog offers it straight back —
*Resume your game?*, naming the players and how far you got, with three
answers: **Continue** picks the game up, **New Game** starts another, and
**Exit Game** leaves it alone and keeps it saved. That third one was always
possible by pressing Escape or tapping outside, but only if you knew to — on a
phone an unlabelled way out is no way out. It discards nothing, and says so.
Dismissing the dialog now means Exit rather than New Game, so a stray tap on
the backdrop is never what puts a game behind you. Only after an actual reload; arriving fresh still just shows the
Continue button, since a dialog in front of everyone who once left a game
unfinished would be nagging rather than helpful. A styled confirmation
*before* the page goes is not possible for any site: a page cannot render its
own UI during `beforeunload`, and browsers replace whatever it supplies with
fixed wording of their own — so the dialog goes on the other side of the
reload, where the app is in charge of it.

**One board, and it is the 3D one.** A real WebGL board: turned pieces with
genuine depth, a lit scene with cast shadows, a camera that swings round the
board when you flip it, and moves that carry the piece through the air. Its
pieces are *generated*, not modelled — chess pieces are surfaces of revolution,
so a two-dozen-point profile produces a real lathe-turned piece with its
plinth, chamfer, collar and coronet. There are no model files to ship or keep
in sync.

The knight is the exception twice over: it is not a surface of revolution, and
after two attempts it is no longer an extruded silhouette either. It is built
from eight solids — neck, cranium, jaw, muzzle, two ears and three mane lobes —
placed and then baked into a single geometry at build time, so it costs the
same two draw calls a lathe-turned piece does. See *Things that went wrong*
for why the silhouette approach could not work on a board seen from above.

**The finish.** Filmic tone mapping, so a highlight on a turned surface rolls
off and keeps its shape instead of clipping to a bald white patch. A small
studio — graded sky, warm softbox where the key light is, cool fill opposite,
floor bounce — built from primitives and prefiltered into a cube map, so the
pieces have a room to reflect: a polished object reads as polished because you
can see something in it, and before this there was nothing. A clearcoat over
each piece, because a finished piece is lacquer over wood and one specular lobe
has to average the two into something that looks like neither. And the board is
a surface rather than two colours: every square gets its own wood grain, with
its own direction and its own seed, a matching roughness map so the grain
catches the light, and a drawn seam at every join.

Both boards draw from **one palette**: the 3D board reads the same colours the
flat board's CSS names for that theme, and the exposure is what compensates for
the light and the tone curve. That is deliberate and was learned the hard way —
see *Things that went wrong*. The rendered pixels are sampled against those CSS
values in the test suite, so the two cannot drift apart unnoticed.

**Moving a piece is a motion, not a cut.** Both boards share one duration and
one easing curve so a move feels the same whichever is on screen, and the 3D
board spends them on a carry: the piece is lifted, taken across, and set down,
with the knight arcing higher because it is the piece that jumps. The arc is a
function of the *travel* rather than of the clock, which is what puts its top
over the middle of the move instead of over wherever the piece happens to be
when half the time has gone — drive it from the clock and the piece arrives
above its square and drops onto it. A captured piece is held until the piece
taking it is most of the way across, then displaced, so the two are one event
rather than a square emptying itself and then being landed on.

Dragging follows the pointer continuously rather than snapping the piece to the
centre of whichever square it is over, and a piece released onto a square it
cannot legally reach is animated back rather than teleported. The timings live
in `config.js` and the tests read them from there, so tuning them cannot leave
a stale number behind in an assertion.

**Board size**, in the control row next to Flip, in three steps: *Fit* (the
default), *Large* and *Max*. It is zoom, but implemented as camera
elevation rather than as a dolly, which sounds like the wrong lever until you
measure the board. On a 412px phone the frame is square while the board, seen
from 56 degrees, projects about 1.35 times wider than tall — roughly 110px of
the frame's height is empty sky. Raising the camera spends that space on the
board, so **the whole board stays visible at every step and there is nothing to
pan**; a dolly would have to crop to get squares the same size, and a chessboard
you have to scroll around is worse than a small one. At the top step the frame
also crops the wooden rim, which is another tenth of the width spent on
something you never tap.

It fixes the more annoying half of the problem too. At the low angle the far
rank is a 23.9px target while the near rank is 36.6px; at Max they are 41.8px
and 46.2px — **every square within 3px of every other**. Each level is measured
square by square through the live camera in the board-size suite.

There is no Look & Feel setting any more. Every player gets the 3D board, so
the picker had nothing left to choose between, and a radiogroup of one is a
control that cannot do anything — the section hides itself whenever fewer than
two styles are selectable, and would come back on its own if a second one were
ever added.

**Classic**, the flat DOM grid, is still built and still tested, but as the
*fallback* rather than an option: if a device refuses a WebGL context the app
says so and mounts it, rather than showing an empty frame. That refusal is
remembered for the visit only and never written to settings — persisting it
would strand the player on the flat board for good, with no picker left to
climb back out of. `?ui=classic` reaches it deliberately while `DEBUG` is on,
which is how it stays previewable and how the renderer-agnostic suites drive
the app.

Retiring a look needs one flag. `selectable: false` in `UI_STYLES` takes it out
of the picker, and `resolveUiStyle` then declines to trust it out of storage —
so a saved `uiStyle` of `arcade` from the removed CSS-perspective *Arcade 3D*
skin, and a saved `classic` from back when it was on offer, both land on the
3D board with no migration step and nobody left behind. (`js/board-3d.js`
explains in its header why Arcade went; the history is in git.)

**Interface** — start screen, new-game setup, waiting room with the shareable
code, responsive game screen, settings (sound, board theme,
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
│   └── board-3d.css              Canvas host + a11y layer for the WebGL board
├── js/
│   ├── config.js                 Constants, DEBUG flag, logger
│   ├── app.js                    Composition root (entry point)
│   ├── avatar.js                 Profile pictures: crop, scale, re-encode, validate
│   ├── firebase-config.js        YOUR Firebase project config (empty by default)
│   ├── chess-engine.js           Defensive wrapper around chess.js
│   ├── game-controller.js        Orchestration, selection, autosave
│   ├── board-shared.js           Square list, FEN parsing, labels — used by BOTH boards
│   ├── board.js                  Flat DOM board: rendering and interaction
│   ├── board-3d.js               WebGL board: same contract, lazily loaded
│   ├── bot.js                    The opponent: evaluation and search
│   ├── bot-worker.js             Runs that search off the main thread
│   ├── ui.js                     Screens, modals, panels, toasts
│   ├── storage.js                Versioned, validated localStorage
│   ├── sound.js                  Web Audio effects
│   ├── sessions/
│   │   ├── local-session.js      Provider — two players, one device
│   │   ├── bot-session.js        Provider — one player, one computer
│   │   └── firebase-session.js   Phase 2 provider — two devices
│   └── vendor/
│       ├── chess.js              chess.js 1.4.0 ESM build (vendored)
│       ├── three.module.js       three.js r180 (vendored, for the 3D board)
│       └── three.core.js         three.js core chunk it imports
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

The length is `ROOM_CODE_LENGTH` in `js/firebase-config.js`, and everything on
the client follows it: generation, the join field's `maxlength`, the
placeholder dashes and the error text. The **one** place it cannot reach is the
security rules, which import nothing — `firebase/database.rules.json` matches
`{6}` by hand, and the two must change together. Changing the constant without
redeploying the rules rejects every room creation, with a `permission_denied`
that looks nothing like a length problem.

This was briefly four characters, which is the better length for something read
aloud and typed with thumbs. It went back to six because the rules are the
gate: they match `{6}`, and a four-character room is refused before anything
else about the request is considered. To go back to four, change both and
deploy.

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
A draw can only be offered in your own name. A profile picture must be a
`data:` URL of a raster image and at most 24KB, so a room cannot be used as
file hosting and a picture cannot be a URL pointing at somebody's server.

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

Three independent `localStorage` keys are used so a corrupt game never costs
you your preferences:

- `chess-arena:game` — the current game
- `chess-arena:settings` — sound, theme, coordinates, animations, auto-flip
- `chess-arena:avatars` — the remembered profile picture for each New Game seat

Profile pictures get their own key rather than living inside settings. They
are the only thing here measured in kilobytes rather than bytes, and a quota
failure writing a picture must not take the settings record down with it.

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
    "players": {
      "w": { "name": "Alex", "avatar": "data:image/webp;base64,UklGR..." },
      "b": { "name": "Sam", "avatar": null }
    },
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

The app ships with no test dependencies; verification is run from outside the
project. Fifteen suites cover the game itself — **815 assertions, all passing,
with zero console errors in every browser and viewport tested** — and
nine more cover profile pictures, the room code, the mobile board and the
capture trays, a further **183 assertions**, run against the
real app in Chromium and the shipped security rules in the database emulator. The
two groups were run separately, so the totals are reported separately rather
than as one number:

| Suite | Assertions | What it covers |
| --- | --- | --- |
| Engine (Node) | 81 | Every rule scenario in the spec, plus error handling |
| **Bot engine (Node)** | **13** | **Its chess: mate in one, free material, no self-blunders, promotion, timing** |
| **Bot mode (Chromium)** | **34** | **Replies, refuses its own pieces to the player, never blocks a frame, survives a reload** |
| App (jsdom) | 137 | Boots the real app, drives it by tap/click, asserts DOM; a rematch swaps colours every time and offers no way not to |
| Layout (Chromium) | 145 | 9 viewports: overflow, board geometry, touch targets |
| Interaction (Chromium) | 42 | Real page refresh, drag-and-drop, keyboard, clipboard |
| **Resume after refresh (Chromium)** | **42** | **The dialog is the app's own, appears only after a reload, and all three answers do the right thing** |
| **Multiplayer (Chromium ×2)** | **82** | **The setup form follows the chosen mode, then two devices against the Firebase emulator** |
| **Animation (Chromium)** | **44** | **The move animation actually runs, every time, and leaves nothing stranded; the capture is held and lands with it** |
| **3D board (Chromium)** | **93** | **All 64 squares pick correctly; play, flip, themes, keyboard, GPU teardown; the finish is measured — grain, seams, the no-GPU path — and so is the motion: the velocity profile of the shipped curve, the arc's top over the middle of the move, and a drag that moves the piece on every pointer move rather than once per square** |
| Config state | 16 | Online availability, and that the SDK is never fetched for local play |
| Waiting watchdog | 4 | The host's recovery poll runs while waiting and stops when seated |
| **Styles** | **30** | **A visitor who touches nothing lands on the 3D board and can play on it; the picker is gone, not empty; no retired style returns by any route; the fallback board still works** |
| **Control row (Chromium)** | **39** | **Undo never reaches the controller by any route; Draw is absent; the row still holds 44px targets** |
| **Board size (Chromium)** | **33** | **Every square measured through the live camera at each level: each step bigger, near and far converge, nothing ever cropped, picking still exact** |
| **Profile pictures (Chromium)** | **39** | **A real file through the real picker: centre-cropped, scaled to 128px, under budget; shown on the card, saved, restored after a reload, offered back next game; a 6-megapixel photo still fits; a non-image is refused and says why; remote, `javascript:` and SVG values all rejected** |
| **Rules (emulator)** | **14** | **The shipped rules loaded into the database emulator and driven as an ordinary signed-in user: a room with no picture is accepted, every avatar shape is rejected (the field is not in the deployed rules), unknown player fields rejected, and a stranger's uid still refused a seat** |
| **Profile pictures — regression (Chromium)** | **24** | **The paths whose signatures changed: the bot seat never inherits a picture, a rematch carries each picture across the colour swap, the mode toggle still hides the right rows, and a move still plays** |
| **Profile pictures — EXIF (Chromium)** | **3** | **A JPEG built with a real EXIF Orientation tag comes out upright, proved by which edge the colours land on — the classic sideways-avatar bug, tested rather than assumed** |
| **Live two-device game (Chromium ×2 + real project)** | **11** | **Two browsers against the actual Firebase project, not the emulator: create, join, seats and names sync, a move each way, no pictures online, room deleted afterwards** |
| **Capture trays (Chromium)** | **19** | **The trays must never cover a square — the drawn board and the tray are both measured through the live camera at all three zooms — must vanish when empty, must follow a board flip, and a full pile of 15 3D portraits must stay within the board's height. Caught a real bug: the render cache keyed on pieces alone, so after an even trade a flip left the right shapes in the wrong colour** |
| **Mobile board + captures (Chromium)** | **24** | **The board measured on four phones (it must use ≥92% of the width, with no horizontal overflow), then the piles driven through real moves: the right piece in the right side's colour, the lead only on the leader, level material showing no lead at all, and a promotion adding nothing to either pile** |
| **Room code (Chromium)** | **35** | **Every character of the code measured against the viewport across 5 widths × 7 text sizes. `body{overflow-x:hidden}` clips overflow and `.waiting` centres, so an over-wide code used to lose one character from EACH end and still read as a valid shorter code** |
| **Room code length (Chromium + emulator)** | **14** | **Six characters everywhere the length appears independently: the constant, `ONLINE_AVATARS`, the normaliser, the join field's maxlength and typing limit, both placeholders, and the security rules — which cannot import the constant, so they are checked to accept 6 and reject 3, 4 and look-alike characters** |

The 3D suite's headline check is picking. Every one of the 64 squares is
projected through the live camera to find where it is actually drawn, clicked
at that pixel, and the board asked which square it thinks was hit — all 64
match. That is verified square by square rather than spot-checked because it is
the exact failure that killed the CSS 3D skin (see *Things that went wrong*).

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

A further issue was a spurious "Opponent disconnected" modal after a *failed*
join, because the presence check ran even when not seated in a room.

And one from the CSS-perspective skin that was later removed. It is worth
recording because it looks like a CSS problem and is really an input problem —
and because it is the reason the 3D board is WebGL:

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

   The WebGL board later solved this properly rather than working around it:
   it picks by raycasting against the real geometry, so what you click is by
   construction what you see, at any camera angle.

And two from building that WebGL board:

8. **Switching board style broke the board that was switched *to*.** Both
   boards attach their listeners to the same `#board` element, and neither
   removed them. After one switch a single tap was delivered to *two* boards:
   both called the controller, the square was activated twice, and the second
   activation toggled the selection straight back off. The move silently did
   nothing — no error, no console output, a board that just felt dead. Fixed by
   giving each board an `AbortController` and aborting it in `dispose()`, so a
   board detaches completely when it hands the element over. It is the same
   double-activation shape as the old drag bug (4), from a different cause.

9. **The board was rendered nearly black, and nothing noticed.** The 3D
   board's square colours had been darkened as albedo, on the sound reasoning
   that they pass through a light and a tone curve before reaching the eye and
   should be pre-compensated. In the same pass the exposure was lowered to stop
   highlights clipping. Both were defensible; together they compounded, and the
   board rendered at **57% of the theme's light squares and 39% of its dark
   ones**. It shipped, because every assertion was about behaviour and none was
   about pixels, and because each change looked reasonable next to the one
   before it. The fix put the compensation in the exposure — one number for the
   whole scene — and put the palette back to the values the CSS names, so there
   is a single source for it. The test now screenshots the board and samples a
   light and a dark square against the CSS custom property for the current
   theme, which is a check that fails whichever of the two boards moves.

10. **The knight took three goes, and the first two failed the same way.** Its
   head began as an extruded 2D silhouette, which is the natural choice — the
   silhouette is what identifies the piece. But this camera looks down at the
   board from between 56 and 84 degrees, and the silhouette lives in a
   vertical plane: at 56 degrees that plane keeps about half its height on
   screen, at 84 degrees a tenth. The identity of the piece was in the part
   you cannot see. Attempt one extruded it deeper; attempt two tapered the
   extrusion so the muzzle was narrower than the cheek and tipped the head
   back to turn the profile toward the camera — which laid the horse on its
   back and rendered, in the words of the screenshot, as a crumpled paper
   cone. Attempt three throws the silhouette away and builds the head as
   solids, sized so the **muzzle projects forward past the edge of the base**.
   That overhang is the one feature that survives a top-down view, and it is
   what the tests now measure. The general lesson is not "extrude deeper": it
   is that a piece has to be identifiable in the projection the camera
   actually produces, and for a board seen from above that is the plan view.

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
| 15 | e4, e5, Nf3, then tap Undo | Refused — Undo is locked, and says so |
| 16 | Play moves, then refresh | *Resume your game?* dialog; Continue restores position and history |
| 16b | Refresh again, tap Exit Game | Back on the menu, nothing lost — Continue still offers the same game |
| 17 | Flip Board | Only orientation changes |
| 18 | Move after checkmate | Rejected |
| 19 | Pick a picture for Player 1, start a game | It shows on White's card; Black keeps the king glyph |
| 20 | Pick a sideways phone photo | Arrives upright — EXIF rotation is applied, not ignored |
| 21 | Pick a wide photo | Cropped to the centre square, never squashed |
| 22 | Rematch | Colours swap and each picture goes with its player |
| 23 | Return to the menu and start another game | The picture is offered back, already in place |
| 24 | Tap the × on a picker | Picture gone, king glyph back, and it is not offered next time |
| 25 | Pick a non-image file | Refused with a message naming the problem; nothing changes |
| 26 | Create a room with the phone's text size at maximum | All six characters of the code still readable |
| 27 | Capture a piece | It appears in the tray at that player's end of the board, in the other side's colour |
| 27b | Flip the board after an even trade | Both piles swap sides and keep their own colours |
| 28 | Trade evenly, then win a piece | The lead badge appears only on the side that is ahead, and vanishes at level material |
| 29 | Promote a pawn | Neither pile changes — a promotion is not a capture |
| 30 | Play on a phone | The board reaches both edges of the screen; cards and controls keep their margins |

Positions for tests 9–14 are one tap away via the DEBUG presets below.

### Online checklist (two devices)

| # | Test | Expected |
| --- | --- | --- |
| 19 | Create a room | 6-character code shown, waiting screen |
| 20 | Join with that code | Both devices land on the board automatically |
| 21 | Each device's own colour | Always at the bottom of its own board |
| 22 | Tap an opponent piece | Nothing happens; no move is sent |
| 23 | Move on device A | Appears on B within a moment, with last-move highlight |
| 24 | Look for a Draw button | There is none — the control row is Undo, Flip, Resign |
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
4. **Undo is locked in the UI, and Draw is gone from it.** Undo stays in the
   row with a padlock and refuses to act; the Draw button was removed
   outright. Neither capability was deleted — both are still implemented and
   still tested — so restoring either is a small, contained change rather than
   a repair job: an id in `LOCKED_CONTROLS` for Undo, a button and one line of
   wiring for Draw.

   The practical consequence is that a draw can no longer be *offered* from
   this build, online or off. Receiving, accepting and declining still work,
   since a peer on an older build can still send one.

   If Undo is ever unlocked, its own caveats still apply: it has no depth
   limit and no confirmation, and is local-only — online, a unilateral
   take-back would let one player rewind the opponent's position. Turning it
   into an offer the opponent approves is the natural next step; it already
   routes through `submitAction`, so the change is confined to the session
   provider.

11. **Online games have no clock, no rate limiting and no room cleanup.**
    Rooms are never deleted, and an authenticated user can create unlimited
    ones. Before running this publicly, add a scheduled cleanup and App Check.

12. **A disconnected player's seat is held indefinitely.** There is no
    abandonment timeout, so a game whose opponent never returns stays open. You
    can leave the room, but you cannot claim a win.

13. **Move legality is enforced by clients, not the server.** See
    [Trust model](#trust-model) for exactly what that does and does not mean.

14. **Two of the finish refinements are switched off without a GPU.** The
    environment map and the pieces' clearcoat are a texture unit and a few ALU
    ops on any GPU made this decade, and hundreds of CPU instructions per
    fragment on a software rasteriser — which is what Chrome falls back to when
    it blocklists a driver. Profiled on this project's own SwiftShader test
    harness, the environment map alone took the 95th-percentile frame during a
    move from 17ms to 500ms. The board detects the absence of a GPU (not its
    speed, which is unknowable) and drops those two along with the board's
    roughness map and half the lathe segments, which brings that figure back to
    17ms exactly. Everyone else gets the full finish. The honest caveat: the
    full path's cost has only been measured under software rendering, where it
    is worst by a wide margin, so its real-GPU cost is inferred rather than
    measured.

15. **Perspective still costs tap size, but far less than it did.** The far
    rank used to be a 22px target on a 412px phone against the near rank's
    36px — the hardest square on the board to hit. The board-size control
    fixes most of that by raising the camera rather than dollying in, which
    spends the empty sky a tilted board leaves in a square frame instead of
    cropping anything.

    **The default is Fit, which is the level that costs the most here.** It is
    chosen for how the board looks rather than for reach, and the numbers are
    worth stating plainly. Measured through the live camera on a 390px phone,
    with the board now running edge to edge:

    | Level | Board drawn | Far rank | Near rank | Far square area |
    | --- | --- | --- | --- | --- |
    | **Fit** (default) | 321px (82% of the screen) | **24px** | 36px | 745px² |
    | Large | 345px (88%) | 32px | 43px | 1171px² |
    | Max | 366px (94%) | 42px | 47px | 1819px² |

    So a far-rank square at Fit is under half the area of one at Max, and a
    24px target against the 44px this app uses everywhere else. Fit also draws
    the board across only 82% of the screen even though the canvas is full
    width — that is the level's own geometry rather than slack, because the
    camera reserves headroom for a king standing on the far rank, which at a
    low angle projects well above the board.

    None of this is a trap: the Size control cycles the three levels and says
    which one you are on, so a player who finds the back rank fiddly is one tap
    from Large and two from Max, and the choice is remembered. Every square is
    reachable at every level regardless — picking is a raycast against real
    geometry, and all 64 are verified individually at every zoom level.
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
