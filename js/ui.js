// Panel wiring. Everything here reads and writes the store; nothing else touches the DOM.

import { state, level, guides, clips, selectedClip, selectedGuide, selectedGuideIds,
         selectedGuideIndices, select, selectGuide, on, emit, patch,
         setRepeats, setDuration, updateClip, commitGuides, addClip, reframe,
         duplicateClip, removeClip, serialize, deserialize, track, audioClips, anyAudio,
         setTrackStart, setTrackLevel, setAudioClipStart, setAudioClipLevel,
         setHitParams, syncBeatTimes,
         beatTimes, barTimes, setMetro, hasGrid, setRunPivot, runPivotIndex,
         videoClips, videoClip,
         setVideoClipStart, setVideoClipSettings,
         particleEmitters, selectedEmitter, selectEmitter, updateEmitter,
         addParticleEmitter, duplicateParticleEmitter, removeParticleEmitter,
         camera, cameraKeys, cameraMode, cameraChannelKeys, cameraKeyCount,
         selectedCamKey, selectedCamAxis,
         addCameraKey, addCameraChannelKey, setCameraChannelSpan,
         updateCameraKey, updateCameraChannelKey, removeCameraKey, removeCameraChannelKey,
         setCameraMode, setCameraEnabled, clearCameraTrack,
         selectCameraKey,
         alignClipWithCamera,
         copyClipData, pasteClip, CLIPBOARD_FORMAT,
         FONT_SLOTS, DIM_PRESETS,
         TRACKS, MIN_CLIP } from './state.js';
import { VOICES } from './audio/metronome.js';
import { EASES, cameraAt, defaultCameraPosition } from './camera.js';
import { TRACK_KINDS } from './audio/engine.js';
import { VIDEO_CHANNEL_KINDS, VIDEO_EFFECTS } from './video/engine.js';
import { PARTICLE_SHAPES, PARTICLE_ORIGINS, TEXT_MODES, MAX_EMITTERS } from './particles.js';
import { ROLES, LEVELS, LEVEL_KEYS, patternLabel, rebalanceGuides, guideDisplay, guideHandles,
         regionAt, drivingRegion, normalizeGuides, scaleRange, distributeRange, DISTRIBUTIONS } from './structure.js';
import { EFFECTS, effectsForRole, effectIds, resolveParams } from './effects.js';
import { FONT_PRESETS } from './typography.js';
import { $, el, fmtTime, fmtDur, clamp, download, toast, nearest, round } from './util.js';

let app;
let clipClipboard = null;

const PROJECT_FORMAT = 'kinetic-typography-composer';
const PROJECT_VERSION = 8;

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
  on('guides duration', () => { renderPattern(); syncInspector(); });
  on('clips duration', () => { renderClipList(); syncInspector(); });
  on('selection', () => { renderPattern(); renderClipList(); buildInspector(); renderCameraPanel(); });
  on('camera', renderCameraPanel);
  on('clip', () => { renderClipList(); });
  on('audio audioMove audioLevel hits', syncAudioPanel);
  on('video videoMove videoLevel', syncVideoPanel);
  on('particles project duration', renderParticlePanel);
  on('metro grid audio', syncMetroPanel);
  on('fonts', syncFontPanel);
  on('view', syncViewMode);
  on('time clips clip guides audioMove', syncTime);

  syncTopBar();
  renderPattern();
  renderClipList();
  renderVideoChannels();
  buildInspector();
  renderCameraPanel();
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

  $('#projName').addEventListener('input', e => { state.project.name = e.target.value; });

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

  $('#btnSave').addEventListener('click', () => {
    const name = (state.project.name || 'composition').replace(/[^\w\-. ]+/g, '_');
    download(`${name}.ktc.json`, new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' }));
    toast('Project saved');
  });
  $('#btnLoad').addEventListener('click', () => $('#projFile').click());
  const openProject = projectFile => {
    if (!projectFile || projectFile.format !== PROJECT_FORMAT) throw new Error('Not a composer file');
    // The project file stores media references, not browser-owned buffers.
    // Drop the current runtime sources before replacing their metadata so
    // audio from the previous project cannot keep playing after Open.
    for (const { kind } of TRACK_KINDS) app.clearAudio?.(kind);
    app.clearVideos?.();
    deserialize(projectFile);
    app.timeline.fit();
    toast('Project loaded — re-import saved audio and backdrop media to attach them');
  };

  $('#projFile').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      openProject(parseProjectFile(await f.text()));
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

function renderClipList() {
  const host = $('#clipList');
  host.replaceChildren();
  const list = clips();
  $('#clipChip').textContent = `${list.length} layer${list.length === 1 ? '' : 's'}`;

  [...list].sort((a, b) => a.start - b.start || a.track - b.track).forEach(c => {
    const role = ROLES[drivingRegion(state.project.levels, c.start).role];
    const on = state.ui.sel?.type === 'clip' && state.ui.sel.id === c.id;
    host.append(el('div', {
      class: 'stage-row' + (on ? ' is-active' : ''),
      style: { '--role': role.color },
      onClick: () => select('clip', c.id)
    },
      el('span', { class: 'w-1 h-5 rounded-full shrink-0', style: { background: role.color } }),
      el('span', { class: 'flex-1 min-w-0' },
        el('div', { class: 'truncate text-[11px] text-zinc-300 leading-tight' }, (c.text || '—').replace(/\n/g, ' ')),
        el('div', { class: 'text-[9px] font-mono text-zinc-600 leading-tight' },
          `T${c.track + 1} · ${c.start.toFixed(2)}–${c.end.toFixed(2)}s · ${EFFECTS[c.effect]?.label ?? c.effect}`)),
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
        : 'Select a layer on the timeline, or a 起承轉合 point to move a reference line.'));
    return;
  }

  builtFor = 'clip:' + clip.id + '|' + clip.effect;
  const drive = drivingRegion(state.project.levels, clip.start);
  const role = ROLES[drive.role];
  const macro = regionAt(level('overall'), clip.start);
  const micro = regionAt(level('animation'), clip.start);
  $('#inspTitle').textContent = 'Layer';
  $('#inspChip').textContent = `T${clip.track + 1} · ${EFFECTS[clip.effect]?.label ?? clip.effect}`;

  host.append(
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

    field('Text', el('textarea', {
      class: 'inp resize-y min-h-[62px] leading-snug', rows: 2, spellcheck: 'false',
      onInput: e => { updateClip(clip.id, { text: e.target.value }); app.timeline.draw(); }
    }, clip.text)),

    field('Effect', el('div', { class: 'flex gap-1.5' },
      el('select', { class: 'sel', onChange: e => { updateClip(clip.id, { effect: e.target.value, params: {} }); buildInspector(); app.timeline.draw(); } },
        ...groupedEffectOptions(clip, role.key)),
      el('button', {
        class: 'btn btn-sq', title: 'Try the next effect suited to this phase',
        onClick: () => {
          const list = effectsForRole(role.key);
          const next = list[(list.indexOf(clip.effect) + 1) % list.length];
          updateClip(clip.id, { effect: next, params: {} });
          buildInspector(); app.timeline.draw();
        }
      }, '⇄'))),

    ...paramSliders(clip),

    slider('Beat reaction', clip.beatReact, 0, 1, 0.01, v => updateClip(clip.id, { beatReact: v }),
           anyAudio() ? null : 'no audio yet'),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      field('Colour', el('input', {
        type: 'color', value: clip.color, class: 'w-full h-8 bg-base-900 border border-line rounded cursor-pointer',
        onInput: e => updateClip(clip.id, { color: e.target.value })
      })),
      field('Align', el('select', { class: 'sel', onChange: e => updateClip(clip.id, { align: e.target.value }) },
        ...['left', 'center', 'right'].map(a =>
          el('option', { value: a, selected: clip.align === a }, a[0].toUpperCase() + a.slice(1)))))),

    slider('Size', clip.size, 0.03, 0.9, 0.005, v => updateClip(clip.id, { size: v }), 'of short edge'),
    slider('Line height', clip.lineHeight, 0.6, 2.4, 0.01, v => updateClip(clip.id, { lineHeight: v })),
    slider('Letter spacing', clip.tracking, -0.3, 1, 0.005, v => updateClip(clip.id, { tracking: v })),

    field('Position · scene units', el('div', { class: 'space-y-1.5' },
      positionFields(clip.position,
        pos => updateClip(clip.id, { position: { ...(clip.position ?? {}), ...pos } })),
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
  );
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

function groupedEffectOptions(clip, roleKey) {
  const mine = effectsForRole(roleKey);
  const rest = effectIds().filter(id => !mine.includes(id));
  const opt = id => el('option', { value: id, selected: clip.effect === id }, EFFECTS[id].label);
  return [
    el('optgroup', { label: `Suited to ${ROLES[roleKey].cn}` }, ...mine.map(opt)),
    el('optgroup', { label: 'Other' }, ...rest.map(opt))
  ];
}

function paramSliders(clip) {
  const def = EFFECTS[clip.effect] ?? EFFECTS.hold;
  const p = resolveParams(clip.effect, clip.params);
  return def.params.map(pm =>
    slider(pm.label, p[pm.key], pm.min, pm.max, pm.step, v =>
      updateClip(clip.id, { params: { ...clip.params, [pm.key]: v } })));
}

function box(id, label) {
  return el('div', { class: 'rounded-md bg-base-900 border border-line py-1.5' },
    el('div', { id, class: 'text-[11px] font-semibold text-zinc-200 font-mono' }, '–'),
    el('div', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, label));
}

function field(label, node) {
  return el('div', {}, el('span', { class: 'lbl' }, label), node);
}

function slider(label, value, min, max, step, onChange, hint = null) {
  const val = el('span', { class: 'text-zinc-400 font-mono normal-case' }, fmtNum(value));
  return el('div', {},
    el('span', { class: 'lbl flex items-center justify-between' },
      el('span', {}, label, hint ? el('span', { class: 'text-zinc-700 ml-1 normal-case' }, `(${hint})`) : null),
      val),
    el('input', {
      type: 'range', min, max, step, value, class: 'w-full',
      onInput: e => { const v = +e.target.value; val.textContent = fmtNum(v); onChange(v); }
    }));
}

/** Three editable world-space coordinates shared by text and camera objects. */
function positionFields(position = {}, onChange) {
  const p = { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 };
  return el('div', { class: 'grid grid-cols-3 gap-1.5' },
    ...['x', 'y', 'z'].map(axis => el('label', { class: 'block' },
      el('span', { class: 'text-[9px] uppercase tracking-wider text-zinc-600' }, axis),
      el('input', {
        type: 'number', step: '0.1', value: round(p[axis], 1),
        class: 'inp !py-1 font-mono text-[11px]',
        onChange: e => onChange({ [axis]: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0 })
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
    if (builtFor !== 'clip:' + clip.id + '|' + clip.effect) { buildInspector(); return; }
    set('#inspStart', fmtTime(clip.start));
    set('#inspLen', `${(clip.end - clip.start).toFixed(2)}s`);
    set('#inspEnd', fmtTime(clip.end));
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

  const pick = (kind, replaceId = null) => {
    const inp = $('#videoFile');
    inp.dataset.kind = kind;
    inp.dataset.replaceId = replaceId ?? '';
    inp.multiple = !replaceId;
    inp.click();
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
          onClick: () => pick(meta.kind, clip.id)
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
    const files = [...(e.target.files ?? [])];
    // Music stays a single source; VO/SFX may be inserted as a batch.
    const chosen = kind === 'bgm' ? files.slice(0, 1) : files;
    chosen.reduce((chain, file) => chain.then(() => app.importAudio(file, kind)), Promise.resolve());
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

function renderAudioLanes() {
  const host = $('#audioLanes');
  if (!host || holdsFocus(host)) return;      // a fader is being driven — leave it be
  host.replaceChildren();

  for (const meta of TRACK_KINDS) {
    const isBgm = meta.kind === 'bgm';
    const tr = isBgm ? track('bgm') : null;
    const lane = audioClips(meta.kind);
    const loaded = lane.filter(clip => clip.ready);
    const pick = () => {
      const inp = $('#audioFile');
      inp.dataset.kind = meta.kind;
      inp.multiple = !isBgm;
      inp.click();
    };

    const head = el('div', { class: 'flex items-center gap-1.5' },
      el('span', {
        class: 'w-9 shrink-0 text-[9px] font-mono uppercase tracking-wider ' +
               (loaded.length ? 'text-zinc-300' : 'text-zinc-600')
      }, meta.short),
      isBgm && tr.ready
        ? el('span', { class: 'flex-1 min-w-0 truncate text-[11px] text-zinc-300', title: tr.name }, tr.name)
        : el('button', {
          class: 'btn flex-1 !py-1 !text-[11px]', onClick: pick,
          title: isBgm ? `Import ${meta.label.toLowerCase()}` : `Add another ${meta.label.toLowerCase()} clip`
        }, isBgm ? `Import ${meta.label.toLowerCase()}…` : `${loaded.length ? 'Add' : 'Import'} ${meta.label.toLowerCase()}…`),
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 ' + (tr.mute ? '!text-red-400' : ''),
        title: tr.mute ? 'Unmute' : 'Mute',
        onClick: () => { setTrackLevel(meta.kind, { mute: !tr.mute }); renderAudioLanes(); app.timeline.draw(); }
      }, tr.mute ? '⨯' : '♪') : null,
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6', title: 'Replace', onClick: pick
      }, '⤒') : null,
      isBgm && tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Remove',
        onClick: () => app.clearAudio(meta.kind)
      }, '✕') : null
    );

    const body = loaded.map(clip => {
      const controls = el('div', { class: 'pl-9 space-y-1.5' });
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
          type: 'range', min: 0, max: 1.5, step: 0.01, value: clip.volume, class: 'flex-1',
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
  const loaded = TRACK_KINDS.map(meta => ({ meta, count: audioClips(meta.kind).filter(clip => clip.ready).length }))
    .filter(({ count }) => count > 0);

  $('#audioChip').textContent = loaded.length
    ? loaded.map(({ meta, count }) => `${meta.short}${count > 1 ? ` ×${count}` : ''}`).join(' · ')
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
    if (f) app.loadFontFile(f, +e.target.dataset.slot || 0);
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
  renderParticlePanel();
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

function renderEmitterList() {
  const host = $('#emitterList');
  if (!host) return;
  const list = particleEmitters();
  const current = selectedEmitter();
  const on = list.filter(e => e.on).length;
  $('#particleChip').textContent = list.length
    ? `${list.length} emitter${list.length === 1 ? '' : 's'}${on === list.length ? '' : ` · ${on} on`}`
    : 'none';

  host.replaceChildren();
  list.forEach((e, i) => host.append(el('div', {
    class: 'stage-row' + (current?.id === e.id ? ' is-active' : ''),
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

function renderParticlePanel() {
  renderEmitterList();
  const host = $('#particlePanel');
  if (!host || holdsFocus(host)) return;      // never rebuild under a dragged slider

  const s = selectedEmitter();
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

    field(s.origin === 'point' ? 'Emitter position' : 'Emitter offset',
      positionFields(s, props => set(props))),

    sl('Rate', 'rate', 0, 400, 1, 'per second'),
    sl('Burst on beat', 'burst', 0, 200, 1),
    sl('Lifetime', 'life', 0.1, 6, 0.05, 'seconds'),
    sl('Size', 'size', 0.5, 120, 0.5),
    sl('Speed', 'speed', 0, 2000, 5),
    directional ? sl('Direction', 'direction', 0, 360, 1, 'degrees') : null,
    sl('Spread', 'spread', 0, 1, 0.01),
    sl('Gravity', 'gravity', -1500, 1500, 5),
    sl('Wind', 'wind', -1500, 1500, 5),
    sl('Drag', 'drag', 0, 6, 0.01),
    sl('Turbulence', 'turbulence', 0, 800, 1),
    sl('Spin', 'spin', 0, 12, 0.05),
    sl('Depth spread', 'spawnDepth', 0, 2000, 5),

    el('div', { class: 'grid grid-cols-2 gap-2' },
      colorField('Newborn', s.colorA, v => set({ colorA: v })),
      colorField('Dying', s.colorB, v => set({ colorB: v }))),
    sl('Opacity', 'opacity', 0, 1, 0.01),
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
function buildLookPanel() {
  const p = state.project;
  const bind = (id, key, fmt) => {
    const n = $(id);
    n.value = p[key];
    const label = $(id + 'Val');
    const show = () => { if (label) label.textContent = fmt ? fmt(p[key]) : p[key]; };
    n.addEventListener('input', e => {
      p[key] = +e.target.value;
      show(); emit('render');
      if (key === 'depth') app.renderer.invalidate();
    });
    show();
  };
  $('#bgColor').value = p.bg;
  $('#bgColor').addEventListener('input', e => { p.bg = e.target.value; emit('render'); });
  bind('#vignette', 'vignette', v => v.toFixed(2));
  bind('#grain', 'grain', v => v.toFixed(3));
  bind('#depth', 'depth', v => `${v}px`);

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
  const live = clips().filter(c => t >= c.start && t < c.end).length;
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

    // text fields and menus swallow everything
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !isSlider)) return;

    // a focused slider owns the arrow keys; Esc hands the keyboard back to the
    // timeline, and space still plays because a range does nothing with it
    if (isSlider) {
      if (e.key === 'Escape') { e.preventDefault(); active.blur(); }
      else if (e.key === ' ') { e.preventDefault(); app.togglePlay(); }
      return;
    }

    const frame = 1 / state.project.fps;
    const clip = selectedClip();

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (clip) duplicateClip(clip.id);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (!clip) return;
      e.preventDefault();
      copySelectedClipToClipboard();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipClipboard) {
      e.preventDefault();
      pasteClipData(clipClipboard);
      return;
    }
    switch (e.key) {
      case ' ': e.preventDefault(); app.togglePlay(); break;
      case 'Home': app.seek(0); break;
      case 'End': app.seek(state.project.duration); break;
      case 'ArrowLeft': e.preventDefault(); app.seek(state.ui.time - (e.shiftKey ? frame * 10 : frame)); break;
      case 'ArrowRight': e.preventDefault(); app.seek(state.ui.time + (e.shiftKey ? frame * 10 : frame)); break;
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        const list = [...clips()].sort((a, b) => a.start - b.start);
        if (!list.length) break;
        const i = list.findIndex(c => c.id === state.ui.sel?.id);
        const n = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1);
        select('clip', list[i < 0 ? 0 : n].id);
        break;
      }
      case 'Backspace': case 'Delete': {
        const ck = selectedCamKey();
        if (ck) { e.preventDefault(); removeCameraKey(ck.id, selectedCamAxis()); app.timeline.draw(); }
        else if (clip) { e.preventDefault(); removeClip(clip.id); }
        break;
      }
      case '[': if (clip) app.seek(clip.start); break;
      case ']': if (clip) app.seek(Math.max(0, clip.end - frame)); break;
      case 'Escape': {
        const sel = state.ui.sel;
        if (sel?.type === 'guide' && (sel.ids?.length ?? 1) > 1) select('guide', sel.id, sel.level);
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
