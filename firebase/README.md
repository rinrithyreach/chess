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
| Rooms live only at valid room codes | `$roomCode.matches(/^[A-HJ-NP-Z2-9]{4}$/)` |
| Only the two seated players may write | `.write` checks `players/*/uid === auth.uid` |
| A seat may be claimed only when empty | write allowed while a seat has no `uid` |
| You cannot seat someone else | `uid` must equal `auth.uid`, or be a uid already in the room (so a rematch can swap seats) |
| The host never changes | `hostUid` is immutable once set |
| Only known fields exist | `$other: {".validate": false}` on every object |
| Fields are well formed | per-field type, pattern and length checks |
| Names cannot be abused as payloads | `name` capped at 20 characters |
| Profile pictures cannot be abused as file hosting | `avatar` capped at 24KB and must be a `data:` URL of a raster image |
| A profile picture cannot phone home | `avatar` must be `data:`, so it can never be a URL pointing at someone's server |
| A draw can only be offered in your own name | `drawOffer/from` must match your seat |

### What the rules cannot enforce

Realtime Database rules cannot run a chess engine, so they cannot verify that
a written FEN is a legal continuation of the previous position. A player using
a modified client could write a legal-looking but illegal position **for their
own turn**.

They still cannot:

- move as the other player,
- forge a result attributed to the opponent,
- seat themselves twice or evict an opponent,
- write fields the schema does not define.

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
