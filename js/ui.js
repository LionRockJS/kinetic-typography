// Panel wiring. Everything here reads and writes the store; nothing else touches the DOM.

import { state, level, guides, clips, selectedClip, selectedClips, selectedClipIds,
         selectClip, clipsInOrder, selectedGuide, selectedGuideIds,
         selectedGuideIndices, select, selectGuide, on, emit, patch,
         setRepeats, setDuration, updateClip, setTextStyle, resetClipStyle,
         commitGuides, addClip, reframe,
         duplicateClip, removeClip, serialize, deserialize, track, audioClips, savedAudioClips, anyAudio,
         setTrackStart, setTrackLevel, setAudioClipStart, setAudioClipLevel,
         AUDIO_MAX_VOLUME, audioVolumeKeys, selectedAudioVolumeKey, selectAudioVolumeKey, addAudioVolumeKey,
         updateAudioVolumeKey, removeAudioVolumeKey, clearAudioVolumeKeys,
         setHitParams, syncBeatTimes,
         beatTimes, barTimes, setMetro, hasGrid, setRunPivot, runPivotIndex,
         videoClips, videoClip,
         setVideoClipStart, setVideoClipSettings,
         BACKDROP_MODES, backdrop, backdropAt, backdropKeys, selectedBackdropKey,
         selectBackdropKey, selectBackdropTrack, addBackdropKey, updateBackdropKey,
         setBackdrop, removeBackdropKey, clearBackdropTrack, backdropCss,
         clipColorKeys, selectedClipColorKey, addClipColorKey, updateClipColorKey,
         removeClipColorKey,
         setClipStage, setStageDuration,
         setClipParent, canSetClipParent, clipWorldPosition,
         particleEmitters, selectedEmitter, selectEmitter, activeEmitterId, updateEmitter,
         addParticleEmitter, duplicateParticleEmitter, removeParticleEmitter,
         copyEmitterData, pasteEmitter, EMITTER_CLIPBOARD_FORMAT,
         alignEmitterWithCamera,
         camera, cameraKeys, cameraMode, cameraChannelKeys, cameraKeyCount,
         selectedCamKey, selectedCamAxis,
         addCameraKey, addCameraChannelKey, setCameraChannelSpan,
         updateCameraKey, updateCameraChannelKey, removeCameraKey, removeCameraChannelKey,
         setCameraMode, setCameraEnabled, clearCameraTrack,
         selectCameraKey,
         alignClipWithCamera,
         copyClipData, pasteClip, CLIPBOARD_FORMAT,
         newProject, PROJECT_FORMAT, PROJECT_VERSION,
         FONT_SLOTS, DIM_PRESETS,
         fontAssets, setClipFont,
         TRACKS, MIN_CLIP } from './state.js';
import { undo, redo, resetHistory, touch, historyInfo } from './history.js';
import { VOICES } from './audio/metronome.js';
import { EASES, cameraAt, defaultCameraPosition } from './camera.js';
import { TRACK_KINDS } from './audio/engine.js';
import { VIDEO_CHANNEL_KINDS, VIDEO_EFFECTS } from './video/engine.js';
import { PARTICLE_SHAPES, PARTICLE_ORIGINS, TEXT_MODES, MAX_EMITTERS,
         PARTICLE_CURVE_POINTS, PARTICLE_CURVE_PRESETS, normalizeParticleCurve } from './particles.js';
import { ROLES, LEVELS, LEVEL_KEYS, patternLabel, rebalanceGuides, guideDisplay, guideHandles,
         regionAt, drivingRegion, normalizeGuides, scaleRange, distributeRange, DISTRIBUTIONS } from './structure.js';
import { EFFECTS, effectsForRole, effectIds, resolveParams,
         clipStage, stageWindows, clipLive, clipStyle, stageStyle, overridesStyle,
         TEXT_STYLE_KEYS, STAGE_KEYS } from './effects.js';
import { FONT_PRESETS } from './typography.js';
import { $, el, fmtTime, fmtDur, clamp, download, toast, nearest, round } from './util.js';
import { clearAutosave } from './autosave.js';
import { requestMedia } from './media/store.js';
import { pickAudioFiles, pickVideoFiles } from './media/pick.js';

let app;
let clipClipboard = null;
let emitterClipboard = null;
let activeCurveGesture = null;

function parseProjectFile(text) {
  // JSON exported by some desktop/browser combinations can start with a UTF-8
  // BOM. JSON.parse rejects that character even though the rest is valid JSON.
  const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project file must contain a JSON object');
  }
  if (value.format !== PROJECT_FORMAT) throw new Error('Not a composer file');
  const version = Number(value.version);
  if (Number.isFinite(version) && version > PROJECT_VERSION) {
    throw new Error(`Project format v${version} is newer than this composer`);
  }
  return value;
}

export function initUI(ctx) {
  app = ctx;
  buildTopBar();
  buildStructure();
  buildLayers();
  buildVideoPanel();
  buildAudioPanel();
  buildMetroPanel();
  buildFontPanel();
  buildCameraPanel();
  buildParticlePanel();
  buildLookPanel();
  buildViewport();
  buildTransport();
  buildShortcuts();

  on('project duration', syncTopBar);
  on('history', syncHistoryButtons);
  on('guides duration', () => { renderPattern(); syncInspector(); });
  on('clips duration', () => { renderClipList(); syncInspector(); });
  on('selection', () => { renderPattern(); renderClipList(); buildInspector(); renderCameraPanel(); renderParticlePanel(true); renderBackdropPanel(); renderAudioLanes(); });
  on('camera', renderCameraPanel);
  on('clip', () => { renderClipList(); syncInspector(); });
  on('audio audioMove audioLevel hits', syncAudioPanel);
  on('video videoMove videoLevel', syncVideoPanel);
  on('backdrop', renderBackdropPanel);
  on('particles project duration', renderParticlePanel);
  on('particleMove', renderEmitterList);   // a timeline drag only moves the window
  on('metro grid audio', syncMetroPanel);
  on('fonts', () => { syncFontPanel(); renderStageText(); syncInspector(); });
  // The stage style also decides what an inherited field in the inspector shows.
  on('project', () => { renderStageText(); syncInspector(); });
  on('view', syncViewMode);
  on('time clips clip guides audioMove', syncTime);
  on('time', () => { syncBackdropPreview(); syncInspector(); syncAudioVolumeButtons(); });

  syncTopBar();
  syncHistoryButtons();
  renderPattern();
  renderClipList();
  renderVideoChannels();
  buildInspector();
  renderCameraPanel();
  renderStageText();
  syncAudioPanel();
  syncMetroPanel();
  syncFontPanel();
  syncViewMode();
  syncTime();
}

// ══ top bar ══════════════════════════════════════════════════
function buildTopBar() {
  const sel = $('#dimPreset');
  sel.append(el('option', { value: 'custom' }, 'Custom'));
  DIM_PRESETS.forEach((p, i) => sel.append(el('option', { value: String(i) }, `${p.label} · ${p.w}×${p.h}`)));
  sel.addEventListener('change', () => {
    const p = DIM_PRESETS[+sel.value];
    if (p) patch({ width: p.w, height: p.h });
    syncTopBar();
  });

  $('#projName').addEventListener('input', e => { state.project.name = e.target.value; touch('project'); });

  const dim = () => {
    patch({
      width: clamp(+$('#dimW').value || 1080, 64, 4096),
      height: clamp(+$('#dimH').value || 1080, 64, 4096)
    });
    syncTopBar();
  };
  $('#dimW').addEventListener('change', dim);
  $('#dimH').addEventListener('change', dim);

  $('#durInput').addEventListener('change', e => {
    setDuration(clamp(+e.target.value || 1, 1, 900), { scale: true });
    app.timeline.fit();
  });
  $('#fpsInput').addEventListener('change', e => patch({ fps: clamp(+e.target.value || 30, 1, 120) }));

  $('#btnUndo').addEventListener('click', () => undo());
  $('#btnRedo').addEventListener('click', () => redo());

  $('#btnNew').addEventListener('click', () => {
    // Destructive and not undoable — the composition it replaces is gone from
    // the autosave too, so this one asks first.
    if (!confirm('Start a new composition? Anything unsaved in this one is discarded.')) return;
    for (const { kind } of TRACK_KINDS) app.clearAudio?.(kind);
    app.clearVideos?.();
    newProject();
    resetHistory('new composition');
    clearAutosave();   // nothing to recover until this one is edited
    app.timeline.fit();
    toast('New composition');
  });

  $('#btnSave').addEventListener('click', () => {
    const name = (state.project.name || 'composition').replace(/[^\w\-. ]+/g, '_');
    download(`${name}.ktc.json`, new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' }));
    toast('Project saved');
  });
  $('#btnLoad').addEventListener('click', () => $('#projFile').click());
  const openProject = async projectFile => {
    if (!projectFile || projectFile.format !== PROJECT_FORMAT) throw new Error('Not a composer file');
    // The project file stores media references, not browser-owned buffers.
    // Drop the current runtime sources before replacing their metadata so
    // audio from the previous project cannot keep playing after Open.
    for (const { kind } of TRACK_KINDS) app.clearAudio?.(kind);
    app.clearVideos?.();
    deserialize(projectFile);
    resetHistory('open project');
    await app.ensureClipFonts?.();
    app.timeline.fit();
    // Sources imported on this browser are cached locally, so most projects come
    // back whole; only what the cache has lost still needs the user.
    const { pending = 0, attached = 0, needsPermission = 0 } = await app.relinkSavedMedia?.() ?? {};
    if (!pending) toast('Project loaded');
    else if (attached === pending) toast(`Project loaded — ${attached} media file${attached === 1 ? '' : 's'} reattached`);
    else if (needsPermission) toast(`Project loaded — ${attached ? `${attached} reattached, ` : ''}${needsPermission} saved ${needsPermission === 1 ? 'file needs' : 'files need'} permission: click ↗`);
    else if (attached) toast(`Project loaded — ${attached} of ${pending} media files reattached; re-import the rest`);
    else toast('Project loaded — re-import saved audio and backdrop media to attach them');
  };

  $('#projFile').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await openProject(parseProjectFile(await f.text()));
    } catch (err) {
      console.error('Could not open project file', err);
      toast('Could not read that file');
    }
    e.target.value = '';
  });
  $('#btnRecord').addEventListener('click', () => app.toggleRecord());
}

function syncTopBar() {
  const p = state.project;
  $('#projName').value = p.name;
  $('#dimW').value = p.width;
  $('#dimH').value = p.height;
  $('#durInput').value = round(p.duration, 2);
  $('#fpsInput').value = p.fps;
  const idx = DIM_PRESETS.findIndex(d => d.w === p.width && d.h === p.height);
  $('#dimPreset').value = idx >= 0 ? String(idx) : 'custom';
  $('#vpDim').textContent = `${p.width} × ${p.height}`;
  $('#timeTotal').textContent = fmtTime(p.duration);
}

function syncHistoryButtons() {
  const h = historyInfo();
  const undoBtn = $('#btnUndo'), redoBtn = $('#btnRedo');
  undoBtn.disabled = !h.canUndo;
  redoBtn.disabled = !h.canRedo;
  undoBtn.title = h.canUndo ? `Undo ${h.undoLabel} (\u2318/Ctrl+Z)` : 'Nothing to undo';
  redoBtn.title = h.canRedo ? `Redo ${h.redoLabel} (\u2318/Ctrl+\u21e7Z)` : 'Nothing to redo';
}

// ══ structure (guides) ═══════════════════════════════════════
function buildStructure() {
  $('#btnBalance').addEventListener('click', () => {
    for (const key of LEVEL_KEYS) rebalanceGuides(level(key));
    commitGuides();
    toast('Both levels reset to the default weighting');
  });
  $('#btnFitBars').addEventListener('click', fitToMusic);
  $('#tSnapGuides').addEventListener('change', e => { state.ui.snapGuides = e.target.checked; });
}

/** Overall lines land on bars; the animation arc is finer, so it lands on beats. */
function fitToMusic() {
  const a = state.audio;
  if (!a.times.length) { toast('No beat grid yet'); return; }
  const beats = beatTimes();
  const bars = barTimes();

  for (const key of LEVEL_KEYS) {
    const lv = level(key);
    const targets = key === 'overall' ? bars : beats;
    for (let i = 1; i < lv.guides.length; i++) {
      const t = nearest(targets, lv.guides[i].t, key === 'overall' ? 4 : 1.5);
      if (t !== null) lv.guides[i].t = t;
    }
    if (key === 'animation') {
      const s0 = nearest(bars, lv.start, 4);
      const e0 = nearest(bars, lv.end, 4);
      if (s0 !== null && e0 !== null && e0 > s0) { lv.start = s0; lv.end = e0; }
    }
    normalizeGuides(lv);
  }
  commitGuides();
  toast('Overall snapped to bars, animation to beats');
}

function renderPattern() {
  $('#patternChip').textContent = patternLabel(level('overall').repeats);
  const host = $('#levelPanels');
  host.replaceChildren();
  for (const key of LEVEL_KEYS) host.append(levelBlock(key));
}

function levelBlock(key) {
  const lv = level(key);
  const meta = LEVELS[key];
  const dur = state.project.duration;
  const overall = key === 'overall';

  const head = el('div', { class: 'flex items-center gap-2' },
    el('span', { class: 'text-[11px] font-semibold text-zinc-300' }, meta.cn),
    el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-600' }, meta.label),
    el('span', { class: 'flex-1' }),
    el('span', { class: 'chip' }, patternLabel(lv.repeats)),
    el('button', { class: 'btn btn-sq !w-6 !h-6 text-sm leading-none', title: 'Remove a 承轉 pair',
                   onClick: () => setRepeats(key, lv.repeats - 1) }, '−'),
    el('span', { class: 'text-xs font-mono text-zinc-300 w-4 text-center' }, lv.repeats),
    el('button', {
      class: 'btn btn-sq !w-6 !h-6 text-sm leading-none',
      title: 'Add a 承轉 pair inside the longest 承 — existing points stay put',
      onClick: () => { if (!setRepeats(key, lv.repeats + 1)) toast('No 承 region long enough to split'); }
    }, '+'));

  const row = el('div', { class: 'pp' });
  const handles = guideHandles(lv.guides);
  handles.forEach((i, k) => {
    const disp = guideDisplay(lv.guides, i);
    if (k > 0) row.append(el('div', { class: 'pp-link',
      style: { '--a': guideDisplay(lv.guides, handles[k - 1]).colors.at(-1), '--b': disp.colors[0] } }));
    const on = selectedGuideIds(key).includes(lv.guides[i].id);
    row.append(el('div', {
      class: 'pp-node' + (disp.combined ? ' pp-wide' : '') + (overall ? '' : ' pp-small') + (on ? ' is-active' : ''),
      style: disp.combined
        ? { '--role': disp.colors[0], background: `linear-gradient(90deg, ${disp.colors[0]} 50%, ${disp.colors[1]} 50%)` }
        : { '--role': disp.colors[0] },
      title: `${disp.label} · ${lv.guides[i].t.toFixed(2)}s`,
      onClick: e => pickGuide(e, key, lv.guides[i].id)
    }, disp.label));
  });

  const span = overall
    ? el('div', { class: 'text-[9px] font-mono text-zinc-600' }, `0.00 → ${dur.toFixed(2)}s · whole video`)
    : el('div', { class: 'flex items-center gap-1.5' },
        el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, 'span'),
        numInput(lv.start, 0, dur, v => setLevelSpan(key, v, lv.end)),
        el('span', { class: 'text-zinc-700 text-[10px]' }, '→'),
        numInput(lv.end, 0, dur, v => setLevelSpan(key, lv.start, v)),
        el('button', { class: 'btn !px-1.5 !py-0.5 !text-[9px]', title: 'Span the whole video',
                       onClick: () => setLevelSpan(key, 0, dur) }, 'full'));

  return el('div', { class: 'rounded-md border border-line bg-base-900 p-2 space-y-1.5' },
    head,
    el('div', { class: 'overflow-x-auto scroll-thin' }, row),
    span,
    guideRows(key));
}

/** Click behaviour shared by the pattern nodes and the guide rows. */
function pickGuide(e, key, id) {
  selectGuide(key, id, (e.metaKey || e.ctrlKey) ? 'toggle' : e.shiftKey ? 'range' : 'set');
}

function numInput(value, min, max, onChange) {
  return el('input', {
    type: 'number', step: '0.05', min, max, value: round(value, 2),
    class: 'inp !w-16 !py-0.5 !text-[10px] font-mono text-center',
    onChange: e => onChange(clamp(+e.target.value || 0, min, max))
  });
}

function setLevelSpan(key, start, end) {
  if (end - start < 0.5) { toast('Span is too short'); return; }
  reframe(key, start, end);
  app.timeline.draw();
}

function guideRows(key) {
  const lv = level(key);
  const wrap = el('div', { class: 'space-y-1' });
  guideHandles(lv.guides).forEach(i => {
    const disp = guideDisplay(lv.guides, i);
    const on = selectedGuideIds(key).includes(lv.guides[i].id);
    const end = lv.guides[i + 1]?.t ?? lv.end;
    wrap.append(el('div', {
      class: 'stage-row !py-1' + (on ? ' is-active' : ''),
      style: { '--role': disp.colors.at(-1) },
      title: '⌘-click to add · ⇧-click to extend',
      onClick: e => pickGuide(e, key, lv.guides[i].id)
    },
      el('span', {
        class: 'dot !w-[16px] !h-[16px] !text-[9px]' + (disp.combined ? ' dot-wide' : ''),
        style: disp.combined
          ? { background: `linear-gradient(90deg, ${disp.colors[0]} 50%, ${disp.colors[1]} 50%)` } : {}
      }, disp.label),
      el('span', { class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-400 font-mono' },
        `${lv.guides[i].t.toFixed(2)}s`),
      el('span', { class: 'text-[9px] font-mono text-zinc-600 shrink-0' }, `${(end - lv.guides[i].t).toFixed(1)}s`)
    ));
  });
  return wrap;
}

// ══ layers (clips) ═══════════════════════════════════════════
function buildLayers() {
  $('#btnAddClip').addEventListener('click', () => {
    const t = state.ui.time;
    const region = drivingRegion(state.project.levels, t);
    const end = Math.min(state.project.duration, Math.max(t + MIN_CLIP, Math.min(region.end || t + 4, t + 4)));
    addClip(t, end, firstFreeTrack(t, end));
  });
  $('#btnDupClip').addEventListener('click', () => {
    const c = selectedClip();
    if (!c) { toast('Select a layer first'); return; }
    duplicateClip(c.id);
  });
  $('#btnCopyClip').addEventListener('click', copySelectedClipToClipboard);
  $('#btnPasteClip').addEventListener('click', pasteClipFromClipboard);
}

function clipboardText(data) {
  return JSON.stringify(data);
}

function isEditableTarget(target) {
  const tag = target?.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' ||
    (tag === 'INPUT' && target.type !== 'range') || target?.isContentEditable;
}

function canHandleClipboardEvent(event) {
  if (isEditableTarget(event.target)) return false;
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed;
}

function rememberSelectedClip() {
  const c = selectedClip();
  if (!c) {
    toast('Select a layer first');
    return null;
  }
  clipClipboard = copyClipData(c.id, state.ui.time);
  return clipClipboard;
}

async function copySelectedClipToClipboard() {
  const data = rememberSelectedClip();
  if (!data) return false;
  const text = clipboardText(data);
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // The in-memory payload still makes copy/paste work when clipboard access
    // is unavailable (for example, when the app is opened without HTTPS).
  }
  toast('Layer copied');
  return true;
}

function parseClipClipboard(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data?.format === CLIPBOARD_FORMAT && data.clip ? data : null;
  } catch {
    return null;
  }
}

function pasteClipData(data) {
  const clip = pasteClip(data, state.ui.time);
  if (!clip) return false;
  app.timeline.draw();
  toast('Layer pasted at playhead');
  return true;
}

async function pasteClipFromClipboard() {
  let data = null;
  try {
    const text = await navigator.clipboard?.readText();
    data = parseClipClipboard(text);
  } catch {
    // Fall back to the last in-app copy below.
  }
  if (!data) data = clipClipboard;
  if (!data) {
    toast('Copy a layer first');
    return false;
  }
  return pasteClipData(data);
}

function handleClipCopyEvent(event) {
  if (!canHandleClipboardEvent(event)) return;
  const data = rememberSelectedClip();
  if (!data) return;
  event.clipboardData?.setData('text/plain', clipboardText(data));
  event.preventDefault();
  toast('Layer copied');
}

function handleClipPasteEvent(event) {
  if (!canHandleClipboardEvent(event)) return;
  const text = event.clipboardData?.getData('text/plain');
  const data = parseClipClipboard(text) ?? (!text ? clipClipboard : null);
  if (!data) return;
  event.preventDefault();
  pasteClipData(data);
}

function firstFreeTrack(start, end) {
  for (let tr = 0; tr < TRACKS; tr++) {
    if (!clips().some(c => c.track === tr && c.start < end && c.end > start)) return tr;
  }
  return 0;
}

/** Padlock icon drawn in the current text colour (an emoji would ignore it). */
function lockGlyph(locked) {
  const span = el('span', { class: 'inline-block align-middle' });
  span.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linecap="round">' +
    '<rect x="2.5" y="5.5" width="7" height="5" rx="1.2" ' +
    (locked ? 'fill="currentColor" stroke="none"/>' : '/>') +
    (locked ? '<path d="M4.3 5.5V4a1.7 1.7 0 0 1 3.4 0v1.5"/>'
            : '<path d="M4.3 5.5V4a1.7 1.7 0 0 1 3.4 0"/>') +
    '</svg>';
  return span;
}

function renderClipList() {
  const host = $('#clipList');
  host.replaceChildren();
  const list = clips();
  const picked = new Set(selectedClipIds());
  $('#clipChip').textContent = picked.size > 1
    ? `${picked.size} of ${list.length}`
    : `${list.length} layer${list.length === 1 ? '' : 's'}`;

  clipsInOrder().forEach(c => {
    const role = ROLES[drivingRegion(state.project.levels, c.start).role];
    const on = picked.has(c.id);
    const primary = state.ui.sel?.type === 'clip' && state.ui.sel.id === c.id;
    host.append(el('div', {
      class: 'stage-row' + (on ? ' is-active' : '') + (on && !primary ? ' opacity-80' : ''),
      style: { '--role': role.color },
      // ⌘/ctrl adds one layer, ⇧ extends the run — the same gestures a file
      // list uses, so a group can be built here as well as on the timeline.
      onClick: e => selectClip(c.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'set')
    },
      el('span', { class: 'w-1 h-5 rounded-full shrink-0', style: { background: role.color } }),
      el('span', { class: 'flex-1 min-w-0' },
        el('div', { class: 'truncate text-[11px] text-zinc-300 leading-tight' }, (c.text || '—').replace(/\n/g, ' ')),
        el('div', { class: 'text-[9px] font-mono text-zinc-600 leading-tight' },
          `T${c.track + 1} · ${c.start.toFixed(2)}–${c.end.toFixed(2)}s · ${stageSummary(c)}` +
          (c.locked ? ' · locked' : ''))),
      el('button', {
        class: 'btn btn-ghost !px-1 !py-0.5 shrink-0 ' +
               (c.locked ? 'text-sky-400' : 'text-zinc-700 hover:text-zinc-400'),
        title: c.locked ? 'Timing locked — click to unlock' : 'Lock this layer\u2019s timing',
        onClick: e => {
          e.stopPropagation();
          updateClip(c.id, { locked: !c.locked });
          app.timeline.draw();
          if (state.ui.sel?.type === 'clip' && state.ui.sel.id === c.id) buildInspector();
        }
      }, lockGlyph(c.locked)),
      el('button', {
        class: 'btn btn-ghost !px-1 !py-0.5 text-zinc-600 hover:text-red-400 shrink-0',
        title: 'Delete layer',
        onClick: e => { e.stopPropagation(); removeClip(c.id); }
      }, '✕')
    ));
  });
  if (!list.length) {
    host.append(el('p', { class: 'text-[10px] text-zinc-600 py-2 text-center' }, 'No layers yet.'));
  }
}

// ══ inspector ════════════════════════════════════════════════
let builtFor = '';

function buildInspector() {
  const host = $('#inspector');
  host.replaceChildren();
  const clip = selectedClip();
  const guide = selectedGuide();

  if (guide) {
    const picked = selectedGuideIndices(guide.level.key);
    if (picked.length > 1) buildRunInspector(host, guide.level, picked);
    else buildGuideInspector(host, guide);
    return;
  }
  if (!clip) {
    builtFor = '';
    $('#inspTitle').textContent = 'Layer';
    $('#inspChip').textContent = '–';
    host.append(el('p', { class: 'text-[11px] text-zinc-600 py-3 text-center leading-relaxed' },
      state.ui.sel?.type === 'camkey'
        ? 'Camera key selected — edit it in the Camera panel below.'
        : state.ui.sel?.type === 'camera'
          ? 'Camera track selected — select a key below to edit its framing.'
        : state.ui.sel?.type === 'guideTrack'
          ? `${LEVELS[state.ui.sel.level]?.label ?? 'Reference'} track selected — select a point below to edit its timing.`
        : state.ui.sel?.type === 'particle'
          ? 'Emitter selected — edit it in the Particles panel below.'
        : state.ui.sel?.type === 'particles'
          ? 'Particle track selected — select an emitter below to edit its settings.'
        : state.ui.sel?.type === 'audio' && !state.ui.sel.id
          ? `${TRACK_KINDS.find(meta => meta.kind === state.ui.sel.kind)?.label ?? 'Sound'} track selected — select a clip to edit its timing.`
        : state.ui.sel?.type === 'textTrack'
          ? `Text element track ${state.ui.sel.track + 1} selected — select a layer to edit it.`
        : state.ui.sel?.type === 'videoTrack'
          ? `${VIDEO_CHANNEL_KINDS.find(meta => meta.kind === state.ui.sel.kind)?.label ?? 'Backdrop video'} track selected.`
        : state.ui.sel?.type === 'backdrop'
          ? 'Backdrop colour track selected — select a key to edit its look.'
        : 'Select a layer on the timeline, or a 起承轉合 point to move a reference line.'));
    return;
  }

  const group = selectedClips();
  builtFor = inspectorKey(clip, group.length);
  const drive = drivingRegion(state.project.levels, clip.start);
  const role = ROLES[drive.role];
  const macro = regionAt(level('overall'), clip.start);
  const micro = regionAt(level('animation'), clip.start);
  $('#inspTitle').textContent = 'Layer';
  $('#inspChip').textContent = group.length > 1
    ? `${group.length} layers`
    : `T${clip.track + 1} · ${stageSummary(clip)}`;

  host.append(...[
    group.length > 1 ? el('div', { class: 'rounded-md border border-line bg-base-900 p-2 space-y-1.5' },
      el('div', { class: 'flex items-center justify-between' },
        el('span', { class: 'text-[11px] font-semibold text-zinc-200' }, `${group.length} layers selected`),
        el('button', {
          class: 'btn btn-ghost !px-1.5 !py-0.5 text-[10px]',
          title: 'Keep only the layer this inspector edits',
          onClick: () => { selectClip(clip.id, 'set'); app.timeline.draw(); }
        }, 'Clear')),
      el('p', { class: 'text-[10px] leading-snug text-zinc-500' },
        'Drag any one of them on the timeline to move the whole group; locked layers stay put. ',
        'The fields below edit ',
        el('span', { class: 'text-zinc-300' }, (clip.text || '—').replace(/\n/g, ' ').slice(0, 24)),
        ', the layer you picked last.'),
      el('div', { class: 'grid grid-cols-2 gap-1.5' },
        el('button', {
          class: 'btn', onClick: () => {
            const lock = !group.every(c => c.locked);
            for (const c of group) updateClip(c.id, { locked: lock });
            app.timeline.draw(); buildInspector();
          }
        }, group.every(c => c.locked) ? 'Unlock all' : 'Lock all'),
        el('button', {
          class: 'btn hover:!text-red-400', onClick: () => {
            for (const c of group) removeClip(c.id);
            app.timeline.draw();
          }
        }, `Delete ${group.length}`))) : null,

    el('div', { class: 'flex items-center gap-2 rounded-md border p-2',
                style: { borderColor: role.color + '44', background: role.color + '10' } },
      el('span', { class: 'w-6 h-6 rounded-full grid place-items-center text-xs font-bold shrink-0',
                   style: { background: role.color, color: '#08090c' } }, role.cn),
      el('div', { class: 'min-w-0 text-[10px] leading-snug text-zinc-500' },
        el('div', {},
          el('span', { class: 'text-zinc-400' }, '整體 '),
          el('span', { style: { color: macro ? ROLES[macro.role].color : '#52596a' } }, macro ? ROLES[macro.role].cn : '–'),
          el('span', { class: 'text-zinc-700' }, '  ·  '),
          el('span', { class: 'text-zinc-400' }, '動態 '),
          el('span', { style: { color: micro ? ROLES[micro.role].color : '#52596a' } }, micro ? ROLES[micro.role].cn : 'outside')),
        'default effect came from the finer phase.')),

    el('div', { class: 'grid grid-cols-3 gap-1.5 text-center' },
      box('inspStart', 'In'), box('inspLen', 'Length'), box('inspEnd', 'Out')),

    el('label', { class: 'tog',
                  title: 'Hold this layer\u2019s in/out points when the composition is rescaled, and stop it being dragged or trimmed on the timeline' },
      el('input', {
        id: 'inspLock', type: 'checkbox', class: 'accent-sky-500', checked: clip.locked === true,
        onChange: e => { updateClip(clip.id, { locked: e.target.checked }); app.timeline.draw(); }
      }), ' Lock timing'),

    field('Text', el('textarea', {
      class: 'inp resize-y min-h-[62px] leading-snug', rows: 2, spellcheck: 'false',
      onInput: e => { updateClip(clip.id, { text: e.target.value }); app.timeline.draw(); }
    }, clip.text)),

    stageEditor(clip, role.key),

    slider('Beat reaction', clip.beatReact, 0, 1, 0.01, v => updateClip(clip.id, { beatReact: v }),
           anyAudio() ? null : 'no audio yet'),

    ...typeSection(clip),

    field('Parent layer', el('div', { class: 'space-y-1.5' },
      el('select', {
        id: 'clipParent', class: 'sel',
        onChange: e => {
          setClipParent(clip.id, e.target.value || null);
          buildInspector();
          app.timeline.draw();
        }
      },
        el('option', { value: '', selected: !clip.parentId }, 'None · world position'),
        ...clipsInOrder()
          .filter(parent => parent.id !== clip.id && canSetClipParent(clip.id, parent.id))
          .map(parent => el('option', {
            value: parent.id, selected: clip.parentId === parent.id
          }, `${(parent.text || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Untitled'} · T${parent.track + 1}`))
      ),
      el('p', { class: 'text-[10px] leading-snug text-zinc-600' },
        clip.parentId
          ? 'This layer follows its parent. Position below is a local offset from that parent.'
          : 'Choose another text layer to make this one follow its position.'))),

    field(clip.parentId ? 'Offset position · scene units' : 'Position · scene units', el('div', { class: 'space-y-1.5' },
      positionFields(clip.position,
        pos => updateClip(clip.id, { position: { ...(clip.position ?? {}), ...pos } }), 'clipPos'),
      clip.parentId ? el('div', { id: 'clipWorldPos', class: 'text-[10px] text-zinc-600 font-mono' }) : null,
      el('button', {
        class: 'btn w-full',
        title: 'Place this text on the current camera frame',
        onClick: () => {
          alignClipWithCamera(clip.id);
          buildInspector();
        }
      }, 'Align with camera'))),

    field('Track', el('select', {
      class: 'sel', onChange: e => { updateClip(clip.id, { track: +e.target.value }); app.timeline.draw(); renderClipList(); }
    }, ...Array.from({ length: TRACKS }, (_, i) =>
      el('option', { value: i, selected: clip.track === i }, `Track ${i + 1}${i === 0 ? ' (front)' : ''}`)))),

    el('div', { class: 'grid grid-cols-2 gap-1.5 pt-1' },
      el('button', { class: 'btn', onClick: () => app.seek(clip.start) }, 'Go to in'),
      el('button', { class: 'btn', onClick: () => app.playRange(clip.start, clip.end) }, 'Preview')),
    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => duplicateClip(clip.id) }, 'Duplicate'),
      el('button', { class: 'btn hover:!text-red-400', onClick: () => removeClip(clip.id) }, 'Delete'))
  ].filter(Boolean));
  syncInspector();
}

function buildGuideInspector(host, sel) {
  const { guide, level: lv } = sel;
  const meta = LEVELS[lv.key];
  const gs = lv.guides;
  const i = gs.indexOf(guide);
  const disp = guideDisplay(gs, i);
  const end = gs[i + 1]?.t ?? lv.end;
  builtFor = 'guide:' + guide.id;
  $('#inspTitle').textContent = 'Reference line';
  $('#inspChip').textContent = `${meta.cn} · ${disp.label}`;

  const note = disp.combined
    ? `${ROLES.qi.note} Dragging this one control sets where 起 ends and 承 begins.`
    : ROLES[guide.role].note;

  host.append(
    el('div', { class: 'flex items-start gap-2 rounded-md border p-2',
                style: { borderColor: disp.colors.at(-1) + '55', background: disp.colors.at(-1) + '12' } },
      el('div', { class: 'h-7 px-2 rounded-full grid place-items-center text-sm font-bold shrink-0',
                  style: { background: disp.combined
                    ? `linear-gradient(90deg, ${disp.colors[0]} 50%, ${disp.colors[1]} 50%)` : disp.colors[0],
                    color: '#08090c' } }, disp.label),
      el('div', { class: 'min-w-0' },
        el('div', { class: 'text-xs font-semibold text-zinc-200' }, `${meta.cn} ${meta.label}`),
        el('div', { class: 'text-[10px] leading-snug text-zinc-500' }, note))),

    el('div', { class: 'grid grid-cols-2 gap-1.5 text-center' },
      box('gAt', 'At'), box('gLen', 'Region')),

    field('Position (s)', el('input', {
      id: 'gPos', type: 'number', step: '0.01', min: lv.start, max: lv.end, value: round(guide.t, 2),
      class: 'inp font-mono',
      onChange: e => {
        guide.t = clamp(+e.target.value || 0, lv.start, lv.end);
        commitGuides(lv.key); app.timeline.draw(); buildInspector();
      }
    })),

    el('p', { class: 'text-[10px] leading-relaxed text-zinc-600' },
      meta.desc, ' Nothing renders from it — layers simply snap to it.'),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => app.seek(guide.t) }, 'Go to'),
      el('button', { class: 'btn', onClick: () => {
        addClip(guide.t, Math.min(end, guide.t + 4), 0);
        app.timeline.draw();
        toast(`Layer added at ${disp.label}`);
      } }, 'Add layer here'))
  );
  syncInspector();
}

/** Inspector for a run of selected reference lines. */
function buildRunInspector(host, lv, picked) {
  const meta = LEVELS[lv.key];
  const i0 = picked[0], i1 = picked.at(-1);
  const from = lv.guides[i0].t, to = lv.guides[i1].t;
  builtFor = 'run:' + lv.key + ':' + picked.join(',') + ':' + runPivotIndex(lv.key);
  $('#inspTitle').textContent = 'Reference lines';
  $('#inspChip').textContent = `${meta.cn} · ${picked.length} points`;

  const labels = picked.map(i => guideDisplay(lv.guides, i));
  const pivotIdx = runPivotIndex(lv.key);

  const parts = [
    el('div', { class: 'rounded-md border border-line bg-base-900 p-2 space-y-1.5' },
      el('div', { class: 'flex flex-wrap gap-1' },
        ...labels.map((d, k) => el('span', {
          class: 'px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition' +
                 (picked[k] === pivotIdx ? ' ring-1 ring-zinc-200' : ''),
          style: { background: d.colors.at(-1) + '22', color: d.colors.at(-1) },
          title: picked[k] === pivotIdx ? 'The centre — click to release' : 'Make this the centre',
          onClick: () => { setRunPivot(lv.guides[picked[k]].id); app.timeline.draw(); buildInspector(); }
        }, d.label))),
      el('p', { class: 'text-[10px] leading-snug text-zinc-500' },
        pivotIdx >= 0
          ? 'Dragging either end now resizes the run around the centre — both sides move. Click the centre again to release it.'
          : 'Drag either end to rescale from the far end; drag one in the middle to slide the run. Click a point to make it the centre.',
        ' Points outside the run stay put.')),

    el('div', { class: 'grid grid-cols-3 gap-1.5 text-center' },
      box('runFrom', 'From'), box('runLen', 'Span'), box('runTo', 'To')),

    field('Span length (s)', el('input', {
      id: 'runSpan', type: 'number', step: '0.05', min: 0.1, value: round(to - from, 2),
      class: 'inp font-mono',
      onChange: e => {
        const want = clamp(+e.target.value || 0.1, 0.1, lv.end - from);
        scaleRange(lv, lv.guides.map(g => g.t), i0, i1, i1, from + want);
        commitGuides(lv.key);
        app.timeline.draw();
        buildInspector();
      }
    })),

    pivotIdx >= 0
      ? el('div', { class: 'flex items-center gap-1.5 rounded-md border border-line bg-base-900 px-2 py-1.5' },
          el('span', { class: 'text-[10px] text-zinc-500 flex-1' },
            'Centre: ', el('b', { class: 'text-zinc-200' }, guideDisplay(lv.guides, pivotIdx).label),
            ` at ${lv.guides[pivotIdx].t.toFixed(2)}s`),
          el('button', {
            class: 'btn !px-2 !py-0.5 !text-[10px]',
            onClick: () => { setRunPivot(lv.guides[pivotIdx].id); app.timeline.draw(); buildInspector(); }
          }, 'Release'))
      : null,

    field('Distribution', el('div', { class: 'space-y-1.5' },
      (() => {
        const mode = el('select', {
          class: 'sel', title: 'Choose how the selected points are spaced',
          'aria-label': 'Distribution shape'
        }, ...Object.entries(DISTRIBUTIONS).map(([id, d]) =>
          el('option', { value: id }, d.label)));
        const hint = el('p', { class: 'text-[10px] leading-snug text-zinc-600' },
          DISTRIBUTIONS[mode.value].description);
        mode.addEventListener('change', () => {
          hint.textContent = DISTRIBUTIONS[mode.value].description;
        });
        return el('div', { class: 'space-y-1.5' },
          el('div', { class: 'flex gap-1.5' },
            mode,
            el('button', {
              class: 'btn shrink-0', title: 'Apply the selected distribution',
              onClick: () => {
                const d = DISTRIBUTIONS[mode.value] ?? DISTRIBUTIONS.even;
                if (distributeRange(lv, i0, i1, mode.value)) {
                  commitGuides(lv.key); app.timeline.draw(); buildInspector();
                  toast(`${d.label} distribution applied`);
                } else toast('Not enough span for that distribution');
              }
            }, 'Apply')),
          hint);
      })())),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => select(null, null) }, 'Clear selection')),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => app.seek(from) }, 'Go to start'),
      el('button', { class: 'btn', onClick: () => app.playRange(from, to) }, 'Preview run'))
  ];
  host.append(...parts.filter(Boolean));
  syncInspector();
}

function groupedEffectOptions(selected, roleKey) {
  const mine = effectsForRole(roleKey);
  const rest = effectIds().filter(id => !mine.includes(id));
  const opt = id => el('option', { value: id, selected: selected === id }, EFFECTS[id].label);
  return [
    el('optgroup', { label: `Suited to ${ROLES[roleKey].cn}` }, ...mine.map(opt)),
    el('optgroup', { label: 'Other' }, ...rest.map(opt))
  ];
}

const STAGE_LABELS = { in: 'In', mid: 'Mid', out: 'Out' };
const stageLabel = (clip, key) => EFFECTS[clipStage(clip, key).effect]?.label ?? clipStage(clip, key).effect;

/** The layer's three effects, collapsed to one name when they all agree. */
// ══ text style ═══════════════════════════════════════════════
//
// The stage holds one text style; a layer takes it whole and overrides only
// what it sets. Each field therefore says where its value came from: "stage"
// while inherited, and a ⟲ that hands it back once the layer has its own.

const STYLE_LABEL = {
  font: 'Typeface', color: 'Colour', size: 'Size',
  lineHeight: 'Line height', tracking: 'Letter spacing', align: 'Align'
};

const ALIGNMENTS = ['left', 'center', 'right'];

/** Typeface options: the loaded slots, optionally led by "from the stage". */
function fontOptions(selected, inherit = null) {
  const opts = inherit === null ? [] : [
    el('option', { value: '', selected: selected === null },
       `From stage · ${trim(state.fonts[inherit]?.name ?? '— none —', 18)}`)
  ];
  state.fonts.forEach((f, i) => opts.push(el('option', { value: i, selected: selected === i },
    `${i + 1} · ${f ? trim(f.name, 22) : '— empty —'}`)));
  return opts;
}

const FONT_WEIGHT_LABELS = {
  100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'Semi bold', 700: 'Bold', 800: 'Extra bold', 900: 'Black'
};

const fontWeightLabel = weight => FONT_WEIGHT_LABELS[weight] ?? 'Custom';

/** Families offered by the built-in catalogue plus decoded local faces. */
function fontFamilyRecords() {
  const records = new Map();
  for (const preset of FONT_PRESETS) {
    if (!records.has(preset.family)) records.set(preset.family, { family: preset.family, label: preset.family });
  }
  for (const entry of fontAssets()) {
    if (!records.has(entry.family)) records.set(entry.family, { family: entry.family, label: entry.family });
  }
  return [...records.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Real weights available for a family; outlines cannot synthesize a missing one. */
function fontWeightRecords(family) {
  const records = new Map();
  for (const preset of FONT_PRESETS) {
    if (preset.family === family) records.set(preset.weight, { weight: preset.weight });
  }
  for (const entry of fontAssets()) {
    if (entry.family === family) records.set(entry.weight, { weight: entry.weight });
  }
  return [...records.values()].sort((a, b) => a.weight - b.weight);
}

function layerFontFamilyOptions(clip) {
  const family = String(clip.fontFamily ?? '').trim();
  const stageOverride = !family && overridesStyle(clip, 'font');
  const families = fontFamilyRecords();
  if (family && !families.some(item => item.family === family)) {
    families.unshift({ family, label: `${family} (unavailable)` });
  }
  return [
    el('option', {
      value: '', selected: !family && !stageOverride
    }, `From stage · ${trim(state.fonts[stageStyle(state.project).font]?.name ?? 'fallback stack', 22)}`),
    el('optgroup', { label: 'Stage fallback lead' },
      ...state.fonts.map((entry, i) => el('option', {
        value: `slot:${i}`, selected: !family && stageOverride && Number(clip.font) === i
      }, `${i + 1} · ${entry ? trim(entry.name, 22) : '— empty —'}`))),
    el('optgroup', { label: 'Layer face' },
      ...families.map(item => el('option', {
        value: `face:${item.family}`, selected: family === item.family
      }, item.label)))
  ];
}

function layerFontWeightOptions(clip) {
  const family = String(clip.fontFamily ?? '').trim();
  const selected = Number(clip.fontWeight);
  const records = fontWeightRecords(family);
  if (family && Number.isFinite(selected) && !records.some(item => item.weight === selected)) {
    records.push({ weight: selected, unavailable: true });
    records.sort((a, b) => a.weight - b.weight);
  }
  return records.length
    ? records.map(item => el('option', {
        value: item.weight, selected: item.weight === selected
      }, `${item.weight} · ${fontWeightLabel(item.weight)}${item.unavailable ? ' · unavailable' : ''}`))
    : [el('option', { value: '', selected: true }, '— unavailable —')];
}

function presetForFont(family, weight) {
  return FONT_PRESETS.find(item => item.family === family && item.weight === Number(weight)) ?? null;
}

function layerFontSection(clip, tags) {
  const family = String(clip.fontFamily ?? '').trim();
  const fontTag = family
    ? el('button', {
        class: 'ml-1 px-1 rounded text-sky-400 hover:bg-base-600 normal-case',
        title: 'Back to the stage typeface',
        onClick: () => { resetClipStyle(clip.id, 'font'); buildInspector(); app.timeline.draw(); }
      }, '⟲')
    : tags.font?.node;

  const chooseFamily = value => {
    if (!value) {
      setClipFont(clip.id, { family: null, weight: null, stageSlot: null });
    } else if (value.startsWith('slot:')) {
      setClipFont(clip.id, {
        family: null, weight: null, stageSlot: Number(value.slice(5))
      });
    } else {
      const nextFamily = value.slice(5);
      const weights = fontWeightRecords(nextFamily).map(item => item.weight);
      const current = Number(clip.fontWeight);
      const nextWeight = weights.includes(current) ? current : weights[0];
      const preset = presetForFont(nextFamily, nextWeight);
      if (preset) app.loadClipFontPreset(clip.id, preset);
      else setClipFont(clip.id, {
        family: nextFamily, weight: nextWeight, stageSlot: null
      });
    }
    app.timeline.draw();
  };

  const chooseWeight = value => {
    const weight = Number(value);
    const preset = presetForFont(family, weight);
    if (preset) app.loadClipFontPreset(clip.id, preset);
    else setClipFont(clip.id, { family, weight, stageSlot: null });
    app.timeline.draw();
  };

  const loadLocal = () => {
    const input = $('#fontFile');
    input.dataset.target = 'clip';
    input.dataset.clipId = clip.id;
    input.click();
  };

  return el('div', { class: 'space-y-1.5' },
    el('span', { class: 'lbl flex items-center' }, 'Typeface', fontTag),
    el('div', { class: 'grid grid-cols-[minmax(0,1fr)_5.5rem_auto] gap-1.5' },
      el('select', {
        class: 'sel min-w-0', title: 'Typeface for this text layer',
        onChange: e => chooseFamily(e.target.value)
      }, ...layerFontFamilyOptions(clip)),
      el('select', {
        class: 'sel !px-1', title: 'Real font weight for this text layer',
        disabled: !family,
        onChange: e => chooseWeight(e.target.value)
      }, ...layerFontWeightOptions(clip)),
      el('button', {
        class: 'btn btn-sq', title: 'Load a font file for this layer only',
        onClick: loadLocal
      }, '⤒')),
    el('p', { class: 'text-[10px] leading-relaxed text-zinc-600' },
      family
        ? 'The layer face leads; stage faces fill any missing glyphs.'
        : 'Inherited from the stage fallback stack.'));
}

/** The label suffix that says where a field's value comes from. */
function styleTag(clip, key, onRevert) {
  const host = el('span', { class: 'ml-1 normal-case shrink-0' });
  const paint = () => host.replaceChildren(
    overridesStyle(clip, key)
      ? el('button', {
          class: 'px-1 rounded text-sky-400 hover:bg-base-600',
          title: `Back to the stage ${STYLE_LABEL[key].toLowerCase()}`,
          onClick: onRevert
        }, '⟲')
      : el('span', { class: 'text-zinc-700', title: 'Taken from the stage text style' }, 'stage'));
  paint();
  return { node: host, paint };
}

/** The colour keys that live inside the selected text block. */
function colorKeySection(clip) {
  const keys = clipColorKeys(clip);
  const selected = selectedClipColorKey();
  const active = selected && state.ui.sel?.id === clip.id ? selected : null;
  const inside = state.ui.time >= clip.start - 1e-6 && state.ui.time <= clip.end + 1e-6;
  const keyList = el('div', { class: 'space-y-1' });

  if (!keys.length) {
    keyList.append(el('p', { class: 'text-[10px] text-zinc-600' },
      'No colour keys yet — double-click inside the block or add one at the playhead.'));
  } else {
    keys.forEach((key, index) => {
      const isActive = active?.id === key.id;
      const row = el('div', {
        class: 'flex items-center gap-1 rounded border px-1.5 py-1 ' +
          (isActive ? 'border-zinc-300/60 bg-base-600' : 'border-line bg-base-900'),
        onClick: () => selectClipColorKey(clip.id, key.id)
      },
        el('span', {
          id: `clipColorKeySwatch_${key.id}`,
          class: 'w-3 h-3 rotate-45 shrink-0 border border-black/60',
          style: { background: key.color },
          title: `Colour key ${index + 1}`
        }),
        el('input', {
          id: `clipColorKeyTime_${key.id}`,
          type: 'number', step: '0.05', min: 0, max: Math.max(0, clip.end - clip.start),
          value: round(key.t, 2), title: 'Time inside this layer',
          class: 'inp !w-[70px] !py-0.5 !text-[10px] font-mono text-center',
          onClick: e => e.stopPropagation(),
          onChange: e => {
            updateClipColorKey(clip.id, key.id, { t: +e.target.value || 0 });
            e.target.blur();
            app.timeline.draw();
          }
        }),
        el('span', { class: 'text-[9px] text-zinc-600' }, 's'),
        el('span', {
          id: `clipColorKeyLabel_${key.id}`,
          class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-500'
        },
          isActive ? `Key ${index + 1} · selected` : `Key ${index + 1}`),
        el('select', {
          class: 'sel !w-[76px] !py-0.5 !text-[10px]', title: 'Easing out of this colour key',
          onClick: e => e.stopPropagation(),
          onChange: e => updateClipColorKey(clip.id, key.id, { ease: e.target.value })
        }, ...Object.entries(EASES).map(([id, ease]) =>
          el('option', { value: id, selected: key.ease === id }, ease.label))),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Delete this colour key',
          onClick: e => { e.stopPropagation(); removeClipColorKey(clip.id, key.id); app.timeline.draw(); }
        }, '✕')
      );
      keyList.append(row);
    });
  }

  return el('div', { class: 'rounded-md border border-line bg-base-900 p-1.5 space-y-1.5' },
    el('div', { class: 'flex items-center gap-1.5' },
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500 flex-1' }, 'Colour animation'),
      el('span', { class: 'chip' }, `${keys.length} key${keys.length === 1 ? '' : 's'}`),
      el('button', {
        id: 'btnClipColorKey',
        class: 'btn !px-1.5 !py-1 !text-[10px]', disabled: !inside,
        title: inside ? 'Add or select a colour key at the playhead' : 'Move the playhead inside this layer first',
        onClick: () => { addClipColorKey(clip.id, state.ui.time); app.timeline.draw(); }
      }, '+ Keyframe'),
      active ? el('button', {
        class: 'btn !px-1.5 !py-1 !text-[10px]', title: 'Edit the layer base colour instead of the selected key',
        onClick: () => { selectClip(clip.id, 'set'); app.timeline.draw(); }
      }, 'Edit base') : null
    ),
    keyList
  );
}

/** Typeface, colour and the type settings, each inherited until it is touched. */
function typeSection(clip) {
  const style = clipStyle(clip, state.project);
  const selected = selectedClipColorKey();
  const key = selected && state.ui.sel?.id === clip.id ? selected : null;
  const tags = {};
  const revert = key => {
    resetClipStyle(clip.id, key);
    buildInspector();
    app.timeline.draw();
  };
  const tag = key => {
    const t = styleTag(clip, key, () => revert(key));
    tags[key] = t;
    return t.node;
  };
  // Keep the existing stage-slot override indicator for legacy layer settings;
  // a layer-local face replaces it with its own reset control below.
  tag('font');
  // Setting a field is what claims it from the stage, so the tag follows the
  // edit without rebuilding the panel under the pointer.
  const set = (key, value) => { updateClip(clip.id, { [key]: value }); tags[key]?.paint(); };
  const row = (key, control) => el('div', {},
    el('span', { class: 'lbl flex items-center' }, STYLE_LABEL[key], tag(key)), control);
  const colorRow = el('div', {},
    el('span', { class: 'lbl flex items-center' },
      STYLE_LABEL.color,
      key
        ? el('span', { class: 'ml-1 normal-case text-sky-400' },
            `key ${clipColorKeys(clip).findIndex(item => item.id === key.id) + 1}`)
        : tag('color')),
    el('input', {
      type: 'color', value: key?.color ?? style.color,
      class: 'w-full h-8 bg-base-900 border border-line rounded cursor-pointer',
      onInput: e => key
        ? updateClipColorKey(clip.id, key.id, { color: e.target.value })
        : set('color', e.target.value)
    }));

  return [
    el('div', { class: 'flex items-center justify-between pt-1' },
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500' }, 'Type'),
      el('button', {
        class: 'btn btn-ghost !px-1.5 !py-0.5 text-[10px]',
        title: 'Hand every type setting on this layer back to the stage',
        onClick: () => { resetClipStyle(clip.id); buildInspector(); app.timeline.draw(); }
      }, 'All from stage')),

    layerFontSection(clip, tags),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      colorRow,
      row('align', el('select', { class: 'sel', onChange: e => set('align', e.target.value) },
        ...ALIGNMENTS.map(a =>
          el('option', { value: a, selected: style.align === a }, a[0].toUpperCase() + a.slice(1)))))),

    colorKeySection(clip),

    slider('Size', style.size, 0.03, 0.9, 0.005, v => set('size', v), 'of short edge', tag('size')),
    slider('Line height', style.lineHeight, 0.6, 2.4, 0.01, v => set('lineHeight', v), null, tag('lineHeight')),
    slider('Letter spacing', style.tracking, -0.3, 1, 0.005, v => set('tracking', v), null, tag('tracking'))
  ];
}

/** The stage's own text style — what every layer starts from. */
function renderStageText() {
  const host = $('#stageText');
  if (!host || holdsFocus(host)) return;      // a slider here is being driven
  host.replaceChildren();
  const s = stageStyle(state.project);
  // A select replaces its own options, so those rebuild the panel; the colour
  // swatch and the sliders write straight through and stay under the pointer.
  const pick = props => { setTextStyle(props); renderStageText(); };

  host.append(
    el('div', { class: 'flex items-center justify-between' },
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500' }, 'Stage text'),
      el('span', { class: 'chip' }, 'every layer inherits')),

    field('Typeface', el('select', { class: 'sel', onChange: e => pick({ font: +e.target.value }) },
      ...fontOptions(s.font))),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      field('Colour', el('input', {
        type: 'color', value: s.color,
        class: 'w-full h-8 bg-base-900 border border-line rounded cursor-pointer',
        onInput: e => setTextStyle({ color: e.target.value })
      })),
      field('Align', el('select', { class: 'sel', onChange: e => pick({ align: e.target.value }) },
        ...ALIGNMENTS.map(a =>
          el('option', { value: a, selected: s.align === a }, a[0].toUpperCase() + a.slice(1)))))),

    slider('Size', s.size, 0.03, 0.9, 0.005, v => setTextStyle({ size: v }), 'of short edge'),
    slider('Line height', s.lineHeight, 0.6, 2.4, 0.01, v => setTextStyle({ lineHeight: v })),
    slider('Letter spacing', s.tracking, -0.3, 1, 0.005, v => setTextStyle({ tracking: v })),

    el('p', { class: 'text-[10px] leading-relaxed text-zinc-600' },
      'A layer follows these until you change the same setting on the layer itself; ',
      'its inspector marks what it has taken over.')
  );
}

const stageSummary = clip =>
  [...new Set(STAGE_KEYS.map(key => stageLabel(clip, key)))].join(' › ');

/** Rebuilding the panel is only needed when the controls themselves change. */
const inspectorKey = (clip, groupSize) =>
  'clip:' + clip.id + '|' + STAGE_KEYS.map(key => clipStage(clip, key).effect).join(',') +
  '|' + groupSize +
  '|font:' + (clip.fontFamily ?? '') + ':' + (clip.fontWeight ?? '') + ':' + (clip.font ?? '') +
  '|parent:' + (clip.parentId ?? '') +
  '|colorKeys:' + clipColorKeys(clip).map(key => key.id).join(',') +
  '|colorKey:' + (state.ui.sel?.colorKeyId ?? '') +
  // Inherited fields show the stage's values, so a change there redraws them.
  '|' + TEXT_STYLE_KEYS.map(key => stageStyle(state.project)[key]).join(',');

/**
 * In · mid · out: one effect each, over one slice of the layer each. Only in
 * and out carry a length — mid is the remainder, and reads back as one — which
 * is the same rule the two handles on the timeline block follow.
 */
function stageEditor(clip, roleKey) {
  const len = Math.max(0, clip.end - clip.start);
  return el('div', { class: 'space-y-1.5' },
    el('span', { class: 'lbl' }, 'Effects · in › mid › out'),
    ...stageWindows(clip).map(w => {
      const stage = clipStage(clip, w.key);
      return el('div', { class: 'rounded-md border border-line bg-base-900 p-1.5 space-y-1' },
        el('div', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500 w-6 shrink-0' },
             STAGE_LABELS[w.key]),
          el('select', {
            class: 'sel !py-0.5 !text-[10px] flex-1 min-w-0',
            title: `Effect played over the ${w.key} stage`,
            onChange: e => setClipStage(clip.id, w.key, { effect: e.target.value })
          }, ...groupedEffectOptions(stage.effect, roleKey)),
          w.key === 'mid'
            ? el('div', {
                id: 'stageDurMid',
                class: 'w-14 shrink-0 text-center text-[10px] font-mono text-zinc-500',
                title: 'Whatever the in and out stages leave'
              }, `${w.dur.toFixed(2)}s`)
            : el('input', {
                id: 'stageDur' + STAGE_LABELS[w.key],
                type: 'number', min: 0, max: round(len, 2), step: '0.05',
                value: round(w.dur, 2),
                class: 'inp !w-14 !py-0.5 !text-[10px] font-mono text-center',
                title: `How long the ${w.key} stage runs, in seconds`,
                onChange: e => setStageDuration(clip.id, w.key, +e.target.value || 0)
              })),
        ...stageParamSliders(clip, w.key, stage));
    }));
}

function stageParamSliders(clip, key, stage) {
  const def = EFFECTS[stage.effect] ?? EFFECTS.hold;
  const p = resolveParams(stage.effect, stage.params);
  return def.params.map(pm =>
    slider(pm.label, p[pm.key], pm.min, pm.max, pm.step, v =>
      setClipStage(clip.id, key, { params: { ...(clip.stages?.[key]?.params ?? {}), [pm.key]: v } })));
}

function box(id, label) {
  return el('div', { class: 'rounded-md bg-base-900 border border-line py-1.5' },
    el('div', { id, class: 'text-[11px] font-semibold text-zinc-200 font-mono' }, '–'),
    el('div', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, label));
}

function field(label, node) {
  return el('div', {}, el('span', { class: 'lbl' }, label), node);
}

/**
 * Tie a slider to an editable readout, so a value can be dragged for feel or
 * typed when the step would never land on it.
 *
 * The slider remains live, while the number readout buffers typed digits until
 * the edit finishes. Updating the model on every input would make the first
 * digit of a multi-digit value (the "1" of "15", for example) take effect
 * immediately and can rebuild the properties panel under the cursor. Enter
 * commits, Esc goes back to the value the field was entered with. The range
 * must already hold the current value.
 */
function linkRange(range, num, onChange) {
  const lo = Number(range.min), hi = Number(range.max);
  // Follow the step's own precision, so a typed value survives being reread.
  const dec = Math.min(3, (String(range.step).split('.')[1] ?? '').length);
  const fmt = v => Number(v).toFixed(dec);
  for (const key of ['min', 'max', 'step']) num.setAttribute(key, range.getAttribute(key));
  num.title = `${fmt(lo)} – ${fmt(hi)}`;
  num.value = fmt(range.value);

  const apply = (v, rewrite) => {
    const next = clamp(v, lo, hi);
    range.value = next;
    if (rewrite) num.value = fmt(next);
    onChange(next);
  };

  let entry = Number(range.value);        // what Esc goes back to
  range.addEventListener('input', e => { const v = +e.target.value; num.value = fmt(v); onChange(v); });
  num.addEventListener('focus', e => { entry = +range.value; e.target.select(); });
  num.addEventListener('input', e => {
    // Keep the paired slider visually in sync without touching the model. A
    // typed value like "15" must survive the first "1" input event intact.
    const raw = e.target.value.trim();
    const v = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(v) && v >= lo && v <= hi) range.value = v;
  });
  num.addEventListener('change', e => {
    const raw = e.target.value.trim();
    const v = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(v)) apply(v, true);
    else num.value = fmt(+range.value);
  });
  num.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); num.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); apply(entry, true); num.blur(); }
  });
  return { sync: v => { range.value = v; num.value = fmt(v); } };
}

function slider(label, value, min, max, step, onChange, hint = null, badge = null) {
  const start = Number.isFinite(Number(value)) ? Number(value) : Number(min) || 0;
  const range = el('input', { type: 'range', min, max, step, value: start, class: 'w-full' });
  const num = el('input', { type: 'number', class: 'num', spellcheck: 'false' });
  linkRange(range, num, onChange);
  return el('div', {},
    el('span', { class: 'lbl flex items-center justify-between gap-2' },
      el('span', { class: 'min-w-0 truncate flex items-center' },
        el('span', { class: 'truncate' },
          label, hint ? el('span', { class: 'text-zinc-700 ml-1 normal-case' }, `(${hint})`) : null),
        badge),
      num),
    range);
}

/**
 * Three editable scene-space coordinates shared by text and camera objects.
 * Root layers and camera keys use world coordinates; a child layer displays
 * its local offset. `idPrefix` names the inputs so another control — the stage
 * move handle — can write its result back without rebuilding the panel.
 */
function positionFields(position = {}, onChange, idPrefix = '') {
  const p = { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 };
  return el('div', { class: 'grid grid-cols-3 gap-1.5' },
    ...['x', 'y', 'z'].map(axis => el('label', { class: 'block' },
      el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, axis),
      el('input', {
        type: 'number', step: '0.1', value: round(p[axis], 1),
        id: idPrefix ? idPrefix + axis.toUpperCase() : null,
        class: 'inp !py-1 font-mono text-[11px]',
        onChange: e => onChange({ [axis]: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0 })
      }))));
}

/**
 * A row of small numeric fields, given as [label, key] pairs read off `obj`.
 * `positionFields` is the x/y/z case; this is the same control for any triple.
 */
function numberFields(pairs, obj = {}, onChange) {
  return el('div', { class: 'grid grid-cols-3 gap-1.5' },
    ...pairs.map(([label, key]) => el('label', { class: 'block' },
      el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, label),
      el('input', {
        type: 'number', step: '1', min: '0', value: round(Number(obj[key]) || 0, 1),
        class: 'inp !py-1 font-mono text-[11px]',
        onChange: e => onChange({ [key]: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0 })
      }))));
}

const fmtNum = v => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

/**
 * True while the keyboard is inside this panel. Panels that rebuild themselves
 * from scratch must not do it under the user's fingers: replacing the node tree
 * destroys the focused control, which drops keyboard focus back to the document
 * and sends the next arrow key to the timeline instead of to the slider.
 */
const holdsFocus = host => {
  const a = document.activeElement;
  return !!host && !!a && host.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
};

function syncInspector() {
  const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
  const clip = selectedClip();
  const guide = selectedGuide();

  if (clip) {
    if (builtFor !== inspectorKey(clip, selectedClipIds().length)) {
      buildInspector(); return;
    }
    set('#inspStart', fmtTime(clip.start));
    set('#inspLen', `${(clip.end - clip.start).toFixed(2)}s`);
    set('#inspEnd', fmtTime(clip.end));
    // Stage lengths also move from the timeline, so the fields follow the drag.
    for (const w of stageWindows(clip)) {
      const n = $('#stageDur' + STAGE_LABELS[w.key]);
      if (!n) continue;
      if (w.key === 'mid') n.textContent = `${w.dur.toFixed(2)}s`;
      else if (document.activeElement !== n) n.value = round(w.dur, 2);
    }
    const lock = $('#inspLock');
    if (lock && document.activeElement !== lock) lock.checked = clip.locked === true;
    const parent = $('#clipParent');
    if (parent && document.activeElement !== parent) parent.value = clip.parentId ?? '';
    // Dragging the layer on stage writes here, so the numbers follow the handle.
    for (const axis of ['x', 'y', 'z']) {
      const n = $('#clipPos' + axis.toUpperCase());
      if (n && document.activeElement !== n) n.value = round(Number(clip.position?.[axis]) || 0, 1);
    }
    const world = $('#clipWorldPos');
    if (world) {
      const p = clipWorldPosition(clip) ?? { x: 0, y: 0, z: 0 };
      world.textContent = `world  x ${round(p.x, 1)}   y ${round(p.y, 1)}   z ${round(p.z, 1)}`;
    }
    const addColorKey = $('#btnClipColorKey');
    if (addColorKey) {
      const inside = state.ui.time >= clip.start - 1e-6 && state.ui.time <= clip.end + 1e-6;
      addColorKey.disabled = !inside;
      addColorKey.title = inside
        ? 'Add or select a colour key at the playhead'
        : 'Move the playhead inside this layer first';
    }
    const keys = clipColorKeys(clip);
    const activeKey = selectedClipColorKey();
    keys.forEach((key, index) => {
      const time = $(`#clipColorKeyTime_${key.id}`);
      if (time) {
        time.max = Math.max(0, clip.end - clip.start);
        if (document.activeElement !== time) time.value = round(key.t, 2);
      }
      const swatch = $(`#clipColorKeySwatch_${key.id}`);
      if (swatch) swatch.style.background = key.color;
      const label = $(`#clipColorKeyLabel_${key.id}`);
      if (label) label.textContent = activeKey?.id === key.id ? `Key ${index + 1} · selected` : `Key ${index + 1}`;
    });
  } else if (guide) {
    const g = guide.guide, lv = guide.level;
    const picked = selectedGuideIndices(lv.key);
    if (picked.length > 1) {
      if (builtFor !== 'run:' + lv.key + ':' + picked.join(',') + ':' + runPivotIndex(lv.key)) { buildInspector(); return; }
      const from = lv.guides[picked[0]].t, to = lv.guides[picked.at(-1)].t;
      set('#runFrom', `${from.toFixed(2)}s`);
      set('#runLen', `${(to - from).toFixed(2)}s`);
      set('#runTo', `${to.toFixed(2)}s`);
      const sp = $('#runSpan');
      if (sp && document.activeElement !== sp) sp.value = round(to - from, 2);
      return;
    }
    if (builtFor !== 'guide:' + g.id) { buildInspector(); return; }
    const i = lv.guides.indexOf(g);
    set('#gAt', `${g.t.toFixed(2)}s`);
    set('#gLen', `${((lv.guides[i + 1]?.t ?? lv.end) - g.t).toFixed(2)}s`);
    const pos = $('#gPos');
    if (pos && document.activeElement !== pos) pos.value = round(g.t, 2);
  }
}

// ══ backdrop video ═══════════════════════════════════════════
function buildVideoPanel() {
  $('#videoFile').addEventListener('change', e => {
    const kind = e.target.dataset.kind || 'v1';
    const replaceId = e.target.dataset.replaceId || null;
    const files = [...(e.target.files ?? [])];
    const chosen = replaceId ? files.slice(0, 1) : files;
    chosen.reduce((chain, file, index) =>
      chain.then(() => app.importVideo(file, kind, index === 0 ? replaceId : null)), Promise.resolve());
    e.target.dataset.kind = '';
    e.target.dataset.replaceId = '';
    e.target.value = '';
  });
  renderVideoChannels();
}

function maskRangeControl(label, value, min, max, step, format, onInput) {
  const val = el('span', { class: 'text-[9px] text-zinc-500 font-mono' }, format(value));
  return el('label', { class: 'block min-w-0' },
    el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600 flex items-center justify-between' },
      el('span', {}, label), val),
    el('input', {
      type: 'range', min, max, step, value, class: 'w-full',
      onInput: e => {
        const next = +e.target.value;
        val.textContent = format(next);
        onInput(next);
      }
    })
  );
}

function renderVideoChannels() {
  const host = $('#videoChannels');
  if (!host || holdsFocus(host)) return;
  host.replaceChildren();

  const clipsByKind = Object.fromEntries(VIDEO_CHANNEL_KINDS.map(({ kind }) => [kind, videoClips(kind)]));
  const loaded = VIDEO_CHANNEL_KINDS
    .map(meta => ({ meta, count: clipsByKind[meta.kind].filter(clip => clip.ready).length }))
    .filter(({ count }) => count > 0);
  $('#videoChip').textContent = loaded.length
    ? loaded.map(({ meta, count }) => `${meta.short}${count > 1 ? ` ×${count}` : ''}`).join(' · ')
    : 'none';

  const pick = async (kind, replaceId = null) => {
    const picked = await pickVideoFiles({ multiple: !replaceId, standard: $('#standardMediaPicker')?.checked });
    if (picked === null) {                         // no File System Access API here
      const inp = $('#videoFile');
      inp.dataset.kind = kind;
      inp.dataset.replaceId = replaceId ?? '';
      inp.multiple = !replaceId;
      inp.click();
      return;
    }
    for (const [index, { file, handle }] of picked.entries()) {
      await app.importVideo(file, kind, index === 0 ? replaceId : null, { handle });
    }
  };
  /** Attach a saved backdrop from its remembered handle, or ask for the file. */
  const attach = async (kind, clip) => {
    const file = await requestMedia(clip).catch(() => null);
    if (file) { await app.importVideo(file, kind, clip.id); return; }
    pick(kind, clip.id);
  };

  const effectOptions = selected => VIDEO_EFFECTS.map(effect =>
    el('option', { value: effect.kind, selected: selected === effect.kind }, effect.label));

  for (const meta of VIDEO_CHANNEL_KINDS) {
    const lane = clipsByKind[meta.kind];
    const pendingCount = lane.filter(clip => !clip.ready && clip.name).length;
    const laneHead = el('div', { class: 'flex items-center gap-1.5' },
      el('span', {
        class: 'w-9 shrink-0 text-[9px] font-mono uppercase tracking-wider',
        style: { color: lane.length ? meta.color : '#52596a' }
      }, meta.short),
      el('span', { class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-500' },
        lane.length
          ? `${lane.length} clip${lane.length === 1 ? '' : 's'}${pendingCount ? ` · ${pendingCount} pending` : ''}`
          : 'No backdrop clips'),
      el('button', {
        class: 'btn !py-1 !text-[10px]',
        title: 'Import one or more backdrop videos into this lane',
        onClick: () => pick(meta.kind)
      }, lane.length ? '+ Add' : `Import ${meta.label.toLowerCase()}…`)
    );

    const clipCards = lane.map(clip => {
      const ready = clip.ready && Number(clip.duration) > 0;
      const shown = clip.visible !== false;
      const duration = Math.max(0, Number(clip.duration) || 0);
      const title = clip.name || 'Unattached backdrop video';
      const head = el('div', { class: 'flex items-center gap-1.5' },
        el('span', {
          class: 'w-9 shrink-0 text-right text-[9px] font-mono',
          style: { color: ready ? meta.color : '#52596a' },
          title: ready ? `${fmtDur(duration)} loaded` : 'Source needs to be re-imported'
        }, ready ? '●' : '○'),
        el('span', {
          class: 'flex-1 min-w-0 truncate text-[11px] ' + (ready ? 'text-zinc-300' : 'text-zinc-500'),
          title
        }, ready ? `${title} · ${fmtDur(duration)}` : `${title} · re-import to attach`),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6 ' + (shown ? '' : 'text-zinc-600'),
          title: shown ? 'Hide this backdrop clip' : 'Show this backdrop clip',
          onClick: () => setVideoClipSettings(meta.kind, clip.id, { visible: !shown })
        }, shown ? '◉' : '○'),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6',
          title: ready ? 'Replace this video source' : 'Attach this saved video source',
          onClick: () => (ready ? pick(meta.kind, clip.id) : attach(meta.kind, clip))
        }, ready ? '⤒' : '↗'),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400',
          title: 'Remove this backdrop clip',
          onClick: () => app.clearVideo(meta.kind, clip.id)
        }, '✕')
      );

      const body = ready
        ? (() => {
            const mask = clip.mask ?? {};
            const patchMask = patch => {
              const current = videoClip(meta.kind, clip.id)?.mask ?? mask;
              setVideoClipSettings(meta.kind, clip.id, { mask: { ...current, ...patch } });
            };
            const maskControls = el('div', {
              class: 'space-y-1.5 pt-1.5 border-t border-line/60 ' +
                     (mask.shape === 'none' ? 'hidden' : '')
            });
            const buildMaskControls = shape => {
              const current = videoClip(meta.kind, clip.id)?.mask ?? mask;
              const width = Number.isFinite(Number(current.width)) ? Number(current.width) : 0.72;
              const height = Number.isFinite(Number(current.height)) ? Number(current.height) : 0.72;
              const x = Number.isFinite(Number(current.x)) ? Number(current.x) : 0.5;
              const y = Number.isFinite(Number(current.y)) ? Number(current.y) : 0.5;
              const blur = Number.isFinite(Number(current.blur)) ? Number(current.blur) : 0;
              maskControls.replaceChildren(
                el('div', { class: 'grid grid-cols-2 gap-1.5' },
                  maskRangeControl('Center X', x * 100, -50, 150, 1,
                    value => `${Math.round(value)}%`, value => patchMask({ x: value / 100 })),
                  maskRangeControl('Center Y', y * 100, -50, 150, 1,
                    value => `${Math.round(value)}%`, value => patchMask({ y: value / 100 }))
                ),
                shape === 'circle'
                  ? maskRangeControl('Size', Math.min(width, height) * 100,
                      2, 200, 1, value => `${Math.round(value)}%`, value => patchMask({
                        width: value / 100, height: value / 100
                      }))
                  : el('div', { class: 'grid grid-cols-2 gap-1.5' },
                      maskRangeControl('Width', width * 100, 2, 200, 1,
                        value => `${Math.round(value)}%`, value => patchMask({ width: value / 100 })),
                      maskRangeControl('Height', height * 100, 2, 200, 1,
                        value => `${Math.round(value)}%`, value => patchMask({ height: value / 100 }))
                    ),
                maskRangeControl('Edge blur', blur, 0, 200, 1,
                  value => `${Math.round(value)}px`, value => patchMask({ blur: value }))
              );
            };
            buildMaskControls(mask.shape);
            const maskSelect = el('select', {
              class: 'sel !py-0.5 !text-[10px] flex-1',
              title: 'Clip this backdrop to a simple geometric shape',
              onChange: e => {
                const shape = e.target.value;
                patchMask({ shape });
                maskControls.classList.toggle('hidden', shape === 'none');
                buildMaskControls(shape);
              }
            },
              ...[['none', 'None'], ['rectangle', 'Rectangle'], ['circle', 'Circle']]
                .map(([id, label]) => el('option', { value: id, selected: mask.shape === id }, label)));

            const effectField = (label, effectKey, durationKey) => {
              const effect = clip[effectKey] ?? 'none';
              const effectDuration = clamp(Number(clip[durationKey]) || 0, 0, duration);
              return el('div', { class: 'min-w-0' },
                el('span', { class: 'lbl' }, `${label} effect`),
                el('div', { class: 'flex items-center gap-1.5' },
                  el('select', {
                    class: 'sel !py-0.5 !text-[10px] flex-1 min-w-0',
                    title: `${label} transition effect`,
                    onChange: e => setVideoClipSettings(meta.kind, clip.id, { [effectKey]: e.target.value })
                  }, ...effectOptions(effect)),
                  el('input', {
                    type: 'number', min: 0, max: Math.max(0.01, duration), step: '0.05',
                    value: round(effectDuration, 2),
                    class: 'inp !w-14 !py-0.5 !text-[10px] font-mono text-center',
                    title: `${label} transition duration in seconds`,
                    onChange: e => setVideoClipSettings(meta.kind, clip.id, {
                      [durationKey]: clamp(+e.target.value || 0, 0, duration)
                    })
                  })
                )
              );
            };

            const opacityValue = clamp(Number(clip.opacity) || 0, 0, 1);
            const opacityLabel = el('span', {
              class: 'text-[9px] text-zinc-500 font-mono w-8 text-right'
            }, `${Math.round(opacityValue * 100)}%`);
            const opacityInput = el('input', {
              type: 'range', min: 0, max: 1, step: 0.01, value: opacityValue,
              class: 'flex-1', title: 'Backdrop opacity',
              onInput: e => {
                const value = +e.target.value;
                opacityLabel.textContent = `${Math.round(value * 100)}%`;
                setVideoClipSettings(meta.kind, clip.id, { opacity: value });
              }
            });
            return el('div', { class: 'pl-9 space-y-1.5' },
              el('div', { class: 'flex items-center gap-1.5' },
                el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600 w-10' }, 'Opacity'),
                el('div', { class: 'flex items-center gap-1.5 flex-1' }, opacityInput, opacityLabel)),
              el('div', { class: 'flex items-center gap-1.5' },
                el('input', {
                  type: 'number', step: '0.05', value: round(clip.start, 2),
                  class: 'inp !w-16 !py-0.5 !text-[10px] font-mono text-center',
                  title: 'Start on the timeline — or drag the video region',
                  onChange: e => setVideoClipStart(meta.kind, clip.id,
                    clamp(+e.target.value || 0, -duration, state.project.duration))
                }),
                el('span', { class: 'text-[9px] text-zinc-600' }, 'start'),
                el('select', {
                  class: 'sel !py-0.5 !text-[10px] flex-1',
                  title: 'How the video fills the frame',
                  onChange: e => setVideoClipSettings(meta.kind, clip.id, { fit: e.target.value })
                },
                  ...[['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']]
                    .map(([id, label]) => el('option', { value: id, selected: clip.fit === id }, label)))
              ),
              el('label', { class: 'tog !text-[10px]' },
                el('input', {
                  type: 'checkbox', class: 'accent-sky-500', checked: clip.loop,
                  onChange: e => setVideoClipSettings(meta.kind, clip.id, { loop: e.target.checked })
                }), 'Loop when the source ends'),
              el('div', { class: 'grid grid-cols-2 gap-1.5' },
                effectField('In', 'inEffect', 'inDuration'),
                effectField('Out', 'outEffect', 'outDuration')),
              clip.loop && clip.outEffect === 'fade'
                ? el('p', { class: 'text-[9px] text-zinc-600' }, 'Out fade is ignored while Loop is on.')
                : null,
              el('div', { class: 'flex items-center gap-1.5' },
                el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600 w-10' }, 'Mask'),
                maskSelect),
              maskControls
            );
          })()
        : el('p', { class: 'pl-9 text-[10px] leading-relaxed text-zinc-600' },
            'Re-import the source to attach this saved clip; its timing and effects are preserved.');

      return el('div', {
        class: 'rounded-md border p-1.5 space-y-1 ' +
               (ready ? 'border-line bg-base-900' : 'border-line/60 bg-base-900/40')
      }, head, body);
    });

    host.append(el('div', {
      class: 'rounded-md border p-1.5 space-y-1 ' +
             (lane.length ? 'border-line bg-base-900/70' : 'border-line/60 bg-base-900/40')
    }, laneHead, ...clipCards));
  }
}

function syncVideoPanel() {
  renderVideoChannels();
}

// ══ audio ════════════════════════════════════════════════════
function buildAudioPanel() {
  $('#audioFile').addEventListener('change', e => {
    const kind = e.target.dataset.kind || 'bgm';
    const attachId = e.target.dataset.attachId || null;
    const files = [...(e.target.files ?? [])];
    // Music stays a single source; VO/SFX may be inserted as a batch — unless
    // the pick came from one saved clip's attach button.
    const chosen = kind === 'bgm' || attachId ? files.slice(0, 1) : files;
    chosen.reduce((chain, file, index) =>
      chain.then(() => app.importAudio(file, kind, index === 0 ? attachId : null)), Promise.resolve());
    e.target.dataset.kind = '';
    e.target.dataset.attachId = '';
    e.target.value = '';
  });

  $('#offsetSlider').addEventListener('input', e => {
    state.audio.offset = +e.target.value;
    syncBeatTimes();
    $('#offsetVal').textContent = `${(state.audio.offset * 1000).toFixed(0)}ms`;
    app.syncMetro();
    app.timeline.draw();
    emit('render');
  });

  $('#tSnap').addEventListener('change', e => { state.ui.snap = e.target.checked; });
  $('#tSnapWords').addEventListener('change', e => {
    state.ui.snapWords = e.target.checked;
    app.timeline.draw();
  });
  $('#tSnapPeaks').addEventListener('change', e => {
    state.ui.snapPeaks = e.target.checked;
    app.timeline.draw();
  });
  $('#hitGap').addEventListener('input', e => {
    setHitParams({ gap: +e.target.value });
    syncPeakLabels();
    app.timeline.draw();
  });
  $('#hitSense').addEventListener('input', e => {
    setHitParams({ sense: +e.target.value });
    syncPeakLabels();
    app.timeline.draw();
  });

  $('#btnUseAudioLen').addEventListener('click', () => {
    const bgm = track('bgm');
    if (!bgm.ready) return;
    setDuration(bgm.start + bgm.duration, { scale: true });
    app.timeline.fit();
    toast(`Composition set to ${fmtDur(state.project.duration)}`);
  });

  renderAudioLanes();
}

function renderAudioVolumePanel(meta, clip) {
  const keys = audioVolumeKeys(clip);
  const active = selectedAudioVolumeKey();
  const inside = clip.duration > 0 && state.ui.time >= clip.start - 1e-6 &&
    state.ui.time <= clip.start + clip.duration + 1e-6;
  const keyList = el('div', { class: 'space-y-1' });

  if (!keys.length) {
    keyList.append(el('div', { class: 'text-[9px] text-zinc-600' },
      'No volume keys — the base level stays constant.'));
  } else {
    keys.forEach((key, index) => {
      const selected = active?.id === key.id &&
        state.ui.sel?.kind === meta.kind && state.ui.sel?.id === clip.id;
      keyList.append(el('div', {
        class: 'flex items-center gap-1 rounded border px-1.5 py-1 ' +
          (selected ? 'border-zinc-300/60 bg-base-600' : 'border-line bg-base-900'),
        onClick: () => { selectAudioVolumeKey(meta.kind, clip.id, key.id); app.timeline.draw(); }
      },
        el('span', {
          class: 'w-3 h-3 rotate-45 shrink-0 border border-black/60',
          style: { background: selected ? '#f4f7fb' : meta.kind === 'bgm' ? '#5fb3e6' : meta.kind === 'vo' ? '#63c497' : '#b18fe0' },
          title: `Volume key ${index + 1}`
        }),
        el('input', {
          type: 'number', step: '0.05', min: 0, max: Math.max(0, clip.duration),
          value: round(key.t, 2), title: 'Time inside this audio source',
          class: 'inp !w-[62px] !py-0.5 !text-[10px] font-mono text-center',
          onClick: e => e.stopPropagation(),
          onChange: e => {
            updateAudioVolumeKey(meta.kind, clip.id, key.id, { t: +e.target.value || 0 });
            e.target.blur();
            renderAudioLanes();
            app.timeline.draw();
          }
        }),
        el('span', { class: 'text-[9px] text-zinc-600' }, 's'),
        el('input', {
          type: 'number', step: '0.05', min: 0, max: AUDIO_MAX_VOLUME,
          value: round(key.volume, 2), title: 'Volume multiplier',
          class: 'inp flex-1 min-w-0 !py-0.5 !text-[10px] font-mono text-right',
          onClick: e => e.stopPropagation(),
          onInput: e => { updateAudioVolumeKey(meta.kind, clip.id, key.id, { volume: e.target.value }); app.timeline.draw(); },
          onBlur: () => renderAudioLanes()
        }),
        el('select', {
          class: 'sel !w-[70px] !py-0.5 !text-[10px]', title: 'Easing out of this volume key',
          onClick: e => e.stopPropagation(),
          onChange: e => { updateAudioVolumeKey(meta.kind, clip.id, key.id, { ease: e.target.value }); app.timeline.draw(); }
        }, ...Object.entries(EASES).map(([id, ease]) =>
          el('option', { value: id, selected: key.ease === id }, ease.label))),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Delete this volume key',
          onClick: e => { e.stopPropagation(); removeAudioVolumeKey(meta.kind, clip.id, key.id); app.timeline.draw(); }
        }, '✕')
      ));
    });
  }

  return el('div', { class: 'pt-1.5 border-t border-line/70 space-y-1.5' },
    el('div', { class: 'flex items-center gap-1.5' },
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500 flex-1' }, 'Volume automation'),
      el('span', { class: 'chip' }, `${keys.length} key${keys.length === 1 ? '' : 's'}`),
      el('button', {
        class: 'btn !px-1.5 !py-1 !text-[10px]', disabled: !inside,
        'data-audio-volume-add': '',
        'data-audio-volume-start': clip.start,
        'data-audio-volume-end': clip.start + clip.duration,
        title: inside ? 'Add or select a volume key at the playhead' : 'Move the playhead inside this audio source first',
        onClick: () => { addAudioVolumeKey(meta.kind, clip.id, state.ui.time); app.timeline.draw(); renderAudioLanes(); }
      }, '+ Keyframe'),
      keys.length ? el('button', {
        class: 'btn !px-1.5 !py-1 !text-[10px] hover:!text-red-400', title: 'Remove all volume keys from this source',
        onClick: () => { clearAudioVolumeKeys(meta.kind, clip.id); app.timeline.draw(); }
      }, 'Clear') : null
    ),
    keyList
  );
}

function renderAudioLanes() {
  const host = $('#audioLanes');
  if (!host || holdsFocus(host)) return;      // a fader is being driven — leave it be
  host.replaceChildren();

  for (const meta of TRACK_KINDS) {
    const isBgm = meta.kind === 'bgm';
    const tr = isBgm ? track('bgm') : null;
    const lane = savedAudioClips(meta.kind);
    const loaded = lane.filter(clip => clip.ready);
    const pending = lane.filter(clip => !clip.ready);
    const multiple = () => !isBgm;
    const pick = async (attachId = null) => {
      const picked = await pickAudioFiles({ multiple: multiple() && !attachId, standard: $('#standardMediaPicker')?.checked });
      if (picked === null) {                       // no File System Access API here
        const inp = $('#audioFile');
        inp.dataset.kind = meta.kind;
        inp.dataset.attachId = attachId ?? '';
        inp.multiple = multiple() && !attachId;
        inp.click();
        return;
      }
      for (const [index, { file, handle }] of picked.entries()) {
        await app.importAudio(file, meta.kind, index === 0 ? attachId : null, { handle });
      }
    };
    // The ↗ on a pending clip: a remembered handle only needs this click to be
    // allowed, so try that before sending the user back to the file dialog.
    const attach = async clip => {
      const file = await requestMedia(clip).catch(() => null);
      if (file) { await app.importAudio(file, meta.kind, clip.id); return; }
      pick(clip.id);
    };

    const head = el('div', { class: 'flex items-center gap-1.5' },
      el('span', {
        class: 'w-9 shrink-0 text-[9px] font-mono uppercase tracking-wider ' +
               (loaded.length ? 'text-zinc-300' : pending.length ? 'text-amber-500/80' : 'text-zinc-600'),
        title: pending.length ? `${pending.length} saved clip${pending.length === 1 ? '' : 's'} waiting to be attached` : ''
      }, meta.short),
      isBgm && tr.ready
        ? el('span', { class: 'flex-1 min-w-0 truncate text-[11px] text-zinc-300', title: tr.name }, tr.name)
        : el('button', {
          class: 'btn flex-1 !py-1 !text-[11px]', onClick: () => pick(),
          title: isBgm ? `Import ${meta.label.toLowerCase()}` : `Add another ${meta.label.toLowerCase()} clip`
        }, isBgm ? `Import ${meta.label.toLowerCase()}…` : `${loaded.length ? 'Add' : 'Import'} ${meta.label.toLowerCase()}…`),
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 ' + (tr.mute ? '!text-red-400' : ''),
        title: tr.mute ? 'Unmute' : 'Mute',
        onClick: () => { setTrackLevel(meta.kind, { mute: !tr.mute }); renderAudioLanes(); app.timeline.draw(); }
      }, tr.mute ? '⨯' : '♪') : null,
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6', title: 'Replace', onClick: () => pick()
      }, '⤒') : null,
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Remove',
        onClick: () => app.clearAudio(meta.kind)
      }, '✕') : null
    );

    const body = lane.map(clip => {
      const controls = el('div', { class: 'pl-9 space-y-1.5' });
      // A project file references media by name, never its bytes. Saved clips
      // stay visible here so their timing survives until the file is attached.
      if (!clip.ready) {
        const slip = clip.start ? ` · at ${clip.start > 0 ? '+' : ''}${round(clip.start, 2)}s` : '';
        controls.append(el('div', { class: 'flex items-center gap-1.5' },
          el('span', {
            class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-500',
            title: `${clip.name || 'Unattached clip'} — re-import this file to attach it`
          }, `○ ${clip.name || 'Unattached clip'}${slip} · re-import to attach`),
          el('button', {
            class: 'btn btn-sq !w-6 !h-6', title: 'Attach this saved source',
            onClick: () => attach(clip)
          }, '↗'),
          el('button', {
            class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Remove clip',
            onClick: () => app.clearAudio(meta.kind, isBgm ? null : clip.id)
          }, '✕')
        ));
        controls.append(renderAudioVolumePanel(meta, clip));
        return controls;
      }
      if (!isBgm) {
        controls.append(el('div', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-400', title: clip.name }, clip.name),
          el('button', {
            class: 'btn btn-sq !w-6 !h-6 ' + (clip.mute ? '!text-red-400' : ''),
            title: clip.mute ? 'Unmute clip' : 'Mute clip',
            onClick: () => { setAudioClipLevel(meta.kind, clip.id, { mute: !clip.mute }); renderAudioLanes(); app.timeline.draw(); }
          }, clip.mute ? '⨯' : '♪'),
          el('button', {
            class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Remove clip',
            onClick: () => app.clearAudio(meta.kind, clip.id)
          }, '✕')
        ));

        if (meta.kind === 'vo') {
          const words = Array.isArray(clip.words) ? clip.words : [];
          const status = clip.speechStatus === 'analyzing'
            ? 'Analysing…'
            : words.length
              ? `${words.length} words${clip.transcript ? ` · ${clip.transcript}` : ''}`
              : clip.speechStatus === 'error' ? 'Analysis failed' : 'Not analysed';
          controls.append(el('div', { class: 'flex items-center gap-1.5' },
            el('span', {
              class: 'flex-1 min-w-0 truncate text-[9px] text-zinc-600',
              title: clip.speechError || clip.transcript || 'No word timing analysis yet'
            }, status),
            el('button', {
              class: 'btn !py-0.5 !px-1.5 !text-[9px] shrink-0',
              disabled: clip.speechStatus === 'analyzing',
              title: 'Run local Whisper analysis and create word snap points',
              onClick: () => app.analyzeVoice(meta.kind, clip.id)
            }, words.length ? 'Re-analyse' : 'Analyse words')
          ));
        }
      }
      controls.append(el('div', { class: 'flex items-center gap-1.5' },
        el('input', {
          type: 'range', min: 0, max: AUDIO_MAX_VOLUME, step: 0.01, value: clip.volume, class: 'flex-1',
          title: `${meta.label} level`,
          onInput: e => isBgm
            ? setTrackLevel(meta.kind, { volume: +e.target.value })
            : setAudioClipLevel(meta.kind, clip.id, { volume: +e.target.value })
        }),
        el('input', {
          type: 'number', step: '0.05', value: round(clip.start, 2),
          class: 'inp !w-16 !py-0.5 !text-[10px] font-mono text-center',
          title: 'Start on the timeline — or drag the waveform',
          onChange: e => {
            const start = clamp(+e.target.value || 0, -clip.duration, state.project.duration);
            if (isBgm) setTrackStart(meta.kind, start);
            else setAudioClipStart(meta.kind, clip.id, start);
            emit('audio', state.audio);
            app.timeline.draw();
          }
        }),
        el('span', { class: 'text-[9px] text-zinc-600' }, 's')));
      controls.append(renderAudioVolumePanel(meta, clip));
      return controls;
    });

    host.append(el('div', {
      class: 'rounded-md border p-1.5 space-y-1 ' +
             (loaded.length ? 'border-line bg-base-900' : 'border-line/60 bg-base-900/40')
    }, head, ...body));
  }
}

function syncPeakLabels() {
  const a = state.audio;
  $('#hitGapVal').textContent = `${(a.hitGap * 1000).toFixed(0)}ms`;
  $('#hitSenseVal').textContent = a.hitSense.toFixed(2);
  $('#statHits').textContent = a.hits.length;
}

export function setAudioProgress(v, label) {
  $('#audioProgress').classList.toggle('hidden', v >= 1 || v < 0);
  $('#audioBar').style.width = `${clamp(v, 0, 1) * 100}%`;
  $('#audioStatus').textContent = label ?? '';
}

function syncAudioPanel() {
  const a = state.audio;
  const bgm = track('bgm');
  const loaded = TRACK_KINDS
    .map(meta => {
      const lane = savedAudioClips(meta.kind);
      return { meta, count: lane.filter(clip => clip.ready).length, pending: lane.filter(clip => !clip.ready).length };
    })
    .filter(({ count, pending }) => count > 0 || pending > 0);

  $('#audioChip').textContent = loaded.length
    ? loaded.map(({ meta, count, pending }) =>
        `${meta.short}${count > 1 ? ` ×${count}` : ''}${pending ? ` +${pending} pending` : ''}`).join(' · ')
    : 'no audio';
  $('#audioInfo').classList.toggle('hidden', !bgm.ready);
  $('#tSnapWords').checked = state.ui.snapWords;
  renderAudioLanes();
  if (!bgm.ready) return;

  $('#statBpm').textContent = a.bpm.toFixed(1);
  $('#statBeats').textContent = a.beats.length;
  $('#statLen').textContent = fmtDur(bgm.duration);
  $('#offsetSlider').value = a.offset;
  $('#offsetVal').textContent = `${(a.offset * 1000).toFixed(0)}ms`;
  $('#hitGap').value = a.hitGap;
  $('#hitSense').value = a.hitSense;
  $('#tSnapPeaks').checked = state.ui.snapPeaks;
  syncPeakLabels();
}

function syncAudioVolumeButtons() {
  const t = state.ui.time;
  for (const button of document.querySelectorAll('[data-audio-volume-add]')) {
    const start = Number(button.getAttribute('data-audio-volume-start'));
    const end = Number(button.getAttribute('data-audio-volume-end'));
    const inside = Number.isFinite(start) && Number.isFinite(end) && t >= start - 1e-6 && t <= end + 1e-6;
    button.disabled = !inside;
    button.title = inside
      ? 'Add or select a volume key at the playhead'
      : 'Move the playhead inside this audio source first';
  }
}

// ══ metronome ════════════════════════════════════════════════
let taps = [];

function buildMetroPanel() {
  const voice = $('#metroVoice');
  for (const [id, v] of Object.entries(VOICES)) voice.append(el('option', { value: id }, v.label));

  $('#btnMetro').addEventListener('click', () => app.setMetroEnabled(!state.metro.on));
  voice.addEventListener('change', e => { setMetro({ voice: e.target.value }); app.syncMetro(); });
  $('#metroVol').addEventListener('input', e => {
    setMetro({ volume: +e.target.value });
    $('#metroVolVal').textContent = Math.round(state.metro.volume * 100) + '%';
    app.syncMetro();
  });
  $('#metroAccent').addEventListener('change', e => { setMetro({ accent: e.target.checked }); app.syncMetro(); });
  $('#metroRec').addEventListener('change', e => { setMetro({ inRecording: e.target.checked }); app.syncMetro(); });

  $('#metroSrcTrack').addEventListener('click', () => {
    if (!track('bgm').ready) { toast('Import music first'); return; }
    setMetro({ source: 'track' });
    app.syncMetro(); app.timeline.draw();
  });
  $('#metroSrcManual').addEventListener('click', () => {
    setMetro({ source: 'manual' });
    app.syncMetro(); app.timeline.draw();
  });

  $('#metroBpm').addEventListener('change', e => {
    setMetro({ bpm: clamp(+e.target.value || 120, 20, 300), source: 'manual' });
    app.syncMetro(); app.timeline.draw();
  });
  $('#metroOff').addEventListener('input', e => {
    setMetro({ offset: +e.target.value, source: 'manual' });
    $('#metroOffVal').textContent = `${(state.metro.offset * 1000).toFixed(0)}ms`;
    app.syncMetro(); app.timeline.draw();
  });

  $('#metroTap').addEventListener('click', () => {
    const now = performance.now() / 1000;
    if (taps.length && now - taps.at(-1) > 2.5) taps = [];      // a pause starts a new count
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length < 2) { toast('Keep tapping…'); return; }
    const gaps = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    setMetro({ bpm: clamp(60 / median, 20, 300), source: 'manual' });
    app.syncMetro(); app.timeline.draw();
    toast(`${state.metro.bpm.toFixed(1)} BPM from ${taps.length} taps`);
  });

  $('#beatsPerBar').addEventListener('change', e => {
    state.audio.beatsPerBar = +e.target.value;
    syncBeatTimes();
    app.syncMetro();
    app.timeline.draw();
  });
}

function syncMetroPanel() {
  const m = state.metro;
  const following = m.source === 'track' && track('bgm').ready;

  $('#btnMetro').textContent = m.on ? 'Click on' : 'Click off';
  $('#btnMetro').classList.toggle('btn-pri', m.on);
  $('#metroChip').textContent = hasGrid()
    ? `${(following ? state.audio.bpm : m.bpm).toFixed(1)} BPM · ${following ? 'track' : 'manual'}`
    : 'no grid';
  $('#metroVoice').value = m.voice;
  $('#metroVol').value = m.volume;
  $('#metroVolVal').textContent = Math.round(m.volume * 100) + '%';
  $('#metroAccent').checked = m.accent;
  $('#metroRec').checked = m.inRecording;
  $('#beatsPerBar').value = String(state.audio.beatsPerBar);

  $('#metroSrcTrack').classList.toggle('btn-pri', following);
  $('#metroSrcTrack').classList.toggle('opacity-40', !track('bgm').ready);
  $('#metroSrcManual').classList.toggle('btn-pri', !following);
  $('#metroManual').classList.toggle('hidden', following);

  const bpm = $('#metroBpm');
  if (document.activeElement !== bpm) bpm.value = round(m.bpm, 1);
  $('#metroOff').value = m.offset;
  $('#metroOffVal').textContent = `${(m.offset * 1000).toFixed(0)}ms`;
}

// ══ typefaces ════════════════════════════════════════════════
let fontSlotBusy = -1;

function buildFontPanel() {
  $('#fontFile').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f && e.target.dataset.target === 'clip' && e.target.dataset.clipId) {
      app.loadClipFontFile(f, e.target.dataset.clipId);
    } else if (f) {
      app.loadFontFile(f, +e.target.dataset.slot || 0);
    }
    delete e.target.dataset.target;
    delete e.target.dataset.clipId;
    e.target.value = '';
  });
  on('fontBusy', slot => { fontSlotBusy = slot; renderFontSlots(); });
  renderFontSlots();
}

function renderFontSlots() {
  const host = $('#fontSlots');
  if (!host) return;
  host.replaceChildren();

  for (let slot = 0; slot < FONT_SLOTS; slot++) {
    const entry = state.fonts[slot];
    const primary = slot === 0;
    const busy = fontSlotBusy === slot && !entry;

    const sel = el('select', {
      class: 'sel !py-1 !text-[11px]',
      onChange: e => {
        if (e.target.value === '') { app.clearFont(slot); return; }
        const preset = FONT_PRESETS.find(f => f.id === e.target.value);
        if (preset) app.loadFontUrl(preset, slot);
      }
    },
      el('option', { value: '', selected: !entry }, primary ? '— pick a typeface —' : '— none —'),
      ...FONT_PRESETS.map(f => el('option', { value: f.id, selected: entry?.preset === f.id }, f.label)),
      entry && !entry.preset ? el('option', { value: entry.preset ?? '__file', selected: true }, entry.name) : null
    );

    host.append(el('div', { class: 'flex items-center gap-1.5' },
      el('span', {
        class: 'w-5 h-5 shrink-0 rounded grid place-items-center text-[10px] font-mono ' +
               (entry ? 'bg-sky-500/20 text-sky-300' : 'bg-base-600 text-zinc-600'),
        title: primary ? 'Primary typeface' : `Fallback ${slot + 1}`
      }, busy ? '·' : String(slot + 1)),
      sel,
      el('button', {
        class: 'btn btn-sq shrink-0', title: 'Load a font file into this slot',
        onClick: () => { const inp = $('#fontFile'); inp.dataset.slot = slot; inp.click(); }
      }, '⤒'),
      el('button', {
        class: 'btn btn-sq shrink-0 ' + (primary || !entry ? 'opacity-30 pointer-events-none' : 'hover:!text-red-400'),
        title: 'Clear this slot',
        onClick: () => app.clearFont(slot)
      }, '✕')
    ));
  }
}

function syncFontPanel() {
  fontSlotBusy = -1;
  const names = state.fonts.filter(Boolean).map(f => f.name);
  $('#fontChip').textContent = names.length
    ? (names.length === 1 ? trim(names[0], 20) : `${trim(names[0], 12)} +${names.length - 1}`)
    : 'loading…';
  renderFontSlots();
}

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ══ camera ═══════════════════════════════════════════════════
function buildCameraPanel() {
  $('#camEnabled').addEventListener('change', e => { setCameraEnabled(e.target.checked); app.timeline.draw(); });
  $('#camSplit').addEventListener('change', e => {
    setCameraMode(e.target.checked ? 'split' : 'combined');
    app.timeline.draw();
  });
  $('#btnCamKey').addEventListener('click', () => { addCameraKey(state.ui.time); app.timeline.draw(); });
  $('#btnCamClear').addEventListener('click', () => {
    clearCameraTrack();
    app.timeline.draw();
    toast('Camera track cleared');
  });
}

const CAMERA_AXIS_META = {
  x: { label: 'X', color: '#38bdf8' },
  y: { label: 'Y', color: '#34d399' },
  z: { label: 'Z', color: '#fbbf24' }
};

function cameraNowLabel(cam = camera()) {
  const now = cameraAt(cam, state.ui.time, { width: state.project.width, height: state.project.height });
  return `now  x ${now.position.x.toFixed(1)}   y ${now.position.y.toFixed(1)}   z ${now.position.z.toFixed(1)}   roll ${(now.roll * 180 / Math.PI).toFixed(1)}°`;
}

function splitCameraChannel(axis) {
  const meta = CAMERA_AXIS_META[axis];
  const keys = cameraChannelKeys(axis);
  const list = el('div', { class: 'space-y-1' });
  if (!keys.length) {
    list.append(el('div', { class: 'text-[10px] text-zinc-600 py-1' }, 'No keys — holds the default framing.'));
  }

  for (const key of keys) {
    const selected = selectedCamAxis() === axis && selectedCamKey()?.id === key.id;
    const row = el('div', {
      class: 'flex items-center gap-1 rounded border px-1.5 py-1 ' +
             (selected ? 'border-zinc-300/60 bg-base-600' : 'border-line bg-base-900'),
      onClick: () => selectCameraKey(axis, key.id)
    },
      el('span', { class: 'w-3 h-3 rotate-45 shrink-0', style: { background: meta.color } }),
      el('input', {
        type: 'number', step: '0.05', min: 0, max: state.project.duration,
        value: round(key.t, 2), title: 'Key time',
        class: 'inp !w-[70px] !py-0.5 !text-[10px] font-mono text-center',
        onInput: e => {
          updateCameraChannelKey(axis, key.id, { t: clamp(+e.target.value || 0, 0, state.project.duration) });
          app.timeline.draw();
        },
        onBlur: () => renderCameraPanel()
      }),
      el('span', { class: 'text-[9px] text-zinc-600' }, 's'),
      el('input', {
        type: 'number', step: '0.1', value: round(key.value, 1), title: `${meta.label} value`,
        class: 'inp flex-1 !py-0.5 !text-[10px] font-mono text-right',
        onInput: e => {
          updateCameraChannelKey(axis, key.id, { value: Number.isFinite(Number(e.target.value)) ? +e.target.value : 0 });
          app.timeline.draw();
        },
        onBlur: () => renderCameraPanel()
      }),
      el('select', {
        class: 'sel !w-[76px] !py-0.5 !text-[10px]', title: 'Easing out of this key',
        onChange: e => { updateCameraChannelKey(axis, key.id, { ease: e.target.value }); app.timeline.draw(); }
      }, ...Object.entries(EASES).map(([id, ease]) =>
        el('option', { value: id, selected: key.ease === id }, ease.label))),
      el('button', {
        class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: `Delete ${meta.label} key`,
        onClick: e => { e.stopPropagation(); removeCameraChannelKey(axis, key.id); app.timeline.draw(); }
      }, '✕')
    );
    list.append(row);
  }

  return el('div', { class: 'rounded-md border border-line bg-base-900 p-1.5 space-y-1.5' },
    el('div', { class: 'flex items-center gap-1.5' },
      el('span', { class: 'w-5 h-5 rounded grid place-items-center text-[10px] font-bold',
                   style: { color: '#08090c', background: meta.color } }, meta.label),
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-400 flex-1' },
        `${meta.label} position · ${keys.length} key${keys.length === 1 ? '' : 's'}`),
      el('button', {
        class: 'btn !px-1.5 !py-1 !text-[10px]', title: `Add ${meta.label} key at the playhead`,
        onClick: () => { addCameraChannelKey(axis, state.ui.time); app.timeline.draw(); }
      }, '+ key'),
      axis === 'z' ? el('button', {
        class: 'btn !px-1.5 !py-1 !text-[10px]', title: 'Replace Z keys with a linear start-to-end move',
        onClick: () => {
          setCameraChannelSpan('z', 0, state.project.duration, 'linear');
          app.timeline.draw();
        }
      }, 'Linear full span') : null
    ),
    list
  );
}

function renderSplitCameraPanel(host) {
  host.append(
    el('div', { class: 'rounded-md bg-base-900 border border-line p-2 text-[10px] font-mono text-zinc-500' },
      cameraNowLabel()),
    el('p', { class: 'text-[10px] leading-snug text-zinc-600' },
      'Each position axis has its own keys and easing. Add several X/Y keys, then use “Linear full span” on Z for a simple depth move.'),
    ...['x', 'y', 'z'].map(splitCameraChannel),
    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', {
        class: 'btn', onClick: () => { addCameraKey(state.ui.time); app.timeline.draw(); }
      }, 'Key all channels'),
      el('button', {
        class: 'btn', onClick: () => {
          for (const axis of ['x', 'y', 'z']) setCameraChannelSpan(axis, 0, state.project.duration, 'linear');
          // The helper selects Z last; keep the selected channel useful.
          app.timeline.draw();
        }
      }, 'Linear all')
    )
  );
}

function renderCameraPanel() {
  // The camera settings only make sense while the CAM track (or one of its
  // keys) is what's selected — otherwise the panel is out of the way.
  const shown = state.ui.sel?.type === 'camera' || state.ui.sel?.type === 'camkey';
  $('#camPanel').classList.toggle('hidden', !shown);
  if (!shown) return;

  const cam = camera();
  const keys = cameraKeys();
  $('#camEnabled').checked = cam.enabled;
  $('#camSplit').checked = cameraMode() === 'split';
  const count = cameraKeyCount();
  $('#camChip').textContent = count
    ? cameraMode() === 'split' ? `${count} axis key${count === 1 ? '' : 's'}` : `${count} key${count === 1 ? '' : 's'}`
    : 'no keys';

  const host = $('#camKeyPanel');
  if (holdsFocus(host)) return;               // a slider is being driven — leave it be
  host.replaceChildren();

  if (cameraMode() === 'split') {
    renderSplitCameraPanel(host);
    return;
  }

  const key = selectedCamKey();

  if (!key) {
    host.append(el('div', { class: 'rounded-md bg-base-900 border border-line p-2 text-[10px] font-mono text-zinc-500' },
      cameraNowLabel(cam)));
    if (keys.length) {
      host.append(el('p', { class: 'text-[10px] text-zinc-600' }, 'Select a key on the CAM track to edit it.'));
    }
    return;
  }

  const upd = props => { updateCameraKey(key.id, props); app.timeline.draw(); };
  host.append(
    el('div', { class: 'flex items-center gap-2' },
      el('span', { class: 'w-3 h-3 rotate-45 bg-violet-400 shrink-0' }),
      el('span', { class: 'text-[11px] text-zinc-300 flex-1' }, `Key ${keys.indexOf(key) + 1} of ${keys.length}`),
      el('button', {
        class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Delete this key',
        onClick: () => { removeCameraKey(key.id); app.timeline.draw(); }
      }, '✕')),

    field('Time (s)', el('input', {
      type: 'number', step: '0.05', min: 0, max: state.project.duration, value: round(key.t, 2),
      class: 'inp font-mono',
      onChange: e => { upd({ t: clamp(+e.target.value || 0, 0, state.project.duration) }); renderCameraPanel(); }
    })),

    field('Position · scene units', positionFields(key.position,
      pos => upd({ position: { ...(key.position ?? {}), ...pos } }))),
    slider('Roll', key.roll * 180 / Math.PI, -180, 180, 0.5, v => upd({ roll: v * Math.PI / 180 }), '°'),

    field('Easing out of this key', el('select', {
      class: 'sel', onChange: e => upd({ ease: e.target.value })
    }, ...Object.entries(EASES).map(([id, e]) =>
      el('option', { value: id, selected: key.ease === id }, e.label)))),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => app.seek(key.t) }, 'Go to key'),
      el('button', {
        class: 'btn',
        onClick: () => {
          upd({ position: defaultCameraPosition(state.project.width, state.project.height), roll: 0 });
          renderCameraPanel();
        }
      }, 'Reset position'))
  );
}

// ══ viewport ═════════════════════════════════════════════════
function buildViewport() {
  const choose = mode => {
    if (state.ui.viewMode === mode) return;
    state.ui.viewMode = mode;
    emit('view', mode);
    emit('render');
  };
  $('#viewOutput').addEventListener('click', () => choose('output'));
  $('#viewSpace').addEventListener('click', () => choose('space'));
}

function syncViewMode() {
  const mode = state.ui.viewMode === 'space' ? 'space' : 'output';
  state.ui.viewMode = mode;
  for (const [id, value] of [['#viewOutput', 'output'], ['#viewSpace', 'space']]) {
    const button = $(id);
    if (!button) continue;
    const active = mode === value;
    button.classList.toggle('view-mode-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  $('#spaceHint')?.classList.toggle('hidden', mode !== 'space');
  $('#safeToggle')?.classList.toggle('hidden', mode === 'space');
  $('#safeArea')?.classList.toggle('hidden', mode !== 'output' || !state.ui.safeArea);
}

// ══ particles ════════════════════════════════════════════════
function buildParticlePanel() {
  $('#btnAddEmitter').addEventListener('click', () => {
    if (!addParticleEmitter()) toast(`At most ${MAX_EMITTERS} emitters`);
  });
  $('#btnDupEmitter').addEventListener('click', () => {
    const e = selectedEmitter();
    if (!e) { toast('Add an emitter first'); return; }
    if (!duplicateParticleEmitter(e.id)) toast(`At most ${MAX_EMITTERS} emitters`);
  });
  $('#btnCopyEmitter').addEventListener('click', copySelectedEmitterToClipboard);
  $('#btnPasteEmitter').addEventListener('click', pasteEmitterFromClipboard);
  renderParticlePanel();
}

function rememberSelectedEmitter() {
  const id = activeEmitterId();
  const emitter = id ? particleEmitters().find(e => e.id === id) : null;
  if (!emitter) {
    toast('Select an emitter first');
    return null;
  }
  emitterClipboard = copyEmitterData(emitter.id);
  return emitterClipboard;
}

async function copySelectedEmitterToClipboard() {
  const data = rememberSelectedEmitter();
  if (!data) return false;
  try {
    await navigator.clipboard?.writeText(clipboardText(data));
  } catch {
    // The in-memory payload still makes copy/paste work when browser clipboard
    // access is unavailable.
  }
  toast('Emitter copied');
  return true;
}

function parseEmitterClipboard(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data?.format === EMITTER_CLIPBOARD_FORMAT && data.emitter ? data : null;
  } catch {
    return null;
  }
}

function pasteEmitterData(data) {
  const emitter = pasteEmitter(data, state.ui.time);
  if (!emitter) {
    toast(particleEmitters().length >= MAX_EMITTERS
      ? `At most ${MAX_EMITTERS} emitters`
      : 'Could not paste emitter');
    return false;
  }
  app.timeline.draw();
  toast('Emitter pasted at playhead');
  return true;
}

async function pasteEmitterFromClipboard() {
  let data = null;
  try {
    const text = await navigator.clipboard?.readText();
    data = parseEmitterClipboard(text);
  } catch {
    // Fall back to the last in-app copy below.
  }
  if (!data) data = emitterClipboard;
  if (!data) {
    toast('Copy an emitter first');
    return false;
  }
  return pasteEmitterData(data);
}

// Blur first: a select still holding focus would block the panel rebuild that
// swaps the controls belonging to the newly chosen mode.
const selectField = (label, value, options, onChange) =>
  field(label, el('select', {
    class: 'sel',
    onChange: e => { const v = e.target.value; e.target.blur(); onChange(v); }
  }, ...options.map(o => el('option', { value: o.id, selected: o.id === value }, o.label))));

const colorField = (label, value, onChange) =>
  field(label, el('input', {
    type: 'color', value,
    class: 'w-full h-8 bg-base-900 border border-line rounded cursor-pointer',
    onInput: e => onChange(e.target.value)
  }));

const emitterLabel = (e, i) =>
  e.name || `${PARTICLE_SHAPES.find(s => s.id === e.shape)?.label ?? e.shape} ${i + 1}`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const CURVE_VIEW = Object.freeze({
  width: 200, height: 86,
  left: 14, right: 197, top: 5, bottom: 69
});

function svgEl(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) n.setAttribute(key, value);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}

function curvePoint(values, i) {
  const x = CURVE_VIEW.left + (CURVE_VIEW.right - CURVE_VIEW.left) * i / (values.length - 1);
  const value = clamp(Number(values[i]) || 0, 0, 1);
  const y = CURVE_VIEW.bottom - (CURVE_VIEW.bottom - CURVE_VIEW.top) * value;
  return [x, y];
}

function curvePath(values, close = false) {
  const points = values.map((_, i) => curvePoint(values, i));
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return close
    ? `${d} L${CURVE_VIEW.right},${CURVE_VIEW.bottom} L${CURVE_VIEW.left},${CURVE_VIEW.bottom} Z`
    : d;
}

function miniCurvePath(values) {
  const points = values.map((_, i) => {
    const x = 1 + 22 * i / (values.length - 1);
    const y = 11 - 10 * clamp(Number(values[i]) || 0, 0, 1);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return points.join(' ');
}

function sameCurve(a, b) {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.015);
}

/**
 * A sampled 0..1 curve editor. The graph owns its pointer gesture so a
 * continuous draw does not rebuild the panel on every sample update.
 */
function curveEditor(label, values, onChange) {
  const initial = normalizeParticleCurve(values);
  const line = svgEl('path', { class: 'curve-line', d: curvePath(initial) });
  const fill = svgEl('path', { class: 'curve-fill', d: curvePath(initial, true) });
  const graph = svgEl('svg', {
    class: 'curve-plot', viewBox: `0 0 ${CURVE_VIEW.width} ${CURVE_VIEW.height}`,
    preserveAspectRatio: 'none', role: 'application', tabindex: '0',
    'aria-label': `${label}. Drag to draw the curve.`
  });

  graph.append(
    svgEl('rect', {
      class: 'curve-bg', x: CURVE_VIEW.left, y: CURVE_VIEW.top,
      width: CURVE_VIEW.right - CURVE_VIEW.left, height: CURVE_VIEW.bottom - CURVE_VIEW.top,
      rx: 1.5
    }),
    ...[0.25, 0.5, 0.75].map(v => svgEl('line', {
      class: 'curve-grid', x1: CURVE_VIEW.left, x2: CURVE_VIEW.right,
      y1: CURVE_VIEW.bottom - (CURVE_VIEW.bottom - CURVE_VIEW.top) * v,
      y2: CURVE_VIEW.bottom - (CURVE_VIEW.bottom - CURVE_VIEW.top) * v
    })),
    ...[0.25, 0.5, 0.75].map(v => svgEl('line', {
      class: 'curve-grid', y1: CURVE_VIEW.top, y2: CURVE_VIEW.bottom,
      x1: CURVE_VIEW.left + (CURVE_VIEW.right - CURVE_VIEW.left) * v,
      x2: CURVE_VIEW.left + (CURVE_VIEW.right - CURVE_VIEW.left) * v
    })),
    fill,
    line,
    svgEl('line', { class: 'curve-axis', x1: CURVE_VIEW.left, x2: CURVE_VIEW.left, y1: CURVE_VIEW.top, y2: CURVE_VIEW.bottom }),
    svgEl('line', { class: 'curve-axis', x1: CURVE_VIEW.left, x2: CURVE_VIEW.right, y1: CURVE_VIEW.bottom, y2: CURVE_VIEW.bottom }),
    svgEl('text', { class: 'curve-y-label', x: 8, y: CURVE_VIEW.top + 3 }, '1'),
    svgEl('text', { class: 'curve-y-label', x: 8, y: CURVE_VIEW.bottom + 3 }, '0'),
    svgEl('text', { class: 'curve-x-label', x: CURVE_VIEW.left, y: CURVE_VIEW.height - 1 }, 'BIRTH'),
    svgEl('text', { class: 'curve-x-label', x: CURVE_VIEW.right, y: CURVE_VIEW.height - 1, 'text-anchor': 'end' }, 'DEATH')
  );

  const presetButtons = PARTICLE_CURVE_PRESETS.map(preset => el('button', {
    class: 'curve-preset', type: 'button', title: preset.label,
    'aria-label': `${label}: ${preset.label}`,
    onClick: ev => {
      ev.stopPropagation();
      onChange([...preset.values]);
    }
  }, svgEl('svg', { viewBox: '0 0 24 12', 'aria-hidden': 'true' },
    svgEl('path', { d: miniCurvePath(preset.values) }))));

  const updateGraph = nextValues => {
    const next = normalizeParticleCurve(nextValues);
    fill.setAttribute('d', curvePath(next, true));
    line.setAttribute('d', curvePath(next));
    presetButtons.forEach((button, i) => {
      const active = sameCurve(next, PARTICLE_CURVE_PRESETS[i].values);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };

  const valueAtPointer = ev => {
    const rect = graph.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = clamp((ev.clientX - rect.left) / rect.width * CURVE_VIEW.width,
      CURVE_VIEW.left, CURVE_VIEW.right);
    const y = clamp((ev.clientY - rect.top) / rect.height * CURVE_VIEW.height,
      CURVE_VIEW.top, CURVE_VIEW.bottom);
    return {
      index: Math.round((x - CURVE_VIEW.left) / (CURVE_VIEW.right - CURVE_VIEW.left) * (PARTICLE_CURVE_POINTS - 1)),
      value: clamp(1 - (y - CURVE_VIEW.top) / (CURVE_VIEW.bottom - CURVE_VIEW.top), 0, 1)
    };
  };

  const applyPointer = ev => {
    const gesture = activeCurveGesture;
    if (!gesture || gesture.graph !== graph) return;
    const point = valueAtPointer(ev);
    if (!point) return;
    const { index, value } = point;
    if (gesture.lastIndex === null) {
      gesture.values[index] = value;
    } else if (gesture.lastIndex === index) {
      gesture.values[index] = value;
    } else {
      const distance = index - gesture.lastIndex;
      const from = Math.min(gesture.lastIndex, index);
      const to = Math.max(gesture.lastIndex, index);
      for (let i = from; i <= to; i++) {
        const t = (i - gesture.lastIndex) / distance;
        gesture.values[i] = gesture.lastValue + (value - gesture.lastValue) * t;
      }
    }
    gesture.lastIndex = index;
    gesture.lastValue = value;
    updateGraph(gesture.values);
    onChange(gesture.values.slice());
  };

  const finishPointer = () => {
    if (!activeCurveGesture || activeCurveGesture.graph !== graph) return;
    activeCurveGesture = null;
    renderParticlePanel();
  };

  graph.addEventListener('pointerdown', ev => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    const point = valueAtPointer(ev);
    if (!point) return;
    activeCurveGesture = {
      graph, values: normalizeParticleCurve(values).slice(),
      lastIndex: null, lastValue: point.value
    };
    graph.setPointerCapture?.(ev.pointerId);
    applyPointer(ev);
  });
  graph.addEventListener('pointermove', applyPointer);
  graph.addEventListener('pointerup', finishPointer);
  graph.addEventListener('pointercancel', finishPointer);
  graph.addEventListener('lostpointercapture', finishPointer);

  updateGraph(initial);
  return el('div', { class: 'curve-editor' },
    el('div', { class: 'flex items-center justify-between gap-2' },
      el('span', { class: 'lbl !mb-0' }, label),
      el('span', { class: 'curve-hint' }, 'drag to draw')),
    el('div', { class: 'flex items-stretch gap-1.5' },
      graph,
      el('div', { class: 'curve-presets', 'aria-label': `${label} presets` }, ...presetButtons)));
}

function renderEmitterList() {
  const host = $('#emitterList');
  if (!host) return;
  const list = particleEmitters();
  const current = activeEmitterId();
  const on = list.filter(e => e.on).length;
  $('#particleChip').textContent = list.length
    ? `${list.length} emitter${list.length === 1 ? '' : 's'}${on === list.length ? '' : ` · ${on} on`}`
    : 'none';

  host.replaceChildren();
  list.forEach((e, i) => host.append(el('div', {
    class: 'stage-row' + (current === e.id ? ' is-active' : ''),
    style: { '--role': e.colorA },
    onClick: () => selectEmitter(e.id)
  },
    el('span', {
      class: 'w-1 h-5 rounded-full shrink-0',
      style: { background: e.on ? e.colorA : '#3f4653' }
    }),
    el('span', { class: 'flex-1 min-w-0' },
      el('div', { class: 'truncate text-[11px] leading-tight ' + (e.on ? 'text-zinc-300' : 'text-zinc-600') },
        emitterLabel(e, i)),
      el('div', { class: 'text-[9px] font-mono text-zinc-600 leading-tight' },
        `${e.start.toFixed(2)}–${e.end.toFixed(2)}s · ${Math.round(e.rate)}/s · ` +
        `${PARTICLE_ORIGINS.find(o => o.id === e.origin)?.label ?? e.origin}`)),
    el('input', {
      type: 'checkbox', class: 'accent-amber-500 shrink-0', checked: e.on,
      title: 'Mute this emitter',
      onClick: ev => ev.stopPropagation(),
      onChange: ev => updateEmitter(e.id, { on: ev.target.checked })
    }),
    el('button', {
      class: 'btn btn-ghost !px-1 !py-0.5 text-zinc-600 hover:text-red-400 shrink-0',
      title: 'Delete emitter',
      onClick: ev => { ev.stopPropagation(); removeParticleEmitter(e.id); }
    }, '✕')
  )));

  if (!list.length) {
    host.append(el('p', { class: 'text-[10px] text-zinc-600 py-2 text-center' },
      'No emitters yet — add one to start shedding particles.'));
  }
}

/** Start / end of one emitter's window, with in- and out-points at the playhead. */
function emitterWindow(s) {
  const timeInput = (key, min, max) => el('input', {
    type: 'number', step: '0.05', min, max, value: round(s[key], 2),
    class: 'inp !py-1 font-mono text-[11px]',
    onChange: e => {
      const v = Number(e.target.value);
      updateEmitter(s.id, Number.isFinite(v) ? { [key]: v } : {});
    }
  });
  return el('div', {},
    el('span', { class: 'lbl' }, 'Live from → to'),
    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      timeInput('start', 0, state.project.duration),
      timeInput('end', 0.05, state.project.duration)),
    el('div', { class: 'grid grid-cols-2 gap-1.5 mt-1.5' },
      el('button', {
        class: 'btn !py-1 !text-[10px]', title: 'Open this emitter at the playhead',
        onClick: () => updateEmitter(s.id, { start: Math.min(state.ui.time, s.end - 0.05) })
      }, 'In at playhead'),
      el('button', {
        class: 'btn !py-1 !text-[10px]', title: 'Close this emitter at the playhead',
        onClick: () => updateEmitter(s.id, { end: Math.max(state.ui.time, s.start + 0.05) })
      }, 'Out at playhead')));
}

function renderParticlePanel(force = false) {
  renderEmitterList();
  const host = $('#particlePanel');
  if (!host || (!force && holdsFocus(host)) || activeCurveGesture) return; // keep a live graph gesture intact

  // Only the emitter list stays up front; the settings themselves wait until an
  // emitter track is the selection, the way the Camera panel does.
  const s = state.ui.sel?.type === 'particle'
    ? particleEmitters().find(e => e.id === state.ui.sel.id) ?? null
    : null;
  host.classList.toggle('hidden', !s);
  $('#particleHint')?.classList.toggle('hidden', !!s || !particleEmitters().length);
  host.replaceChildren();
  if (!s) return;

  const set = props => updateEmitter(s.id, props);
  const sl = (label, key, min, max, step, hint = null) =>
    slider(label, s[key], min, max, step, v => set({ [key]: v }), hint);

  const directional = s.origin !== 'area' && s.origin !== 'outline';

  host.append(
    el('div', { class: 'pt-1 border-t border-line/70' },
      field('Name', el('input', {
        class: 'inp', value: s.name, spellcheck: 'false', placeholder: 'Emitter',
        onChange: e => set({ name: e.target.value })
      }))),

    emitterWindow(s),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      selectField('Shape', s.shape, PARTICLE_SHAPES, v => set({ shape: v })),
      selectField('Born from', s.origin, PARTICLE_ORIGINS, v => set({ origin: v }))),

    field(s.origin === 'point' || s.origin === 'box' ? 'Emitter position' : 'Emitter offset',
      el('div', { class: 'space-y-1.5' },
        positionFields(s, props => set(props)),
        el('button', {
          class: 'btn w-full',
          title: s.origin === 'point' || s.origin === 'box'
            ? 'Place this emitter on the current camera frame'
            : 'Offset this emitter onto the current camera frame',
          onClick: () => {
            alignEmitterWithCamera(s.id);
            renderParticlePanel();
          }
        }, 'Align with camera'))),

    // The box is centred on the emitter position, so its size sits with it.
    s.origin !== 'box' ? null : field('Box size \u00b7 scene units',
      el('div', { class: 'space-y-1.5' },
        numberFields([['w', 'boxW'], ['h', 'boxH'], ['d', 'boxD']], s, props => set(props)),
        el('button', {
          class: 'btn w-full', title: 'Match the box to the composition frame',
          onClick: () => set({ boxW: state.project.width, boxH: state.project.height })
        }, 'Fit to frame'))),

    sl('Rate', 'rate', 0, 400, 1, 'per second'),
    sl('Burst on beat', 'burst', 0, 200, 1),
    sl('Lifetime', 'life', 0.1, 6, 0.05, 'seconds'),
    sl('Size', 'size', 0.5, 120, 0.5),
    curveEditor('Size over life', s.sizeOverLife, values => set({ sizeOverLife: values })),
    sl('Speed', 'speed', 0, 2000, 5),
    sl('Motion blur', 'motionBlur', 0, 0.25, 0.005, 'shutter seconds'),
    directional ? sl('Direction', 'direction', 0, 360, 1, 'degrees') : null,
    sl('Spread', 'spread', 0, 1, 0.01),
    sl('Gravity', 'gravity', -1500, 1500, 5),
    sl('Wind', 'wind', -1500, 1500, 5),
    sl('Drag', 'drag', 0, 6, 0.01),
    sl('Turbulence', 'turbulence', 0, 800, 1),
    sl('Spin', 'spin', 0, 12, 0.05),
    s.origin === 'box' ? null : sl('Depth spread', 'spawnDepth', 0, 2000, 5),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      colorField('Newborn', s.colorA, v => set({ colorA: v })),
      colorField('Dying', s.colorB, v => set({ colorB: v }))),
    sl('Opacity', 'opacity', 0, 1, 0.01),
    curveEditor('Opacity over life', s.opacityOverLife, values => set({ opacityOverLife: values })),
    el('label', { class: 'tog' },
      el('input', {
        type: 'checkbox', class: 'accent-amber-500', checked: s.additive,
        onChange: e => set({ additive: e.target.checked })
      }), ' Additive blending'),

    el('div', { class: 'pt-1.5 border-t border-line/70 space-y-2.5' },
      selectField('Text outlines', s.textMode, TEXT_MODES, v => set({ textMode: v })),
      s.textMode === 'none' ? null : sl('Influence radius', 'textRadius', 4, 600, 1),
      s.textMode === 'collide' ? sl('Bounce', 'bounce', 0, 1, 0.01) : null,
      s.textMode === 'none' || s.textMode === 'collide' ? null : sl('Force', 'textForce', 0, 6000, 10),
      el('p', { class: 'text-[10px] leading-relaxed text-zinc-600' },
        'Particles read the live glyph contours — counters and every stroke included — so they answer to whatever the effects are doing to the letterforms at that moment.')),

    el('div', { class: 'flex gap-1.5' },
      el('button', {
        class: 'btn flex-1',
        onClick: () => set({ seed: 1 + Math.floor(Math.random() * 999999) })
      }, 'Reseed'))
  );
}

// ══ look ═════════════════════════════════════════════════════
function renderBackdropPanel() {
  const host = $('#backdropEditor');
  if (!host || holdsFocus(host)) return;
  const b = backdrop();
  const keys = backdropKeys();
  const key = selectedBackdropKey();
  const target = key ?? b;
  const live = backdropAt(b, state.ui.time);
  const modeLabel = BACKDROP_MODES.find(item => item.id === b.mode)?.label ?? b.mode;
  const setValue = props => {
    const current = selectedBackdropKey();
    if (current) updateBackdropKey(current.id, props);
    else setBackdrop(props);
  };
  const setColor = (index, color) => {
    const colors = [...target.colors];
    colors[index] = color;
    setValue({ colors });
  };
  const color = (label, index) => colorField(label, target.colors[index], value => setColor(index, value));
  const keyLabel = key
    ? `Key ${keys.indexOf(key) + 1} · ${key.t.toFixed(2)}s`
    : keys.length ? 'Base look · select a key to edit it' : 'Base look';

  const keyList = el('div', { class: 'space-y-1' });
  if (!keys.length) {
    keyList.append(el('p', { class: 'text-[10px] text-zinc-600' },
      'No keyframes yet — add one here or double-click the BG track.'));
  } else {
    keys.forEach((item, index) => {
      const active = item.id === key?.id;
      const row = el('div', {
        class: 'flex items-center gap-1 rounded border px-1.5 py-1 ' +
          (active ? 'border-zinc-300/60 bg-base-600' : 'border-line bg-base-900'),
        onClick: () => selectBackdropKey(item.id)
      },
        el('span', {
          class: 'w-3 h-3 rotate-45 shrink-0 border border-black/60',
          style: { background: backdropCss({ ...item, mode: b.mode }) },
          title: `Backdrop key ${index + 1}`
        }),
        el('input', {
          type: 'number', step: '0.05', min: 0, max: state.project.duration,
          value: round(item.t, 2), title: 'Key time',
          class: 'inp !w-[70px] !py-0.5 !text-[10px] font-mono text-center',
          onChange: e => {
            updateBackdropKey(item.id, {
              t: clamp(+e.target.value || 0, 0, state.project.duration)
            });
            e.target.blur();
            renderBackdropPanel();
            app.timeline.draw();
          }
        }),
        el('span', { class: 'text-[9px] text-zinc-600' }, 's'),
        el('span', { class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-500' },
          item.id === key?.id ? keyLabel : `Key ${index + 1}`),
        el('select', {
          class: 'sel !w-[76px] !py-0.5 !text-[10px]', title: 'Easing out of this key',
          onChange: e => updateBackdropKey(item.id, { ease: e.target.value })
        }, ...Object.entries(EASES).map(([id, ease]) =>
          el('option', { value: id, selected: item.ease === id }, ease.label))),
        el('button', {
          class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Delete this backdrop key',
          onClick: e => { e.stopPropagation(); removeBackdropKey(item.id); app.timeline.draw(); }
        }, '✕')
      );
      keyList.append(row);
    });
  }

  const colors = b.mode === 'solid'
    ? color('Colour', 0)
    : b.mode === 'four-point'
      ? el('div', { class: 'grid grid-cols-2 gap-2' },
          color('Top left', 0), color('Top right', 1), color('Bottom left', 2), color('Bottom right', 3))
      : el('div', { class: 'grid grid-cols-2 gap-2' }, color('Start', 0), color('End', 1));

  host.replaceChildren(...[
    el('div', { class: 'flex items-center justify-between' },
      el('span', { class: 'text-[10px] uppercase tracking-wider text-zinc-500' }, 'Backdrop colour'),
      el('span', { class: 'chip' }, `${keys.length} key${keys.length === 1 ? '' : 's'}`)),

    el('div', { class: 'rounded-md border border-line bg-base-900 p-2 space-y-2' },
      el('div', { id: 'backdropPreview', class: 'h-12 rounded border border-white/10 shadow-inner', style: { background: backdropCss(live) },
                 title: `Backdrop at ${state.ui.time.toFixed(2)}s` }),
      el('div', { class: 'flex items-center gap-1.5' },
        el('span', { id: 'backdropCurrentLabel', class: 'flex-1 min-w-0 truncate text-[10px] text-zinc-400' }, keyLabel),
        el('button', {
          class: 'btn !px-1.5 !py-1 !text-[10px]', title: 'Add or select a key at the playhead',
          onClick: () => { addBackdropKey(state.ui.time); app.timeline.draw(); renderBackdropPanel(); }
        }, '+ Keyframe')),
      el('div', { class: 'grid grid-cols-2 gap-1.5' },
        el('button', {
          class: 'btn !py-1 !text-[10px]', title: 'Select the backdrop track',
          onClick: () => { selectBackdropTrack(); renderBackdropPanel(); }
        }, 'Edit base'),
        el('button', {
          class: 'btn !py-1 !text-[10px] hover:!text-red-400', title: 'Remove all backdrop colour keys',
          onClick: () => { clearBackdropTrack(); app.timeline.draw(); }
        }, 'Clear keys'))),

    selectField('Type', b.mode, BACKDROP_MODES, mode => {
      document.activeElement?.blur();
      setBackdrop({ mode });
      renderBackdropPanel();
      app.timeline.draw();
    }),

    colors,
    b.mode === 'linear'
      ? slider('Angle', target.angle, 0, 360, 1, value => setValue({ angle: value }), 'degrees')
      : null,
    b.mode === 'radial'
      ? el('div', { class: 'space-y-2.5' },
          slider('Center X', target.center.x * 100, 0, 100, 1, value => setValue({ center: { x: value / 100 } }), '%'),
          slider('Center Y', target.center.y * 100, 0, 100, 1, value => setValue({ center: { y: value / 100 } }), '%'),
          slider('Radius', target.radius, 0.1, 2, 0.01, value => setValue({ radius: value }), 'frame units'))
      : null,
    el('div', { class: 'pt-1 border-t border-line/70' }, keyList),
    el('p', { class: 'text-[10px] leading-relaxed text-zinc-600' },
      `${modeLabel} is rendered behind backdrop video. Add a key at one time, change its colours, then add another key to transition between them.`)
  ].filter(Boolean));
}

function syncBackdropPreview() {
  const preview = $('#backdropPreview');
  if (!preview) return;
  const live = backdropAt(backdrop(), state.ui.time);
  preview.style.background = backdropCss(live);
  preview.title = `Backdrop at ${state.ui.time.toFixed(2)}s`;
}

function buildLookPanel() {
  const p = state.project;
  const bind = (id, key, after = null) => {
    const range = $(id);
    range.value = p[key];
    linkRange(range, $(id + 'Val'), v => { p[key] = v; emit('render'); after?.(); });
  };
  bind('#vignette', 'vignette');
  bind('#grain', 'grain');
  bind('#depth', 'depth', () => app.renderer.invalidate());

  renderBackdropPanel();

  $('#tSafe').addEventListener('change', e => {
    state.ui.safeArea = e.target.checked;
    syncViewMode();
  });
}

// ══ transport ════════════════════════════════════════════════
function buildTransport() {
  $('#btnPlay').addEventListener('click', () => app.togglePlay());
  $('#btnStop').addEventListener('click', () => { app.pause(); app.seek(0); });
  $('#tLoop').addEventListener('change', e => { state.ui.loop = e.target.checked; });
  $('#btnZoomIn').addEventListener('click', () => app.timeline.zoomBy(1.6, state.ui.time));
  $('#btnZoomOut').addEventListener('click', () => app.timeline.zoomBy(1 / 1.6, state.ui.time));
  $('#btnZoomFit').addEventListener('click', () => app.timeline.fit());
}

export function syncPlayButton(playing) {
  $('#icPlay').classList.toggle('hidden', playing);
  $('#icPause').classList.toggle('hidden', !playing);
}

function syncTime() {
  const t = state.ui.time;
  $('#timeNow').textContent = fmtTime(t);
  $('#frameNow').textContent = `f ${Math.round(t * state.project.fps)}`;
  const macro = regionAt(level('overall'), t);
  const micro = regionAt(level('animation'), t);
  const live = clips().filter(c => clipLive(c, t, state.project)).length;
  const chip = $('#vpStage');
  chip.textContent = `${macro ? ROLES[macro.role].cn : '–'} / ${micro ? ROLES[micro.role].cn : '–'} · ${live} live`;
  chip.style.color = ROLES[(micro ?? macro ?? { role: 'cheng' }).role].color;
}

// ══ keyboard ═════════════════════════════════════════════════
function buildShortcuts() {
  window.addEventListener('keydown', e => {
    const active = document.activeElement;
    const tag = active?.tagName;
    const isSlider = tag === 'INPUT' && active.type === 'range';
    const inField = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !isSlider);

    // Undo is the one shortcut a slider must not swallow. Inside a text field
    // the browser's own undo is the better one, so leave that alone.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && 'zy'.includes(e.key.toLowerCase())) {
      if (inField) return;
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
      app.timeline.draw();
      return;
    }

    // text fields and menus swallow everything
    if (inField) return;

    // a focused slider owns the arrow keys; Esc hands the keyboard back to the
    // timeline, and space still plays because a range does nothing with it
    if (isSlider) {
      if (e.key === 'Escape') { e.preventDefault(); active.blur(); }
      else if (e.key === ' ') { e.preventDefault(); app.togglePlay(); }
      return;
    }

    const frame = 1 / state.project.fps;
    const clip = selectedClip();
    const emitter = state.ui.sel?.type === 'particle' ? selectedEmitter() : null;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (clip) duplicateClip(clip.id);
      else if (emitter) duplicateParticleEmitter(emitter.id);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (!clip && !emitter) return;
      e.preventDefault();
      if (clip) copySelectedClipToClipboard();
      else copySelectedEmitterToClipboard();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      if (clip && clipClipboard) {
        e.preventDefault();
        pasteClipData(clipClipboard);
        return;
      }
      if (emitter) {
        e.preventDefault();
        pasteEmitterFromClipboard();
        return;
      }
    }
    switch (e.key) {
      case ' ': e.preventDefault(); app.togglePlay(); break;
      case 'Home': app.seek(0); break;
      case 'End': app.seek(state.project.duration); break;
      case 'ArrowLeft': e.preventDefault(); app.seek(state.ui.time - (e.shiftKey ? frame * 10 : frame)); break;
      case 'ArrowRight': e.preventDefault(); app.seek(state.ui.time + (e.shiftKey ? frame * 10 : frame)); break;
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        const list = clipsInOrder();
        if (!list.length) break;
        const i = list.findIndex(c => c.id === state.ui.sel?.id);
        const n = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1);
        select('clip', list[i < 0 ? 0 : n].id);
        break;
      }
      case 'Backspace': case 'Delete': {
        const ck = selectedCamKey();
        const avk = selectedAudioVolumeKey();
        if (ck) { e.preventDefault(); removeCameraKey(ck.id, selectedCamAxis()); app.timeline.draw(); }
        else if (avk) {
          e.preventDefault();
          const sel = state.ui.sel;
          removeAudioVolumeKey(sel.kind, sel.id, sel.keyId);
          app.timeline.draw();
        }
        else if (selectedBackdropKey()) {
          e.preventDefault();
          removeBackdropKey(selectedBackdropKey().id);
          app.timeline.draw();
        } else if (clip) {
          e.preventDefault();
          for (const c of selectedClips()) removeClip(c.id);
          app.timeline.draw();
        }
        break;
      }
      case '[': if (clip) app.seek(clip.start); break;
      case ']': if (clip) app.seek(Math.max(0, clip.end - frame)); break;
      case 'Escape': {
        const sel = state.ui.sel;
        if (sel?.type === 'guide' && (sel.ids?.length ?? 1) > 1) select('guide', sel.id, sel.level);
        else if (sel?.type === 'clip' && (sel.ids?.length ?? 1) > 1) {
          selectClip(sel.id, 'set');
          app.timeline.draw();
        }
        break;
      }
      case 'f': app.timeline.fit(); break;
      case 'n': {
        const t = state.ui.time;
        const region = drivingRegion(state.project.levels, t);
        addClip(t, Math.min(state.project.duration, Math.min(region.end || t + 4, t + 4)), 0);
        break;
      }
      case 'l': state.ui.loop = !state.ui.loop; $('#tLoop').checked = state.ui.loop; break;
      case 'm': app.setMetroEnabled(!state.metro.on); break;
      case 'k': addCameraKey(state.ui.time); app.timeline.draw(); break;
    }
  });
}
