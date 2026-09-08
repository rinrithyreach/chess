# Sounds

This folder is intentionally empty.

Phase 1 synthesises every sound effect with the Web Audio API
(`js/sound.js`), so the game has working audio with **no missing-file
requests and no console errors**.

## Using real audio files instead

1. Add these six files here:

   ```
   move.mp3
   capture.mp3
   check.mp3
   castle.mp3
   promote.mp3
   game-over.mp3
   ```

2. In `js/sound.js`, set:

   ```js
   const USE_SOUND_FILES = true;
   ```

Files are preloaded on the first user gesture. Any file that is missing or
fails to decode falls back to its synthesised effect automatically, so a
partial set is safe.

Keep clips short (under ~400 ms) and normalised — move and capture sounds fire
constantly during play.
