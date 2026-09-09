/**
 * bot-worker.js
 * Runs the bot's search off the main thread.
 *
 * A search deep enough to be worth playing takes long enough to be felt: on a
 * phone it is comfortably past the 16ms a frame allows, so on the main thread
 * it would freeze the board — no animation, no taps, no scrolling — every time
 * the bot thinks. Here the page stays completely responsive while it works.
 *
 * Deliberately thin. All the chess lives in bot.js, which knows nothing about
 * workers and so runs identically on the main thread when a worker cannot be
 * created (see bot-session.js).
 */

import { chooseMove } from './bot.js';

self.addEventListener('message', (event) => {
  const { id, fen, timeBudgetMs, maxDepth } = event.data ?? {};
  try {
    const move = chooseMove(fen, { timeBudgetMs, maxDepth });
    self.postMessage({ id, move });
  } catch (error) {
    // Report rather than throw: an unhandled worker error is invisible to the
    // page, and the session needs to know so it can fall back.
    self.postMessage({ id, move: null, error: String(error?.message ?? error) });
  }
});
