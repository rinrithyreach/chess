/**
 * sound.js
 * Game audio.
 *
 * The project ships without audio files, so every effect is synthesised with
 * the Web Audio API. That keeps the feature genuinely working while producing
 * zero 404s and zero console noise.
 *
 * To switch to real audio files later:
 *   1. Drop move.mp3 / capture.mp3 / check.mp3 / castle.mp3 / promote.mp3 /
 *      game-over.mp3 into assets/sounds/
 *   2. Set USE_SOUND_FILES to true below.
 * Files that fail to load fall back to the synthesised effect automatically,
 * so a missing file can never break playback.
 */

import { log, warn } from './config.js';

/** Flip to true only once real audio files exist in assets/sounds/. */
const USE_SOUND_FILES = false;

const SOUND_PATH = './assets/sounds/';

export const SOUND = {
  MOVE: 'move',
  CAPTURE: 'capture',
  CHECK: 'check',
  CASTLE: 'castle',
  PROMOTE: 'promote',
  GAME_OVER: 'game-over',
};

/**
 * Synth recipes. Each is a list of tones layered/sequenced to give the effect
 * a distinct character without sounding like a test beep.
 */
const RECIPES = {
  [SOUND.MOVE]: [
    { freq: 300, type: 'sine', start: 0, dur: 0.07, gain: 0.22, sweepTo: 190 },
  ],
  [SOUND.CAPTURE]: [
    { freq: 190, type: 'square', start: 0, dur: 0.09, gain: 0.13, sweepTo: 80 },
    { freq: 420, type: 'sine', start: 0, dur: 0.07, gain: 0.16, sweepTo: 150 },
  ],
  [SOUND.CHECK]: [
    { freq: 720, type: 'triangle', start: 0, dur: 0.11, gain: 0.2 },
    { freq: 960, type: 'triangle', start: 0.1, dur: 0.16, gain: 0.2 },
  ],
  [SOUND.CASTLE]: [
    { freq: 260, type: 'sine', start: 0, dur: 0.07, gain: 0.2, sweepTo: 180 },
    { freq: 260, type: 'sine', start: 0.1, dur: 0.09, gain: 0.2, sweepTo: 160 },
  ],
  [SOUND.PROMOTE]: [
    { freq: 523, type: 'sine', start: 0, dur: 0.1, gain: 0.17 },
    { freq: 659, type: 'sine', start: 0.08, dur: 0.1, gain: 0.17 },
    { freq: 784, type: 'sine', start: 0.16, dur: 0.14, gain: 0.17 },
    { freq: 1046, type: 'sine', start: 0.24, dur: 0.22, gain: 0.15 },
  ],
  [SOUND.GAME_OVER]: [
    { freq: 440, type: 'sine', start: 0, dur: 0.18, gain: 0.16 },
    { freq: 349, type: 'sine', start: 0.14, dur: 0.2, gain: 0.16 },
    { freq: 262, type: 'sine', start: 0.3, dur: 0.42, gain: 0.18 },
  ],
};

class SoundPlayer {
  #enabled = true;
  #context = null;
  #buffers = new Map();
  #filesTried = false;
  #unsupported = false;

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
  }

  isEnabled() {
    return this.#enabled;
  }

  /**
   * Create (or resume) the AudioContext. Browsers require this to happen in
   * response to a user gesture, so it is called from the first interaction
   * rather than at module load.
   */
  unlock() {
    const ctx = this.#ensureContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        /* Ignored: audio simply stays silent until the next gesture. */
      });
    }
    if (USE_SOUND_FILES && !this.#filesTried) {
      this.#filesTried = true;
      this.#preloadFiles();
    }
  }

  #ensureContext() {
    if (this.#context) return this.#context;
    if (this.#unsupported) return null;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      // Warn once rather than on every effect.
      this.#unsupported = true;
      warn('Web Audio unsupported — sound disabled');
      return null;
    }
    try {
      this.#context = new Ctor();
      return this.#context;
    } catch (error) {
      warn('Could not create AudioContext', error);
      return null;
    }
  }

  /** Optional path: load real audio files when they are present. */
  async #preloadFiles() {
    const ctx = this.#ensureContext();
    if (!ctx) return;
    await Promise.all(
      Object.values(SOUND).map(async (name) => {
        try {
          const response = await fetch(`${SOUND_PATH}${name}.mp3`);
          if (!response.ok) return;
          const data = await response.arrayBuffer();
          this.#buffers.set(name, await ctx.decodeAudioData(data));
        } catch {
          // Missing or undecodable file — the synth fallback covers it.
        }
      }),
    );
    log('Sound files loaded:', this.#buffers.size);
  }

  /** Play a named effect. Safe to call at any time; never throws. */
  play(name) {
    if (!this.#enabled) return;
    const ctx = this.#ensureContext();
    if (!ctx || ctx.state === 'suspended') return;

    try {
      if (this.#buffers.has(name)) {
        this.#playBuffer(ctx, this.#buffers.get(name));
      } else {
        this.#playSynth(ctx, RECIPES[name] ?? RECIPES[SOUND.MOVE]);
      }
    } catch (error) {
      warn('Sound playback failed', name, error);
    }
  }

  #playBuffer(ctx, buffer) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }

  #playSynth(ctx, recipe) {
    const now = ctx.currentTime;
    recipe.forEach((tone) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startAt = now + tone.start;
      const endAt = startAt + tone.dur;

      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, startAt);
      if (tone.sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(tone.sweepTo, endAt);
      }

      // Quick attack, exponential release — reads as a click rather than a beep.
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(tone.gain, startAt + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

      osc.connect(gain).connect(ctx.destination);
      osc.start(startAt);
      osc.stop(endAt + 0.02);
    });
  }

  /**
   * Choose the right effect for a completed move.
   * Check takes priority over the move type, since it is the more important
   * thing for a player to hear.
   */
  playForMove(move, { isCheck = false, isGameOver = false } = {}) {
    if (isGameOver) return this.play(SOUND.GAME_OVER);
    if (isCheck) return this.play(SOUND.CHECK);
    if (!move) return this.play(SOUND.MOVE);
    if (move.isPromotion) return this.play(SOUND.PROMOTE);
    if (move.isCastle) return this.play(SOUND.CASTLE);
    if (move.isCapture) return this.play(SOUND.CAPTURE);
    return this.play(SOUND.MOVE);
  }
}

export const sound = new SoundPlayer();
export default sound;
