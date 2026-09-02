// Small shared helpers.

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const inv   = (a, b, v) => b === a ? 0 : (v - a) / (b - a);
export const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

/** Deterministic 0..1 noise from an integer pair — same glyph, same jitter, every frame. */
export function hash(i, seed = 0) {
  let h = (i * 374761393 + seed * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── easing ───────────────────────────────────────────────────
export const smoothstep = (a, b, v) => { const t = clamp(inv(a, b, v), 0, 1); return t * t * (3 - 2 * t); };
export const easeOutCubic  = t => 1 - (1 - t) ** 3;
export const easeOutQuint  = t => 1 - (1 - t) ** 5;
export const easeInCubic   = t => t * t * t;
export const easeInOutCubic= t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOutBack   = t => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
export const easeOutElastic= t => t === 0 || t === 1 ? t : 2 ** (-9 * t) * Math.sin((t * 10 - .75) * (2 * Math.PI / 3)) + 1;

/** Entrance / exit envelope for a stage: rises over `ins`, falls over `outs`. */
export function envelope(u, ins = 0.22, outs = 0.22) {
  return {
    in:  smoothstep(0, ins, u),
    out: 1 - smoothstep(1 - outs, 1, u),
    get both() { return this.in * this.out; }
  };
}

// ── formatting ───────────────────────────────────────────────
export function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
export const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s` : `${s.toFixed(1)}s`;

// ── dom ──────────────────────────────────────────────────────
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) n.style.setProperty(prop, val);   // custom props need setProperty
        else n.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer;
export function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

/** Nearest value in a sorted array, or null when nothing is within `maxDist`. */
export function nearest(sorted, v, maxDist = Infinity) {
  if (!sorted || !sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  const cands = [sorted[lo], sorted[lo - 1], sorted[lo + 1]].filter(x => x !== undefined);
  let best = null, bd = Infinity;
  for (const c of cands) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c; } }
  return bd <= maxDist ? best : null;
}
