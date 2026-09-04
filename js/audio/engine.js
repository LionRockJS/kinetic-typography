// Audio decoding, analysis hand-off and the transport clock.
//
// Three independent lanes play together: one music source, plus any number of
// voiceover and sound-effects clips. Each clip has its own buffer, position,
// and level, so clips can be slipped against each other freely. VO sources
// can also be copied out as mono data for the optional word-timing worker.
//
// The transport rides the AudioContext while audio is genuinely running, so the
// playhead cannot drift against the track. A context that has not been resumed
// reports a frozen currentTime, though, which would stall the composition — so
// the clock falls back to performance.now() whenever the context is not running
// and re-bases itself when the source changes mid-playback.

import { easeFn } from '../camera.js';

export const TRACK_KINDS = [
  { kind: 'bgm', label: 'Music',  short: 'BGM', analysed: true },
  { kind: 'vo',  label: 'Voice',  short: 'VO',  analysed: false },
  { kind: 'sfx', label: 'Effects', short: 'SFX', analysed: false }
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.streamDest = null;
    this.playing = false;
    this._base = 0;           // position at the last transport change
    this._t0 = 0;             // clock reading at that moment
    this._audioClock = false; // which clock _t0 was read from

    /** @type {Map<string, Map<string, {buffer:AudioBuffer|null, gain:GainNode|null, source:AudioBufferSourceNode|null, start:number, volume:number, mute:boolean, volumeKeys:Array<{t:number,volume:number,ease:string}>}>>} */
    this.tracks = new Map(
      TRACK_KINDS.map(t => [t.kind, new Map()])
    );
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.streamDest);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    for (const lane of this.tracks.values()) {
      for (const tr of lane.values()) {
        if (!tr.gain) {
          tr.gain = this.ctx.createGain();
          tr.gain.gain.value = tr.mute ? 0 : tr.volume;
          tr.gain.connect(this.master);
        }
      }
    }
    return this.ctx;
  }

  // ── clock ──────────────────────────────────────────────────
  /** True once the browser has actually let audio through. */
  get audible() { return !!this.ctx && this.ctx.state === 'running'; }

  _read(useAudio) { return useAudio && this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  now() {
    if (!this.playing) return this._base;
    const audible = this.audible;
    if (audible !== this._audioClock) {
      // banking the elapsed time keeps the playhead continuous across the switch
      this._base += this._read(this._audioClock) - this._t0;
      this._audioClock = audible;
      this._t0 = this._read(audible);
    }
    return this._base + (this._read(audible) - this._t0);
  }

  // ── tracks ─────────────────────────────────────────────────
  track(kind, id = null) {
    const lane = this.tracks.get(kind);
    if (!lane) return null;
    const key = id ?? (kind === 'bgm' ? 'bgm' : lane.keys().next().value);
    return key === undefined ? null : lane.get(key) ?? null;
  }

  _ensureTrack(kind, id = null) {
    const lane = this.tracks.get(kind);
    if (!lane) return null;
    const key = id ?? (kind === 'bgm' ? 'bgm' : null);
    if (key === null) return null;
    if (!lane.has(key)) {
      lane.set(key, {
        buffer: null, gain: null, source: null, start: 0,
        volume: 1, mute: false, volumeKeys: []
      });
    }
    return lane.get(key);
  }

  setBuffer(kind, buffer, id = null) {
    const tr = this._ensureTrack(kind, id);
    if (!tr) return;
    this._stopSource(tr);
    tr.buffer = buffer;
    this._ensureCtx();
  }

  setStart(kind, t, id = null) {
    const tr = this._ensureTrack(kind, id);
    if (!tr) return;
    tr.start = t;
    if (tr.gain && this.playing) this._scheduleGain(tr, this.now());
  }

  setLevel(kind, { volume, mute }, id = null) {
    const tr = this._ensureTrack(kind, id);
    if (!tr) return;
    if (volume !== undefined && Number.isFinite(Number(volume))) {
      tr.volume = Math.max(0, Math.min(1.5, Number(volume)));
    }
    if (mute !== undefined) tr.mute = mute;
    if (!tr.gain && this.ctx) this._ensureCtx();
    if (tr.gain) this._scheduleGain(tr, this.playing ? this.now() : this._base);
  }

  /** Keep the runtime automation copy aligned with the serialisable clip. */
  setVolumeKeys(kind, keys = [], id = null) {
    const tr = this._ensureTrack(kind, id);
    if (!tr) return;
    tr.volumeKeys = (Array.isArray(keys) ? keys : [])
      .filter(key => key && Number.isFinite(Number(key.t)) && Number.isFinite(Number(key.volume)))
      .map(key => ({
        t: Math.max(0, Number(key.t)),
        volume: Math.max(0, Math.min(1.5, Number(key.volume))),
        ease: typeof key.ease === 'string' ? key.ease : 'smooth'
      }))
      .sort((a, b) => a.t - b.t);
    if (tr.gain) this._scheduleGain(tr, this.playing ? this.now() : this._base);
  }

  _volumeAt(tr, compositionTime) {
    const base = Math.max(0, Math.min(1.5, Number(tr.volume) || 0));
    const keys = tr.volumeKeys ?? [];
    if (!keys.length) return base;
    const at = compositionTime - (Number(tr.start) || 0);
    if (at < keys[0].t) return base;
    if (at >= keys.at(-1).t) return keys.at(-1).volume;

    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= at) i++;
    const a = keys[i], b = keys[i + 1];
    const u = Math.max(0, Math.min(1, (at - a.t) / Math.max(1e-6, b.t - a.t)));
    const eased = easeFn(a.ease)(u);
    return a.volume + (b.volume - a.volume) * eased;
  }

  /** Schedule the current level and all future volume keys without clicks. */
  _scheduleGain(tr, compositionTime) {
    if (!tr.gain || !this.ctx) return;
    const param = tr.gain.gain;
    const now = this.ctx.currentTime;
    const current = tr.mute ? 0 : this._volumeAt(tr, compositionTime);
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
    if (tr.mute) return;

    const keys = tr.volumeKeys ?? [];
    const future = keys.filter(key => (Number(tr.start) || 0) + key.t > compositionTime + 1e-6);
    let fromTime = compositionTime;
    let fromValue = current;
    let previous = keys.filter(key => (Number(tr.start) || 0) + key.t <= compositionTime + 1e-6).at(-1) ?? null;
    for (const key of future) {
      const keyTime = (Number(tr.start) || 0) + key.t;
      const seconds = keyTime - fromTime;
      if (seconds <= 1e-6) continue;
      const steps = Math.min(32, Math.max(2, Math.ceil(seconds * 60)));
      const ease = easeFn(previous?.ease ?? 'smooth');
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const value = fromValue + (key.volume - fromValue) * ease(u);
        param.linearRampToValueAtTime(value, now + (seconds * u + fromTime - compositionTime));
      }
      fromTime = keyTime;
      fromValue = key.volume;
      previous = key;
    }
  }

  /** Return a fresh mono copy of a loaded source for speech analysis. */
  getSourceData(kind, id = null) {
    const tr = this.track(kind, id);
    const buffer = tr?.buffer;
    if (!buffer) return null;
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < buffer.length; i++) mono[i] += data[i];
    }
    if (buffer.numberOfChannels > 1) {
      const scale = 1 / buffer.numberOfChannels;
      for (let i = 0; i < mono.length; i++) mono[i] *= scale;
    }
    return { mono, sampleRate: buffer.sampleRate, duration: buffer.duration };
  }

  get loaded() { return [...this.tracks.values()].some(lane => [...lane.values()].some(t => t.buffer)); }

  // ── transport ──────────────────────────────────────────────
  play(from = null) {
    if (from !== null) this._base = from;
    const ctx = this._ensureCtx();
    this._stopAll();

    for (const lane of this.tracks.values()) {
      for (const tr of lane.values()) {
        if (!tr.buffer) continue;
        const at = this._base - tr.start;              // position inside this buffer
        if (at >= tr.buffer.duration) continue;
        this._scheduleGain(tr, this._base);
        const src = ctx.createBufferSource();
        src.buffer = tr.buffer;
        src.connect(tr.gain);
        if (at >= 0) src.start(0, at);
        else src.start(ctx.currentTime - at, 0);        // this lane has not begun yet
        tr.source = src;
      }
    }

    this._audioClock = this.audible;
    this._t0 = this._read(this._audioClock);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._base = this.now();
    this._stopAll();
    this.playing = false;
  }

  seek(t) {
    const wasPlaying = this.playing;
    this._base = Math.max(0, t);
    if (wasPlaying) this.play();
  }

  _stopSource(tr) {
    if (!tr.source) return;
    try { tr.source.onended = null; tr.source.stop(); } catch { /* already stopped */ }
    tr.source.disconnect();
    tr.source = null;
  }

  _stopAll() {
    for (const lane of this.tracks.values()) {
      for (const tr of lane.values()) this._stopSource(tr);
    }
  }

  clearTrack(kind, id = null) {
    const lane = this.tracks.get(kind);
    if (!lane) return;
    if (id !== null) {
      const tr = lane.get(id);
      if (!tr) return;
      this._stopSource(tr);
      lane.delete(id);
      return;
    }
    for (const tr of lane.values()) this._stopSource(tr);
    lane.clear();
  }

  /** Decode a File into an AudioBuffer, plus a mono mixdown for analysis. */
  async decode(file) {
    const ctx = this._ensureCtx();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buffer.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += data[i];
    }
    if (buffer.numberOfChannels > 1) {
      const k = 1 / buffer.numberOfChannels;
      for (let i = 0; i < n; i++) mono[i] *= k;
    }
    return { buffer, mono, sampleRate: buffer.sampleRate };
  }
}

/** Run the beat analysis in a worker. Resolves with the analysis result. */
export function analyze(mono, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyzer.worker.js', import.meta.url));
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.value, m.label);
      else if (m.type === 'done') { worker.terminate(); resolve(m.result); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = err => { worker.terminate(); reject(err); };
    const copy = mono.slice();          // the buffer is transferred away
    worker.postMessage({ samples: copy, sampleRate }, [copy.buffer]);
  });
}

/** Waveform min/max pairs, for lanes we do not run full analysis on. */
export function waveformPeaks(mono, buckets = 2048) {
  const out = new Float32Array(buckets * 2);
  const per = mono.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per), e = Math.min(mono.length, Math.floor((b + 1) * per));
    let mn = 0, mx = 0;
    for (let i = s; i < e; i++) { const v = mono[i]; if (v < mn) mn = v; else if (v > mx) mx = v; }
    out[b * 2] = mn; out[b * 2 + 1] = mx;
  }
  return out;
}
