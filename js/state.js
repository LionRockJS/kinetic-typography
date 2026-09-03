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
import { EFFECTS, STAGE_KEYS, defaultStages, clipLive,
         TEXT_STYLE, TEXT_STYLE_KEYS, stageStyle, overridesStyle } from './effects.js';
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

// The backdrop is a single colour track, separate from the visual video
// channels. A key stores the complete colour value at one moment; the track's
// mode is shared by the keys so switching between solid / gradient types never
// leaves half-defined keyframes behind.
export const BACKDROP_MODES = Object.freeze([
  { id: 'solid', label: 'Solid' },
  { id: 'linear', label: 'Linear gradient' },
  { id: 'radial', label: 'Circular gradient' },
  { id: 'four-point', label: '4-point gradient' }
]);

const BACKDROP_DEFAULT = '#08090c';
const BACKDROP_FALLBACKS = Object.freeze([
  BACKDROP_DEFAULT, '#1b2333', '#26344a', '#101722'
]);

function hexColor(value, fallback = BACKDROP_DEFAULT) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return fallback;
  const body = match[1].toLowerCase();
  return body.length === 3
    ? `#${body.split('').map(c => c + c).join('')}`
    : `#${body}`;
}

function backdropColorList(source = {}, fallback = BACKDROP_FALLBACKS) {
  const raw = Array.isArray(source.colors)
    ? source.colors
    : [source.color ?? source.bg ?? fallback[0]];
  return Array.from({ length: 4 }, (_, i) => hexColor(raw[i] ?? raw[0] ?? fallback[i], fallback[i]));
}

function finiteValue(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function backdropValue(source = {}, fallback = BACKDROP_FALLBACKS) {
  const center = source.center && typeof source.center === 'object' ? source.center : {};
  return {
    colors: backdropColorList(source, fallback),
    angle: clamp(finiteValue(source.angle, 0), -360, 360),
    center: {
      x: clamp(finiteValue(center.x ?? source.centerX, 0.5), 0, 1),
      y: clamp(finiteValue(center.y ?? source.centerY, 0.5), 0, 1)
    },
    radius: clamp(finiteValue(source.radius, 0.75), 0.05, 2)
  };

}

function copyBackdropValue(value) {
  return {
    colors: [...value.colors],
    angle: value.angle,
    center: { ...value.center },
    radius: value.radius
  };
}

function normalizeBackdropKey(source = {}, fallback = BACKDROP_FALLBACKS, duration = 900) {
  const value = backdropValue(source, fallback);
  return {
    id: typeof source.id === 'string' && source.id ? source.id : uid('bk'),
    t: clamp(finiteValue(source.t, 0), 0, duration),
    ease: EASES[source.ease] ? source.ease : 'smooth',
    ...value
  };
}

/** Create the colour track used by a fresh project and by old `bg` projects. */
export function makeBackdrop(props = {}) {
  const source = props && typeof props === 'object' ? props : {};
  const mode = BACKDROP_MODES.some(item => item.id === source.mode) ? source.mode : 'solid';
  const value = backdropValue(source, [hexColor(source.bg ?? source.color, BACKDROP_DEFAULT), ...BACKDROP_FALLBACKS.slice(1)]);
  const rawKeys = Array.isArray(source.keys) ? source.keys
    : Array.isArray(source.keyframes) ? source.keyframes : [];
  const keys = rawKeys
    .filter(key => key && typeof key === 'object')
    .map(key => normalizeBackdropKey(key, value.colors));
  keys.sort((a, b) => a.t - b.t);
  return { mode, ...value, keys };
}

/** Normalize a saved track in place, including projects written before it existed. */
export function normalizeBackdrop(source, duration = 900, fallbackBg = BACKDROP_DEFAULT) {
  const fallback = [hexColor(fallbackBg), ...BACKDROP_FALLBACKS.slice(1)];
  const next = makeBackdrop(source && typeof source === 'object'
    ? { ...source, bg: source.bg ?? fallback[0] }
    : { bg: fallback[0] });
  next.keys = (Array.isArray(source?.keys) ? source.keys
    : Array.isArray(source?.keyframes) ? source.keyframes : [])
    .filter(key => key && typeof key === 'object')
    .map(key => normalizeBackdropKey(key, next.colors, Math.max(1, duration)));
  next.keys.sort((a, b) => a.t - b.t);
  return next;
}

/** A decoded audio source positioned on an audio lane. */
export function makeAudioClip(kind, props = {}) {
  return {
    id: uid('a'), kind,
    name: '', size: 0, duration: 0, peaks: null, start: 0,
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
    name: '', size: 0, duration, start: 0,
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

/** The composition every session starts from, before the demo arrangement. */
const freshProject = () => ({
  name: 'Untitled Composition',
  width: 1080, height: 1080, fps: 30,
  duration: 24,
  bg: '#08090c', vignette: 0.45, grain: 0.06, depth: 0,
  backdrop: makeBackdrop({ colors: ['#08090c', '#1b2333', '#26344a', '#101722'] }),
  // What every text layer draws with unless it says otherwise.
  textStyle: { ...TEXT_STYLE },
  levels: { overall: null, animation: null },
  clips: [],
  camera: { enabled: true, mode: 'combined', keys: [] },
  particles: makeParticles()
});

const freshMetro = () => ({
  on: false, voice: 'kit', volume: 0.7, accent: true, inRecording: false,
  source: 'track',    // 'track' follows the analysed beats, 'manual' uses bpm/offset
  bpm: 120, offset: 0
});

export const state = {
  project: freshProject(),
  ui: {
    time: 0, playing: false, loop: false,
    sel: null,                    // {type:'clip',id} | {type:'guide',level,id,ids} | {type:'camkey',id} | {type:'camera'}
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
  metro: freshMetro(),

  // Ordered fallback stack: a character is drawn with the first font that has
  // a glyph for it, so a Latin face can carry the headline and a CJK face the 漢字.
  fonts: new Array(3).fill(null),  // [{ font, name, preset } | null]

  // Backdrop video settings are project-adjacent like audio. The actual
  // HTMLVideoElements live in VideoEngine and are never serialised.
  video: { channels: freshVideoChannels() }
};

export const fontStack = () => state.fonts.map(f => f?.font).filter(Boolean);
// Slot-aligned, so a layer that leads with slot 3 still names the right face.
export const fontSlots = () => state.fonts.map(f => f?.font ?? null);
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
    // in · mid · out: three effects over three slices of the layer.
    stages: defaultStages(defaultEffect(role), end - start),
    // Typeface, colour, size, line height, letter spacing and alignment are
    // absent on purpose: absent means "from the stage text style".
    // A locked layer keeps its own timing when the composition is rescaled,
    // and cannot be dragged or trimmed on the timeline.
    locked: false,
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
  state.ui.sel = { type: 'clip', id: p.clips[1].id, ids: [p.clips[1].id] };
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

/** Every clip on a lane, including saved references whose media is not attached
 * yet — a freshly opened project holds these until the files are re-imported. */
export const savedAudioClips = kind => {
  const lane = state.audio.tracks[kind];
  if (!lane) return [];
  return kind === 'bgm' ? (lane.ready || lane.name ? [lane] : []) : (lane.clips ?? []);
};

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

// ── backdrop colour track ──────────────────────────────────
function ensureBackdrop() {
  if (!state.project.backdrop || typeof state.project.backdrop !== 'object') {
    state.project.backdrop = makeBackdrop({ bg: state.project.bg });
  }
  return state.project.backdrop;
}

export const backdrop = () => ensureBackdrop();
export const backdropKeys = () => ensureBackdrop().keys;
export const backdropKey = id => backdropKeys().find(key => key.id === id) ?? null;
export const selectedBackdropKey = () =>
  state.ui.sel?.type === 'backdropkey' ? backdropKey(state.ui.sel.id) : null;

export function selectBackdropTrack() {
  if (state.ui.sel?.type === 'backdrop') return;
  state.ui.sel = { type: 'backdrop' };
  emit('selection', state.ui.sel);
}

export function selectBackdropKey(id) {
  const key = backdropKey(id);
  if (!key) return;
  state.ui.sel = { type: 'backdropkey', id };
  emit('selection', state.ui.sel);
}

function rgbFromHex(value) {
  const hex = hexColor(value);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function hexFromRgb(rgb) {
  return `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(a, b, t) {
  const av = rgbFromHex(a), bv = rgbFromHex(b);
  return hexFromRgb(av.map((v, i) => v + (bv[i] - v) * t));
}

function interpolateBackdropValue(a, b, t) {
  return {
    colors: a.colors.map((color, i) => mixHex(color, b.colors[i], t)),
    angle: a.angle + (b.angle - a.angle) * t,
    center: {
      x: a.center.x + (b.center.x - a.center.x) * t,
      y: a.center.y + (b.center.y - a.center.y) * t
    },
    radius: a.radius + (b.radius - a.radius) * t
  };
}

/** Evaluate the backdrop at composition time, including easing between keys. */
export function backdropAt(source, t = 0) {
  const track = source?.backdrop && typeof source.backdrop === 'object'
    ? source.backdrop : (source ?? {});
  const mode = BACKDROP_MODES.some(item => item.id === track.mode) ? track.mode : 'solid';
  const base = backdropValue(track);
  const keys = Array.isArray(track.keys) ? track.keys : [];
  if (!keys.length) return { mode, ...base };

  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  const first = keys[0], last = keys.at(-1);
  if (at < first.t) return { mode, ...base };
  if (at >= last.t) return { mode, ...copyBackdropValue(last) };

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= at) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const raw = clamp((at - a.t) / span, 0, 1);
  const u = (EASES[a.ease] ?? EASES.smooth).fn(raw);
  return { mode, ...interpolateBackdropValue(a, b, u) };
}

/** Sample a backdrop value as a hex colour, used by the timeline preview. */
export function sampleBackdrop(value, x = 0.5, y = 0.5) {
  const source = value && typeof value === 'object' ? value : {};
  const v = backdropValue(source);
  const px = clamp(Number(x) || 0, 0, 1), py = clamp(Number(y) || 0, 0, 1);
  const mode = source.mode;
  let amount = 0.5;
  if (mode === 'linear') {
    const angle = v.angle * Math.PI / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const extent = Math.max(1e-6, 0.5 * (Math.abs(dx) + Math.abs(dy)));
    amount = 0.5 + ((px - 0.5) * dx + (py - 0.5) * dy) / (2 * extent);
  } else if (mode === 'radial') {
    amount = Math.hypot(px - v.center.x, py - v.center.y) / v.radius;
  } else if (mode === 'four-point') {
    const top = mixHex(v.colors[0], v.colors[1], px);
    const bottom = mixHex(v.colors[2], v.colors[3], px);
    return mixHex(top, bottom, py);
  }
  return mixHex(v.colors[0], v.colors[1], clamp(amount, 0, 1));
}

/** A compact CSS preview of the value shown in the backdrop inspector. */
export function backdropCss(value) {
  const v = value && typeof value === 'object' ? value : {};
  const colors = backdropColorList(v);
  if (v.mode === 'linear') return `linear-gradient(${v.angle ?? 0}deg, ${colors[0]}, ${colors[1]})`;
  if (v.mode === 'radial') {
    const center = v.center && typeof v.center === 'object' ? v.center : { x: 0.5, y: 0.5 };
    return `radial-gradient(circle at ${(center.x ?? 0.5) * 100}% ${(center.y ?? 0.5) * 100}%, ${colors[0]}, ${colors[1]})`;
  }
  if (v.mode === 'four-point') {
    return `radial-gradient(circle at 0 0, ${colors[0]}, transparent 68%),` +
      `radial-gradient(circle at 100% 0, ${colors[1]}, transparent 68%),` +
      `radial-gradient(circle at 0 100%, ${colors[2]}, transparent 68%),` +
      `radial-gradient(circle at 100% 100%, ${colors[3]}, ${colors[3]} 70%)`;
  }
  return colors[0];
}

/** Change the unkeyed/base backdrop value. */
export function setBackdrop(props = {}) {
  const b = ensureBackdrop();
  const center = props.center && typeof props.center === 'object'
    ? { ...b.center, ...props.center } : b.center;
  const next = backdropValue({ ...b, ...props, center }, b.colors);
  if (BACKDROP_MODES.some(item => item.id === props.mode)) b.mode = props.mode;
  Object.assign(b, next);
  // Keep the old static field useful to older integrations and project files.
  state.project.bg = b.colors[0];
  emit('backdrop', b);
  emit('render');
  return b;
}

function backdropKeyValueFrom(key, props = {}) {
  const center = props.center && typeof props.center === 'object'
    ? { ...(key.center ?? { x: 0.5, y: 0.5 }), ...props.center } : key.center;
  return backdropValue({ ...key, ...props, center }, key.colors);
}

export function addBackdropKey(t = state.ui.time) {
  const b = ensureBackdrop();
  const at = clamp(Number(t) || 0, 0, state.project.duration);
  const existing = b.keys.find(key => Math.abs(key.t - at) < 1e-3);
  if (existing) {
    selectBackdropKey(existing.id);
    return existing;
  }
  const value = backdropAt(b, at);
  const key = {
    id: uid('bk'), t: at, ease: 'smooth',
    colors: [...value.colors], angle: value.angle,
    center: { ...value.center }, radius: value.radius
  };
  b.keys.push(key);
  b.keys.sort((a, z) => a.t - z.t);
  state.ui.sel = { type: 'backdropkey', id: key.id };
  emit('backdrop', b);
  emit('selection', state.ui.sel);
  emit('render');
  return key;
}

export function updateBackdropKey(id, props = {}) {
  const key = backdropKey(id);
  if (!key) return null;
  if ('t' in props) key.t = clamp(Number(props.t) || 0, 0, state.project.duration);
  const value = backdropKeyValueFrom(key, props);
  Object.assign(key, value);
  if ('ease' in props) key.ease = EASES[props.ease] ? props.ease : 'smooth';
  if ('t' in props) backdropKeys().sort((a, z) => a.t - z.t);
  emit('backdrop', ensureBackdrop());
  emit('render');
  return key;
}

export function removeBackdropKey(id) {
  const b = ensureBackdrop();
  const i = b.keys.findIndex(key => key.id === id);
  if (i < 0) return null;
  const [removed] = b.keys.splice(i, 1);
  if (state.ui.sel?.type === 'backdropkey' && state.ui.sel.id === id) {
    const next = b.keys[Math.max(0, i - 1)] ?? b.keys[0];
    state.ui.sel = next ? { type: 'backdropkey', id: next.id } : { type: 'backdrop' };
    emit('selection', state.ui.sel);
  }
  emit('backdrop', b);
  emit('render');
  return removed;
}

export function clearBackdropTrack() {
  const b = ensureBackdrop();
  b.keys.length = 0;
  if (state.ui.sel?.type === 'backdropkey') state.ui.sel = { type: 'backdrop' };
  emit('backdrop', b);
  emit('selection', state.ui.sel);
  emit('render');
}

export function commitBackdropKeys() {
  const b = ensureBackdrop();
  b.keys.sort((a, z) => a.t - z.t);
  emit('backdrop', b);
  emit('render');
}

/** Slip one lane along the timeline. */
// ── particles ────────────────────────────────────────────────
export const particles = () => state.project.particles;
export const particleEmitters = () => state.project.particles.emitters;
export const particleEmitter = id => particleEmitters().find(e => e.id === id) ?? null;

/** The emitter the panel is editing — falling back to the first one. */
export const selectedEmitter = () =>
  particleEmitter(state.ui.particle) ?? particleEmitters()[0] ?? null;

/**
 * The emitter the *selection* is on — null while anything else (a text layer,
 * a guide, a camera key) holds it, so only one thing ever reads as selected.
 * `state.ui.particle` stays put underneath as the emitter the panel edits.
 */
export const activeEmitterId = () =>
  state.ui.sel?.type === 'particle' ? state.ui.sel.id : null;

export function selectEmitter(id) {
  const same = state.ui.particle === id && state.ui.sel?.type === 'particle' && state.ui.sel.id === id;
  if (same) return;
  state.ui.particle = id;
  // The emitter is also *the* selection, so the Particles panel can hide the
  // way the Camera one does when the track isn't what's being worked on.
  state.ui.sel = id ? { type: 'particle', id } : null;
  emit('particles', state.project.particles);
  emit('selection', state.ui.sel);
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

/**
 * Move an emitter onto the frame plane of the camera at the given time.
 *
 * Emitters live in the same world space as text layers, so the placement is the
 * camera's displacement from neutral framing — the same offset a text layer
 * gets from `alignClipWithCamera`.
 */
export function alignEmitterWithCamera(id, t = state.ui.time) {
  if (!particleEmitter(id)) return null;
  return updateEmitter(id, cameraFrameOffsetAt(t));
}

/**
 * The live window, moved or trimmed from the timeline. Kept light: a drag emits
 * only `particleMove` and a re-render, and commitEmitters() closes the gesture.
 */
export function setEmitterWindow(id, start, end) {
  const e = particleEmitter(id);
  if (!e) return null;
  const dur = state.project.duration;
  e.start = clamp(start, 0, Math.max(0, dur - 0.05));
  e.end = clamp(end, e.start + 0.05, dur);
  e.revision = (e.revision + 1) % 1e9;
  emit('particleMove', e);
  emit('render');
  return e;
}

export function commitEmitters() {
  emit('particles', state.project.particles);
  emit('render');
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
  state.ui.sel = { type: 'particle', id: e.id };
  emit('particles', state.project.particles);
  emit('selection', state.ui.sel);
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
  if (state.ui.sel?.type === 'particle' && state.ui.sel.id === id) {
    state.ui.sel = state.ui.particle ? { type: 'particle', id: state.ui.particle } : null;
    emit('selection', state.ui.sel);
  }
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
/** Ids selected as text layers (empty unless layers hold the selection). */
export function selectedClipIds() {
  const sel = state.ui.sel;
  if (sel?.type !== 'clip') return [];
  return sel.ids ?? (sel.id ? [sel.id] : []);
}

/** The selected layers themselves, in project order. */
export function selectedClips() {
  const ids = new Set(selectedClipIds());
  return clips().filter(c => ids.has(c.id));
}

/** Layers in the order the list and range selection read them. */
export const clipsInOrder = () =>
  [...clips()].sort((a, b) => a.start - b.start || a.track - b.track);

/**
 * Select a text layer.
 *
 * @param {'set'|'toggle'|'range'} mode  'toggle' adds or removes one layer,
 *        'range' extends from the anchor — the last layer picked outright —
 *        to the clicked one along the timeline order, so a second ⇧-click
 *        re-extends from the same place rather than from the previous one.
 *        The clicked layer stays the primary, so the inspector keeps editing
 *        the one the user last pointed at.
 */
export function selectClip(id, mode = 'set') {
  const list = clips();
  if (!list.some(c => c.id === id)) return;
  const sel = state.ui.sel;
  const same = sel?.type === 'clip';
  let ids = same
    ? [...(sel.ids ?? [sel.id])].filter(x => list.some(c => c.id === x))
    : [];
  const held = same && list.some(c => c.id === sel.anchor) ? sel.anchor : sel?.id;
  let anchor = id;

  if (mode === 'toggle') {
    ids = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
    if (!ids.length) { state.ui.sel = null; emit('selection', null); return; }
    if (!ids.includes(id)) id = ids.at(-1);
  } else if (mode === 'primary' && ids.includes(id)) {
    // Pressing an already-selected layer keeps the group so it can be dragged;
    // the click collapses it only if nothing moved.
    anchor = held ?? id;
  } else if (mode === 'range' && same && held) {
    const order = clipsInOrder();
    const a = order.findIndex(c => c.id === held);
    const b = order.findIndex(c => c.id === id);
    if (a < 0 || b < 0) ids = [id];
    else {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      ids = order.slice(lo, hi + 1).map(c => c.id);
      anchor = held;
    }
  } else {
    ids = [id];
  }
  // Anything but an extension re-anchors on the layer just picked.
  if (mode !== 'range' && mode !== 'primary') anchor = id;
  state.ui.sel = { type: 'clip', id, ids, anchor };
  emit('selection', state.ui.sel);
}

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
export const clipsAt = t => clips().filter(c => clipLive(c, t, state.project));

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
  normalizeStages(clip);
  p.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id, ids: [clip.id] };
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

/** Select the camera track itself when its empty lane is clicked. */
export function selectCameraTrack() {
  if (state.ui.sel?.type === 'camera') return;
  state.ui.sel = { type: 'camera' };
  emit('selection', state.ui.sel);
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
      (type !== 'guide' || (cur.ids?.length ?? 1) === 1) &&
      (type !== 'clip' || (cur.ids?.length ?? 1) === 1)) return;
  state.ui.sel = type
    ? type === 'guide' ? { type, id, level: levelKey, ids: [id], pivot: null }
    : type === 'clip' ? { type, id, ids: [id], anchor: id }
    : { type, id }
    : null;
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
    p.clips.forEach(c => {
      if (c.locked) return;
      c.start *= k; c.end *= k;
      for (const key of ['in', 'out']) {
        const stage = c.stages?.[key];
        if (stage) stage.dur = (Number(stage.dur) || 0) * k;
      }
    });
    p.particles.emitters.forEach(e => { e.start *= k; e.end *= k; });
    const backdropTrack = p.backdrop;
    if (backdropTrack?.keys) backdropTrack.keys.forEach(key => { key.t *= k; });
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
  p.backdrop = normalizeBackdrop(p.backdrop, p.duration, p.bg);
  p.bg = p.backdrop.colors[0];
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

/**
 * Bring one layer's in/mid/out to a usable shape.
 *
 * A project written before stages existed carries a single `effect` and one set
 * of params: read that as the same effect on all three stages, split along its
 * own arc, which animates identically to how it was authored. Durations are in
 * seconds and are clamped against the layer's current length, so a trim can
 * squeeze the stages but never make them overrun it.
 */
function normalizeStages(c) {
  const len = Math.max(MIN_CLIP, c.end - c.start);
  const legacy = typeof c.effect === 'string' ? c.effect : null;
  const saved = c.stages && typeof c.stages === 'object' ? c.stages : {};
  const base = legacy
    ?? (EFFECTS[saved.mid?.effect] ? saved.mid.effect : null)
    ?? (EFFECTS[saved.in?.effect] ? saved.in.effect : null)
    ?? 'hold';
  const fallback = defaultStages(base, len, legacy ? (c.params ?? {}) : {});

  c.stages = Object.fromEntries(STAGE_KEYS.map(key => {
    const from = legacy ? null : saved[key];
    const effect = EFFECTS[from?.effect] ? from.effect : fallback[key].effect;
    const params = from?.params && typeof from.params === 'object'
      ? { ...from.params } : fallback[key].params;
    return [key, { effect, params }];
  }));

  const dur = key => {
    const v = legacy ? fallback[key].dur : Number(saved[key]?.dur);
    return Number.isFinite(v) ? Math.max(0, v) : fallback[key].dur;
  };
  const inDur = clamp(dur('in'), 0, len);
  c.stages.in.dur = inDur;
  c.stages.out.dur = clamp(dur('out'), 0, len - inDur);

  delete c.effect;
  delete c.params;
}

/**
 * Change the stage text style. Every layer that has not overridden the fields
 * being set follows along, which is the point of it.
 */
export function setTextStyle(props) {
  const style = state.project.textStyle ?? (state.project.textStyle = { ...TEXT_STYLE });
  Object.assign(style, props);
  emit('project', state.project);
  emit('render');
}

/** Hand a layer's type settings back to the stage — all of them, or just one. */
export function resetClipStyle(id, key = null) {
  const clip = clips().find(c => c.id === id);
  if (!clip) return;
  for (const k of key ? [key] : TEXT_STYLE_KEYS) delete clip[k];
  emit('clip', clip);
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
    c.locked = c.locked === true;
    normalizeStages(c);
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
  state.ui.sel = { type: 'clip', id: clip.id, ids: [clip.id] };
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
  const clip = { ...src, id: uid('c'), stages: copyStages(src.stages),
                 start: clamp(src.end, 0, state.project.duration - MIN_CLIP) };
  clip.position = { ...(src.position ?? { x: 0, y: 0, z: 0 }) };
  clip.end = clamp(clip.start + len, clip.start + MIN_CLIP, state.project.duration);
  state.project.clips.push(clip);
  state.ui.sel = { type: 'clip', id: clip.id, ids: [clip.id] };
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
  const sel = state.ui.sel;
  if (sel?.type === 'clip') {
    const ids = (sel.ids ?? [sel.id]).filter(x => x !== id);
    if (ids.length) state.ui.sel = { type: 'clip', id: ids.includes(sel.id) ? sel.id : ids.at(-1), ids };
    else if (sel.id === id) {
      const next = p.clips[Math.max(0, i - 1)];
      state.ui.sel = next ? { type: 'clip', id: next.id, ids: [next.id] } : null;
    }
  }
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

const copyStages = stages => Object.fromEntries(STAGE_KEYS.map(key => {
  const s = stages?.[key] ?? {};
  return [key, { ...s, params: { ...(s.params ?? {}) } }];
}));

/** Set the effect or the params of one stage of a text layer. */
export function setClipStage(id, key, props) {
  const c = clips().find(x => x.id === id);
  if (!c || !STAGE_KEYS.includes(key)) return null;
  const stage = c.stages?.[key];
  if (!stage) return null;
  if (props.effect !== undefined && EFFECTS[props.effect]) {
    stage.effect = props.effect;
    // Params belong to the effect that declared them: a swap starts clean.
    stage.params = props.params ?? {};
  } else if (props.params !== undefined) {
    stage.params = { ...props.params };
  }
  emit('clip', c);
  emit('render');
  return c;
}

/**
 * Set how long the in or the out stage runs, in seconds. Mid takes whatever is
 * left, so the two authored stages are only ever held apart by the layer.
 */
export function setStageDuration(id, key, seconds) {
  const c = clips().find(x => x.id === id);
  if (!c || (key !== 'in' && key !== 'out')) return null;
  const len = Math.max(MIN_CLIP, c.end - c.start);
  const other = key === 'in' ? 'out' : 'in';
  const room = Math.max(0, len - (Number(c.stages[other].dur) || 0));
  c.stages[key].dur = clamp(Number(seconds) || 0, 0, room);
  emit('clip', c);
  emit('render');
  return c;
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
    // The bytes stay out of the project file; the size is kept because it keys
    // the local media cache that reattaches the source on the next Open.
    size: Math.max(0, Number(clip.size) || 0),
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
    size: Math.max(0, Number(clip.size) || 0),
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
    size: Math.max(0, serialNumber(source.size)),
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
    size: Math.max(0, serialNumber(source.size)),
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

// The on-disk contract, shared by Save, Open and the autosave snapshot.
export const PROJECT_FORMAT = 'kinetic-typography-composer';
export const PROJECT_VERSION = 11;

export function serialize() {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
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
  if (!json || json.format !== PROJECT_FORMAT) throw new Error('Not a composer file');
  const p = json.project ?? {};
  const legacyGuides = Array.isArray(p.guides) ? p.guides : null;   // v2 files
  Object.assign(state.project, p);
  const proj = state.project;
  delete proj.guides;
  delete proj.repeats;

  // v10 and earlier only had a static `bg`; newer files carry a dedicated
  // backdrop colour track. Normalize at the boundary so renderers and panels
  // never have to branch on the project version.
  proj.backdrop = normalizeBackdrop(proj.backdrop, proj.duration, proj.bg);
  proj.bg = proj.backdrop.colors[0];

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
  const hadTextStyle = !!p.textStyle;
  proj.textStyle = stageStyle(proj);
  // Layers written before the stage text style pinned every value on the layer
  // itself. Read anything that matches the stage default as inherited, so a
  // later change to the stage still moves those layers; anything that differs
  // stays the layer's own.
  if (!hadTextStyle) {
    for (const c of proj.clips) {
      for (const key of TEXT_STYLE_KEYS) {
        if (!overridesStyle(c, key)) { delete c[key]; continue; }
        const own = c[key], stage = proj.textStyle[key];
        const same = typeof own === 'number' && typeof stage === 'number'
          ? Math.abs(own - stage) < 1e-9 : own === stage;
        if (same) delete c[key];
      }
    }
  }
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
  state.ui.sel = state.project.clips.length
    ? { type: 'clip', id: state.project.clips[0].id, ids: [state.project.clips[0].id] }
    : null;
  state.ui.view = { start: 0, end: state.project.duration * 1.05 };
  state.ui.time = 0;
  emit('project', state.project);
  emit('guides', state.project.levels);
  emit('clips', state.project.clips);
  emit('backdrop', state.project.backdrop);
  emit('video', state.video);
  emit('particles', state.project.particles);
  emit('selection', state.ui.sel);
  emit('render');
}

/**
 * Throw the composition away and start again from the default arrangement.
 * Runtime media is the caller's to release first — the decoded buffers belong
 * to the audio and video engines, not to the store.
 */
export function newProject() {
  const p = state.project;
  for (const key of Object.keys(p)) delete p[key];
  Object.assign(p, freshProject());
  resetAudioState();
  state.video.channels = freshVideoChannels();
  Object.assign(state.metro, freshMetro());

  initProject();                    // default guides, the demo layers, a selection
  state.ui.time = 0;
  state.ui.particle = p.particles.emitters[0]?.id ?? null;
  syncBeatTimes();

  emit('project', p);
  emit('duration', p.duration);
  emit('guides', p.levels);
  emit('clips', p.clips);
  emit('camera', p.camera);
  emit('backdrop', p.backdrop);
  emit('particles', p.particles);
  emit('audio', state.audio);
  emit('video', state.video);
  emit('metro', state.metro);
  emit('selection', state.ui.sel);
  emit('render');
}
