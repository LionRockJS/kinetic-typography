// Crash recovery: the composition as it stands, kept in localStorage.
//
// Save writes a .ktc.json the user has to ask for; this writes the same
// document, unasked, every time the editing goes quiet. A tab that is closed
// by accident, a reload, a crashed GPU process — reopening the page brings the
// work back rather than the demo arrangement.
//
// It is deliberately the *same* payload as a saved file: one serializer, one
// reader, one set of migrations. What it cannot hold is what a file cannot
// hold either — the decoded audio and video bytes. Those come back through the
// media cache on the way in, exactly as they do when a project file is opened.
//
// Everything here degrades quietly: with no usable localStorage — a private
// window, blocked storage, a page opened over file:// — the app runs as it did
// before, minus the recovery.

import { state, serialize, deserialize, on, PROJECT_FORMAT, PROJECT_VERSION } from './state.js';
import { validSelection } from './history.js';
import { clamp, toast } from './util.js';

const KEY = 'ktc:autosave:v1';
const IDLE = 800;        // ms of quiet before a snapshot is written
const MAX_WAIT = 8000;   // continuous editing still lands a snapshot this often

// Everything that can change what `serialize()` would produce. Playback,
// rendering and selection are not on the list: they cost a write and restore
// nothing worth restoring.
const WATCHED = new Set([
  'project', 'duration', 'guides', 'clips', 'clip', 'camera',
  'particles', 'particleMove', 'backdrop',
  'audio', 'audioMove', 'audioLevel',
  'video', 'videoMove', 'videoLevel',
  'metro', 'grid', 'hits', 'fonts',
  // The undo stack moving is itself proof the project changed — and it is the
  // only announcement some edits make (the project name is typed straight into
  // the state and merely touched), so it belongs on the list.
  'history'
]);

let timer = 0;
let pendingSince = 0;
let enabled = true;
let wired = false;

function storage() {
  // Reading `localStorage` itself throws when storage is blocked for the origin.
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The saved-file document, plus the little of the editing session worth keeping. */
function snapshot() {
  const ui = state.ui;
  return {
    ...serialize(),
    savedAt: Date.now(),
    ui: {
      time: ui.time,
      viewMode: ui.viewMode,
      particle: ui.particle,
      sel: ui.sel ? JSON.parse(JSON.stringify(ui.sel)) : null
    }
  };
}

/** Write the snapshot now, cancelling any pending one. */
export function saveNow() {
  clearTimeout(timer);
  timer = 0;
  pendingSince = 0;
  const store = storage();
  if (!enabled || !store) return false;
  try {
    store.setItem(KEY, JSON.stringify(snapshot()));
    return true;
  } catch (err) {
    // Out of quota, or storage switched off mid-session. Stop rather than
    // throwing on every subsequent edit, and say so once.
    enabled = false;
    console.warn('Autosave stopped', err);
    toast('Autosave stopped — browser storage is full or unavailable', 3600);
    return false;
  }
}

function schedule() {
  if (!enabled) return;
  if (!timer) pendingSince = Date.now();
  // A long unbroken gesture — dragging a layer for ten seconds — should not
  // postpone the snapshot indefinitely.
  if (Date.now() - pendingSince >= MAX_WAIT) { saveNow(); return; }
  clearTimeout(timer);
  timer = setTimeout(saveNow, IDLE);
}

export function clearAutosave() {
  clearTimeout(timer);
  timer = 0;
  pendingSince = 0;
  try { storage()?.removeItem(KEY); } catch { /* nothing to clear */ }
}

/** The stored snapshot, or null when there is nothing usable to recover. */
export function readAutosave() {
  const store = storage();
  if (!store) return null;
  let raw = null;
  try { raw = store.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.format !== PROJECT_FORMAT) return null;
    const version = Number(data.version);
    // Written by a newer build of the app: leave it alone rather than opening
    // it half-understood.
    if (Number.isFinite(version) && version > PROJECT_VERSION) return null;
    return data;
  } catch { return null; }
}

/**
 * Put a snapshot back into the store. Returns what was recovered — the age of
 * the snapshot, for the message the user sees — or null if it could not be read,
 * in which case the unusable snapshot is dropped.
 */
export function restoreAutosave(data = readAutosave()) {
  if (!data) return null;
  try {
    deserialize(data);
  } catch (err) {
    console.warn('Could not recover the last session', err);
    clearAutosave();
    return null;
  }

  const ui = data.ui && typeof data.ui === 'object' ? data.ui : {};
  state.ui.time = clamp(Number(ui.time) || 0, 0, state.project.duration);
  state.ui.viewMode = ui.viewMode === 'space' ? 'space' : 'output';
  const emitters = state.project.particles.emitters;
  if (emitters.some(e => e.id === ui.particle)) state.ui.particle = ui.particle;
  // Only if it still points at something: the layer it named may have been the
  // casualty the user is recovering from.
  const sel = validSelection(ui.sel);
  if (sel) state.ui.sel = sel;

  return {
    savedAt: Number(data.savedAt) || 0,
    name: state.project.name,
    // The typefaces are loaded by the caller: fonts are decoded resources, not
    // state, and the boot sequence already owns that step.
    fonts: Array.isArray(data.fonts) ? data.fonts : null
  };
}

/** Begin watching. Safe to call once the project is in its opening state. */
export function startAutosave() {
  if (wired) return;
  wired = true;
  on('*', evt => { if (WATCHED.has(evt)) schedule(); });
  // Closing the tab, or switching away from it, is the last chance to write.
  // `pagehide` fires where `beforeunload` is unreliable (Safari, mobile).
  addEventListener('pagehide', () => { if (timer) saveNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) saveNow();
  });
  // Nothing is written until something is edited: an untouched session is the
  // demo arrangement, which is what an empty snapshot reopens as anyway, and
  // writing it would mean announcing a "recovery" nobody needed.
}
