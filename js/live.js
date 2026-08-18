import { idleState, targetFromFeatures, glide, advance, kick } from './cymafield.js?v=17f9b6fa';

// Live conductor: audio frames in, field state out.
//
// There is no worker and no regeneration. The field is a dozen floats the
// shader re-evaluates per pixel, so gliding them here IS the update — which
// is what gives live input low latency and makes the water flow between
// patterns instead of cutting between separately generated designs.

// A design, once formed, is HELD when the sound stops; it must not dissolve
// back to droplets. Two thresholds rather than one (hysteresis) plus a
// stability window are what stop room tone and momentary pitch-detector
// errors from repeatedly re-forming the figure.
export const ON_RMS = 0.020;      // must exceed this to count as real sound
export const OFF_RMS = 0.009;     // and fall below THIS to count as stopped
export const STABLE_SEC = 0.22;   // sustained above ON before it takes effect
export const RELEASE_SEC = 0.6;   // sustained below OFF before it holds

// Onset detector on spectral flux: fires when flux exceeds mean + 1.5 sigma
// of ~1s of history, then decays. 150ms refractory.
export class KickDetector {
  constructor() { this.hist = []; this.value = 0; this.refractory = 0; }
  step(flux, dt) {
    this.value *= Math.exp(-dt / 0.12);
    this.refractory = Math.max(0, this.refractory - dt);
    this.hist.push(flux);
    if (this.hist.length > 60) this.hist.shift();
    const n = this.hist.length;
    if (n >= 10 && this.refractory === 0) {
      const mean = this.hist.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      if (flux > mean + 1.5 * sd && flux > 0.001) { this.value = 1; this.refractory = 0.15; }
    }
    return this.value;
  }
}

export function pitchNormOf(hz) {
  // Same 6-octave span (55 Hz - 3520 Hz) the fingerprint uses.
  return hz > 20 ? Math.min(1, Math.max(0, Math.log2(hz / 55) / 6)) : 0.35;
}

export class LiveConductor {
  constructor({ audio, renderer, onVu = null, onState = null }) {
    Object.assign(this, { audio, renderer, onVu, onState });
    this.field = idleState();
    this.phase = 'idle';          // 'idle' | 'active' | 'hold'
    this.kick = new KickDetector();
    this._loudFor = 0;
    this._quietFor = 0;
    this._last = 0;
    this.running = true;
  }

  start() {
    const step = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(step);
      this.tick(performance.now() / 1000);
    };
    this._raf = requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  tick(nowSec) {
    const dt = Math.min(0.1, this._last ? nowSec - this._last : 1 / 60);
    this._last = nowSec;
    const f = this.audio.getMusicalFrame();
    if (!f) return;
    if (this.onVu) this.onVu(f.rms);

    const k = this.kick.step(f.flux, dt);

    this._loudFor = f.rms > ON_RMS ? this._loudFor + dt : 0;
    this._quietFor = f.rms < OFF_RMS ? this._quietFor + dt : 0;

    if (this._loudFor >= STABLE_SEC) {
      // First valid sound: flood the figure in. Held across silence after
      // that — the design never drains back to an empty canvas on its own.
      this.field.growTarget = 1;
      this.phase = 'active';
    }
    else if (this.phase === 'active' && this._quietFor >= RELEASE_SEC) this.phase = 'hold';

    // Responsive only while the sound is actually present. Without this the
    // figure keeps gliding toward a silent target throughout the release
    // window, so by the time HOLD is entered the water has already drained
    // away and the idle droplets are back — which is the whole thing Hold
    // exists to prevent.
    const responsive = this.phase === 'active' && f.rms >= OFF_RMS;

    if (responsive) {
      const target = targetFromFeatures({
        pitchNorm: pitchNormOf(f.pitchHz), rms: f.rms,
        centroid: f.centroid, spread: f.spread, pitchConf: f.pitchConf,
      });
      // A low-confidence frame still carries loudness, but its pitch is
      // unreliable — let it drive amplitude and leave the topology alone
      // rather than jerking the figure on a detector glitch.
      if (f.pitchConf < 0.35) {
        target.m = this.field.m; target.n = this.field.n;
        target.kr = this.field.kr; target.ma = this.field.ma;
      }
      glide(this.field, target, dt, 0.55);
      // Amplitude tracks faster than topology: loudness should feel
      // immediate, while the figure takes a moment to reorganise.
      this.field.amp += (target.amp - this.field.amp) * (1 - Math.exp(-dt / 0.12));
      if (k > 0.5) kick(this.field, k);
      advance(this.field, dt);
    }

    // 'idle' and 'hold' both leave the state untouched: idle has nothing to
    // show yet, hold is the point. The renderer advances material time (and
    // only material time) for both.
    this.renderer.setField(this.field, responsive ? 'live-active' : 'live-hold');
    if (this.onState) this.onState(this.phase);
  }

  reset() {
    // idleState has growTarget 0, so Clear drains the figure back out rather
    // than cutting it.
    this.field = idleState();
    this.phase = 'idle';
    this._loudFor = 0;
    this._quietFor = 0;
  }
}
