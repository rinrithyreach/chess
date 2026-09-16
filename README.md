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

**Three game modes** — *Local Two Player* (share one device), *Player vs Bot*
and *Online Multiplayer*. Each is a session provider and nothing else: the
board, the UI and the controller are identical in all of them.

**The bot** — negamax with alpha-beta, ordered moves, a quiescence search and
piece-square tables, searching under a time budget rather than to a fixed
depth, so the wait is bounded on a cheap phone and a faster device simply gets
a stronger opponent. It runs in a Web Worker, so the board never freezes while
it thinks. It punishes hanging pieces and short tactics, and will miss deeper
combinations.

**Difficulty levels have been removed.** Player vs Bot offered Easy, Medium and
Hard — one bot at three settings of the time budget and depth ceiling its search
already takes. Gone: `BOT_LEVELS` and the two helpers that looked a level up,
the Difficulty row on the New Game form, the level carried in the game state and
written into every save, and the seat name that carried it, *Bot (Hard)*.

The bot plays at the one strength it had before there was a choice, which was
Medium: `BOT_TIME_BUDGET_MS` and `BOT_MAX_DEPTH`, a 1.2-second budget a move
and never deeper than four plies. The per-game strength field the search reads
stays, for the reason it outlived the tournament ladder: a search that reads its
budget off a field costs nothing, and is the shape a choice would need.

**A game saved while levels existed still resumes**, at the one strength. The
level in the record is ignored, and the seat's old name is given back as plain
*Bot* when the record loads — in `storage.js`, because every reader of a save
comes through there. So the card, the PGN headers and the menu's Continue label
never name a strength that is not the one playing, and the resumed game can
still find which side is the bot's, which it does by that name. Only in a bot
game: between two people, a seat called *Bot (Hard)* is just what somebody
typed.

The `.time-picker` and `.time-option` classes went with the row. Built for
Speed Chess's time controls and passed from picker to picker since, this was
their last user.

**Speed Chess has been removed**, and the chess clock with it — it was the
only thing that ever had one. Gone: the mode, four time controls, the clock
kept as two balances and a timestamp, the interval that watched for a flag,
the two readouts on the player cards, the bot spending its own time to think
and the margin it kept back not to flag mid-search, the `timeout` end reason,
and the clock that rode along inside every saved game.

Taken out whole for the reason Tournament was: a mode off the form but left
half-wired is worse than one still offered, and a clock nothing can start is
a field on every game record, a branch in every session, and a shape the
parts that stay get written around.

Two things outlived it. The opponent picker — bot or a friend on this device
— passed to Elemental Chess, and has since gone with that too, as have the
`.time-option` classes it was drawn with, which outlived both as the
bot-difficulty row until that went as well. And `BOT_MIN_THINK_MS`, the courtesy pause before the bot
replies, which used to be trimmed to whatever the clock could spare and is now
simply the pause.

**Tournament has been removed.** It was a ladder of five bots — one bot at
five settings of the two numbers it already took — climbed a rung at a time,
with how far you had ever got kept apart from where you currently stood. It
was taken out whole rather than hidden: the mode, the rungs, the run, the
form's ladder, the game-over dialog's "next rung" button, its stylesheet
block, and the ninety-odd lines of controller and session that carried a rung
through a game and a save.

A mode taken off the form but left half-wired is worse than one still
offered. Nothing on screen admits it exists, every trace of it is a trap for
whoever reads the code next, and the parts that stay get written around a
shape nothing uses. The one deliberate remnant is `RETIRED_STORAGE_KEYS` in
`js/config.js`, which exists so `chess-arena:gauntlet` is swept off the
devices that have one rather than left behind: `chess-arena:` is a namespace
this app is responsible for the whole of, not only the part it still reads.

The bot itself is untouched. Its strength was always a per-game field with
the ordinary constants as its default, and only the ladder ever overrode it.

**Elemental Chess has been removed**, and the whole layer it needed with it.
It was the one variant: every piece carried an element, every element granted
one power the piece could spend once a match, and a second, louder power that
cost the whole turn. It had grown to seventeen elements against sixteen
pieces, with a loadout before the match to decide which of them came.

Gone whole: the mode and its opponent picker, `elemental.js` and its two
sessions, thirty-four powers, the six board effects, the charges and the
per-piece element map, the graveyard and the last-move record they were
tracked beside, the power bar, the supers row, the all-powers panel, the
loadout picker, the rules card, the corner glyphs and the effect washes on
both boards, every burst, beam, shockwave and knock, the two synth sounds, and
the FEN-only save path that existed because a power reloading the position
threw chess.js' move history away.

Taken out whole for the reason Tournament and Speed Chess were: a mode off the
form but left half-wired is worse than one still offered. Nothing on screen
would admit it existed, every trace of it would be a trap for whoever read the
code next, and the parts that stay get written around a shape nothing uses.

Four things it had been keeping alive went with it, all of them load-bearing
for nothing else by the end:

- **The variant hooks on `LocalSession`.** `setPosition()` replaced the board
  without a move having been played, `publishState()` announced state the base
  class knew nothing about, and `getAllLegalMoves()` was there so a rule that
  subtracts moves could ask what the whole set was first. All three existed for
  this variant and had no other caller.
- **The bot's move vetting.** The search plays chess and had to have its answer
  checked against a freeze or a patch of vines before it was played. With
  nothing left to forbid a legal move, the check and its fallback table go.
- **`FEN_ONLY_MODES`, and the two counts that read it.** A saved game's depth is
  the length of its move list again, everywhere — the second branch existed
  because a burn cleared the history out from under that list.
- **`squareDistance()` and the Cleanse wave it timed.**

The opponent picker went too. It was built for Speed Chess, outlived it as
Elemental Chess's, and had no third user — so the `.time-option` classes it
was drawn with passed to the bot-difficulty row, and have since gone with that.

**The bot is untouched.** Its strength was always a per-game field with the
ordinary constants as its default, and only the elemental session ever reached
past the search — through `botUsePower()`, a hook nothing defines any more.

**Online multiplayer** — create a room, share a six-character code, and play
across two devices. Live move sync, per-device board orientation, opponent
presence, automatic reconnect, resignation, and rematches that require both
players to agree (and swap colours). The network draw-offer path is still
implemented and still tested, but with the Draw button gone there is no longer
a way to start one from this build.

**Names are up to 120 characters — a sentence, and as many words as fit in
one.** One number, `NAME_MAX_LENGTH`, sets every box a name can be typed into
— both players on the New Game form, the online name, your own name in the
friends panel, and the two mid-game rename boxes — and the same number is
enforced by the security rules on the three names that leave the device: your
seat in a room, your profile, and the name on a friend request or an
invitation. They match for the reason the chat cap matches: a name that can be
typed but not saved is a refusal that arrives after the fact, with the box
already emptied.

There is a limit at all, rather than none, for two reasons that are nothing to
do with taste. The whole room record is rewritten on **every move**, both names
inside it, so a name is a cost paid again on every move by both devices. And a
player card is one line with an ellipsis, so past a point the extra characters
cannot be seen by anybody anyway — the card carries the whole name in its
`title`, so a clipped one can still be read rather than merely noticed, and
so now do the friend rows, the request and invite rows, and the name over a
chat message.

The number went twenty, then fifty, then a hundred and twenty, and the last of
those is the one that stops it being a number anybody notices. It is around
four times what fits on the card it is drawn on, so what you run into is no
longer the cap — it is the card, and the card has handled it since the first
of those three numbers. It is still not unlimited and cannot be: the security
rules enforce a length rather than the absence of one, and a field with no cap
is a field that eventually has a book pasted into it.

**Raising it is two files and one deploy, and the deploy is the half that
matters.** `NAME_MAX_LENGTH` in `js/config.js` and the four name rules in
`firebase/database.rules.json` are the two files; until `firebase deploy
--only database` is actually run, the deployed rules still enforce whatever
number they were last deployed with, and a longer name works in every mode
that never leaves the device while being refused by every room. That state is
survivable but it used to be baffling: the refusal came back as "The room
would not take that name", which is true and useless. A rename refused on a
name longer than `DEPLOYED_NAME_FLOOR` now says it is longer than the room
allows and names the file to deploy. Length is the only thing about a name the
rules have an opinion on — the validate is `isString() && length > 0 &&
length <= N` and nothing else, and whether the seat is yours was settled by
the transaction, which fails a different way — so that guess is right
essentially always.

**A player can be renamed mid-game**, in every mode. A pencil sits against
the name on each card this device may act for, and pressing it swaps the name
for a box holding the same name — deliberately not a dialog, since a name is
one short string and the card is already showing it. Enter or tapping away
commits, Escape puts the old name back.

Which cards those are is not decided by the mode but asked of the session:
`getControllableColors()`, the same question as *may I move these pieces*. So
online it is the one seat you are sitting in, against a bot it is yours and
never the bot's, and in local two-player it is both — two pencils, because
both players really are here. A rename of a seat the device does not control
is refused rather than quietly ignored, whichever route it arrives by.

It follows the COLOUR rather than the position, because Flip can put a seat at
either end of the screen.

Until this existed, fixing a name meant starting again — and online, leaving
the room, which ends the game for the other player too. Online the new name
reaches the other screen within a moment without either of you reloading;
offline it goes through the autosave, so a resumed game comes back under it.

Two details that are load-bearing rather than decorative. Online, the write
re-checks the seat *inside* the transaction rather than trusting the colour it
was called with: a rematch swaps the two players, and that swap is written by
whichever client gets there first, so between this device deciding it is White
and the write landing, White can be somebody else. And a local rename does not
touch your stored profile — online your name IS your identity to everybody
else and is kept for the next room, but the two names in a local game belong to
the game in front of you, and quietly overwriting your online profile because
you renamed Player 2 would be a surprise.

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

**Pictures travel online too** — a seat carries the picture of the player in
it, so both devices show the same two faces. What travels is a *smaller* copy
than the one kept on this device: **96px inside a 6KB budget**, not 128px
inside 24KB. That is not tidiness. Every move is written as a transaction over
the whole room document, and the seats are part of that document, so a picture
in a seat is not sent once — it is sent again on every move, by both players,
for the length of the game. At the stored budget that is a photograph's worth
of upload per move on a phone; at this one a move carrying two faces is about
9KB. The 96px costs nothing visible: a player card is 38px at its largest, so
even a 3× screen has more pixels than it can use.

**This needs the security rules deployed.** `players/$color` ends with
`"$other": { ".validate": false }`, so rules without the `avatar` field refuse
a seat that carries one — and a refused field takes the whole room write with
it, which is the difference between "no picture" and "cannot create a room at
all". That is exactly what happened here once, which is why
[deploying the rules](#3-deploy-the-security-rules--do-not-skip-this) has the
heading it has — and why the client no longer depends on it: **a room the
rules turn down is retried once without the picture**, and the players get
their game with a note instead of an error. Deploy
`firebase/database.rules.json` to get the pictures themselves.
`ONLINE_AVATARS` in `js/firebase-config.js` turns the whole thing off again if
you ever want it off — the seat then omits the field and the online form hides
its picker rather than offering a control that does nothing. The friends
panel’s copy of that picker is deliberately *not* hidden with it: a profile
row is a different write with its own rules, so your friends can still see
your face even when the players in a game cannot.

**Your own picture can be set from the friends panel**, not only from the
New Game form. It is the same picture and the same slot — two controls onto
one thing, exactly as your name has a box in both places — so setting it in
either shows in both. That is where it belongs: the picture’s whole job is to
be the face beside your name in somebody else’s friends list, and the friends
panel is where your name and your code already live. Reaching it used to mean
going to New Game and choosing Online Multiplayer, which is a strange route
to your own profile.

The pickers are painted from storage rather than from hub state, and that is
load-bearing rather than incidental. The hub loads its copy of the picture
inside `#connect`, *after* awaiting Firebase — so until that round trip lands,
and for ever on a device that cannot reach it, the hub’s idea of your picture
is `null`. A first pass at this rendered the pickers from that, which wiped
the picture off both of them the moment the panel opened. There is a test for
it now, with the network cut.

Wherever a picture is read — and online it was written by the other player's
client — it is validated at the point of use, because the rules protect the
*room* and the check on arrival is what protects *this device*. Only `data:`
URLs of `png`, `jpeg` or `webp` are ever rendered: never a remote URL, which
could otherwise report who looked at the board, and never SVG, which is a
document rather than a picture.

**Chat** — a sheet behind one button in the room bar, with the count of what
has arrived while it was shut riding on the button. It is a sheet rather than
a panel beside the board because on a phone that panel *is* the space under
the board, and a chat log there would push the controls off the screen — you
are either reading the position or reading the message, never both.

The button's icon is **drawn rather than typed**. It was a 💬, which sat
between the menu and the settings buttons — both inline SVG taking the bar's
own colour — as the one full-colour thing in a monochrome row, and arrived as
a different picture on Windows, Android and iOS, which nothing else in the bar
does. It is now one path with the three dots knocked out of the bubble by
`fill-rule: evenodd`, so the whole icon is a single shape following
`currentColor` and darkening on hover along with the border. Swapping it
turned up that the circle is 34px and the browser's own button padding is
`1px 6px`, which left a 20px content box for a 22px icon: it overflowed and
sat a pixel off centre. The 44px icon buttons either side had never noticed,
having 32px of room for the same icon.

A message is at most **160 characters**, and the box will not take a
character more: the cap is `CHAT_MAX_LENGTH` and the same number is enforced
by the security rules, so nothing can be typed that the room then refuses —
a refusal arrives after the send, with the text already gone from the box,
which is the worst possible moment to learn about it. Runs of whitespace are
collapsed, so a message that is forty newlines is inside every cap and still
cannot take the panel over.

Every message is drawn with `textContent` into nodes built one at a time.
It has to be: the body of a message is the one string in this app that
*another person* chose, and `innerHTML` anywhere on that path is a way to put
markup on somebody else's screen. The suite sends
`<img src=x onerror=alert(1)>` and asserts it arrives as those characters and
that no element was created.

**The log is capped at 40 messages and trimmed by whoever writes to it.**
There is no server here to prune anything — and, more to the point, every
move rewrites the whole room document, chat included. An unbounded log would
be a cost paid again on every move, by both devices, growing all game.

**Emotes** — eight of them, on a row above the message box: a wave, a
handshake, applause, thinking, surprise, fire, an *oops* and a *sorry*. One
lands as a bubble on the card of whoever sent it and fades after **five
seconds**, as well as appearing in the log.

Five rather than the 2.6 it was, because the person you sent it to is looking
at the board — that is why you are both here — and an emote sent while they
were thinking about a move had usually gone by the time they looked up, which
made it register as nothing at all. The extra time is spent entirely on the
still part in the middle: arriving and leaving are gestures of about 300ms
and 500ms, and stretching those only makes the bubble feel slow to appear.

The duration is written once, as `EMOTE_BUBBLE_MS`. The stylesheet reads it
from a custom property that `ui.js` sets at startup, because two copies of it
had to agree and the failure when they did not was a quiet one: the shorter
wins, so the bubble either vanished mid-animation or sat there finished and
faded until the timer caught up.

What travels is an **id, never a glyph**. The receiving device draws the
emote from its own copy of `EMOTES`, so the only thing an opponent can put on
your screen through this path is one of the eight pictures chosen in
`js/config.js`, and a message body reading `fire` cannot be made to render as
anything else. An id that is not on the list draws nothing at all rather than
leaving a gap. The set is also deliberately chosen: there is no emote here
that can be aimed at somebody, which is the cheapest moderation there is and
close to the only kind a client with no server behind it can do.

**Chat and emotes are one switch in Settings, and off means off.** Nothing is
sent, nothing arrives, no bubble pops and no count appears — and the chat
button goes away rather than sitting there refusing, because a button that is
there is a promise that pressing it does something.

**Friends** — a six-character **friend code**, claimed once and yours, on the
Friends panel reachable from the main menu. Give somebody your code, they
type it in, a request appears on your screen with the name they play under,
and you accept or decline. Both lists are written in a single update, so a
friendship can never end up half-made — a list where they have you and you do
not have them is worse than no friendship at all, because neither person can
see why. Removing works the same way, in both directions.

The code is the same alphabet as a room code, and for the same reason: it
gets read aloud or typed off a screenshot. They are still different things —
a room code names a game and dies with it, a friend code names a person and
does not — which is why the two lengths are separate constants that happen to
agree.

Be clear about what an account is here: sign-in is **anonymous**, so "you"
are a uid Firebase gave this browser. Clearing site data is the same as
deleting the account, a second browser is a different person, and there is no
password — so there is nothing to steal and nothing to recover. The code is a
label on that uid, kept in local storage *and* on the profile row, and
reclaimed from either on the next visit rather than a new one being claimed,
which would strand every friend holding the old one.

**Inviting somebody to play** — the point of keeping a list. Every friend
on it has an **Invite** button, and one tap does the whole thing: it hosts
a room, puts that room's code in front of them, and leaves you on the
waiting screen. On their phone the invitation appears at the top of the
Friends panel with **Join** and **Ignore**, the menu button carries a count,
and a line says who is asking even if they are in the middle of something
else. Joining needs no code typed and none read out — but the code is still
on the waiting screen for a friend who would rather type it.

An invitation is the one thing in that panel with a clock on it, because it
names a room rather than a person and a room only exists while its host is
sitting in it. So it expires by itself after three minutes — hidden on the
receiving side, and actually deleted from the database on the sending side
— and leaving the room takes every invitation into it along as well. That
is deliberate: an invitation pointing at a room that has gone is worse than
no invitation, because tapping Join on one gets "room not found", which
reads like a broken app rather than a late reply.

Only somebody already on your list can send you one, which is stricter than
a friend request on purpose. A request from a stranger is a name and a
question you can decline; an invitation is an offer to walk into a room
somebody else controls, and that is not something a guessed code should be
able to put on your screen. The rules enforce it as well as the client
does.

**Online status** — a friend shows as **Online**, **In a game**, or offline
with a rough "last seen", each with a coloured dot so a list can be scanned
rather than read. Presence is written when the app opens and cleared by an
`onDisconnect` handler that lives on Firebase's servers, so it fires for a
closed laptop as well as for a tapped Back button.

It is also re-stamped on a timer, because that handler covers the ordinary
case and not the odd one: a client can die in a way the server never notices
— a lid, a tunnel — and a record older than `PRESENCE_STALE_MS` is read as
offline rather than shown to a friend who would then wait for somebody who is
not there.

This is a different thing from the `connected` flag on a seat, and the two are
kept apart deliberately. A seat answers *"is the player I am facing still on
the other end of THIS game"*; a person answers *"is my friend about at all"*.
The first is about a room and dies with it; the second outlives every room.
Going online starts the friends layer even if the panel is never opened —
otherwise somebody with friends would appear idle to all of them for the
whole game they are visibly in the middle of.

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

**Background** — four grounds in Settings: *Midnight* (the default cool dark),
*Charcoal*, *Forest* and *Mahogany*. Not only the strip around the board —
the 3D renderer is transparent, so the page shows through its scene as well
as around it, and changing this changes what the board is sitting in. Each one
redefines the surface tokens only — ground, glow, panels and borders, in one
hue, holding the lightness ladder the default sets — so cards, modals and
toasts follow without being listed. Text and accent tokens are deliberately
untouched: they carry the contrast, and every background is checked against
them (body text clears **AAA** on the ground and on a panel in all four).
Each swatch in the picker is the game screen in miniature — ground, a player
card, the gold pip — rather than a square of the ground: these grounds are all
within a few points of black, so a plain chip of one is a black box that tells
you nothing. What separates them on a real screen is the ground seen against
the cards and the accent on it, so that is what the swatch shows.

Applied before first paint by the same inline script that applies the skin,
so coming back to a saved choice never flashes the default first.

**Interface** — start screen, new-game setup, waiting room with the shareable
code, responsive game screen, friends panel, chat sheet, settings (sound,
board theme, background, coordinates, animations, auto-flip, chat and emotes),
custom confirmation modals, toasts, and a collapsible move history.

**Every control answers the pointer** — hovering any button lifts it 2px,
opens a shadow under it, and on the gold and red solid buttons sends a sheen
across the face. One block at the end of `style.css` rather than a transform
scattered through nine components, and it is deliberately last in the file:
these selectors are no more specific than the component rules they extend, so
source order is what makes them win.

Three things are excluded on purpose. The **lift sits behind `hover: hover`**,
because a touch screen reports a tap as a hover and then keeps reporting it —
unguarded, a phone leaves the last button you pressed floating and lit. A
**locked control** (the Undo) does not move or glow, which is the whole point
of it being locked. And **`prefers-reduced-motion` removes the movement
entirely** rather than letting it snap to its finished position with the
transition stripped off: the jump without the motion is the worst of both.
The colour changes stay there — the control still answers, it just does it by
lighting up rather than by moving.

Keyboard focus gets the same lift as hover. A control that lights up for a
mouse and does nothing for Tab is telling half the room it is not for them.

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
├── .nojekyll                     Tells GitHub Pages to serve the files as they are
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
│   ├── firebase-client.js        One app, one sign-in, shared by the two things that connect
│   ├── social.js                 Friend codes, requests, friends, presence
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
│   │   ├── bot-session.js        The bot, as a mixin over any base provider
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

**Redeploy them after updating the app.** The rules have grown five times
now — seat pictures, then chat, then friends and presence, then a longer name
cap, then a much longer one — and each time, a project still running the older
set refuses the new feature rather than ignoring it. Nothing breaks: a room is
still created, a game is still playable, and the app says which thing needs the
deploy. But the feature stays off until this command is run.

The name cap is the one to watch, because it is the only one of the five that
a player meets by *typing something* rather than by pressing a button that is
missing. A client at 120 against rules deployed at 20 refuses the name and
nothing else, and the refusal arrives on a rename that looked like it worked
— so it says so specifically now, and names this file.

If `firebase-tools` is not installed, the same file can be pasted into
**Realtime Database → Rules** in the Firebase console and published — which
is a much shorter road than installing a CLI and logging in, for a console
you are already signed in to.

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

Board orientation, sound, theme, background and animations are per-device display
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
    "w": { "uid": "abc123…", "name": "Alex", "connected": true,
           "avatar": "data:image/webp;base64,UklGR…" },
    "b": { "uid": "def456…", "name": "Sam",  "connected": true }
  },
  "chat": {
    "mk3f9x-a2b": { "uid": "abc123…", "color": "w", "kind": "text",
                    "body": "good luck", "at": 1736300031000 },
    "mk3fa1-7qz": { "uid": "def456…", "color": "b", "kind": "emote",
                    "body": "gg", "at": 1736300044000 }
  }
}
```

A message key is its timestamp in base 36 plus a short random tail, so the
natural key order is also the reading order and two messages sent in the same
millisecond — one from each device — are still two messages. `push()` would
do this better; it is not used because appending goes through a transaction
on the whole `chat` node, which has to know the key it is adding before it
adds it, so that it can sort and drop the oldest in the same write.

The stamp is the **sender's** clock, which is the honest trade. A server
stamp would order two badly-skewed phones correctly, but it does not resolve
until the write lands, and the write is the thing that needs to sort the log
in order to trim it.

The rules on a message are worth reading carefully, because one line in them
is load-bearing in a way that is easy to miss. `uid` must equal `auth.uid`
**or be unchanged from what is already there**, and `color` likewise must
either be unchanged or match the seat you are sitting in. Without the
"unchanged" halves, the first message would break every subsequent move: a
move rewrites the whole room, chat included, so the opponent's messages are
re-sent by your client on every move and would be refused as forgeries.

`avatar` is optional and absent rather than null when there is no picture:
Realtime Database reads a null child as a deletion instruction, and the rules
validate the field only when it is present. It is capped at **6144
characters** and must be a `data:` URL of a raster image — the rules are what
stop a room being used as free file hosting, and they are the half of that a
modified client cannot talk its way past.

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

### Friends, and who is about

Rooms are not the only thing in the database any more. Two more trees sit
beside them, and neither one dies with a game:

```json
{
  "handles": { "K7M2QD": "abc123…" },

  "users": {
    "abc123…": {
      "profile":  { "name": "Alex", "code": "K7M2QD", "updatedAt": 1736300000000,
                    "avatar": "data:image/webp;base64,UklGR…" },
      "presence": { "state": "playing", "at": 1736300042000 },
      "friends":  { "def456…": { "at": 1736200000000 } },
      "requests": { "ghi789…": { "name": "Sam", "code": "P4XB2T", "at": 1736290000000 } },
      "sent":     { "jkl012…": { "at": 1736295000000 } },
      "invites":  { "def456…": { "name": "Sam", "room": "K7M2QD", "at": 1736299000000 } }
    }
  }
}
```

`handles` is a claim-once index from code to uid: the rules let you write one
only if it does not exist or already points at you, and only with your own
uid as the value. That is what makes "add by code" possible without anybody
being able to repoint somebody else's code at themselves.

`profile` and `presence` are readable by **anyone signed in**, and that is
deliberate rather than an oversight — resolving a friend code means reading a
stranger's row, so it could not work otherwise. `friends`, `requests` and
`sent` are readable **only by their owner**.

Accepting a request is the one operation that writes into somebody else's
subtree, and the rules allow it narrowly: you may add yourself to
`users/$them/friends` only while `users/$you/requests/$them` still exists —
that is, only while their request to you is standing. Because `root` in a
rules expression is the state *before* the write, the same update can delete
the request it is relying on, which is how both lists and both cleanups land
atomically. Removing a friend is allowed without that proof, since a delete
cannot be used to put anything anywhere.

`invites` is an inbox like `requests`, with one difference that carries the
whole feature: a request may be written by anybody who knows your code,
while an invite may only be written by somebody **already on your friends
list** — `root.child('users').child($uid).child('friends').child($fromUid)`
has to exist. Deleting one is exempt from that check, so an invitation can
still be withdrawn after a falling-out. There is no lock on the room code
itself beyond its shape, because a room code is not a secret: knowing one
has always been the way into a game.

Nobody can read what they have written into somebody else's inbox, so the
sending device keeps its own record of what it has sent. That is what the
"Invited" on a row is drawn from, and what the withdrawal aims at when the
room goes.

Each friend on your list gets one profile listener and one presence listener,
rebuilt from the list whenever it changes rather than patched on add and
remove — a listener left behind by a removed friend would go on reporting a
presence for a row that is no longer on screen. A request needs no listener at
all: it carries the name it was sent with, so a stranger asking cannot make
your device subscribe to a stranger's row.

---

## Trust model

Being straight about this matters more than sounding secure.

**What the security rules enforce.** Only authenticated users can read or
write. Only the two seated players can write to a room. A seat can only be
claimed when empty and only for your own uid. The host never changes. Every
field is type-, pattern- and length-checked, and unknown fields are rejected.
A draw can only be offered in your own name. A profile picture must be a
`data:` URL of a raster image and at most **6KB**, so a room cannot be used as
file hosting and a picture cannot be a URL pointing at somebody's server. The
client holds itself to that same 6KB before it ever writes a seat, but it is
the rules that make it true of everyone.

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

**What chat and friends add to this, and what they do not.** A message must
carry your own uid and the colour of the seat you are in, so nobody can put
words in their opponent's mouth; it must be text or one of eight emote ids,
and at most 160 characters, so the log cannot become file storage. A profile
picture is held to exactly the same rule as a seat picture — the same line,
checked by the test suite to be the same line. A friend request can only be
written by the person it is from, and never to yourself. An **invitation**
is held tighter still: only somebody already on your list may write one,
and it may carry nothing but a name, a room code of the right shape, and a
time.

Two things are worth saying plainly. **Either player can delete the other's
messages**, because both can write the room and a deletion needs only write
access — the same reason either can delete the room. And **muting is the only
moderation there is**: the send cooldown lives on the sender, so it stops a
leaning finger rather than a modified client. What actually protects somebody
from an unpleasant opponent is the switch in Settings, plus an emote set with
nothing in it that can be aimed at a person.

**An anonymous uid is not an identity.** There is no password, so nothing can
be phished; equally, nothing can be recovered. Somebody who guesses a friend
code can put one request in front of you, which you decline; they cannot read
anything of yours. But a friends list built on browser-local credentials is a
friends list that a cleared cache deletes, and this is the honest ceiling on
what accounts mean here until real sign-in exists.

What an invitation does **not** protect you from is a friend you have
stopped wanting to hear from: they can keep sending them for as long as
they are on your list. The answer to that is the same as the answer to an
unpleasant opponent — take them off it, which is one tap and clears both
sides.

**Rate limiting and cleanup are not implemented.** An authenticated user can
create unlimited rooms, and rooms are never deleted. Nor are profiles,
handles or presence rows. Expired invitations are the one thing here that
does clean up after itself, and only because the client that sent it is
still running; one sent by a tab that was then closed is left behind,
invisible to everybody, until that device sends the next one. Before running this publicly you would want a
scheduled cleanup of stale rooms and handles, App Check, and a server-side
cap on how many requests one account can send.

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

Five independent `localStorage` keys are used so a corrupt game never costs
you your preferences:

- `chess-arena:game` — the current game
- `chess-arena:settings` — sound, board theme, background, coordinates,
  animations, auto-flip, chat and emotes
- `chess-arena:avatars` — the remembered profile picture for each New Game seat
- `chess-arena:profile` — the name this device plays online under, and the
  friend code it claimed

Profile pictures get their own key rather than living inside settings. They
are the only thing here measured in kilobytes rather than bytes, and a quota
failure writing a picture must not take the settings record down with it.

The profile is separate for a different reason: it is an identity rather than
a preference. Losing a setting costs you a tap; losing the friend code costs
you the list, because the next visit would claim a new one and strand
everybody holding the old. (The code is also on the profile row in the
database, and is reclaimed from there first — so this key is the fast path,
not the only copy.)

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
real app in Chromium and the shipped security rules in the database emulator.
Pictures on online seats add **36 more**, the background setting **32**, hover feedback **20**, chat, emotes, friends and presence **110**, long names **56**, a confirmation raised over a sheet **40**, renaming mid-game **48**, the emote bubble **14**, with **15** more run against the deployed site and the real Firebase project rather than a stand-in. A further **440** covered Elemental Chess — the variant, its powers panel, the powers being chosen, and the supers — and went with the mode; they are not counted here because there is nothing left for them to run against. The groups were run separately, so
the totals are reported separately rather than as one number:

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
| Rules (emulator) | 14 | The rules of the time loaded into the database emulator and driven as an ordinary signed-in user: a room with no picture accepted, unknown player fields rejected, a stranger's uid refused a seat. Its avatar rows asserted that *every* picture was rejected, which was true of the rules then deployed and is no longer true of the rules in this repo — superseded by the suite below, not re-run |
| **Pictures on online seats (Chromium ×2)** | **36** | **Two devices against a database that enforces the shipped rule text — the cap and the pattern are read out of `firebase/database.rules.json` itself, so client and rules are checked against each other rather than against anyone's memory. A photograph over the budget at 128px comes back 96px and inside it; one already inside is not re-encoded a second time; a remote URL, an SVG and nothing at all are all refused. Two players create, join, and see each other's face on both devices, and the room document carrying both faces is 9,475 bytes. Then the same run against rules that do NOT know the field: the write is refused, the room is created anyway without the picture, both players are told why, and the game is playable — the failure that this feature caused the first time it shipped. Zero console errors** |
| **Background (Chromium)** | **32** | **All four grounds: each repaints the page, marks only itself checked, and previews itself in the picker rather than the one in force; the choice survives a reload and is proved to be on the root element BEFORE any module runs (app.js blocked, the attribute already set), so it cannot flash the default first; an unknown id out of storage lands on the default. The swatches are measured rather than admired: each must show a card that separates from its own ground (fill and outline both), and no two cards may be within 8 points of each other — the check that a paint-chip preview would fail even while every ground was technically a different colour. Contrast is computed from the token values in the stylesheet itself for every background — body text AAA on the ground and on a panel, muted text AA, the accent legible — rather than eyeballed** |
| **Hover feedback (Chromium)** | **20** | **Measured as a pointer, as a finger, and as someone who asked for less motion. With a pointer: buttons, icon buttons, the picture pickers and the swatches all lift exactly 2px and settle back when it leaves, the gold buttons glow gold rather than grey, the sheen is a real gradient behind the label, and hovering the chosen swatch does not strip the outline that marks it chosen. Locked Undo stays flat and shadowless while Flip beside it lifts, and a press beats the lift. On a touch screen the media query does not match, so a tapped button is not left floating. Under reduced motion the lift does not happen at all and the sheen is gone rather than parked mid-sweep. Caught two real specificity bugs: the gold glow was losing to the generic hover rule, and the reduced-motion override was losing to both** |
| **The deployed site (Chromium ×2 + real project)** | **15** | **The published URL on a phone viewport, the real SDK from the CDN, the real rules: two anonymous accounts claim two friend codes, one adds the other by code, the request arrives with the right name, accepting writes both lists, then a real room with a real message and a real emote crossing between them, a move landing after the conversation, and presence moving to "in a game" on the friend's screen. It removes its own rooms, profiles, presence, friendships and handles afterwards, so the database is left as it was found. Caught a real bug: a friend whose presence had not arrived yet was being announced as offline** |
| **Chat, emotes, friends, presence, invitations (Chromium ×2–3)** | **110** | **Fifteen of them read `firebase/database.rules.json` itself and assert what it says — that a message can only be written as yourself *or left exactly as it was*, that a colour must match the seat you hold, that a friends list is readable only by its owner, that somebody may add themselves to yours only while your request stands, that a request cannot be sent to yourself, that an invitation may only be written by somebody already on the list while withdrawing one is always allowed, and that the profile-picture rule is byte-for-byte the seat-picture rule. The rest drive two and three real browsers against a database that enforces that rule text. Two players talk: what you send lands on your own side and the other side, attributed to the seat, counted as unread while the sheet is shut and cleared when it opens. An emote arrives named and is drawn from the receiver's own list; with the sheet open it stays in the log on **both** devices, and only with the sheet shut does it pop on the card of whoever sent it. That pair replaced an assertion that checked for a bubble while the sheet was open — a bubble nobody could see, since the sheet is drawn over the cards, so it passed for as long as the bug existed and would have gone on passing. `<img src=x onerror=alert(1)>` arrives as characters and creates no element. **A move after a conversation is not refused** — the check the "unchanged" rule clauses exist for, and the one that would have broken every game after the first message. A log of 60 is shown 40 deep, oldest dropped, and sending into a full log trims the room rather than growing it. Blank, whitespace-only, over-long and unknown-emote sends are each refused for their own reason, and a second send in the same instant is refused for the cooldown. With the setting off the button is gone, both sends refuse, and nothing arrives on screen. Two devices claim two different friend codes, each handle points back at its claimer, a request crosses with the right name, accepting writes both lists and clears both cleanups, and removing clears both. Presence follows a game: starting one moves a friend to "In a game" on the other device without anybody reopening the panel. A reload reclaims the same code rather than a second one. Then the whole thing again against rules that know none of it: the game is still playable and the move still crosses, the message is refused with an explanation, and the friends panel says the rules need deploying rather than sitting empty. It also holds the mode list in place: the five modes in their intended order, and choosing any one of them marking that one and only that one — measured from computed styles after the transition has finished, because a row caught mid-fade looks selected and this project has been fooled by that twice. That check found a real bug: Online Multiplayer could not be highlighted at all, because the rule keyed on a class its label had never carried. Then invitations, on three browsers at once: a friend who is about can be asked, one who is not on the list cannot — and a third browser going round the client and writing straight at the database is refused by the rules, which is the check that matters, since the client is the half an attacker replaces. One tap hosts a room, stands in it, gets the panel out of the way, and writes an invitation naming that room, under the right name, carrying nothing else; the row for that friend then says "Invited" and will not send a second. Cancelling the room withdraws it rather than leaving it pointing at a room that has gone. Asked again, the other phone shows a count with the panel shut, the invitation named and offering both answers, and Join seats both players in that one room with no code typed anywhere — after which the invitation is deleted and the count is gone. An invitation seeded three minutes old is not offered at all, neither in the panel nor in the state behind it. And the only write refused in the whole run is the one that was supposed to be. Zero console errors** |
| **The emote bubble (Chromium)** | **14** | **A duration, so it is measured rather than trusted: the bubble is fired and watched at 50ms intervals until it goes, and it has to still be there well past the old 2.6s and to leave within a small margin of the configured time — it lives 5,014ms against a configured 5,000. The stylesheet is checked to READ the duration rather than repeat it, no emote animation is left carrying a hard-coded one, every `var()` fallback matches the constant, and the custom property is confirmed on the root of a running page. Plus the things a longer bubble must not break: it still appears at once, carries the right glyph, and a second emote replays the animation instead of sitting still because the class was already on** |
| **Renaming a player mid-game (Chromium ×2 + real project)** | **48** | **Two browsers in one real room. The control appears on exactly one card and it is the seat that device is sitting in — checked against the colour rather than the position — while the same card on the opponent's screen has no button at all. The name becomes a box holding the name it already had; Enter commits, the card updates, and the OTHER browser shows the new name without reloading. A move still plays afterwards, so the rename did not disturb the game. Escape abandons the edit instead of saving it, a blank name is refused with a reason, and the new name is written to the stored profile for the next room. The room is deleted afterwards, so the database is left as it was found. Then the offline modes, each checked for the cards it should offer rather than for a blanket answer: local two-player offers BOTH, and a bot game offers yours and not the bot's. In each, the rename goes in through the real control, lands on the card and in the game state, and survives a reload through the autosave. The bot's own seat refuses a rename asked for directly, and its name is untouched afterwards. And a local rename leaves the stored online profile alone, which is the one way this could have quietly changed who you are to your friends** |
| **A confirmation over a sheet (Chromium)** | **40** | **Which of two dialogs is in front, asked the only way that means anything: `elementFromPoint` in the middle of the panel, on the Remove button, and in the corner of the screen. All three came back `modal-friends` before the fix — the question was up, drawn, and completely unreachable. Driven through the real × on a real friend row, with the row seeded rather than fetched, because which dialog is in front needs no database. The row carries whose it is for a screen reader, the dangerous button is toned dangerous and says "Remove" rather than "OK", and the sheet stays open underneath. Then the bookkeeping the stacking hid: cancelling closes the question and not the sheet, and leaves the page behind locked — it used to unlock under an open sheet — while Cancel still answers false, which is what stops the removal. Escape unwinds one layer at a time, the sheet coming back still open and still locking, and only the second press lets the page behind scroll. Confirming answers true. The same again over the CHAT sheet, which is also later in the markup, where the chat has to keep counting as open underneath: a message arriving while a confirmation sits over the log is not news. And the whole thing at 320, where both buttons are 44px and reachable by a finger, and the dialog fits without a sideways scroll. The seed being wiped mid-suite by the app's own social repaint is why the rows go back in before every press: the first press worked and the second found an empty list, which read exactly like a friend having been removed by CANCELLING** |
| **Long names (Chromium)** | **56** | **The cap is one number and everything agrees with it: all four name boxes read it out of config, the four rules in `database.rules.json` carry it, the markup fallbacks match, and no `slice(0, 20)` is left anywhere — checked by reading the shipped files rather than by remembering. Then a 37-character name through the real form: typed whole, over the cap stopped AT the cap rather than let run, carried into the game intact, held whole in the card's DOM and offered in full on hover where the card clips it, and back whole after a reload. The card is measured at 320 and 390 — one line still, inside its own card, no sideways scroll. The stored profile keeps it at full length with Firebase cut off, which is where the cap actually lives. And the state every existing installation will be in the moment this ships: client at 120, deployed rules still at 20 — the friends hub still comes up, the box still shows the whole name, and the panel says plainly that the rules need deploying and names the file. Waited for rather than slept through, because a refused write costs a real round trip and a fixed wait landing early reads as "no hub at all" — which is exactly how this was briefly mistaken for a regression. Then the whole of it again with a name of MANY WORDS filled up to the cap rather than counted out to it, because a run of 120 x's proves the field holds 120 characters and nothing about whether a person could use it: fifteen words typed in full, reaching the seat with every word intact, clipped on the card rather than growing it, the whole sentence on hover, and at 320 and 390 still one line, still inside its own card, still no sideways scroll. Including through the box the complaint actually came from — the pencil on your own card, which gets the cap from config like the other four and takes a sentence without trimming it. And the three places a name is drawn are read out of the shipped CSS rather than trusted, because two of them only ever appear in a room with a second person in it. Then the refusal itself: a long name turned down online is called too long and told which file to deploy, a short one keeps the sentence that fits it, and the guess between them is made against a named floor rather than a bare 20. And last the pill that has to carry it, measured at 320 rather than looked at — a toast may use the width of the phone rather than half of it, is centred within it to the pixel, and the one naming a file stays on the screen instead of hanging off the side it was centred within. That measurement is the whole of how (16) was found** |
| **Your picture from the friends panel (Chromium)** | **38** | **The picker is in your own card, says what it does, and imports a real PNG through the real pipeline. It is ONE picture: the same data URL lands on the online form’s picker, in storage and on the hub, setting it in either place shows in both, and clearing it in either clears both. It survives a reload. Then the same again with every remote Firebase request aborted — the hub up, not connected, its own copy of the picture null — where the picture has to stay put on both pickers and in storage, which is the bug that pass caught. Plus a regression pass proving the two seat pickers are still separate slots: a picture on Player 1 reaches the white seat and nothing else** |
| **Profile pictures — regression (Chromium)** | **24** | **The paths whose signatures changed: the bot seat never inherits a picture, a rematch carries each picture across the colour swap, the mode toggle still hides the right rows, and a move still plays** |
| **Profile pictures — EXIF (Chromium)** | **3** | **A JPEG built with a real EXIF Orientation tag comes out upright, proved by which edge the colours land on — the classic sideways-avatar bug, tested rather than assumed** |
| Live two-device game (Chromium ×2 + real project) | 11 | Two browsers against the actual Firebase project, not the emulator: create, join, seats and names sync, a move each way, room deleted afterwards. Pictures were off at the time and so went untested here; the suite above covers them, but against a stand-in for the database rather than the real one |
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

Fourteen real bugs were caught and fixed. Three in Phase 1:

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

And four from Elemental Chess. **That mode has since been removed**, so the
files and methods named below are no longer in the tree — the entries stay
because the lessons are about layering, caching and what a view may ask, none
of which left with the variant. The first two are the same shape: a thing that
resets itself and a thing that counts, neither of which the variant remembered
to tell the rest of the app about.

11. **A rematch inherited the previous game's spent charges.** Restart and
   Rematch rebuild the position in `LocalSession`, which the elemental layer
   sits above and which knows nothing about charges. So the pieces went back
   to their squares and the bookkeeping did not: a rook that had spent its ice
   an hour ago was still spent, effects laid in the game before were still
   standing, and the ply they expire against never reset so they never
   expired. Every bit of it invisible until somebody tapped a piece and was
   told it had nothing left. Fixed by overriding `submitAction` to reset the
   elemental state and re-charge the board for exactly those two actions —
   and deliberately not for Undo, which is locked app-wide and would need a
   history of every power ever used to roll back through.

12. **A game seven moves deep offered to resume "0 moves played".** The
   Continue dialog counts `state.moves`, which is chess.js' move list — and a
   power that changes the board reloads the FEN, which clears that list. The
   position was right, the count was of the moves since the last burn. It is
   the small, plausible kind of wrong that nobody reports and everybody
   half-notices. Fixed by counting from the FEN's own full-move counter for
   the modes that persist by position, which is exact and needs nothing
   stored.

And one from putting the picture picker in the friends panel, which is the
same lesson as (4) wearing different clothes — a cache that is empty until a
round trip lands, read as though it were empty because there is nothing there:

13. **Opening the friends panel wiped your profile picture.** The obvious way
   to keep two controls onto one picture in step is to render both of them
   from the hub, which owns the profile. But the hub loads its copy inside
   `#connect`, *after* awaiting Firebase — so before that round trip lands,
   and for ever on a device that cannot reach it, `social.avatar` is null.
   Rendering that null painted "no picture" over both pickers the instant the
   panel opened, and the picture was still in storage the whole time, so it
   came back on the next reload and went again on the next open. Fixed by
   leaving storage as the one source the pickers read: it is what the hub
   itself loads from, so there is nothing for them to be out of step with.
   The test that catches it aborts every remote Firebase request and then
   checks the picture is still there — which it is not, against the version
   without this fix.

And one from the powers panel — also gone with the mode — which is the only
bug here that was invisible by design:

14. **Choosing a power from the panel froze the entire UI, silently.** The
   panel can ask which piece should cast, and in that moment there is no
   caster yet — so the aiming state carries a null square until the question
   is answered. The 3D board had never seen one: it marks the caster on every
   repaint, and a null square threw. Nothing went red. The controller wraps
   every view listener so that a broken renderer cannot take the game down
   with it, which is right, and it means a renderer throwing on every repaint
   looks *exactly* like a UI that has decided to stop changing — no error, no
   crash, stale pixels. Escape did nothing, the bar kept the wrong text, and
   the power bar was still sitting there after a resignation, because none of
   them had been repainted since. Fixed by not marking a caster that does not
   exist yet. The flat board was unaffected, and not by luck — it compares
   `square === aiming.from`, which is simply false everywhere when `from` is
   null.

   The lesson was the test rather than the fix. The suites all asserted "no
   console errors", and that assertion **passed for the whole time the bug was
   live** — a swallowed throw is a warning, not an error. The harness now
   collects warnings too and every suite asserts that no view threw and got
   caught. Putting the bug back proves it: the old check still passes, the new
   one fails and names the line.

   The stage that caused it has since gone — powers reach the whole board, so
   every charged rook offers the same freeze and there is nothing to ask. The
   null guard stayed. It costs one condition, and a state that cannot happen
   today is a poor thing to have built a renderer around twice.

And one more from the same mode, which had been sitting there the whole time
being hidden by a rule that changed underneath it:

15. **The panel flashed the bot its own hand.** The elemental session refuses
   to answer questions about a colour this device may not move — which is what
   stops a player firing the bot's rook — and it stands that refusal down for
   exactly as long as the bot is inside the session using a power of its own,
   because the bot is not at a keyboard and needs the same two methods. Fair
   enough for `getPower`. Not for `getArsenal`, which is a *view's* question:
   the panel repaints on every published state, one of the states the bot
   publishes lands while that flag is still up, and the panel would draw the
   bot's counts and its readiness on the player's screen for a frame or two
   before going blank again. Fixed by having `getArsenal` ask
   `getControllableColors()` directly and never the flag — a view's answer
   must not depend on whether the opponent happens to be mid-thought.

   It was only ever reachable in a window a frame or two wide, and the test
   that catches it had been asserting the right thing for the wrong reason for
   months: it passed because the bot never had a power ready that early, back
   when reach came off the caster's own lines. Widening the reach made the bot
   fire on move one, every game, and the assertion started failing — which is
   the most useful thing a test can do.

16. **Every toast had been laid out against half the screen.** The strip the
   pills sit in is `position: fixed` with no width, and it was centred the
   familiar way — `left: 50%` with a `transform: translateX(-50%)` pulling it
   back. That centres it correctly and quietly halves it: a fixed box with no
   width shrinks to fit inside what is left of the viewport *from its own left
   edge*, and the transform is a paint-time move that the layout has already
   finished without. So on a 320px phone the strip was 160px, and every toast
   wrapped at half the width its own `max-width: min(88vw, 340px)` allowed.
   Fixed with `left: 0; right: 0` and no transform, the pills already being
   centred by `align-items: center`.

   Nobody had noticed because nothing measured it and the messages were short
   enough to survive it — "The room would not take that name" merely came out
   on two lines instead of one. It surfaced while checking whether a longer
   refusal would fit, and the longer one did not merely wrap: it contains a
   filename, which is one unbreakable word, so it blew straight through the
   160px and hung off the side of the screen it had been so carefully centred
   within. `overflow-wrap: anywhere` on the pill is the other half of that.

   Found by measuring rather than by looking, which is the only way this kind
   is ever found. A centred thing that is too narrow still looks centred.

17. **The confirmation opened behind the sheet that raised it.** Every modal
   shares `z-index: 100`, so which of two overlapping ones is in front came
   down to which was written later in `index.html` — and the confirmation is
   written second of nine. All seven after it covered it, the friends sheet
   among them. Pressing × on a friend put a question up behind an opaque
   sheet: nothing appeared to happen, the × appeared broken, and the app was
   in fact waiting on an answer that could not be seen or reached. Escape or
   the sheet's own backdrop were the only ways out, and both read as giving
   up rather than as answering. Fixed by giving the confirmation a level of
   its own at 110 — above the other dialogs, below the toasts at 200, because
   a toast has to be readable over anything. The draw offer is raised with it:
   it arrives from the network, so it can land while a sheet is up, and it was
   the same bug waiting for the Draw button to come back.

   The invisible half was bookkeeping. `#openModal` is one slot, which held
   for as long as dialogs never overlapped. A confirmation breaks that by
   design — it is always raised from on top of something — so opening one
   overwrote the name of what it covered, and settling it set the slot to
   null. The page behind started scrolling again underneath a sheet that was
   still open, and a later `closeModal()` with no argument had nothing to
   close. It now remembers the one thing underneath and hands it back, one
   deep rather than a stack, because one is the depth the app actually uses:
   nothing raises a confirmation from on top of a confirmation.

   `isChatOpen()` and `isFriendsOpen()` stopped asking that slot and started
   asking the sheet, which is the only thing that knows. Both were briefly
   answering "no" while a confirmation sat on top of an open sheet — and the
   chat one decides whether an arriving message is news, so a message landing
   in that window would have been counted unread while you were looking
   straight at the log it arrived in.

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
| 31 | Pick a background in Settings | The whole page repaints at once — ground, cards, modals and all |
| 32 | Reload after picking one | It is still there, and was there from the first frame rather than snapping in |
| 33 | Open Friends from the menu | A six-character code appears; copy it |
| 34 | Type your name in the Friends panel | It is remembered, and the New Game form offers the same name |
| 35 | Turn Chat & Emotes off, then join a game | No chat button; nothing arrives and nothing can be sent |
| 36 | Open Friends with nobody on the list | No Game invites section at all, and the empty line explains what to do |

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
| 31 | Choose a picture on each device before joining | Both faces show on both devices, on the right seats |
| 32 | Play with the rules not yet deployed | Room still opens, no pictures, both players told the rules are out of date |
| 33 | Send a message from device A | It appears on B; the chat button carries a count until B opens the sheet |
| 34 | Tap an emote | It pops on the sender's card on *both* devices and appears in the log |
| 35 | Make a move after chatting | The move lands normally — chat does not break the room write |
| 36 | Swap friend codes and add each other | A request appears with the right name; accepting puts each on the other's list |
| 37 | Start a game while a friend watches their list | They see you move from Online to In a game |
| 38 | Close the tab | The friend sees you go offline within moments |
| 39 | Tap Invite beside a friend | You land on the waiting screen with a code; their phone shows a count on Friends |
| 40 | Open their Friends panel | The invitation is at the top, named, with Join and Ignore |
| 41 | Tap Join | Both devices are in the same game, no code typed anywhere |
| 42 | Invite, then Cancel the room | The invitation disappears from their panel rather than pointing at a dead room |
| 43 | Invite somebody who is offline | The button is there but refuses, and says why |
| 44 | Tap × beside a friend | The question appears **in front of** the sheet with both buttons pressable; Cancel leaves them on the list and the sheet open; Escape closes the question only |

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

11. **There is no clock.** There was one, for Speed Chess, and it went with
    that mode. It was local-only and could only ever have been: online is two
    devices with two ideas of the time, and a client that owns its own clock
    can simply decline to flag, so a real one needs the server holding the
    time — a Cloud Function owning the write, the same change move validation
    would need. If a clock comes back it belongs in the session provider,
    which is where the last one lived.

12. **A flag would fall even when the winner could not possibly mate.** This
    is written down because it is a trap for whoever adds a clock back. Under
    FIDE rules a player who runs out of time draws rather than loses if the
    opponent has no way to force mate — king alone, king and bishop. Here it
    is a loss either way. Deciding it needs "can this material force mate",
    which chess.js exposes only for the position as a whole rather than per
    side, so it would have to be reasoned out here. Rare enough in a blitz
    game to be worth naming rather than guessing at.

13. **Online games have no rate limiting and no room cleanup.**
    Rooms are never deleted, and an authenticated user can create unlimited
    ones. Before running this publicly, add a scheduled cleanup and App Check.

14. **A disconnected player's seat is held indefinitely.** There is no
    abandonment timeout, so a game whose opponent never returns stays open. You
    can leave the room, but you cannot claim a win.

15. **Move legality is enforced by clients, not the server.** See
    [Trust model](#trust-model) for exactly what that does and does not mean.

16. **Two of the finish refinements are switched off without a GPU.** The
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

17. **Perspective still costs tap size, but far less than it did.** The far
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
6. **There is no clock in any mode.** The one that existed belonged to
   Speed Chess and was removed with it. It was local-only for the reason
   given above: a client that owns its own clock can decline to flag, so a
   real one has to be held by the server.
7. **Draw offers are trust-based**, as they must be when both players share a
   device.
8. **Threefold repetition is auto-claimed**, not offered as a choice. FIDE
   makes it claimable; this app ends the game automatically.
9. **A friends list is only as durable as the browser it lives in.** Sign-in
   is anonymous, so the account is a uid in this browser's storage: clearing
   site data deletes it, and a phone is a different person from a laptop.
   Real sign-in is the fix and is a Phase 4 concern; nothing about the data
   model would have to change, because everything already hangs off a uid.
10. **An invitation only reaches somebody with the app open.** There are no
   push notifications, so an invite lands in a panel rather than on a lock
   screen: a friend who has the tab closed will never see it, and it will
   have expired by the time they do. Presence is what makes that workable —
   the button is refused for somebody who is not there — but "Online" can
   be up to a couple of minutes stale in the optimistic direction, so an
   invitation can still be sent into an empty room. Real notifications mean
   a service worker and FCM, which means a server, which is a Phase 8
   concern.
11. **An invitation sent by a tab that is then closed is left behind.** It
   expires from view on both sides after three minutes, and the sender
   deletes it when the room goes — but that deletion runs in the sender's
   browser, so a tab closed before then leaves the row in the database,
   invisible to everybody, until that device sends its next one. Nothing
   here can fix that without a server; an `onDisconnect` handler could
   cover the common case and was left out deliberately, because it would
   have to be registered per recipient and would then fire against
   whatever invitation happened to be there at the time.
12. **Chat has no moderation beyond a mute.** The send cooldown lives on the
   sender, so it slows a finger rather than a modified client; the emote set
   is chosen so that nothing in it can be aimed at somebody; and either
   player can delete the other's messages, because both can write the room.
   The switch in Settings is the real protection. A reporting or blocking
   system would need a server.
13. **Presence can be up to a couple of minutes stale in one direction.**
   Firebase clears it on disconnect, which covers the ordinary case
   server-side; a client that dies without the server noticing is caught
   instead by `PRESENCE_STALE_MS`, so a friend can show as online a little
   after they have gone. Shortening it means a more frequent heartbeat,
   which is the trade.
14. **Two modern CSS features are used, both with fallbacks.** `:has()` powers
   the setup screen's "this is the mode you picked" highlight — keyed on the
   row not being *disabled*, rather than on a class every label has to
   remember to carry (unsupported browsers lose only that highlight),
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
| **3** | Clocks — 1 / 3 / 5 / 10 / 15 minute | Built as Speed Chess, then removed with it. Server-held time is the version worth having, which makes this Phase 8's problem |
| **4** | Accounts — username, profile, match history, statistics | Partly — a name, a picture, a friend code, friends, presence and invitations to play all exist, on anonymous sign-in; no real accounts, history or statistics yet |
| **5** | Competitive — ELO, leaderboard, matchmaking, spectators | Planned |
| **6** | AI — opponent, difficulty levels, analysis, hints | Partly — the opponent exists. Difficulty levels were built, then removed; analysis and hints do not exist |
| **7** | Advanced chess — PGN replay, opening recognition, analysis, blunder detection | Planned |
| **8** | Deployment — server-side move validation (Cloud Functions), App Check, room cleanup, GitHub Pages / Firebase Hosting, mobile testing | Planned |

---

## Licence

`chess.js` is BSD-2-Clause (Jeff Hlywa); its licence header is preserved in
`js/vendor/chess.js`. Application code is yours to use as you see fit.
