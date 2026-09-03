// Undo / redo for the composition.
//
// Snapshots rather than commands: every editing action in this app already ends
// by mutating `state.project` in place and announcing itself on the bus, so the
// cheapest correct history is a deep copy of the project taken whenever the
// user pauses. Nothing at the call sites has to be rewritten, and an action
// added later is undoable the day it is written.
//
// A gesture is one entry, not one entry per pointermove: a change schedules a
// commit that only lands once the pointer is up and the edits have gone quiet,
// so dragging a layer across the timeline undoes in a single step.
//
// Scope is `state.project` — structure, text layers, camera, particles and the
// composition settings. Audio and backdrop media deliberately live outside it,
// because the browser owns the decoded buffers and an undo cannot conjure them
// back; importing or removing media is therefore not undoable, and in exchange
// undoing a text edit can never silently detach a soundtrack.

import { state, on, emit, syncBeatTimes } from './state.js';
import { LEVEL_KEYS } from './structure.js';
import { clamp } from './util.js';

const LIMIT = 100;    // entries kept in each direction — each holds a whole project
const IDLE = 320;     // ms of quiet before pending edits become one entry

// Events that can only be the result of a change to state.project.
const WATCHED = new Set([
  'project', 'duration', 'guides', 'clips', 'clip', 'camera', 'backdrop', 'particles', 'particleMove'
]);

const EVENT_LABELS = {
  clips: 'layers', clip: 'layer', guides: 'structure', camera: 'camera', backdrop: 'backdrop',
  particles: 'particles', particleMove: 'particles',
  duration: 'duration', project: 'composition'
};

// Countable things, so an entry can name itself "delete layer" rather than
// merely "layers". Ordered: the first count that moved wins the label.
const COUNTED = [
  ['clips', 'layer'], ['guides', 'structure point'],
  ['camkeys', 'camera key'], ['emitters', 'emitter'], ['backdropkeys', 'backdrop key']
];

let past = [];
let future = [];
let baseline = null;      // the state as of the last committed entry
let applying = false;     // true while undo/redo writes the project back
let timer = 0;
let pointerDown = false;
const pending = new Set();

function counts(p) {
  const cam = p.camera ?? {};
  const channels = cam.channels && typeof cam.channels === 'object' ? cam.channels : null;
  return {
    clips: p.clips?.length ?? 0,
    guides: LEVEL_KEYS.reduce((n, key) => n + (p.levels?.[key]?.guides?.length ?? 0), 0),
    camkeys: (cam.keys?.length ?? 0) +
      (channels ? Object.values(channels).reduce((n, list) => n + (list?.length ?? 0), 0) : 0),
    emitters: p.particles?.emitters?.length ?? 0,
    backdropkeys: p.backdrop?.keys?.length ?? 0
  };
}

function snapshot(label = 'edit') {
  return {
    label,
    project: JSON.stringify(state.project),
    counts: counts(state.project),
    sel: state.ui.sel ? structuredClone(state.ui.sel) : null,
    particle: state.ui.particle
  };
}

/** Name the transition, for the button tooltips. */
function describe(prev, next) {
  for (const [key, noun] of COUNTED) {
    const d = next.counts[key] - prev.counts[key];
    if (d > 0) return `add ${noun}${d > 1 ? 's' : ''}`;
    if (d < 0) return `delete ${noun}${d < -1 ? 's' : ''}`;
  }
  // Most specific first: changing the duration rescales the layers too, and
  // "duration" is the honest name for that entry.
  for (const evt of ['duration', 'project', 'camera', 'guides', 'particleMove', 'particles', 'clips', 'clip']) {
    if (pending.has(evt)) return EVENT_LABELS[evt];
  }
  return 'edit';
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** What the two buttons should say right now. */
export function historyInfo() {
  return {
    canUndo: canUndo(), canRedo: canRedo(),
    undoLabel: canUndo() ? baseline?.label ?? 'edit' : '',
    redoLabel: canRedo() ? future[future.length - 1].label : ''
  };
}

const announce = () => emit('history', historyInfo());

/** A selection only survives an undo if what it pointed at came back with it. */
export function validSelection(sel) {
  const p = state.project;
  if (!sel || typeof sel !== 'object') return null;
  if (sel.type === 'camera') return sel;
  if (sel.type === 'clip') {
    if (!p.clips.some(c => c.id === sel.id)) return null;
    const ids = (sel.ids ?? [sel.id]).filter(id => p.clips.some(c => c.id === id));
    return { ...sel, ids: ids.length ? ids : [sel.id] };
  }
  if (sel.type === 'particle') {
    return (p.particles?.emitters ?? []).some(e => e.id === sel.id) ? sel : null;
  }
  if (sel.type === 'backdrop') return sel;
  if (sel.type === 'backdropkey') {
    return (p.backdrop?.keys ?? []).some(key => key.id === sel.id) ? sel : { type: 'backdrop' };
  }
  if (sel.type === 'camkey') {
    const list = sel.axis ? p.camera.channels?.[sel.axis] ?? [] : p.camera.keys ?? [];
    return list.some(k => k.id === sel.id) ? sel : null;
  }
  if (sel.type === 'guide') {
    const gs = p.levels?.[sel.level]?.guides ?? [];
    if (!gs.some(g => g.id === sel.id)) return null;
    const ids = (sel.ids ?? [sel.id]).filter(id => gs.some(g => g.id === id));
    return { ...sel, ids: ids.length ? ids : [sel.id] };
  }
  return null;
}

function apply(entry) {
  applying = true;
  try {
    const restored = JSON.parse(entry.project);
    // Replace the contents rather than the object: the renderer, timeline and
    // panels all hold `state.project` itself.
    for (const key of Object.keys(state.project)) delete state.project[key];
    Object.assign(state.project, restored);

    const emitters = state.project.particles?.emitters ?? [];
    state.ui.particle = emitters.some(e => e.id === entry.particle)
      ? entry.particle : emitters[0]?.id ?? null;
    state.ui.sel = validSelection(entry.sel);
    state.ui.time = clamp(state.ui.time, 0, state.project.duration);

    syncBeatTimes();          // a manual grid is drawn against the duration
    emit('project', state.project);
    emit('duration', state.project.duration);
    emit('guides', state.project.levels);
    emit('clips', state.project.clips);
    emit('camera', state.project.camera);
    emit('backdrop', state.project.backdrop);
    emit('particles', state.project.particles);
    emit('selection', state.ui.sel);
    emit('render');
  } finally {
    applying = false;
  }
  baseline = entry;
  clearTimeout(timer);
  timer = 0;
  pending.clear();
}

/** Fold any outstanding edits into one entry. Returns true if history moved. */
export function commitHistory() {
  clearTimeout(timer);
  timer = 0;
  if (applying || !baseline) { pending.clear(); return false; }
  const next = snapshot();
  if (next.project === baseline.project) { pending.clear(); return false; }
  next.label = describe(baseline, next);
  pending.clear();
  past.push(baseline);
  if (past.length > LIMIT) past.shift();
  future = [];
  baseline = next;
  announce();
  return true;
}

/**
 * A discrete action — a button, a keyboard shortcut — is its own entry as soon
 * as it happens. Only the continuous edits wait: a pointer gesture until the
 * button comes up, and a field being typed into or a slider being nudged until
 * the keystrokes stop.
 */
function settling() {
  if (pointerDown) return true;
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function schedule() {
  clearTimeout(timer);
  const delay = settling() ? IDLE : 0;
  timer = setTimeout(() => {
    timer = 0;
    // Never cut a gesture in half: wait for the button to come up.
    if (pointerDown) { schedule(); return; }
    commitHistory();
  }, delay);
}

/** Note that the project may have changed. Cheap — the diff happens on commit. */
export function touch(evt = 'project') {
  if (applying) return;
  pending.add(evt);
  schedule();
}

export function undo() {
  commitHistory();
  if (!past.length) return false;
  const prev = past.pop();
  future.push(baseline);
  if (future.length > LIMIT) future.shift();
  apply(prev);
  announce();
  return true;
}

export function redo() {
  commitHistory();
  if (!future.length) return false;
  const next = future.pop();
  past.push(baseline);
  if (past.length > LIMIT) past.shift();
  apply(next);
  announce();
  return true;
}

/** Start again from the project as it stands — boot, and opening a file. */
export function resetHistory(label = 'open') {
  past = [];
  future = [];
  pending.clear();
  clearTimeout(timer);
  timer = 0;
  baseline = snapshot(label);
  announce();
}

export function initHistory() {
  resetHistory('new composition');
  on('*', evt => { if (WATCHED.has(evt)) touch(evt); });
  // Capture phase, so the flag is set before any canvas handler runs. Anything
  // typed before this press is its own entry, not part of what follows.
  window.addEventListener('pointerdown', () => {
    if (timer) commitHistory();
    pointerDown = true;
  }, true);
  const release = () => { pointerDown = false; };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
}
