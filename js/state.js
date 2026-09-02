// Project store + a tiny event bus.
//
// Two independent things live in a project:
//   levels — the 起承轉合 reference lines, at two scales: the overall arc of the
//            whole video, and the finer animation arc inside it. Structure only,
//            no content.
//   clips  — the text layers that actually render, snapped against those lines

import { makeLevel, rebuildGuides, normalizeGuides, reframeLevel, drivingRegion, guideHandles,
         addPair, removePair, LEVEL_KEYS, LEVELS, MAX_REPEATS, defaultEffect } from './structure.js';
import { grid as metroGrid } from './audio/metronome.js';
import { cameraAt, sortKeys, CAMERA_REST } from './camera.js';
import { clamp, uid } from './util.js';

const listeners = new Map();

export function on(evt, fn) {
  for (const e of evt.split(' ')) {
    if (!listeners.has(e)) listeners.set(e, new Set());
    listeners.get(e).add(fn);
  }
  return () => off(evt, fn);
}
export function off(evt, fn) { for (const e of evt.split(' ')) listeners.get(e)?.delete(fn); }
export function emit(evt, data) {
  for (const fn of listeners.get(evt) ?? []) fn(data);
  if (evt !== '*') for (const fn of listeners.get('*') ?? []) fn(evt, data);
}

export const DIM_PRESETS = [
  { label: 'Square 1080',    w: 1080, h: 1080 },
  { label: 'Vertical 9:16',  w: 1080, h: 1920 },
  { label: 'Landscape 16:9', w: 1920, h: 1080 },
  { label: 'Portrait 4:5',   w: 1080, h: 1350 },
  { label: 'Cinema 2.39:1',  w: 1920, h: 804  },
  { label: 'Story HD 9:16',  w: 720,  h: 1280 }
];

export const TRACKS = 3;
export const MIN_CLIP = 0.2;
export const FONT_SLOTS = 3;

export const state = {
  project: {
    name: 'Untitled Composition',
    width: 1080, height: 1080, fps: 30,
    duration: 24,
    bg: '#08090c', vignette: 0.45, grain: 0.06, depth: 0,
    levels: { overall: null, animation: null },
    clips: [],
    camera: { enabled: true, keys: [] }
  },
  ui: {
    time: 0, playing: false, loop: false,
    sel: null,                    // {type:'clip',id} | {type:'guide',level,id,ids} | {type:'camkey',id}
    snap: true, snapGuides: true, snapPeaks: true, safeArea: false,
    view: { start: 0, end: 24 },
    recording: false
  },
  // Three audio lanes that play together. Only the music lane is analysed —
  // voice and effects just need a waveform and a position.
  audio: {
    tracks: {
      bgm: { kind: 'bgm', name: '', duration: 0, peaks: null, start: 0, volume: 1, mute: false, ready: false },
      vo:  { kind: 'vo',  name: '', duration: 0, peaks: null, start: 0, volume: 1, mute: false, ready: false },
      sfx: { kind: 'sfx', name: '', duration: 0, peaks: null, start: 0, volume: 1, mute: false, ready: false }
    },
    // analysis of the music lane
    bpm: 0, beats: [], onsets: [], onsetStrength: [], envelope: null,
    offset: 0,              // fine correction of the detected grid against the track
    beatsPerBar: 4,
    times: [], bars: [],    // cached effective beat / bar times
    gridSource: 'manual',
    hits: [],               // filtered transients — the "peaks" layers snap to
    hitGap: 0.35,           // never two peaks closer than this
    hitSense: 0.2           // how strong a transient has to be to count
  },

  // The click track: its own tempo source, voice and level, mixed alongside the
  // music rather than instead of it.
  metro: {
    on: false, voice: 'kit', volume: 0.7, accent: true, inRecording: false,
    source: 'track',    // 'track' follows the analysed beats, 'manual' uses bpm/offset
    bpm: 120, offset: 0
  },

  // Ordered fallback stack: a character is drawn with the first font that has
  // a glyph for it, so a Latin face can carry the headline and a CJK face the 漢字.
  fonts: new Array(3).fill(null)   // [{ font, name, preset } | null]
};

export const fontStack = () => state.fonts.map(f => f?.font).filter(Boolean);
export const fontsReady = () => fontStack().length > 0;

export function setFont(slot, entry) {
  if (slot < 0 || slot >= FONT_SLOTS) return;
  state.fonts[slot] = entry;
  emit('fonts', state.fonts);
  emit('render');
}

export function makeClip(start, end, track, role, text = 'Text') {
  return {
    id: uid('c'), start, end, track,
    text,
    effect: defaultEffect(role),
    params: {},
    color: '#ffffff',
    size: 0.2,
    align: 'center',
    lineHeight: 1.25,
    tracking: 0,
    offsetX: 0, offsetY: 0,
    beatReact: role === 'zhuan' ? 0.6 : 0.25
  };
}

export function initProject() {
  const p = state.project;
  p.levels = {
    overall: makeLevel('overall', LEVELS.overall.repeats, 0, p.duration),
    animation: makeLevel('animation', LEVELS.animation.repeats, 0, p.duration)
  };
  const og = p.levels.overall.guides;
  const region = i => ({ start: og[i].t, end: og[i + 1]?.t ?? p.duration });

  // A small demo arrangement so the canvas is not empty. Clips are placed
  // against the guides — they are not owned by them.
  const r0 = region(0), r1 = region(1), r2 = region(2), r3 = region(3);
  p.clips = [
    Object.assign(makeClip(r0.start, r1.start + 0.6, 0, 'qi', 'KINETIC'), { size: 0.16 }),
    Object.assign(makeClip(r1.start + 0.3, r2.end, 1, 'cheng', '起承轉合'), { size: 0.21 }),
    Object.assign(makeClip(r2.start, r2.end + 0.4, 0, 'zhuan', 'TURN'), { size: 0.18, color: '#f472b6' }),
    Object.assign(makeClip(r3.start, p.duration, 0, 'he', 'TYPOGRAPHY\nCOMPOSER'), { size: 0.13 })
  ];
  state.ui.sel = { type: 'clip', id: p.clips[1].id };
  state.ui.view = { start: 0, end: p.duration * 1.05 };
}

/**
 * The beat grid everything snaps to, from whichever source is active:
 *   'track'  — detected beats + where the track sits + grid correction
 *   'manual' — a plain tempo grid, so there is a meter to work to with no music
 *
 * Cached, because the renderer, the timeline and the metronome all read it.
 */
export function syncBeatTimes() {
  const a = state.audio, m = state.metro;
  const bgm = a.tracks.bgm;
  const followTrack = m.source === 'track' && bgm.ready && a.beats.length > 0;

  if (followTrack) {
    const k = bgm.start + a.offset;
    a.times = a.beats.map(b => b + k);
  } else {
    a.times = metroGrid(m.bpm, m.offset, state.project.duration);
  }
  a.bars = a.times.filter((_, i) => i % a.beatsPerBar === 0);
  a.gridSource = followTrack ? 'track' : 'manual';
  syncHits();                       // peaks ride along with the track position
  emit('grid', a);
}

export const hasGrid = () => state.audio.times.length > 0;

/**
 * Musical peaks: the detected transients, thinned so no two sit closer than
 * `hitGap`. Strongest first, so a thinned-out region keeps its loudest hit
 * rather than merely its earliest one.
 */
export function syncHits() {
  const a = state.audio;
  if (!a.tracks.bgm.ready || !a.onsets.length) { a.hits = []; return; }

  const order = a.onsets
    .map((t, i) => i)
    .filter(i => (a.onsetStrength[i] ?? 1) >= a.hitSense)
    .sort((x, y) => (a.onsetStrength[y] ?? 1) - (a.onsetStrength[x] ?? 1));

  const kept = [];                       // kept sorted, so proximity is a binary search
  for (const i of order) {
    const t = a.onsets[i];
    if (nearestSorted(kept, t) < a.hitGap) continue;
    let lo = 0, hi = kept.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (kept[mid] < t) lo = mid + 1; else hi = mid; }
    kept.splice(lo, 0, t);
  }
  a.hits = kept.map(t => t + a.tracks.bgm.start);
  emit('hits', a.hits);
}

function nearestSorted(sorted, v) {
  if (!sorted.length) return Infinity;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  let best = Infinity;
  for (const j of [lo - 1, lo, lo + 1]) {
    if (j >= 0 && j < sorted.length) best = Math.min(best, Math.abs(sorted[j] - v));
  }
  return best;
}

export function setHitParams({ gap, sense }) {
  const a = state.audio;
  if (gap !== undefined) a.hitGap = clamp(gap, 0.03, 4);
  if (sense !== undefined) a.hitSense = clamp(sense, 0, 0.95);
  syncHits();
}

export function setMetro(props) {
  Object.assign(state.metro, props);
  if ('source' in props || 'bpm' in props || 'offset' in props) syncBeatTimes();
  emit('metro', state.metro);
}

export const beatTimes = () => state.audio.times;
export const barTimes = () => state.audio.bars;

export const track = kind => state.audio.tracks[kind];
export const anyAudio = () => Object.values(state.audio.tracks).some(t => t.ready);

/** Slip one lane along the timeline. */
export function setTrackStart(kind, t) {
  const tr = track(kind);
  if (!tr) return;
  tr.start = t;
  if (kind === 'bgm') syncBeatTimes();
  emit('audioMove', { kind, start: t });
  emit('render');
}

export function setTrackLevel(kind, props) {
  const tr = track(kind);
  if (!tr) return;
  Object.assign(tr, props);
  emit('audioLevel', { kind, ...props });
}

// ── accessors ────────────────────────────────────────────────
export const levels = () => state.project.levels;
export const level = key => state.project.levels[key];
export const guides = (key = 'overall') => state.project.levels[key]?.guides ?? [];
export const allGuideTimes = () => LEVEL_KEYS.flatMap(k => guides(k).map(g => g.t));
export const clips = () => state.project.clips;
export const selection = () => state.ui.sel;
export const selectedClip = () =>
  state.ui.sel?.type === 'clip' ? clips().find(c => c.id === state.ui.sel.id) ?? null : null;
export const selectedGuide = () => {
  const sel = state.ui.sel;
  if (sel?.type !== 'guide') return null;
  const g = guides(sel.level).find(x => x.id === sel.id);
  return g ? { guide: g, level: level(sel.level) } : null;
};

/** Ids currently selected in a level (empty unless that level holds the selection). */
export function selectedGuideIds(levelKey = null) {
  const sel = state.ui.sel;
  if (sel?.type !== 'guide') return [];
  if (levelKey && sel.level !== levelKey) return [];
  return sel.ids ?? (sel.id ? [sel.id] : []);
}

/** Selected guide indices in a level, ascending. */
export function selectedGuideIndices(levelKey) {
  const ids = new Set(selectedGuideIds(levelKey));
  const gs = guides(levelKey);
  const out = [];
  for (let i = 0; i < gs.length; i++) if (ids.has(gs[i].id)) out.push(i);
  return out;
}

/**
 * @param {'set'|'toggle'|'range'} mode  'toggle' adds or removes one point,
 *        'range' extends from the current primary to the clicked one.
 */
export function selectGuide(levelKey, id, mode = 'set') {
  const lv = level(levelKey);
  if (!lv) return;
  const sel = state.ui.sel;
  const sameLevel = sel?.type === 'guide' && sel.level === levelKey;
  const selectable = new Set(guideHandles(lv.guides));   // index 0 has no handle
  let ids = sameLevel ? [...(sel.ids ?? [sel.id])] : [];

  if (mode === 'toggle') {
    ids = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
    if (!ids.length) { state.ui.sel = null; emit('selection', null); return; }
    if (!ids.includes(id)) id = ids.at(-1);
  } else if (mode === 'range' && sameLevel && sel.id) {
    const a = lv.guides.findIndex(g => g.id === sel.id);
    const b = lv.guides.findIndex(g => g.id === id);
    if (a < 0 || b < 0) { ids = [id]; }
    else {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      ids = lv.guides.filter((g, i) => i >= lo && i <= hi && selectable.has(i)).map(g => g.id);
    }
  } else {
    ids = [id];
  }
  state.ui.sel = { type: 'guide', level: levelKey, id, ids };
  emit('selection', state.ui.sel);
}

/** Select every guide of a level whose time falls inside [a, b]. */
export function selectGuidesInRange(levelKey, a, b) {
  const lv = level(levelKey);
  if (!lv) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const picked = guideHandles(lv.guides)
    .filter(i => lv.guides[i].t >= lo && lv.guides[i].t <= hi)
    .map(i => lv.guides[i].id);
  if (!picked.length) { state.ui.sel = null; emit('selection', null); return; }
  state.ui.sel = { type: 'guide', level: levelKey, id: picked.at(-1), ids: picked };
  emit('selection', state.ui.sel);
}
export const clipsAt = t => clips().filter(c => t >= c.start && t < c.end);

// ── camera track ─────────────────────────────────────────────
export const camera = () => state.project.camera;
export const cameraKeys = () => state.project.camera.keys;
export const selectedCamKey = () =>
  state.ui.sel?.type === 'camkey' ? cameraKeys().find(k => k.id === state.ui.sel.id) ?? null : null;

/** New key takes the framing already in force, so adding one never jumps. */
export function addCameraKey(t) {
  const cam = camera();
  const at = clamp(t, 0, state.project.duration);
  const existing = cam.keys.find(k => Math.abs(k.t - at) < 1e-3);
  if (existing) { state.ui.sel = { type: 'camkey', id: existing.id }; emit('selection', state.ui.sel); return existing; }

  const now = cam.keys.length ? cameraAt({ ...cam, enabled: true }, at) : CAMERA_REST;
  const key = { id: uid('ck'), t: at, x: now.x, y: now.y, zoom: now.zoom, roll: now.roll, ease: 'smooth' };
  cam.keys.push(key);
  sortKeys(cam);
  state.ui.sel = { type: 'camkey', id: key.id };
  emit('camera', cam);
  emit('selection', state.ui.sel);
  emit('render');
  return key;
}

export function updateCameraKey(id, props) {
  const cam = camera();
  const k = cam.keys.find(x => x.id === id);
  if (!k) return;
  Object.assign(k, props);
  if ('t' in props) { k.t = clamp(k.t, 0, state.project.duration); sortKeys(cam); }
  emit('camera', cam);
  emit('render');
}

export function removeCameraKey(id) {
  const cam = camera();
  const i = cam.keys.findIndex(k => k.id === id);
  if (i < 0) return;
  cam.keys.splice(i, 1);
  if (state.ui.sel?.type === 'camkey' && state.ui.sel.id === id) {
    state.ui.sel = cam.keys.length ? { type: 'camkey', id: cam.keys[Math.max(0, i - 1)].id } : null;
    emit('selection', state.ui.sel);
  }
  emit('camera', cam);
  emit('render');
}

export function setCameraEnabled(on) {
  camera().enabled = on;
  emit('camera', camera());
  emit('render');
}

export function commitCameraKeys() {
  sortKeys(camera());
  emit('camera', camera());
  emit('render');
}

export function select(type, id, levelKey = null) {
  const cur = state.ui.sel;
  if (cur?.type === type && cur?.id === id && cur?.level === levelKey &&
      (type !== 'guide' || (cur.ids?.length ?? 1) === 1)) return;
  state.ui.sel = type ? (type === 'guide' ? { type, id, level: levelKey, ids: [id] } : { type, id }) : null;
  emit('selection', state.ui.sel);
}

export function setTime(t, why = 'seek') {
  state.ui.time = clamp(t, 0, state.project.duration);
  emit('time', { time: state.ui.time, why });
}

// ── mutations ────────────────────────────────────────────────
export function patch(props, evt = 'project') {
  Object.assign(state.project, props);
  emit(evt, state.project);
  emit('render');
}

/**
 * Change a level's 承轉 pair count in place. Existing points never move — pairs
 * are inserted into (or merged out of) 承 regions.
 * @returns {boolean} false when a pair could not be added for lack of room.
 */
export function setRepeats(levelKey, n) {
  const lv = level(levelKey);
  if (!lv) return true;
  const target = clamp(Math.round(n), 1, MAX_REPEATS);
  let ok = true;
  while (lv.repeats < target) if (!addPair(lv)) { ok = false; break; }
  while (lv.repeats > target) if (!removePair(lv)) { ok = false; break; }
  normalizeGuides(lv);
  emit('guides', lv);
  emit('render');
  return ok;
}

/** Reset a level to the default weighting — the one place points do move. */
export function rebalanceLevel(levelKey) {
  const lv = level(levelKey);
  if (!lv) return;
  lv.guides = rebuildGuides(lv, lv.repeats);
  normalizeGuides(lv);
  emit('guides', lv);
  emit('render');
}

export function reframe(levelKey, start, end) {
  const lv = level(levelKey);
  if (!lv) return;
  reframeLevel(lv, clamp(start, 0, state.project.duration), clamp(end, 0, state.project.duration));
  emit('guides', lv);
  emit('render');
}

export function setDuration(d, { scale = true } = {}) {
  const p = state.project;
  const old = p.duration;
  p.duration = clamp(d, 1, 900);
  if (scale && old > 0) {
    const k = p.duration / old;
    p.camera.keys.forEach(key => { key.t *= k; });
    for (const key of LEVEL_KEYS) {
      const lv = level(key);
      if (!lv) continue;
      lv.start *= k; lv.end *= k;
      lv.guides.forEach(g => { g.t *= k; });
    }
    p.clips.forEach(c => { c.start *= k; c.end *= k; });
  }
  // the overall arc always spans the whole video
  if (p.levels.overall) { p.levels.overall.start = 0; p.levels.overall.end = p.duration; }
  for (const key of LEVEL_KEYS) {
    const lv = level(key);
    if (!lv) continue;
    lv.end = clamp(lv.end, lv.start + 0.001, p.duration);
    normalizeGuides(lv);
  }
  normalizeClips();
  state.ui.time = clamp(state.ui.time, 0, p.duration);
  if (state.ui.view.end - state.ui.view.start < 0.5) state.ui.view = { start: 0, end: p.duration * 1.05 };
  syncBeatTimes();
  emit('duration', p.duration);
  emit('guides', p.levels);
  emit('clips', p.clips);
  emit('render');
}

export function normalizeClips() {
  const d = state.project.duration;
  for (const c of state.project.clips) {
    c.start = clamp(c.start, 0, Math.max(0, d - MIN_CLIP));
    c.end = clamp(c.end, c.start + MIN_CLIP, d);
    c.track = clamp(Math.round(c.track), 0, TRACKS - 1);
  }
}

export function addClip(start, end, track = 0) {
  const p = state.project;
  const s = clamp(start, 0, p.duration - MIN_CLIP);
  const e = clamp(end, s + MIN_CLIP, p.duration);
  const role = drivingRegion(p.levels, s).role;
  const clip = makeClip(s, e, track, role, 'New text');
  p.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id };
  emit('clips', p.clips);
  emit('selection', state.ui.sel);
  emit('render');
  return clip;
}

export function duplicateClip(id) {
  const src = clips().find(c => c.id === id);
  if (!src) return null;
  const len = src.end - src.start;
  const clip = { ...src, id: uid('c'), params: { ...src.params },
                 start: clamp(src.end, 0, state.project.duration - MIN_CLIP) };
  clip.end = clamp(clip.start + len, clip.start + MIN_CLIP, state.project.duration);
  state.project.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id };
  emit('clips', state.project.clips);
  emit('selection', state.ui.sel);
  emit('render');
  return clip;
}

export function removeClip(id) {
  const p = state.project;
  const i = p.clips.findIndex(c => c.id === id);
  if (i < 0) return;
  p.clips.splice(i, 1);
  if (state.ui.sel?.id === id) state.ui.sel = p.clips.length ? { type: 'clip', id: p.clips[Math.max(0, i - 1)].id } : null;
  emit('clips', p.clips);
  emit('selection', state.ui.sel);
  emit('render');
}

export function updateClip(id, props) {
  const c = clips().find(x => x.id === id);
  if (!c) return;
  Object.assign(c, props);
  emit('clip', c);
  emit('render');
}

export function commitClips() {
  normalizeClips();
  emit('clips', clips());
  emit('render');
}

export function commitGuides(levelKey = null) {
  for (const key of levelKey ? [levelKey] : LEVEL_KEYS) {
    const lv = level(key);
    if (lv) normalizeGuides(lv);
  }
  emit('guides', state.project.levels);
  emit('render');
}

// ── serialisation (audio is referenced, never embedded) ──────
export function serialize() {
  return {
    format: 'kinetic-typography-composer',
    version: 2,
    project: JSON.parse(JSON.stringify(state.project)),
    audio: anyAudio()
      ? {
          bpm: state.audio.bpm, offset: state.audio.offset,
          beatsPerBar: state.audio.beatsPerBar,
          hitGap: state.audio.hitGap, hitSense: state.audio.hitSense,
          tracks: Object.fromEntries(Object.entries(state.audio.tracks).map(([k, t]) =>
            [k, { name: t.name, start: t.start, volume: t.volume, mute: t.mute, duration: t.duration }]))
        }
      : null,
    metro: { ...state.metro },
    fonts: state.fonts.map(f => (f ? { name: f.name, preset: f.preset ?? null } : null))
  };
}

export function deserialize(json) {
  if (!json || json.format !== 'kinetic-typography-composer') throw new Error('Not a composer file');
  const p = json.project ?? {};
  const legacyGuides = Array.isArray(p.guides) ? p.guides : null;   // v2 files
  Object.assign(state.project, p);
  const proj = state.project;
  delete proj.guides;
  delete proj.repeats;

  if (!proj.levels || !proj.levels.overall) {
    proj.levels = {
      overall: legacyGuides?.length
        ? { key: 'overall', repeats: p.repeats ?? 1, start: 0, end: proj.duration, guides: legacyGuides }
        : makeLevel('overall', LEVELS.overall.repeats, 0, proj.duration),
      animation: makeLevel('animation', LEVELS.animation.repeats, 0, proj.duration)
    };
  }
  if (!proj.levels.animation) proj.levels.animation = makeLevel('animation', LEVELS.animation.repeats, 0, proj.duration);
  proj.levels.overall.start = 0;
  proj.levels.overall.end = proj.duration;
  if (!Array.isArray(proj.clips)) proj.clips = [];
  if (!proj.camera || !Array.isArray(proj.camera.keys)) proj.camera = { enabled: true, keys: [] };
  sortKeys(proj.camera);
  for (const key of LEVEL_KEYS) normalizeGuides(proj.levels[key]);
  normalizeClips();
  state.ui.sel = state.project.clips.length ? { type: 'clip', id: state.project.clips[0].id } : null;
  state.ui.view = { start: 0, end: state.project.duration * 1.05 };
  state.ui.time = 0;
  emit('project', state.project);
  emit('guides', state.project.levels);
  emit('clips', state.project.clips);
  emit('selection', state.ui.sel);
  emit('render');
}
