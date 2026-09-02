/* Beat / tempo analysis worker (classic worker — no imports).
 *
 * Pipeline: mono downmix → decimate to ~22 kHz → STFT → spectral flux →
 * adaptive peak picking (onsets) → autocorrelation tempo → phase search → beat grid.
 */

'use strict';

const TARGET_SR = 22050;
const FRAME = 1024;
const HOP = 256;
const PEAK_BUCKETS = 4096;

// ── FFT (iterative radix-2, in place) ────────────────────────
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = Math.sin(2 * Math.PI * i / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre =  re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre;        im[j] += tim;
        }
      }
    }
  };
}

// ── helpers ─────────────────────────────────────────────────
function decimate(src, factor) {
  if (factor <= 1) return src;
  const n = Math.floor(src.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += src[i * factor + k];
    out[i] = s / factor;
  }
  return out;
}

function clampf(v, a, b) { return v < a ? a : v > b ? b : v; }

function movingMean(arr, radius) {
  const n = arr.length, out = new Float32Array(n);
  let sum = 0;
  const win = radius * 2 + 1;
  for (let i = 0; i < n + radius; i++) {
    if (i < n) sum += arr[i];
    if (i - win >= 0) sum -= arr[i - win];
    const c = i - radius;
    if (c >= 0) out[c] = sum / Math.min(win, n);
  }
  return out;
}

function waveformPeaks(samples, buckets) {
  const out = new Float32Array(buckets * 2);
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per), e = Math.min(samples.length, Math.floor((b + 1) * per));
    let mn = 0, mx = 0;
    for (let i = s; i < e; i++) { const v = samples[i]; if (v < mn) mn = v; else if (v > mx) mx = v; }
    out[b * 2] = mn; out[b * 2 + 1] = mx;
  }
  return out;
}

// ── main ────────────────────────────────────────────────────
self.onmessage = ev => {
  const { samples, sampleRate } = ev.data;
  const report = (value, label) => self.postMessage({ type: 'progress', value, label });

  try {
    const duration = samples.length / sampleRate;
    report(0.05, 'building waveform');
    const peaks = waveformPeaks(samples, PEAK_BUCKETS);

    report(0.12, 'resampling');
    const factor = Math.max(1, Math.floor(sampleRate / TARGET_SR));
    const sig = decimate(samples, factor);
    const sr = sampleRate / factor;
    const hopTime = HOP / sr;
    // A transient shows up in the flux about half an analysis window early — put it back.
    const latency = (FRAME / 2) / sr;

    // window
    const win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));

    const fft = makeFFT(FRAME);
    const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    const bins = FRAME / 2;
    const prev = new Float32Array(bins);
    const frames = Math.max(1, Math.floor((sig.length - FRAME) / HOP));
    const flux = new Float32Array(frames);

    report(0.18, 'spectral flux');
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      for (let i = 0; i < FRAME; i++) { re[i] = sig[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let sum = 0;
      for (let k = 1; k < bins; k++) {
        const m = Math.log1p(80 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        const d = m - prev[k];
        if (d > 0) sum += d;
        prev[k] = m;
      }
      flux[f] = sum;
      if ((f & 1023) === 0) report(0.18 + 0.55 * (f / frames), 'spectral flux');
    }

    // normalise: remove the local floor, rectify, scale to 0..1
    report(0.76, 'onset envelope');
    const floor = movingMean(flux, Math.round(0.4 / hopTime));
    const env = new Float32Array(frames);
    let emax = 1e-9;
    for (let f = 0; f < frames; f++) {
      const v = flux[f] - floor[f];
      env[f] = v > 0 ? v : 0;
      if (env[f] > emax) emax = env[f];
    }
    for (let f = 0; f < frames; f++) env[f] /= emax;

    // onsets — local maxima above an adaptive threshold
    const thr = movingMean(env, Math.round(0.15 / hopTime));
    const minGap = Math.round(0.06 / hopTime);
    const onsets = [], strengths = [];
    let last = -1e9;
    for (let f = 2; f < frames - 2; f++) {
      const v = env[f];
      if (v < 0.06) continue;
      if (v <= env[f - 1] || v < env[f + 1]) continue;
      if (v < thr[f] * 1.6 + 0.04) continue;
      if (f - last < minGap) continue;
      onsets.push(f * hopTime + latency);
      strengths.push(v);
      last = f;
    }

    // tempo — autocorrelation with harmonic reinforcement
    report(0.86, 'tempo');
    const minLag = Math.max(2, Math.round((60 / 200) / hopTime));
    const maxLag = Math.min(frames - 1, Math.round((60 / 55) / hopTime));
    let bestLag = minLag, bestScore = -1;
    const score = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let f = 0; f + lag < frames; f++) s += env[f] * env[f + lag];
      score[lag] = s / (frames - lag);
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = score[lag];
      const l2 = lag * 2, l3 = lag * 3;
      if (l2 <= maxLag) s += 0.55 * score[l2];
      if (l3 <= maxLag) s += 0.25 * score[l3];
      const bpm = 60 / (lag * hopTime);
      // gentle preference for tempi humans actually tap
      s *= Math.exp(-0.5 * (Math.log(bpm / 122) / 0.55) ** 2);
      if (s > bestScore) { bestScore = s; bestLag = lag; }
    }

    // sub-frame refinement: the true period rarely lands on a whole frame
    const sm = score[bestLag - 1] ?? 0, s0 = score[bestLag], sp = score[bestLag + 1] ?? 0;
    const denom = sm - 2 * s0 + sp;
    const lag0 = bestLag + (denom !== 0 ? clampf(0.5 * (sm - sp) / denom, -0.5, 0.5) : 0);

    let period = lag0 * hopTime;
    let bpm = 60 / period;
    while (bpm < 70)  { bpm *= 2; period /= 2; }
    while (bpm > 190) { bpm /= 2; period *= 2; }

    // phase + period lock: slide and stretch the grid onto the strongest onsets
    report(0.93, 'beat grid');
    const fitGrid = (pf, o) => {
      let s = 0, n = 0;
      for (let x = o; x < frames; x += pf) {
        const i = Math.round(x);
        if (i < 0 || i >= frames) continue;
        s += env[i] + 0.6 * ((env[i - 1] ?? 0) + (env[i + 1] ?? 0));
        n++;
      }
      return n ? s / n : 0;
    };

    let periodF = period / hopTime;
    let bestOff = 0, bestFit = -1, bestPF = periodF;
    for (let m = -20; m <= 20; m++) {
      const pf = periodF * (1 + m * 0.0015);
      if (pf < 2) continue;
      for (let o = 0; o < pf; o += 0.25) {
        const fit = fitGrid(pf, o);
        if (fit > bestFit) { bestFit = fit; bestOff = o; bestPF = pf; }
      }
    }
    periodF = bestPF;
    period = periodF * hopTime;
    bpm = 60 / period;

    const beats = [];
    for (let x = bestOff; x * hopTime + latency < duration; x += periodF) beats.push(x * hopTime + latency);

    report(1, 'done');
    const beatsArr = Float32Array.from(beats);
    const onsetArr = Float32Array.from(onsets);
    const strengthArr = Float32Array.from(strengths);
    self.postMessage({
      type: 'done',
      result: {
        duration, bpm, period, offset: beats[0] ?? 0,
        peaks, envelope: env, envHop: hopTime,
        beats: beatsArr, onsets: onsetArr, onsetStrength: strengthArr,
        confidence: (() => {
          let m = 0; for (let i = 0; i < frames; i++) m += env[i];
          m = m / frames || 1e-9;
          return Math.max(0, Math.min(1, bestFit / (m * 3.6)));
        })()
      }
    }, [peaks.buffer, env.buffer, beatsArr.buffer, onsetArr.buffer, strengthArr.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
