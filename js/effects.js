// Effect library.
//
// An effect is a pure function that writes a per-glyph transform for the current
// moment. It receives the glyph's slot in the line and `u` — progress through its
// own stage, 0 → 1 — so it owns the full arc: entrance, life, exit.
//
//   g : { x, y, z, rx, ry, rz, sx, sy, sz, opacity }   pre-filled with the rest layout
//   c : { i, n, u, t, time, pulse, react, rnd, p, W, H, size }

import { clamp, lerp, hash, smoothstep,
         easeOutCubic, easeOutQuint, easeInCubic, easeInOutCubic, easeOutBack, easeOutElastic } from './util.js';

const TAU = Math.PI * 2;

/**
 * Per-glyph progress through a window: the window opens at `start`, lasts `len`,
 * and each successive glyph is delayed by up to `stag` of it.
 */
function seq(u, i, n, start, len, stag = 0.55, order = 'ltr') {
  let k = 0;
  if (n > 1) {
    if (order === 'rtl')         k = (n - 1 - i) / (n - 1);
    else if (order === 'center') k = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    else if (order === 'edges')  k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    else if (order === 'random') k = hash(i, 77);
    else                         k = i / (n - 1);
  }
  const delay = start + k * stag * len;
  const dur = Math.max(1e-4, len * (1 - stag));
  return clamp((u - delay) / dur, 0, 1);
}

const IN = 'in', OUT = 'out';
const P = (key, label, min, max, step, def) => ({ key, label, min, max, step, def });

export const EFFECTS = {

  // ── 起 · open ──────────────────────────────────────────────
  // 起 is a strike, not a passage — it lands fast and hands over.
  strike: {
    label: 'Strike', roles: ['qi'],
    params: [P('impact', 'Impact', 0, 3, 0.01, 1.5), P('stag', 'Stagger', 0, 0.9, 0.01, 0.22),
             P('shake', 'Shake', 0, 1, 0.01, 0.35)],
    apply(g, c) {
      const a = easeOutQuint(seq(c.u, c.i, c.n, 0, 0.34, c.p.stag));
      const out = easeInCubic(smoothstep(0.86, 1, c.u));
      g.sx = g.sy = g.sz = lerp(1 + c.p.impact, 1, a) * (1 - out * 0.08) * (1 + c.pulse * 0.06);
      const shake = (1 - a) * c.p.shake;
      g.x += (hash(c.i, 3) - 0.5) * shake * c.size * 0.3;
      g.y += (hash(c.i, 9) - 0.5) * shake * c.size * 0.3;
      g.rz += (hash(c.i, 15) - 0.5) * shake * 0.22;
      g.opacity *= a * (1 - out);
    }
  },

  rise: {
    label: 'Rise', roles: ['qi'],
    params: [P('dist', 'Distance', 0, 1.2, 0.01, 0.45), P('stag', 'Stagger', 0, 0.95, 0.01, 0.6),
             P('span', 'Entrance', 0.05, 0.9, 0.01, 0.4)],
    apply(g, c) {
      const a = easeOutQuint(seq(c.u, c.i, c.n, 0, c.p.span, c.p.stag));
      const b = easeInCubic(seq(c.u, c.i, c.n, 1 - 0.28, 0.28, c.p.stag * 0.5));
      g.y += (1 - a) * -c.p.dist * c.H * 0.5 + b * c.H * 0.25;
      g.opacity *= a * (1 - b);
      g.sx = g.sy = g.sz = lerp(0.86, 1, a) * (1 + c.pulse * 0.05);
    }
  },

  fadeScale: {
    label: 'Bloom', roles: ['qi'],
    params: [P('from', 'Start scale', 0.1, 1.8, 0.01, 0.55), P('stag', 'Stagger', 0, 0.95, 0.01, 0.35),
             P('rot', 'Twist', 0, 1, 0.01, 0.2)],
    apply(g, c) {
      const a = easeOutBack(seq(c.u, c.i, c.n, 0, 0.38, c.p.stag, 'center'));
      const b = easeInOutCubic(seq(c.u, c.i, c.n, 0.76, 0.24, 0.3));
      const s = lerp(c.p.from, 1, a) * lerp(1, 1.4, b);
      g.sx = g.sy = g.sz = s * (1 + c.pulse * 0.06);
      g.rz += (1 - a) * c.p.rot * (hash(c.i, 3) - 0.5) * TAU * 0.25;
      g.opacity *= clamp(a, 0, 1) * (1 - b);
    }
  },

  typewriter: {
    label: 'Typewriter', roles: ['qi'],
    params: [P('span', 'Type over', 0.1, 0.95, 0.01, 0.5), P('kick', 'Kick', 0, 1, 0.01, 0.45),
             P('cursor', 'Cursor sway', 0, 1, 0.01, 0.3)],
    apply(g, c) {
      const a = seq(c.u, c.i, c.n, 0, c.p.span, 0.92);
      const pop = easeOutElastic(clamp(a, 0, 1));
      const b = easeInCubic(smoothstep(0.82, 1, c.u));
      g.sx = g.sy = g.sz = a > 0 ? lerp(1 + c.p.kick * 0.6, 1, pop) : 0;
      g.y += (1 - pop) * c.p.kick * c.size * 0.15;
      g.rz += Math.sin(c.time * 1.7 + c.i) * c.p.cursor * 0.02;
      g.opacity *= (a > 0 ? 1 : 0) * (1 - b);
      g.y += b * -c.H * 0.12;
    }
  },

  unfold: {
    label: 'Unfold', roles: ['qi', 'zhuan'],
    params: [P('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 0), P('stag', 'Stagger', 0, 0.95, 0.01, 0.7),
             P('depth', 'Depth push', 0, 1, 0.01, 0.4)],
    apply(g, c) {
      const a = easeOutQuint(seq(c.u, c.i, c.n, 0, 0.45, c.p.stag));
      const b = easeInCubic(seq(c.u, c.i, c.n, 0.78, 0.22, 0.4, 'rtl'));
      const ang = (1 - a) * -Math.PI / 2 + b * Math.PI / 2;
      if (c.p.axis > 0.5) g.ry += ang; else g.rx += ang;
      g.z += (1 - a) * -c.p.depth * c.H * 0.6 + b * c.p.depth * c.H * 0.4;
      g.opacity *= a * (1 - b);
    }
  },

  // ── 承 · develop ──────────────────────────────────────────
  // 承 picks the piece up where 起 left it: gathered at that one point,
  // then spreading outward slowly across the whole stage.
  spread: {
    label: 'Spread', roles: ['cheng'],
    params: [P('gather', 'Gather at start', 0, 1, 0.01, 0.88), P('span', 'Spread over', 0.15, 1, 0.01, 0.78),
             P('sway', 'Sway', 0, 1, 0.01, 0.3)],
    apply(g, c) {
      const a = easeOutQuint(seq(c.u, c.i, c.n, 0, c.p.span, 0.5, 'center'));
      const env = smoothstep(0, 0.04, c.u) * (1 - smoothstep(0.9, 1, c.u));
      const k = lerp(1 - c.p.gather, 1, a);
      g.x *= k; g.y *= k;
      const sway = Math.sin(c.time * TAU * 0.17 + c.i * 0.7) * c.p.sway;
      g.y += sway * c.size * 0.07;
      g.rz += sway * 0.05;
      g.sx = g.sy = g.sz = lerp(0.5, 1, a) * (1 + c.pulse * 0.05);
      g.opacity *= env;
    }
  },

  breathe: {
    label: 'Breathe', roles: ['cheng'],
    params: [P('amt', 'Amount', 0, 0.4, 0.005, 0.06), P('rate', 'Rate', 0.05, 3, 0.01, 0.4),
             P('phase', 'Per-glyph phase', 0, 1, 0.01, 0.35)],
    apply(g, c) {
      const env = smoothstep(0, 0.12, c.u) * (1 - smoothstep(0.9, 1, c.u));
      const ph = c.i * c.p.phase;
      const s = 1 + Math.sin(c.time * TAU * c.p.rate + ph) * c.p.amt + c.pulse * 0.09;
      g.sx = g.sy = g.sz = s;
      g.y += Math.sin(c.time * TAU * c.p.rate * 0.5 + ph) * c.size * 0.02;
      g.opacity *= env;
    }
  },

  wave: {
    label: 'Wave', roles: ['cheng'],
    params: [P('amp', 'Amplitude', 0, 0.5, 0.005, 0.09), P('len', 'Wavelength', 0.2, 6, 0.05, 1.4),
             P('speed', 'Speed', 0, 3, 0.01, 0.7)],
    apply(g, c) {
      const env = smoothstep(0, 0.16, c.u) * (1 - smoothstep(0.86, 1, c.u));
      const ph = (c.i / Math.max(1, c.n)) * TAU * c.p.len - c.time * TAU * c.p.speed;
      g.y += Math.sin(ph) * c.p.amp * c.size * (0.6 + c.pulse * 0.5);
      g.rz += Math.cos(ph) * 0.12;
      g.sx = g.sy = g.sz = 1 + c.pulse * 0.05;
      g.opacity *= env;
    }
  },

  drift: {
    label: 'Drift', roles: ['cheng'],
    params: [P('amt', 'Spread', 0, 1, 0.01, 0.22), P('rate', 'Rate', 0.02, 1.5, 0.01, 0.22),
             P('depth', 'Parallax', 0, 1, 0.01, 0.45)],
    apply(g, c) {
      const env = smoothstep(0, 0.18, c.u) * (1 - smoothstep(0.84, 1, c.u));
      const r1 = hash(c.i, 11), r2 = hash(c.i, 23), r3 = hash(c.i, 41);
      const th = c.time * TAU * c.p.rate;
      g.x += Math.sin(th + r1 * TAU) * c.p.amt * c.size * 0.5;
      g.y += Math.cos(th * 0.83 + r2 * TAU) * c.p.amt * c.size * 0.4;
      g.z += Math.sin(th * 0.6 + r3 * TAU) * c.p.depth * c.H * 0.18;
      g.rz += Math.sin(th * 0.5 + r1 * TAU) * 0.06;
      g.opacity *= env;
    }
  },

  tracking: {
    label: 'Tracking', roles: ['cheng'],
    params: [P('open', 'Open to', -0.4, 1.5, 0.01, 0.5), P('from', 'Start at', -0.6, 1, 0.01, -0.12),
             P('lift', 'Lift', 0, 1, 0.01, 0.15)],
    apply(g, c) {
      const env = smoothstep(0, 0.14, c.u) * (1 - smoothstep(0.88, 1, c.u));
      const k = easeInOutCubic(smoothstep(0.05, 0.95, c.u));
      const spread = lerp(c.p.from, c.p.open, k);
      const mid = (c.n - 1) / 2;
      g.x += (c.i - mid) * spread * c.size * 0.55;
      g.y += Math.sin(k * Math.PI) * c.p.lift * c.size * 0.12;
      g.sx = g.sy = g.sz = 1 + c.pulse * 0.04;
      g.opacity *= env;
    }
  },

  // ── 轉 · turn ─────────────────────────────────────────────
  shatter: {
    label: 'Shatter', roles: ['zhuan'],
    params: [P('force', 'Force', 0, 1.5, 0.01, 0.45), P('spin', 'Spin', 0, 1.5, 0.01, 0.5),
             P('decay', 'Settle', 0.5, 12, 0.1, 4)],
    apply(g, c) {
      const env = smoothstep(0, 0.08, c.u) * (1 - smoothstep(0.9, 1, c.u));
      const kick = Math.exp(-c.sinceBeat * c.p.decay) * (0.35 + c.react);
      const a = hash(c.i, 5) * TAU, r = 0.4 + hash(c.i, 9) * 0.6;
      g.x += Math.cos(a) * kick * c.p.force * c.size * r;
      g.y += Math.sin(a) * kick * c.p.force * c.size * r;
      g.z += (hash(c.i, 13) - 0.5) * kick * c.p.force * c.H * 0.3;
      g.rz += (hash(c.i, 17) - 0.5) * kick * c.p.spin * 1.4;
      g.rx += (hash(c.i, 19) - 0.5) * kick * c.p.spin * 0.9;
      g.sx = g.sy = g.sz = 1 + kick * 0.18;
      g.opacity *= env;
    }
  },

  flip: {
    label: 'Flip', roles: ['zhuan'],
    params: [P('turns', 'Turns', 0.5, 4, 0.5, 1), P('stag', 'Stagger', 0, 0.95, 0.01, 0.65),
             P('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 1)],
    apply(g, c) {
      const a = easeInOutCubic(seq(c.u, c.i, c.n, 0.1, 0.72, c.p.stag));
      const ang = a * Math.PI * c.p.turns;
      if (c.p.axis > 0.5) g.ry += ang; else g.rx += ang;
      const env = smoothstep(0, 0.08, c.u) * (1 - smoothstep(0.92, 1, c.u));
      g.z += Math.sin(a * Math.PI) * c.H * 0.12;
      g.sx = g.sy = g.sz = 1 + Math.sin(a * Math.PI) * 0.1 + c.pulse * 0.05;
      g.opacity *= env;
    }
  },

  glitch: {
    label: 'Glitch', roles: ['zhuan'],
    params: [P('amt', 'Displace', 0, 1, 0.01, 0.35), P('rate', 'Rate', 1, 30, 1, 12),
             P('slice', 'Dropout', 0, 0.9, 0.01, 0.25)],
    apply(g, c) {
      const env = smoothstep(0, 0.06, c.u) * (1 - smoothstep(0.94, 1, c.u));
      const step = Math.floor(c.time * c.p.rate);
      const r = hash(c.i * 31 + step, 61);
      const on = r > c.p.slice * (0.4 + c.react * 0.6);
      const jitter = (hash(c.i * 17 + step, 7) - 0.5) * 2;
      g.x += jitter * c.p.amt * c.size * 0.6 * (0.4 + c.pulse);
      g.y += (hash(c.i * 13 + step, 29) - 0.5) * c.p.amt * c.size * 0.18;
      g.sx = 1 + (hash(c.i + step, 3) - 0.5) * c.p.amt * 0.5;
      g.sy = g.sz = 1;
      g.opacity *= env * (on ? 1 : 0.06);
    }
  },

  explode: {
    label: 'Explode', roles: ['zhuan'],
    params: [P('force', 'Force', 0, 2, 0.01, 0.7), P('hold', 'Hold', 0, 0.9, 0.01, 0.45),
             P('spin', 'Spin', 0, 2, 0.01, 0.6)],
    apply(g, c) {
      const a = easeOutCubic(smoothstep(0, 0.22, c.u));
      const b = easeInCubic(smoothstep(c.p.hold, 1, c.u));
      const ang = Math.atan2(g.y || (hash(c.i, 2) - 0.5), g.x || (hash(c.i, 4) - 0.5));
      const r = 0.5 + hash(c.i, 8) * 0.9;
      g.x += Math.cos(ang) * b * c.p.force * c.W * 0.55 * r + (1 - a) * (hash(c.i, 6) - 0.5) * c.W * 0.2;
      g.y += Math.sin(ang) * b * c.p.force * c.H * 0.55 * r;
      g.z += b * (hash(c.i, 12) - 0.5) * c.H * c.p.force;
      g.rz += b * c.p.spin * (hash(c.i, 14) - 0.5) * TAU;
      g.sx = g.sy = g.sz = lerp(0.9, 1, a) * (1 + c.pulse * 0.07) * lerp(1, 0.6, b);
      g.opacity *= a * (1 - smoothstep(c.p.hold + 0.2, 1, c.u));
    }
  },

  scramble: {
    label: 'Scramble', roles: ['zhuan'],
    params: [P('amt', 'Swap range', 0, 1.5, 0.01, 0.6), P('rate', 'Rate', 0.5, 12, 0.5, 4),
             P('tilt', 'Tilt', 0, 1, 0.01, 0.4)],
    apply(g, c) {
      const env = smoothstep(0, 0.1, c.u) * (1 - smoothstep(0.88, 1, c.u));
      const settle = 1 - smoothstep(0.55, 0.95, c.u);
      const step = Math.floor(c.time * c.p.rate);
      const target = Math.floor(hash(c.i + step * 97, 43) * c.n);
      const dx = (target - c.i) * c.size * 0.7 * c.p.amt;
      const k = smoothstep(0, 1, (c.time * c.p.rate) % 1);
      g.x += dx * k * settle;
      g.rz += (hash(c.i + step, 51) - 0.5) * c.p.tilt * settle;
      g.sx = g.sy = g.sz = 1 + c.pulse * 0.08;
      g.opacity *= env;
    }
  },

  // ── 合 · close ────────────────────────────────────────────
  converge: {
    label: 'Converge', roles: ['he'],
    params: [P('spread', 'From', 0, 2, 0.01, 0.8), P('span', 'Settle over', 0.1, 0.95, 0.01, 0.55),
             P('spin', 'Spin in', 0, 2, 0.01, 0.5)],
    apply(g, c) {
      const a = easeOutQuint(seq(c.u, c.i, c.n, 0, c.p.span, 0.5, 'random'));
      const b = smoothstep(0.9, 1, c.u);
      const r1 = hash(c.i, 21) - 0.5, r2 = hash(c.i, 33) - 0.5;
      g.x += (1 - a) * r1 * c.W * c.p.spread;
      g.y += (1 - a) * r2 * c.H * c.p.spread;
      g.z += (1 - a) * (hash(c.i, 45) - 0.5) * c.H * c.p.spread * 0.6;
      g.rz += (1 - a) * r1 * TAU * c.p.spin;
      g.sx = g.sy = g.sz = lerp(0.7, 1, a) * (1 + c.pulse * 0.05);
      g.opacity *= a * (1 - b);
    }
  },

  collapse: {
    label: 'Collapse', roles: ['he'],
    params: [P('hold', 'Hold', 0, 0.9, 0.01, 0.5), P('to', 'End scale', 0, 1, 0.01, 0.02),
             P('spin', 'Spin', 0, 2, 0.01, 0.35)],
    apply(g, c) {
      const a = easeOutCubic(smoothstep(0, 0.2, c.u));
      const b = easeInOutCubic(smoothstep(c.p.hold, 1, c.u));
      g.x = lerp(g.x, 0, b);
      g.y = lerp(g.y, 0, b);
      g.rz += b * c.p.spin * TAU * 0.25 * (hash(c.i, 7) - 0.5) * 2;
      g.sx = g.sy = g.sz = lerp(lerp(1.06, 1, a), c.p.to, b) * (1 + c.pulse * 0.04);
      g.opacity *= a * (1 - smoothstep(0.86, 1, c.u));
    }
  },

  dissolve: {
    label: 'Dissolve', roles: ['he'],
    params: [P('lift', 'Lift', -1, 1, 0.01, 0.35), P('span', 'Fade over', 0.1, 0.95, 0.01, 0.6),
             P('blurScale', 'Bloat', 0, 1, 0.01, 0.35)],
    apply(g, c) {
      const a = easeOutCubic(smoothstep(0, 0.14, c.u));
      const b = seq(c.u, c.i, c.n, 1 - c.p.span, c.p.span, 0.75, 'random');
      const e = easeInOutCubic(b);
      g.y += e * c.p.lift * c.H * 0.35 + (1 - a) * -c.size * 0.2;
      g.x += e * (hash(c.i, 55) - 0.5) * c.size * 0.6;
      g.rz += e * (hash(c.i, 65) - 0.5) * 0.8;
      g.sx = g.sy = g.sz = lerp(0.94, 1, a) * lerp(1, 1 + c.p.blurScale, e);
      g.opacity *= a * (1 - e);
    }
  },

  // ── universal ─────────────────────────────────────────────
  zoom: {
    label: 'Zoom', roles: ['qi', 'cheng', 'zhuan', 'he'],
    params: [P('from', 'From depth', -2, 2, 0.01, 1), P('to', 'To depth', -2, 2, 0.01, -0.35),
             P('roll', 'Roll', -1, 1, 0.01, 0.1)],
    apply(g, c) {
      const k = easeInOutCubic(clamp(c.u, 0, 1));
      const env = smoothstep(0, 0.14, c.u) * (1 - smoothstep(0.86, 1, c.u));
      g.z += lerp(c.p.from, c.p.to, k) * c.H * 0.5;
      g.rz += lerp(-c.p.roll, c.p.roll, k) * 0.3;
      g.sx = g.sy = g.sz = 1 + c.pulse * 0.05;
      g.opacity *= env;
    }
  },

  hold: {
    label: 'Hold (no motion)', roles: ['qi', 'cheng', 'zhuan', 'he'],
    params: [P('fade', 'Fade edges', 0, 0.5, 0.01, 0.1)],
    apply(g, c) {
      const f = Math.max(0.001, c.p.fade);
      g.opacity *= smoothstep(0, f, c.u) * (1 - smoothstep(1 - f, 1, c.u));
      g.sx = g.sy = g.sz = 1 + c.pulse * 0.04;
    }
  }
};

export const effectIds = () => Object.keys(EFFECTS);
export const effectsForRole = role => effectIds().filter(id => EFFECTS[id].roles.includes(role));

/** Merge authored params over the effect's defaults. */
export function resolveParams(effectId, params = {}) {
  const def = EFFECTS[effectId] ?? EFFECTS.hold;
  const out = {};
  for (const p of def.params) out[p.key] = params[p.key] ?? p.def;
  return out;
}

export function applyEffect(effectId, g, c) {
  (EFFECTS[effectId] ?? EFFECTS.hold).apply(g, c);
}
