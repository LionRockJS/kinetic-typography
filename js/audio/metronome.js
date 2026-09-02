// Metronome — a synthesised click/drum track on its own bus.
//
// It is not the music: it has its own voice, its own level, and its own mute,
// and it mixes with the imported track rather than replacing it. Nothing is
// sampled — every hit is built from oscillators and filtered noise, so there is
// no asset to load and the click stays tight at any tempo.
//
// Hits are scheduled ahead of the playhead on the AudioContext clock (setTimeout
// is far too jittery to place a beat), from the same grid the timeline snaps to.

const LOOKAHEAD = 0.15;    // seconds of grid scheduled in advance
const TICK_MS = 25;        // how often the scheduler wakes

export const VOICES = {
  click: { label: 'Click' },
  kit:   { label: 'Drum kit' },
  rim:   { label: 'Rimshot' }
};

export class Metronome {
  /** @param {import('./engine.js').AudioEngine} engine shares the transport clock and context */
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.voice = 'kit';
    this.volume = 0.7;
    this.accent = true;
    this.inRecording = false;

    this.times = [];
    this.beatsPerBar = 4;
    this._next = 0;
    this._lastNow = 0;
    this._timer = null;
    this.gain = null;
    this._noise = null;
  }

  get ctx() { return this.engine.ctx; }

  _attach() {
    const ctx = this.engine._ensureCtx();
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(ctx.destination);
    }
    this._routeRecording();
    return ctx;
  }

  /** The click is monitor-only unless you ask for it in the export. */
  _routeRecording() {
    const dest = this.engine.streamDest;
    if (!this.gain || !dest) return;
    try { this.gain.disconnect(dest); } catch { /* not connected */ }
    if (this.inRecording) this.gain.connect(dest);
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  setInRecording(on) {
    this.inRecording = on;
    this._routeRecording();
  }

  /** @param {number[]} times beat times on the composition timeline */
  setGrid(times, beatsPerBar) {
    this.times = times ?? [];
    this.beatsPerBar = Math.max(1, beatsPerBar || 4);
    this._reseek();
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && this.engine.playing) this.start();
    else if (!on) this.stop();
  }

  start() {
    if (!this.enabled || this._timer) return;
    this._attach();
    this._reseek();
    this._timer = setInterval(() => this._schedule(), TICK_MS);
    this._schedule();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Point the scheduler at the first beat still ahead of the playhead. */
  _reseek() {
    const now = this.engine.now();
    this._lastNow = now;
    this._next = 0;
    while (this._next < this.times.length && this.times[this._next] < now - 0.01) this._next++;
  }

  _schedule() {
    if (!this.enabled || !this.engine.playing) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = this.engine.now();

    // Only a *jump* in the transport means we lost our place — scheduling ahead
    // of the playhead is normal and must not be mistaken for one.
    if (now < this._lastNow - 0.05 || now > this._lastNow + 0.5) this._reseek();
    this._lastNow = now;

    const horizon = now + LOOKAHEAD;
    while (this._next < this.times.length && this.times[this._next] < horizon) {
      const t = this.times[this._next];
      if (t >= now - 0.02) {
        const when = ctx.currentTime + (t - now);
        this._hit(when, this.accent && this._next % this.beatsPerBar === 0);
      }
      this._next++;
    }
  }

  // ── voices ─────────────────────────────────────────────────
  _noiseBuffer() {
    if (this._noise) return this._noise;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  _env(when, peak, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    g.connect(this.gain);
    return g;
  }

  _tone(when, from, to, decay, peak, type = 'sine') {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, when);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, when + decay * 0.9);
    osc.connect(this._env(when, peak, decay));
    osc.start(when);
    osc.stop(when + decay + 0.02);
  }

  _noiseHit(when, { freq, Q, decay, peak, type = 'bandpass' }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    src.connect(f).connect(this._env(when, peak, decay));
    src.start(when);
    src.stop(when + decay + 0.02);
  }

  _hit(when, accent) {
    switch (this.voice) {
      case 'kit':
        if (accent) {
          this._tone(when, 165, 45, 0.16, 0.9);                                  // kick
          this._noiseHit(when, { freq: 5200, Q: 0.8, decay: 0.03, peak: 0.12, type: 'highpass' });
        } else {
          this._noiseHit(when, { freq: 9000, Q: 0.7, decay: 0.035, peak: 0.3, type: 'highpass' });
        }
        break;
      case 'rim':
        this._noiseHit(when, { freq: accent ? 2400 : 1800, Q: 9, decay: 0.045, peak: accent ? 0.7 : 0.4 });
        this._tone(when, accent ? 900 : 700, accent ? 900 : 700, 0.02, accent ? 0.35 : 0.2, 'square');
        break;
      default:
        this._tone(when, accent ? 1600 : 1000, accent ? 1600 : 1000, 0.05,
                   accent ? 0.85 : 0.45, 'triangle');
    }
  }
}

/** A plain grid from a tempo, for when there is no track to follow. */
export function grid(bpm, offset, duration) {
  const out = [];
  if (!(bpm > 0)) return out;
  const step = 60 / bpm;
  let t = offset % step;
  if (t < -1e-9) t += step;
  for (; t <= duration + 1e-6; t += step) out.push(t);
  return out;
}
