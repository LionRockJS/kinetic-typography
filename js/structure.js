// 起承轉合 — the reference structure of a piece.
//
// These are NOT containers for content. They are guide lines on the timeline,
// the way a grid is a guide on a canvas: they mark where the piece opens, where
// it spreads, where it turns and where it resolves. Text clips are placed
// against them and snap to them, but nothing "lives inside" a guide.
//
// A composition carries the structure at two levels:
//
//   overall    the arc of the whole video — usually simple, spanning end to end
//   animation  the finer arc the individual animations move to; it has its own
//              span and its own repeat count, and it snaps to the overall level
//
//   起 qi     open      a short strike — the start point
//   承 cheng  develop   the long stretch, spreading out from that point
//   轉 zhuan  turn      the change point, a second or two
//   合 he     close     resolve
//
// Base pattern 起承轉合. After a 轉 comes another 承, so repeating the middle
// pair extends the arc: 起承轉承轉合, 起承轉承轉承轉合, …

import { uid, clamp } from './util.js';

export const ROLES = {
  qi:    { key: 'qi',    cn: '起', pin: 'Qǐ',    en: 'Open',    color: '#38bdf8', weight: 0.45, cap: 1.2,
           note: 'A short strike. The start point — kept brief on purpose.' },
  cheng: { key: 'cheng', cn: '承', pin: 'Chéng', en: 'Develop', color: '#34d399', weight: 2.4,
           note: 'The long stretch: motion spreads outward from the start point.' },
  zhuan: { key: 'zhuan', cn: '轉', pin: 'Zhuǎn', en: 'Turn',    color: '#f472b6', weight: 0.5, cap: 1.6,
           note: 'The change point. A second or two, then it hands over.' },
  he:    { key: 'he',    cn: '合', pin: 'Hé',    en: 'Close',   color: '#fbbf24', weight: 1.2,
           note: 'Gather everything and resolve.' }
};

export const ROLE_KEYS = ['qi', 'cheng', 'zhuan', 'he'];
export const MAX_REPEATS = 6;
export const MIN_REGION = 0.15;

/** Role sequence for n 承轉 pairs: 起 (承 轉)×n 合 */
export function patternRoles(repeats) {
  const n = clamp(Math.round(repeats) || 1, 1, MAX_REPEATS);
  const mid = [];
  for (let i = 0; i < n; i++) mid.push('cheng', 'zhuan');
  return ['qi', ...mid, 'he'];
}

export const patternLabel = repeats => patternRoles(repeats).map(r => ROLES[r].cn).join('');

/**
 * Default region lengths across [0, duration].
 *
 * A role may declare a `cap` — the longest it should ever run. 起 and 轉 are
 * capped because they read as hits, not passages; the time they give back goes
 * to the uncapped roles, so a longer piece stretches 承 rather than the beats
 * that punctuate it.
 */
export function weightedSpans(roles, duration) {
  const lens = new Array(roles.length).fill(0);
  const total = roles.reduce((a, r) => a + ROLES[r].weight, 0);

  let capped = 0, freeWeight = 0;
  roles.forEach((r, i) => {
    const share = duration * (ROLES[r].weight / total);
    const cap = ROLES[r].cap;
    if (cap !== undefined && share > cap) { lens[i] = cap; capped += cap; }
    else freeWeight += ROLES[r].weight;
  });

  const rest = Math.max(0, duration - capped);
  roles.forEach((r, i) => {
    if (lens[i] === 0) lens[i] = freeWeight > 0 ? rest * (ROLES[r].weight / freeWeight) : 0;
  });

  const out = [];
  let t = 0;
  for (let i = 0; i < roles.length; i++) {
    out.push({ role: roles[i], start: t, end: i === roles.length - 1 ? duration : t + lens[i] });
    t += lens[i];
  }
  return out;
}

// ── levels ───────────────────────────────────────────────────
export const LEVELS = {
  overall: {
    key: 'overall', label: 'Overall', cn: '整體', repeats: 1,
    desc: 'The arc of the whole video. Keep it simple — it runs end to end.'
  },
  animation: {
    key: 'animation', label: 'Animation', cn: '動態', repeats: 3,
    desc: 'The finer arc the animations move to. It has its own span inside the video.'
  }
};
export const LEVEL_KEYS = ['overall', 'animation'];

/** Guide points for a pattern, laid out across [start, end]. */
export function buildGuides(repeats, start, end) {
  const span = Math.max(0.001, end - start);
  return weightedSpans(patternRoles(repeats), span)
    .map(s => ({ id: uid('g'), role: s.role, t: start + s.start }));
}

export function makeLevel(key, repeats, start, end) {
  return { key, repeats, start, end, guides: buildGuides(repeats, start, end) };
}

/** Regenerate a level's guide times from scratch — only "Rebalance" wants this. */
export function rebuildGuides(level, repeats) {
  const fresh = buildGuides(repeats, level.start, level.end);
  return fresh.map((g, i) => (level.guides[i]?.role === g.role ? { ...level.guides[i], t: g.t } : g));
}

/**
 * Add one 承轉 pair without disturbing a single existing point.
 *
 * The longest 承 region is split in two by dropping a new 轉 into the middle of
 * it, followed by a new 承. Since every 承 is already followed by a 轉, the
 * sequence stays 起(承轉)ⁿ合 — and every guide the user has placed keeps its time.
 *
 *   … 承ₖ ────────────────── 轉ₖ …   becomes
 *   … 承ₖ ───── 轉ₙ 承ₙ ───── 轉ₖ …
 *
 * @returns {boolean} false when no 承 region has room for the split.
 */
export function addPair(level, min = MIN_REGION) {
  const gs = level.guides;
  let at = -1, widest = -1;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i].role !== 'cheng') continue;
    const span = (gs[i + 1]?.t ?? level.end) - gs[i].t;
    if (span > widest) { widest = span; at = i; }
  }
  if (at < 0) return false;

  const start = gs[at].t;
  const end = gs[at + 1]?.t ?? level.end;
  const turn = clamp((end - start) * 0.15, min, ROLES.zhuan.cap);
  if (end - start < min * 2 + turn) return false;

  const half = (end - start - turn) / 2;
  gs.splice(at + 1, 0,
    { id: uid('g'), role: 'zhuan', t: start + half },
    { id: uid('g'), role: 'cheng', t: start + half + turn });
  level.repeats++;
  return true;
}

/**
 * Drop one 承轉 pair, again leaving every surviving point where it is: the
 * shortest 轉ₖ + 承ₖ₊₁ run is removed, which merges two 承 regions into one.
 */
export function removePair(level) {
  const gs = level.guides;
  if (level.repeats <= 1) return false;
  let at = -1, shortest = Infinity;
  for (let i = 1; i < gs.length - 1; i++) {
    if (gs[i].role !== 'zhuan' || gs[i + 1].role !== 'cheng') continue;   // never the final 轉
    const span = (gs[i + 2]?.t ?? level.end) - gs[i].t;
    if (span < shortest) { shortest = span; at = i; }
  }
  if (at < 0) return false;
  gs.splice(at, 2);
  level.repeats--;
  return true;
}

export function rebalanceGuides(level) {
  const spans = weightedSpans(patternRoles(level.repeats), Math.max(0.001, level.end - level.start));
  level.guides.forEach((g, i) => { if (spans[i]) g.t = level.start + spans[i].start; });
  return level.guides;
}

/** Keep a level's guides ordered, non-overlapping and inside its own span. */
export function normalizeGuides(level, min = MIN_REGION) {
  const gs = level.guides;
  if (!gs.length) return gs;
  gs[0].t = level.start;
  for (let i = 1; i < gs.length; i++) {
    const lo = gs[i - 1].t + min;
    const hi = level.end - min * (gs.length - i);
    gs[i].t = clamp(gs[i].t, lo, Math.max(lo, hi));
  }
  return gs;
}

/**
 * Move the 起承 boundary and carry every later point with it by ratio, anchored
 * on the level's end — the same treatment the end cap gives the whole
 * composition. A longer opening strike compresses the arc that follows it
 * rather than shunting one point into its neighbour.
 *
 * @param {number[]} snapshot guide times as they were when the drag began
 */
export function scaleFromHead(level, snapshot, t1, min = MIN_REGION) {
  const gs = level.guides;
  const t0 = snapshot[1] ?? level.start;
  const k = (level.end - t1) / Math.max(1e-6, level.end - t0);
  gs[0].t = level.start;
  for (let i = 1; i < gs.length; i++) gs[i].t = t1 + (snapshot[i] - t0) * k;
  normalizeGuides(level, min);
  return gs;
}

/** How far the 起承 handle may travel before the arc behind it runs out of room. */
export function headRange(level, min = MIN_REGION) {
  return {
    lo: level.start + min,
    hi: Math.max(level.start + min, level.end - min * (level.guides.length - 1))
  };
}

/**
 * How far the moving end of a selected range may travel.
 * Outside points never move during a range drag, so the snapshot is authoritative.
 */
export function rangeBounds(level, snapshot, i0, i1, moving, min = MIN_REGION) {
  const minSpan = min * (i1 - i0);
  if (moving === i1) {
    return { lo: snapshot[i0] + minSpan, hi: (snapshot[i1 + 1] ?? level.end) - min };
  }
  return { lo: (snapshot[i0 - 1] ?? level.start) + min, hi: snapshot[i1] - minSpan };
}

/**
 * Rescale a run of points by dragging one of its ends, anchored on the other —
 * the same ratio move the end cap and the 起承 handle make, but bounded at both
 * ends by the selection. Every point between i0 and i1 travels with it so the
 * ordering can never fold over; points outside the run stay exactly where they are.
 */
export function scaleRange(level, snapshot, i0, i1, moving, t, min = MIN_REGION) {
  const gs = level.guides;
  const anchor = moving === i1 ? i0 : i1;
  const aT = snapshot[anchor];
  const { lo, hi } = rangeBounds(level, snapshot, i0, i1, moving, min);
  const tt = clamp(t, lo, Math.max(lo, hi));
  const k = (tt - aT) / ((snapshot[moving] - aT) || 1e-6);
  for (let j = i0; j <= i1; j++) gs[j].t = aT + (snapshot[j] - aT) * k;
  normalizeGuides(level, min);
  return tt;
}

/** Slide a run of points rigidly, clamped by the points on either side of it. */
export function translateRange(level, snapshot, i0, i1, delta, min = MIN_REGION) {
  const gs = level.guides;
  const before = (snapshot[i0 - 1] ?? level.start) + min;
  const after = (snapshot[i1 + 1] ?? level.end) - min;
  const d = clamp(delta, before - snapshot[i0], after - snapshot[i1]);
  for (let j = i0; j <= i1; j++) gs[j].t = snapshot[j] + d;
  normalizeGuides(level, min);
  return d;
}

/** Even spacing for a run of points across the span it already occupies. */
export function distributeRange(level, i0, i1, min = MIN_REGION) {
  const gs = level.guides;
  if (i1 - i0 < 2) return false;
  const a = gs[i0].t, b = gs[i1].t;
  const step = (b - a) / (i1 - i0);
  if (step < min) return false;
  for (let j = i0 + 1; j < i1; j++) gs[j].t = a + step * (j - i0);
  normalizeGuides(level, min);
  return true;
}

/** Move and/or stretch a whole level, carrying its guides with it. */
export function reframeLevel(level, start, end, min = MIN_REGION) {
  const oldSpan = Math.max(1e-6, level.end - level.start);
  const newSpan = Math.max(min * level.guides.length, end - start);
  const k = newSpan / oldSpan;
  level.guides.forEach(g => { g.t = start + (g.t - level.start) * k; });
  level.start = start;
  level.end = start + newSpan;
  normalizeGuides(level, min);
  return level;
}

/**
 * The phase a moment falls in for one level. Outside the level's own span there
 * is no phase — the animation level need not cover the whole video.
 */
export function regionAt(level, t) {
  if (!level?.guides?.length) return null;
  if (t < level.start || t > level.end) return null;
  const gs = level.guides;
  for (let i = gs.length - 1; i >= 0; i--) {
    if (t >= gs[i].t) {
      return { index: i, role: gs[i].role, start: gs[i].t, end: gs[i + 1]?.t ?? level.end, level: level.key };
    }
  }
  return { index: 0, role: gs[0].role, start: gs[0].t, end: gs[1]?.t ?? level.end, level: level.key };
}

/** The phase that should drive a clip's defaults: the finest level covering it. */
export function drivingRegion(levels, t) {
  return regionAt(levels.animation, t) ?? regionAt(levels.overall, t)
      ?? { index: 0, role: 'cheng', start: 0, end: 0, level: 'overall' };
}

/** Human-readable name for a repeated role, e.g. the 2nd 轉 → "轉2". */
export function guideLabel(guides, guide) {
  const same = guides.filter(g => g.role === guide.role);
  const n = same.indexOf(guide) + 1;
  return same.length > 1 ? `${ROLES[guide.role].cn}${n}` : ROLES[guide.role].cn;
}

/**
 * 起 always sits at 0 and the first 承 follows immediately, so the two share a
 * single control: one handle that says how long the opening strike runs.
 */
export const headIsCombined = gs => gs[0]?.role === 'qi' && gs[1]?.role === 'cheng';

/** Indices that get their own handle — the locked 0 point is folded into 起承. */
export function guideHandles(gs) {
  const out = [];
  for (let i = headIsCombined(gs) ? 1 : 0; i < gs.length; i++) out.push(i);
  return out;
}

/** Label and colours for a guide handle. */
export function guideDisplay(gs, i) {
  if (i === 1 && headIsCombined(gs)) {
    return { label: '起承', colors: [ROLES.qi.color, ROLES.cheng.color], combined: true };
  }
  const g = gs[i];
  return { label: guideLabel(gs, g), colors: [ROLES[g.role].color], combined: false };
}

/** A sensible starting effect for a clip that begins inside a given phase. */
export function defaultEffect(role, seed = 0) {
  const table = {
    qi:    ['strike', 'rise', 'fadeScale', 'typewriter'],
    cheng: ['spread', 'breathe', 'wave', 'drift'],
    zhuan: ['shatter', 'flip', 'glitch', 'explode'],
    he:    ['converge', 'collapse', 'dissolve']
  };
  const list = table[role] ?? table.cheng;
  return list[seed % list.length];
}
