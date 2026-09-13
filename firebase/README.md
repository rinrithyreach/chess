# Firebase configuration

Everything in this folder is deployed to *your* Firebase project. Nothing here
contains secrets.

## `database.rules.json`

These rules are the only thing protecting your database. The web config in
`js/firebase-config.js` is public by design and authorises nothing — it merely
identifies the project.

Deploy them with:

```bash
firebase deploy --only database
```

### What the rules enforce

| Guarantee | How |
| --- | --- |
| Only signed-in users can read or write | `.read` / `.write` require `auth != null` |
| Rooms live only at valid room codes | `$roomCode.matches(/^[A-HJ-NP-Z2-9]{6}$/)` |
| Only the two seated players may write | `.write` checks `players/*/uid === auth.uid` |
| A seat may be claimed only when empty | write allowed while a seat has no `uid` |
| You cannot seat someone else | `uid` must equal `auth.uid`, or be a uid already in the room (so a rematch can swap seats) |
| The host never changes | `hostUid` is immutable once set |
| Only known fields exist | `$other: {".validate": false}` on every object |
| Fields are well formed | per-field type, pattern and length checks |
| Names cannot be abused as payloads | `name` capped at 20 characters |
| A room cannot be used as file hosting | `avatar` capped at 6144 characters |
| A picture cannot phone home | `avatar` must be a `data:` URL of a png, jpeg or webp — never a remote URL, and never SVG, which is a document rather than a picture |
| A draw can only be offered in your own name | `drawOffer/from` must match your seat |
| Nobody can speak as their opponent | a message's `uid` must be yours and its `color` must be the seat you hold — **or both must be unchanged**, which is what lets a move rewrite the room without re-forging every message already in it |
| Chat cannot become storage | `body` capped at 160 characters, `kind` only `text` or `emote` |
| A friend code is claimed once | `handles/$code` is writable only when absent or already yours, and only with your own uid as the value |
| Your lists are yours | `friends`, `requests` and `sent` are readable only by their owner |
| A profile is readable by anyone signed in | deliberately — resolving a friend code means reading a stranger's row |
| Only you write your own profile and presence | `.write` is `auth.uid === $uid`, with no exceptions |
| Somebody can join your list only if you asked | writing `users/$you/friends/$them` as *them* requires `users/$them/requests/$you` to exist |
| You cannot send yourself a request | `$fromUid !== $uid` |
| A profile picture is held to the seat rule | the same expression, character for character — the test suite asserts the two strings are equal |

### What the rules cannot enforce

Realtime Database rules cannot run a chess engine, so they cannot verify that
a written FEN is a legal continuation of the previous position. A player using
a modified client could write a legal-looking but illegal position **for their
own turn**.

They still cannot:

- move as the other player,
- forge a result attributed to the opponent,
- seat themselves twice or evict an opponent,
- write fields the schema does not define,
- put words in the opponent's mouth, or an emote id that is not one of the eight,
- read anybody's friends, requests or sent list but their own,
- add themselves to a friends list that has not asked for them.

Two things they deliberately allow, which are worth knowing:

- **Either player can delete the other's chat messages.** Both can write the
  room, and a deletion needs only write access — the same reason either can
  delete the room itself. Muting is the answer, not a rule.
- **Anyone signed in can read any profile and any presence row.** That is what
  makes "add by friend code" work at all. Nothing else about an account is
  readable, and a profile holds only a display name, a code and an optional
  picture.

For a casual two-friends game this is the normal trade-off, and it is the same
one most client-authoritative multiplayer games make. To close the gap fully,
move move-validation into a Cloud Function that owns the write — see
"Trust model" in the root README.

## `../firebase.json`

Wires the rules file to the project, configures Hosting, and defines the local
emulator ports used by the automated multiplayer tests:

| Emulator | Port |
| --- | --- |
| Auth | 9099 |
| Realtime Database | 9000 |
| Emulator UI | 4000 |

Run them with:

```bash
firebase emulators:start --only database,auth
```
