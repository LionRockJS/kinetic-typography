// Project store + a tiny event bus.
//
// The project keeps independent structure, text, camera and backdrop media:
//   levels — the 起承轉合 reference lines, at two scales: the overall arc of the
//            whole video, and the finer animation arc inside it. Structure only,
//            no content.
//   clips  — the text layers that actually render, snapped against those lines
//   video  — visual-only backdrop channels; names/settings are saved, while
//            runtime object URLs never leak into project JSON

import { makeLevel, rebuildGuides, normalizeGuides, reframeLevel, drivingRegion, guideHandles,
         addPair, removePair, LEVEL_KEYS, LEVELS, MAX_REPEATS, defaultEffect } from './structure.js';
import { grid as metroGrid } from './audio/metronome.js';
import { VIDEO_CHANNEL_KINDS, VIDEO_EFFECTS } from './video/engine.js';
import { makeParticles, makeEmitter, MAX_EMITTERS } from './particles.js';
import { cameraAt, sortKeys, sortChannelKeys, defaultCameraPosition, cameraPosition,
         normalizeCameraKey, normalizeCameraChannelKey,
         CAMERA_AXES, EASES, isSplitCamera } from './camera.js';
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

/** A decoded audio source positioned on an audio lane. */
export function makeAudioClip(kind, props = {}) {
  return {
    id: uid('a'), kind,
    name: '', duration: 0, peaks: null, start: 0,
    transcript: '', words: [], speechStatus: 'idle', speechError: '',
    volume: 1, mute: false, ready: false,
    ...props,
    kind
  };
}

const freshAudioTracks = () => ({
  // BGM remains the single analysed source that drives the beat grid.
  bgm: makeAudioClip('bgm'),
  // VO and SFX are lanes containing any number of independently positioned clips.
  vo:  { kind: 'vo',  clips: [] },
  sfx: { kind: 'sfx', clips: [] }
});

export function makeVideoClip(kind, props = {}) {
  const source = props && typeof props === 'object' ? props : {};
  const inEffect = VIDEO_EFFECTS.some(effect => effect.kind === source.inEffect)
    ? source.inEffect : 'none';
  const outEffect = VIDEO_EFFECTS.some(effect => effect.kind === source.outEffect)
    ? source.outEffect : 'none';
  const duration = Math.max(0, Number(source.duration) || 0);
  const maxEffectDuration = duration || 900;
  const effectDuration = (value, fallback = 0.5) => clamp(
    Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback,
    0, maxEffectDuration);
  return {
    id: typeof source.id === 'string' && source.id ? source.id : uid('v'),
    kind,
    name: '', duration, start: 0,
    opacity: 1, fit: 'cover', loop: false, visible: true,
    inEffect, inDuration: effectDuration(source.inDuration),
    outEffect, outDuration: effectDuration(source.outDuration),
    ready: false,
    ...source,
    duration,
    inDuration: effectDuration(source.inDuration),
    outDuration: effectDuration(source.outDuration),
    mask: makeVideoMask(source.mask),
    kind,
    inEffect, outEffect
  };
}

export function makeVideoChannel(kind, props = {}) {
  const source = props && typeof props === 'object' ? props : {};
  const rawClips = Array.isArray(source.clips)
    ? source.clips
    : (source.name || Number(source.duration) > 0 ? [source] : []);
  return {
    kind,
    clips: rawClips
      .filter(clip => clip && typeof clip === 'object')
      .map(clip => makeVideoClip(kind, clip))
  };
}

/** A small, serialisable geometry mask applied to one backdrop channel. */
function makeVideoMask(props = {}) {
  const source = props && typeof props === 'object' ? props : {};
  return {
    shape: ['none', 'rectangle', 'circle'].includes(source.shape) ? source.shape : 'none',
    // Position is the mask centre in frame percentages. Size is the bounding
    // box in frame percentages; circles use the smaller dimension as radius.
    x: clamp(Number.isFinite(Number(source.x)) ? Number(source.x) : 0.5, 0, 1),
    y: clamp(Number.isFinite(Number(source.y)) ? Number(source.y) : 0.5, 0, 1),
    width: clamp(Number.isFinite(Number(source.width)) ? Number(source.width) : 0.72, 0.02, 2),
    height: clamp(Number.isFinite(Number(source.height)) ? Number(source.height) : 0.72, 0.02, 2),
    blur: clamp(Number.isFinite(Number(source.blur)) ? Number(source.blur) : 0, 0, 1000)
  };
}

const freshVideoChannels = () => Object.fromEntries(
  VIDEO_CHANNEL_KINDS.map(({ kind }) => [kind, makeVideoChannel(kind)])
);

export const state = {
  project: {
    name: 'Untitled Composition',
    width: 1080, height: 1080, fps: 30,
    duration: 24,
    bg: '#08090c', vignette: 0.45, grain: 0.06, depth: 0,
    levels: { overall: null, animation: null },
    clips: [],
    camera: { enabled: true, mode: 'combined', keys: [] },
    particles: makeParticles()
  },
  ui: {
    time: 0, playing: false, loop: false,
    sel: null,                    // {type:'clip',id} | {type:'guide',level,id,ids} | {type:'camkey',id}
    snap: true, snapGuides: true, snapPeaks: true, snapWords: true, safeArea: false,
    viewMode: 'output',           // 'output' = final camera, 'space' = 3D scene editor
    particle: null,               // id of the particle emitter being edited
    view: { start: 0, end: 24 },
    recording: false
  },
  // Three audio lanes that play together. Music drives beats; VO can also
  // carry optional word timings, while effects just need waveforms/positions.
  audio: {
    tracks: freshAudioTracks(),
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
  fonts: new Array(3).fill(null),  // [{ font, name, preset } | null]

  // Backdrop video settings are project-adjacent like audio. The actual
  // HTMLVideoElements live in VideoEngine and are never serialised.
  video: { channels: freshVideoChannels() }
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
    position: { x: 0, y: 0, z: 0 },
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
/** Clips on a lane; BGM is represented by its single legacy-compatible object. */
export const audioClips = kind => {
  const lane = state.audio.tracks[kind];
  if (!lane) return [];
  return kind === 'bgm' ? (lane.ready ? [lane] : []) : (lane.clips ?? []);
};

export const audioClip = (kind, id) => audioClips(kind).find(c => c.id === id) ?? null;

export const anyAudio = () => Object.values(state.audio.tracks).some(lane =>
  lane.kind === 'bgm'
    ? lane.ready || !!lane.name || Number(lane.duration) > 0
    : (lane.clips ?? []).some(c => c.ready || !!c.name || Number(c.duration) > 0));

/** Absolute word boundaries from every loaded VO clip, ready for timeline snapping. */
export const voiceWordTimes = () => {
  const times = [];
  for (const clip of audioClips('vo')) {
    if (!clip.ready || !Array.isArray(clip.words)) continue;
    const start = Number(clip.start) || 0;
    for (const word of clip.words) {
      const a = Number(word?.start), b = Number(word?.end);
      if (Number.isFinite(a)) times.push(start + a);
      if (Number.isFinite(b)) times.push(start + b);
    }
  }
  return times.sort((a, b) => a - b);
};

/** Add a VO/SFX clip. BGM is intentionally kept as one source. */
export function addAudioClip(kind, props = {}, { notify = true } = {}) {
  if (kind === 'bgm') return track('bgm');
  const lane = state.audio.tracks[kind];
  if (!lane?.clips) return null;
  const clip = makeAudioClip(kind, props);
  lane.clips.push(clip);
  if (notify) {
    emit('audio', state.audio);
    emit('render');
  }
  return clip;
}

export function setAudioClipStart(kind, id, t) {
  if (kind === 'bgm') return setTrackStart(kind, t);
  const clip = audioClip(kind, id);
  if (!clip) return;
  clip.start = clamp(Number(t) || 0, -Math.max(0, clip.duration), state.project.duration);
  emit('audioMove', { kind, id, start: clip.start });
  emit('render');
}

export function setAudioClipLevel(kind, id, props) {
  if (kind === 'bgm') return setTrackLevel(kind, props);
  const clip = audioClip(kind, id);
  if (!clip) return;
  Object.assign(clip, props);
  emit('audioLevel', { kind, id, ...props });
}

export function removeAudioClip(kind, id) {
  if (kind === 'bgm') return null;
  const lane = state.audio.tracks[kind];
  if (!lane?.clips) return null;
  const i = lane.clips.findIndex(c => c.id === id);
  if (i < 0) return null;
  const [clip] = lane.clips.splice(i, 1);
  emit('audio', state.audio);
  emit('render');
  return clip;
}

export const videoChannels = () => state.video.channels;
export const videoChannel = kind => state.video.channels[kind];
export const videoClips = kind => videoChannel(kind)?.clips ?? [];
export const videoClip = (kind, id) => videoClips(kind).find(clip => clip.id === id) ?? null;
export const anyVideo = () => VIDEO_CHANNEL_KINDS.some(({ kind }) =>
  videoClips(kind).some(v => v.ready || v.name || Number(v.duration) > 0));

/** Add a visual clip to one of the three independent backdrop lanes. */
export function addVideoClip(kind, props = {}, { notify = true } = {}) {
  const lane = videoChannel(kind);
  if (!lane) return null;
  const clip = makeVideoClip(kind, props);
  lane.clips.push(clip);
  if (notify) {
    emit('video', state.video);
    emit('render');
  }
  return clip;
}

export function removeVideoClip(kind, id, { notify = true } = {}) {
  const lane = videoChannel(kind);
  if (!lane) return null;
  const i = lane.clips.findIndex(clip => clip.id === id);
  if (i < 0) return null;
  const [clip] = lane.clips.splice(i, 1);
  if (notify) {
    emit('video', state.video);
    emit('render');
  }
  return clip;
}

/** Slip one backdrop video clip along its channel. */
export function setVideoClipStart(kind, id, t) {
  const v = videoClip(kind, id);
  if (!v) return;
  v.start = clamp(Number(t) || 0, -Math.max(0, v.duration), state.project.duration);
  emit('videoMove', { kind, id, start: v.start });
  emit('render');
}

/** Keep the old one-clip call shape working for external callers. */
export function setVideoStart(kind, id, t) {
  if (t === undefined) { t = id; id = videoClips(kind)[0]?.id; }
  return setVideoClipStart(kind, id, t);
}

export function setVideoClipSettings(kind, id, props) {
  const v = videoClip(kind, id);
  if (!v) return;
  if ('opacity' in props) v.opacity = clamp(Number(props.opacity) || 0, 0, 1);
  if ('fit' in props && ['cover', 'contain', 'stretch'].includes(props.fit)) v.fit = props.fit;
  if ('loop' in props) v.loop = !!props.loop;
  if ('visible' in props) v.visible = !!props.visible;
  if ('inEffect' in props && VIDEO_EFFECTS.some(effect => effect.kind === props.inEffect)) v.inEffect = props.inEffect;
  if ('outEffect' in props && VIDEO_EFFECTS.some(effect => effect.kind === props.outEffect)) v.outEffect = props.outEffect;
  const maxEffectDuration = v.duration > 0 ? v.duration : state.project.duration;
  if ('inDuration' in props) v.inDuration = clamp(Number(props.inDuration) || 0, 0, maxEffectDuration);
  if ('outDuration' in props) v.outDuration = clamp(Number(props.outDuration) || 0, 0, maxEffectDuration);
  if ('mask' in props) v.mask = makeVideoMask({ ...v.mask, ...(props.mask ?? {}) });
  emit('videoLevel', { kind, id, ...props });
  emit('render');
}

/** Keep the old one-clip call shape working for external callers. */
export function setVideoSettings(kind, id, props) {
  if (props === undefined) { props = id; id = videoClips(kind)[0]?.id; }
  return setVideoClipSettings(kind, id, props);
}

/** Slip one lane along the timeline. */
// ── particles ────────────────────────────────────────────────
export const particles = () => state.project.particles;
export const particleEmitters = () => state.project.particles.emitters;
export const particleEmitter = id => particleEmitters().find(e => e.id === id) ?? null;

/** The emitter the panel is editing — falling back to the first one. */
export const selectedEmitter = () =>
  particleEmitter(state.ui.particle) ?? particleEmitters()[0] ?? null;

export function selectEmitter(id) {
  if (state.ui.particle === id) return;
  state.ui.particle = id;
  emit('particles', state.project.particles);
}

/** Merge settings into one emitter; every value is re-clamped on the way in. */
export function updateEmitter(id, props) {
  const e = particleEmitter(id);
  if (!e) return null;
  const next = makeEmitter({ ...e, ...props, id }, { duration: state.project.duration });
  next.revision = (e.revision + 1) % 1e9;
  Object.assign(e, next);
  emit('particles', state.project.particles);
  emit('render');
  return e;
}

/** A new emitter, opening at the playhead and running to the end. */
export function addParticleEmitter(props = {}) {
  const list = particleEmitters();
  if (list.length >= MAX_EMITTERS) return null;
  const start = clamp(state.ui.time, 0, Math.max(0, state.project.duration - 0.1));
  const e = makeEmitter({
    start, end: state.project.duration,
    name: `Emitter ${list.length + 1}`,
    ...props
  }, { duration: state.project.duration });
  list.push(e);
  state.ui.particle = e.id;
  emit('particles', state.project.particles);
  emit('render');
  return e;
}

export function duplicateParticleEmitter(id) {
  const src = particleEmitter(id);
  if (!src) return null;
  return addParticleEmitter({ ...src, id: undefined, name: `${src.name || 'Emitter'} copy` });
}

export function removeParticleEmitter(id) {
  const list = particleEmitters();
  const i = list.findIndex(e => e.id === id);
  if (i < 0) return;
  list.splice(i, 1);
  if (state.ui.particle === id) state.ui.particle = list[Math.min(i, list.length - 1)]?.id ?? null;
  emit('particles', state.project.particles);
  emit('render');
}

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
  state.ui.sel = { type: 'guide', level: levelKey, id, ids, pivot: null };
  emit('selection', state.ui.sel);
}

/**
 * The point a run scales about. Clicking a selected point makes it the centre;
 * clicking it again releases it and the run goes back to scaling from its far end.
 */
export function setRunPivot(id) {
  const sel = state.ui.sel;
  if (sel?.type !== 'guide') return;
  sel.pivot = sel.pivot === id ? null : id;
  emit('selection', sel);
}

export const runPivotIndex = levelKey => {
  const sel = state.ui.sel;
  if (sel?.type !== 'guide' || sel.level !== levelKey || !sel.pivot) return -1;
  return guides(levelKey).findIndex(g => g.id === sel.pivot);
};

/** Select every guide of a level whose time falls inside [a, b]. */
export function selectGuidesInRange(levelKey, a, b) {
  const lv = level(levelKey);
  if (!lv) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const picked = guideHandles(lv.guides)
    .filter(i => lv.guides[i].t >= lo && lv.guides[i].t <= hi)
    .map(i => lv.guides[i].id);
  if (!picked.length) { state.ui.sel = null; emit('selection', null); return; }
  state.ui.sel = { type: 'guide', level: levelKey, id: picked.at(-1), ids: picked, pivot: null };
  emit('selection', state.ui.sel);
}
export const clipsAt = t => clips().filter(c => t >= c.start && t < c.end);

/**
 * The displacement of the authored camera from its neutral framing.
 *
 * Text lives in world space while the camera moves through that space. A new
 * layer should therefore be created on the camera's current frame plane,
 * rather than always at world origin. Keeping this as an offset from the
 * neutral camera also leaves the layer at the normal text depth when the
 * camera is at its default Z distance.
 */
export function cameraFrameOffsetAt(t = state.ui.time) {
  const width = Number(state.project.width) || 1080;
  const height = Number(state.project.height) || 1080;
  const now = cameraAt(camera(), Number.isFinite(Number(t)) ? Number(t) : state.ui.time,
    { width, height });
  const neutral = defaultCameraPosition(width, height);
  return {
    x: now.position.x - neutral.x,
    y: now.position.y - neutral.y,
    z: now.position.z - neutral.z
  };
}

export const CLIPBOARD_FORMAT = 'kinetic-typography-clip';

/** Return a JSON-safe clipboard payload for one text layer. */
export function copyClipData(id, t = state.ui.time) {
  const clip = clips().find(c => c.id === id);
  if (!clip) return null;
  return {
    format: CLIPBOARD_FORMAT,
    version: 1,
    clip: JSON.parse(JSON.stringify(clip)),
    cameraOffset: cameraFrameOffsetAt(t)
  };
}

function finiteClipPosition(position = {}) {
  position = position && typeof position === 'object' ? position : {};
  return {
    x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0,
    y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0,
    z: Number.isFinite(Number(position.z)) ? Number(position.z) : 0
  };
}

/**
 * Paste a copied layer at `t` (the playhead by default).
 *
 * The payload stores the camera offset at copy time. Rebuilding the layer's
 * position from its camera-relative offset means a paste remains in the same
 * place in the output even when the camera has moved between copy and paste.
 */
export function pasteClip(data, t = state.ui.time) {
  if (!data || typeof data !== 'object') return null;
  if (data.format && data.format !== CLIPBOARD_FORMAT) return null;
  const source = data.clip && typeof data.clip === 'object' ? data.clip : data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const p = state.project;
  const at = Number.isFinite(Number(t)) ? Number(t) : state.ui.time;
  const start = clamp(at, 0, Math.max(0, p.duration - MIN_CLIP));
  const sourceStart = Number(source.start);
  const sourceEnd = Number(source.end);
  const sourceLength = Number.isFinite(sourceStart) && Number.isFinite(sourceEnd)
    ? sourceEnd - sourceStart : 0;
  const length = Math.max(MIN_CLIP, sourceLength || 4);
  const end = clamp(start + length, start + MIN_CLIP, p.duration);

  const copiedOffset = finiteClipPosition(data.cameraOffset);
  const sourcePosition = finiteClipPosition(source.position);
  const localPosition = {
    x: sourcePosition.x - copiedOffset.x,
    y: sourcePosition.y - copiedOffset.y,
    z: sourcePosition.z - copiedOffset.z
  };
  const currentOffset = cameraFrameOffsetAt(start);
  const clip = {
    ...JSON.parse(JSON.stringify(source)),
    id: uid('c'), start, end,
    track: clamp(Math.round(Number(source.track) || 0), 0, TRACKS - 1),
    position: {
      x: localPosition.x + currentOffset.x,
      y: localPosition.y + currentOffset.y,
      z: localPosition.z + currentOffset.z
    }
  };
  delete clip.offsetX;
  delete clip.offsetY;
  p.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id };
  emit('clips', p.clips);
  emit('selection', state.ui.sel);
  emit('render');
  return clip;
}

// ── camera track ─────────────────────────────────────────────
export const camera = () => state.project.camera;
export const cameraKeys = () => state.project.camera.keys;
export const cameraMode = () => isSplitCamera(state.project.camera) ? 'split' : 'combined';
export const cameraChannelKeys = axis => {
  if (!CAMERA_AXES.includes(axis)) return [];
  return state.project.camera.channels?.[axis] ?? [];
};
export const cameraKeyCount = () => cameraMode() === 'split'
  ? CAMERA_AXES.reduce((n, axis) => n + cameraChannelKeys(axis).length, 0)
  : cameraKeys().length;
export const selectedCamKey = () =>
  state.ui.sel?.type !== 'camkey' ? null
    : state.ui.sel.axis ? cameraChannelKeys(state.ui.sel.axis).find(k => k.id === state.ui.sel.id) ?? null
    : cameraKeys().find(k => k.id === state.ui.sel.id) ?? null;
export const selectedCamAxis = () =>
  state.ui.sel?.type === 'camkey' ? state.ui.sel.axis ?? null : null;

function selectCameraKeyState(axis, id) {
  state.ui.sel = { type: 'camkey', id, ...(axis ? { axis } : {}) };
  emit('selection', state.ui.sel);
}

export function selectCameraKey(axis, id) {
  if (!CAMERA_AXES.includes(axis)) return;
  if (!cameraChannelKeys(axis).some(key => key.id === id)) return;
  selectCameraKeyState(axis, id);
}

function splitCameraKeys(cam) {
  const width = Number(state.project.width) || 1080;
  const height = Number(state.project.height) || 1080;
  const keys = Array.isArray(cam.keys) ? cam.keys : (cam.keys = []);
  return Object.fromEntries(CAMERA_AXES.map(axis => [axis, keys.map(key => ({
    id: uid(`ck${axis}`), t: key.t,
    value: cameraPosition(key, width, height)[axis],
    ease: EASES[key.ease] ? key.ease : 'smooth'
  }))]));
}

/** Convert the combined position keys into independent X/Y/Z channels. */
export function setCameraMode(mode) {
  const cam = camera();
  const next = mode === 'split' ? 'split' : 'combined';
  const oldMode = cameraMode();
  if (oldMode === next) return;

  const oldSelection = state.ui.sel?.type === 'camkey' ? selectedCamKey() : null;
  const oldTime = oldSelection?.t ?? null;

  if (next === 'split') {
    cam.channels = splitCameraKeys(cam);
    cam.mode = 'split';
    if (oldTime !== null) {
      const key = cameraChannelKeys('x').find(k => Math.abs(k.t - oldTime) < 1e-4);
      if (key) selectCameraKeyState('x', key.id);
    }
  } else {
    const split = { ...cam, enabled: true, mode: 'split' };
    const times = [...new Set([
      ...(cam.keys ?? []).map(key => key.t),
      ...CAMERA_AXES.flatMap(axis => cameraChannelKeys(axis).map(key => key.t))
    ])].sort((a, b) => a - b);
    if (times.length) {
      const width = Number(state.project.width) || 1080;
      const height = Number(state.project.height) || 1080;
      cam.keys = times.map(t => {
        const source = (cam.keys ?? []).find(key => Math.abs(key.t - t) < 1e-4);
        const value = cameraAt(split, t, { width, height });
        return {
          id: source?.id ?? uid('ck'), t,
          position: { ...value.position }, roll: value.roll,
          ease: EASES[source?.ease] ? source.ease : 'smooth'
        };
      });
    }
    cam.mode = 'combined';
    delete cam.channels;
    if (oldTime !== null) {
      const key = cam.keys.find(k => Math.abs(k.t - oldTime) < 1e-4);
      state.ui.sel = key ? { type: 'camkey', id: key.id } : null;
      emit('selection', state.ui.sel);
    }
  }
  emit('camera', cam);
  emit('render');
}

function newChannelKey(axis, t, value, ease = 'smooth') {
  return { id: uid(`ck${axis}`), t, value, ease: EASES[ease] ? ease : 'smooth' };
}

function ensureMasterKeyAt(t, now) {
  const cam = camera();
  let key = cam.keys.find(k => Math.abs(k.t - t) < 1e-3);
  if (!key) {
    key = { id: uid('ck'), t, position: { ...now.position }, roll: now.roll, ease: 'smooth' };
    cam.keys.push(key);
    sortKeys(cam);
  }
  return key;
}

/** Add a key to one split position channel, taking its current value. */
export function addCameraChannelKey(axis, t) {
  if (!CAMERA_AXES.includes(axis)) return null;
  if (cameraMode() !== 'split') setCameraMode('split');
  const cam = camera();
  const at = clamp(t, 0, state.project.duration);
  const keys = cameraChannelKeys(axis);
  const existing = keys.find(key => Math.abs(key.t - at) < 1e-3);
  if (existing) {
    selectCameraKeyState(axis, existing.id);
    return existing;
  }
  const now = cameraAt({ ...cam, enabled: true }, at, {
    width: state.project.width, height: state.project.height
  });
  const key = newChannelKey(axis, at, now.position[axis]);
  keys.push(key);
  sortChannelKeys(keys);
  selectCameraKeyState(axis, key.id);
  emit('camera', cam);
  emit('render');
  return key;
}

/** Replace one split channel with a two-key span, useful for a linear Z move. */
export function setCameraChannelSpan(axis, start, end, ease = 'linear') {
  if (!CAMERA_AXES.includes(axis)) return null;
  if (cameraMode() !== 'split') setCameraMode('split');
  const cam = camera();
  const width = state.project.width, height = state.project.height;
  const lo = clamp(Math.min(start, end), 0, state.project.duration);
  const hi = clamp(Math.max(start, end), lo, state.project.duration);
  const now = { ...cam, enabled: true };
  const first = cameraAt(now, lo, { width, height }).position[axis];
  const last = cameraAt(now, hi, { width, height }).position[axis];
  cam.channels[axis] = [newChannelKey(axis, lo, first, ease),
    newChannelKey(axis, hi, last, ease)];
  sortChannelKeys(cam.channels[axis]);
  selectCameraKeyState(axis, cam.channels[axis][1].id);
  emit('camera', cam);
  emit('render');
  return cam.channels[axis];
}

export function updateCameraChannelKey(axis, id, props) {
  const key = cameraChannelKeys(axis).find(x => x.id === id);
  if (!key) return;
  if ('t' in props) key.t = clamp(Number(props.t) || 0, 0, state.project.duration);
  if ('value' in props) key.value = Number.isFinite(Number(props.value)) ? Number(props.value) : 0;
  if ('ease' in props) key.ease = EASES[props.ease] ? props.ease : 'smooth';
  if ('t' in props) sortChannelKeys(cameraChannelKeys(axis));
  emit('camera', camera());
  emit('render');
}

export function removeCameraChannelKey(axis, id) {
  const keys = cameraChannelKeys(axis);
  const i = keys.findIndex(key => key.id === id);
  if (i < 0) return;
  keys.splice(i, 1);
  if (state.ui.sel?.type === 'camkey' && state.ui.sel.id === id && state.ui.sel.axis === axis) {
    const next = keys[Math.max(0, i - 1)] ?? keys[0];
    state.ui.sel = next ? { type: 'camkey', id: next.id, axis } : null;
    emit('selection', state.ui.sel);
  }
  emit('camera', camera());
  emit('render');
}

export function clearCameraTrack() {
  const cam = camera();
  cam.keys.length = 0;
  if (isSplitCamera(cam)) {
    for (const axis of CAMERA_AXES) (cam.channels[axis] ??= []).length = 0;
  }
  if (state.ui.sel?.type === 'camkey') {
    state.ui.sel = null;
    emit('selection', null);
  }
  emit('camera', cam);
  emit('render');
}

/** New key takes the framing already in force, so adding one never jumps. */
export function addCameraKey(t) {
  const cam = camera();
  const at = clamp(t, 0, state.project.duration);

  if (cameraMode() === 'split') {
    const now = cameraAt({ ...cam, enabled: true }, at, {
      width: state.project.width, height: state.project.height
    });
    let primary = null;
    for (const axis of CAMERA_AXES) {
      const keys = cameraChannelKeys(axis);
      let key = keys.find(k => Math.abs(k.t - at) < 1e-3);
      if (!key) {
        key = newChannelKey(axis, at, now.position[axis]);
        keys.push(key);
        sortChannelKeys(keys);
      }
      primary ??= key;
    }
    ensureMasterKeyAt(at, now);
    selectCameraKeyState('x', primary.id);
    emit('camera', cam);
    emit('render');
    return primary;
  }

  const existing = cam.keys.find(k => Math.abs(k.t - at) < 1e-3);
  if (existing) { state.ui.sel = { type: 'camkey', id: existing.id }; emit('selection', state.ui.sel); return existing; }

  const now = cam.keys.length
    ? cameraAt({ ...cam, enabled: true }, at, { width: state.project.width, height: state.project.height })
    : { position: defaultCameraPosition(state.project.width, state.project.height), roll: 0 };
  const key = {
    id: uid('ck'), t: at, position: { ...now.position }, roll: now.roll, ease: 'smooth'
  };
  cam.keys.push(key);
  sortKeys(cam);
  state.ui.sel = { type: 'camkey', id: key.id };
  emit('camera', cam);
  emit('selection', state.ui.sel);
  emit('render');
  return key;
}

export function updateCameraKey(id, props, axis = null) {
  if (cameraMode() === 'split' && axis) return updateCameraChannelKey(axis, id, props);
  const cam = camera();
  const k = cam.keys.find(x => x.id === id);
  if (!k) return;
  Object.assign(k, props);
  if ('t' in props) { k.t = clamp(k.t, 0, state.project.duration); sortKeys(cam); }
  emit('camera', cam);
  emit('render');
}

export function removeCameraKey(id, axis = null) {
  if (cameraMode() === 'split') {
    const selectedAxis = axis ?? selectedCamAxis();
    if (selectedAxis) return removeCameraChannelKey(selectedAxis, id);
  }
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
  if (isSplitCamera(camera())) {
    for (const axis of CAMERA_AXES) sortChannelKeys(cameraChannelKeys(axis));
  }
  emit('camera', camera());
  emit('render');
}

export function select(type, id, levelKey = null) {
  const cur = state.ui.sel;
  if (cur?.type === type && cur?.id === id && cur?.level === levelKey &&
      (type !== 'guide' || (cur.ids?.length ?? 1) === 1)) return;
  state.ui.sel = type ? (type === 'guide' ? { type, id, level: levelKey, ids: [id], pivot: null } : { type, id }) : null;
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
    if (isSplitCamera(p.camera)) {
      for (const axis of CAMERA_AXES) p.camera.channels[axis].forEach(key => { key.t *= k; });
    }
    for (const key of LEVEL_KEYS) {
      const lv = level(key);
      if (!lv) continue;
      lv.start *= k; lv.end *= k;
      lv.guides.forEach(g => { g.t *= k; });
    }
    p.clips.forEach(c => { c.start *= k; c.end *= k; });
    p.particles.emitters.forEach(e => { e.start *= k; e.end *= k; });
  }
  for (const { kind } of VIDEO_CHANNEL_KINDS) {
    for (const v of videoClips(kind)) {
      v.start = clamp(v.start, -Math.max(0, v.duration), p.duration);
      v.inDuration = Math.max(0, Number(v.inDuration) || 0);
      v.outDuration = Math.max(0, Number(v.outDuration) || 0);
    }
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
  for (const e of p.particles.emitters) {
    e.start = clamp(e.start, 0, Math.max(0, p.duration - 0.05));
    e.end = clamp(e.end, e.start + 0.05, p.duration);
  }
  state.ui.time = clamp(state.ui.time, 0, p.duration);
  if (state.ui.view.end - state.ui.view.start < 0.5) state.ui.view = { start: 0, end: p.duration * 1.05 };
  syncBeatTimes();
  emit('duration', p.duration);
  emit('guides', p.levels);
  emit('clips', p.clips);
  emit('particles', p.particles);
  emit('render');
}

export function normalizeClips() {
  const d = state.project.duration;
  const width = Number(state.project.width) || 1080;
  const height = Number(state.project.height) || 1080;
  for (const c of state.project.clips) {
    c.start = clamp(c.start, 0, Math.max(0, d - MIN_CLIP));
    c.end = clamp(c.end, c.start + MIN_CLIP, d);
    c.track = clamp(Math.round(c.track), 0, TRACKS - 1);
    const pos = c.position;
    c.position = {
      x: Number.isFinite(Number(pos?.x)) ? Number(pos.x) : (Number(c.offsetX) || 0) * width,
      y: Number.isFinite(Number(pos?.y)) ? Number(pos.y) : (Number(c.offsetY) || 0) * height,
      z: Number.isFinite(Number(pos?.z)) ? Number(pos.z) : 0
    };
    delete c.offsetX;
    delete c.offsetY;
  }
}

export function addClip(start, end, track = 0) {
  const p = state.project;
  const s = clamp(start, 0, p.duration - MIN_CLIP);
  const e = clamp(end, s + MIN_CLIP, p.duration);
  const role = drivingRegion(p.levels, s).role;
  const clip = makeClip(s, e, track, role, 'New text');
  // New text is authored on the frame currently shown by the camera. The
  // offset is relative to neutral framing, so the default camera still puts
  // it at the normal world-space text plane.
  clip.position = cameraFrameOffsetAt(s);
  p.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id };
  emit('clips', p.clips);
  emit('selection', state.ui.sel);
  emit('render');
  return clip;
}

/** Place a text layer on the frame plane of the camera at the given time. */
export function alignClipWithCamera(id, t = state.ui.time) {
  const clip = clips().find(c => c.id === id);
  if (!clip) return null;
  clip.position = cameraFrameOffsetAt(t);
  emit('clip', clip);
  emit('render');
  return clip;
}

export function duplicateClip(id) {
  const src = clips().find(c => c.id === id);
  if (!src) return null;
  const len = src.end - src.start;
  const clip = { ...src, id: uid('c'), params: { ...src.params },
                 start: clamp(src.end, 0, state.project.duration - MIN_CLIP) };
  clip.position = { ...(src.position ?? { x: 0, y: 0, z: 0 }) };
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

// ── serialisation (audio/video are referenced, never embedded) ─
function serialAudioClip(clip) {
  return {
    id: clip.id,
    name: clip.name,
    start: clip.start,
    volume: clip.volume,
    mute: clip.mute,
    duration: clip.duration,
    transcript: typeof clip.transcript === 'string' ? clip.transcript : '',
    words: Array.isArray(clip.words)
      ? clip.words.map(word => ({
          text: typeof word?.text === 'string' ? word.text : '',
          start: Number(word?.start), end: Number(word?.end),
          ...(Number.isFinite(Number(word?.score)) ? { score: Number(word.score) } : {})
        })).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end))
      : []
  };
}

function serialVideoClip(clip) {
  return {
    id: clip.id,
    name: clip.name,
    start: clip.start,
    opacity: clip.opacity,
    fit: clip.fit,
    loop: clip.loop,
    visible: clip.visible,
    duration: clip.duration,
    inEffect: clip.inEffect,
    inDuration: clip.inDuration,
    outEffect: clip.outEffect,
    outDuration: clip.outDuration,
    mask: { ...(clip.mask ?? {}) }
  };
}

const AUDIO_DEFAULTS = {
  bpm: 0, offset: 0, beatsPerBar: 4,
  hitGap: 0.35, hitSense: 0.2
};

function resetAudioState() {
  state.audio.tracks = freshAudioTracks();
  Object.assign(state.audio, {
    ...AUDIO_DEFAULTS,
    beats: [], onsets: [], onsetStrength: [], envelope: null,
    times: [], bars: [], gridSource: 'manual', hits: []
  });
}

function serialNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function restoreSpeechWords(saved, duration) {
  if (!Array.isArray(saved)) return [];
  return saved.map(word => {
    const source = word && typeof word === 'object' ? word : {};
    const start = clamp(serialNumber(source.start), 0, duration);
    const end = clamp(serialNumber(source.end, start), start, duration);
    const text = typeof source.text === 'string' ? source.text.trim() : '';
    return {
      text, start, end,
      ...(Number.isFinite(Number(source.score)) ? { score: Number(source.score) } : {})
    };
  }).filter(word => word.text && word.end > word.start);
}

/** Restore a reference to an audio file without pretending its bytes are loaded. */
function restoreAudioClip(kind, saved = {}, durationLimit) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const duration = Math.max(0, serialNumber(source.duration));
  const volume = clamp(serialNumber(source.volume, 1), 0, 1.5);
  const words = restoreSpeechWords(source.words, duration);
  return makeAudioClip(kind, {
    id: typeof source.id === 'string' && source.id ? source.id : uid('a'),
    name: typeof source.name === 'string' ? source.name : '',
    duration,
    start: clamp(serialNumber(source.start), -duration, durationLimit),
    volume,
    mute: source.mute === true,
    transcript: typeof source.transcript === 'string' ? source.transcript : '',
    words,
    speechStatus: words.length ? 'ready' : 'idle',
    speechError: '',
    // The project file contains a reference, not an AudioBuffer. The user
    // must attach the source again before it can play or draw a waveform.
    ready: false,
    peaks: null
  });
}

function restoreAudio(json, durationLimit) {
  resetAudioState();
  const saved = json?.audio;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;

  state.audio.bpm = Math.max(0, serialNumber(saved.bpm));
  state.audio.offset = clamp(serialNumber(saved.offset), -1, 1);
  const beatsPerBar = Math.round(serialNumber(saved.beatsPerBar, 4));
  state.audio.beatsPerBar = [2, 3, 4, 6, 8].includes(beatsPerBar) ? beatsPerBar : 4;
  state.audio.hitGap = clamp(serialNumber(saved.hitGap, AUDIO_DEFAULTS.hitGap), 0.03, 4);
  state.audio.hitSense = clamp(serialNumber(saved.hitSense, AUDIO_DEFAULTS.hitSense), 0, 0.95);

  const tracks = saved.tracks && typeof saved.tracks === 'object' ? saved.tracks : {};
  const bgm = tracks.bgm;
  if (bgm && typeof bgm === 'object') {
    state.audio.tracks.bgm = restoreAudioClip('bgm', bgm, durationLimit);
  }

  for (const kind of ['vo', 'sfx']) {
    const lane = tracks[kind];
    if (!lane || typeof lane !== 'object') continue;
    // v2 stored one object per lane; v6 stores a clips array. Accept both so
    // opening an older project cannot silently discard a voice/effects file.
    const savedClips = Array.isArray(lane.clips)
      ? lane.clips
      : (lane.name || Number(lane.duration) > 0 ? [lane] : []);
    state.audio.tracks[kind].clips = savedClips
      .filter(clip => clip && typeof clip === 'object')
      .map(clip => restoreAudioClip(kind, clip, durationLimit));
  }
}

/** Restore reference-only backdrop clips, accepting the original one-per-lane shape. */
function restoreVideoClip(kind, saved = {}, durationLimit) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const duration = Math.max(0, serialNumber(source.duration));
  const effectDuration = value => clamp(serialNumber(value, 0.5), 0, duration || durationLimit || 900);
  return makeVideoClip(kind, {
    id: typeof source.id === 'string' && source.id ? source.id : uid('v'),
    name: typeof source.name === 'string' ? source.name : '',
    duration,
    start: clamp(serialNumber(source.start), -duration, durationLimit),
    opacity: clamp(serialNumber(source.opacity, 1), 0, 1),
    fit: ['cover', 'contain', 'stretch'].includes(source.fit) ? source.fit : 'cover',
    loop: source.loop === true,
    visible: source.visible !== false,
    inEffect: source.inEffect,
    inDuration: effectDuration(source.inDuration),
    outEffect: source.outEffect,
    outDuration: effectDuration(source.outDuration),
    mask: source.mask,
    // The project file contains a reference, not video bytes. The user must
    // attach the source again before it can play or render.
    ready: false
  });
}

function restoreVideo(json, durationLimit) {
  const savedVideo = json?.video?.channels ?? json?.backdrops?.channels;
  const savedByKind = Array.isArray(savedVideo)
    ? Object.fromEntries(savedVideo.map(v => [v.kind, v]))
    : (savedVideo && typeof savedVideo === 'object' ? savedVideo : {});

  state.video.channels = Object.fromEntries(VIDEO_CHANNEL_KINDS.map(({ kind }) => {
    const saved = savedByKind[kind];
    const rawClips = Array.isArray(saved)
      ? saved
      : (Array.isArray(saved?.clips)
        ? saved.clips
        : (saved && (saved.name || Number(saved.duration) > 0) ? [saved] : []));
    return [kind, makeVideoChannel(kind, {
      clips: rawClips.map(clip => restoreVideoClip(kind, clip, durationLimit))
    })];
  }));
}

export function serialize() {
  return {
    format: 'kinetic-typography-composer',
    version: 8,
    project: JSON.parse(JSON.stringify(state.project)),
    audio: anyAudio()
      ? {
          bpm: state.audio.bpm, offset: state.audio.offset,
          beatsPerBar: state.audio.beatsPerBar,
          hitGap: state.audio.hitGap, hitSense: state.audio.hitSense,
          tracks: {
            bgm: serialAudioClip(state.audio.tracks.bgm),
            vo: { clips: audioClips('vo').map(serialAudioClip) },
            sfx: { clips: audioClips('sfx').map(serialAudioClip) }
          }
        }
      : null,
    video: anyVideo()
      ? {
          channels: Object.fromEntries(VIDEO_CHANNEL_KINDS.map(({ kind }) =>
            [kind, { clips: videoClips(kind).map(serialVideoClip) }]))
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
  proj.particles = makeParticles(proj.particles, { duration: proj.duration });
  if (!proj.camera || !Array.isArray(proj.camera.keys)) {
    proj.camera = { enabled: true, mode: 'combined', keys: [] };
  }
  // v2 stored clip offsets as frame fractions and camera keys as pan/zoom.
  // Convert those once at the boundary so every renderer and editor thereafter
  // deals only in explicit world-space positions.
  const width = Number.isFinite(Number(proj.width)) ? Number(proj.width) : 1080;
  const height = Number.isFinite(Number(proj.height)) ? Number(proj.height) : 1080;
  for (const c of proj.clips) {
    const pos = c.position;
    c.position = {
      x: Number.isFinite(Number(pos?.x)) ? Number(pos.x) : (Number(c.offsetX) || 0) * width,
      y: Number.isFinite(Number(pos?.y)) ? Number(pos.y) : (Number(c.offsetY) || 0) * height,
      z: Number.isFinite(Number(pos?.z)) ? Number(pos.z) : 0
    };
    delete c.offsetX;
    delete c.offsetY;
  }
  proj.camera.enabled = proj.camera.enabled !== false;
  proj.camera.keys.forEach(key => normalizeCameraKey(key, width, height));
  sortKeys(proj.camera);
  proj.camera.mode = proj.camera.mode === 'split' ? 'split' : 'combined';
  if (proj.camera.mode === 'split') {
    const savedChannels = proj.camera.channels && typeof proj.camera.channels === 'object'
      ? proj.camera.channels : {};
    proj.camera.channels = Object.fromEntries(CAMERA_AXES.map(axis => {
      // A present-but-empty channel is intentional: it means that axis holds
      // the default framing until the user adds a key.
      const hasSaved = Array.isArray(savedChannels[axis]);
      const list = hasSaved ? savedChannels[axis] : proj.camera.keys.map(key => ({
        id: uid(`ck${axis}`), t: key.t,
        value: cameraPosition(key, width, height)[axis], ease: key.ease
      }));
      list.forEach(key => normalizeCameraChannelKey(key, axis, width, height));
      sortChannelKeys(list);
      return [axis, list];
    }));
  }
  for (const key of LEVEL_KEYS) normalizeGuides(proj.levels[key]);
  normalizeClips();

  // Video files are deliberately not embedded. Keep the saved clip settings,
  // but mark every source as needing a local re-import on this browser session.
  restoreVideo(json, proj.duration);

  // Audio follows the same reference-only rule as video. Reset the previous
  // project's decoded metadata first, then keep every saved lane/clip as a
  // pending reference so a subsequent Save cannot lose VO or SFX settings.
  restoreAudio(json, proj.duration);

  // The metronome lives beside the project rather than inside it, so restore
  // the saved settings explicitly when opening a project. Rebuild the cached
  // grid afterwards so manual BPM/offset settings are reflected immediately.
  if (json.metro && typeof json.metro === 'object' && !Array.isArray(json.metro)) {
    Object.assign(state.metro, json.metro);
  }
  syncBeatTimes();
  emit('metro', state.metro);
  emit('audio', state.audio);

  state.ui.particle = state.project.particles.emitters[0]?.id ?? null;
  state.ui.sel = state.project.clips.length ? { type: 'clip', id: state.project.clips[0].id } : null;
  state.ui.view = { start: 0, end: state.project.duration * 1.05 };
  state.ui.time = 0;
  emit('project', state.project);
  emit('guides', state.project.levels);
  emit('clips', state.project.clips);
  emit('video', state.video);
  emit('particles', state.project.particles);
  emit('selection', state.ui.sel);
  emit('render');
}
