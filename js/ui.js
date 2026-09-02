// Panel wiring. Everything here reads and writes the store; nothing else touches the DOM.

import { state, level, guides, clips, selectedClip, selectedGuide, selectedGuideIds,
         selectedGuideIndices, select, selectGuide, on, emit, patch,
         setRepeats, setDuration, updateClip, commitGuides, addClip, reframe,
         duplicateClip, removeClip, serialize, deserialize, track, anyAudio,
         setTrackStart, setTrackLevel, setHitParams, syncBeatTimes,
         beatTimes, barTimes, setMetro, hasGrid, camera, cameraKeys, selectedCamKey,
         addCameraKey, updateCameraKey, removeCameraKey, setCameraEnabled, commitCameraKeys,
         FONT_SLOTS, DIM_PRESETS,
         TRACKS, MIN_CLIP } from './state.js';
import { VOICES } from './audio/metronome.js';
import { EASES, cameraAt, CAMERA_REST } from './camera.js';
import { TRACK_KINDS } from './audio/engine.js';
import { ROLES, LEVELS, LEVEL_KEYS, patternLabel, rebalanceGuides, guideDisplay, guideHandles,
         regionAt, drivingRegion, normalizeGuides, scaleRange, distributeRange } from './structure.js';
import { EFFECTS, effectsForRole, effectIds, resolveParams } from './effects.js';
import { FONT_PRESETS } from './typography.js';
import { $, el, fmtTime, fmtDur, clamp, download, toast, nearest, round } from './util.js';

let app;

export function initUI(ctx) {
  app = ctx;
  buildTopBar();
  buildStructure();
  buildLayers();
  buildAudioPanel();
  buildMetroPanel();
  buildFontPanel();
  buildCameraPanel();
  buildLookPanel();
  buildTransport();
  buildShortcuts();

  on('project duration', syncTopBar);
  on('guides duration', () => { renderPattern(); syncInspector(); });
  on('clips duration', () => { renderClipList(); syncInspector(); });
  on('selection', () => { renderPattern(); renderClipList(); buildInspector(); renderCameraPanel(); });
  on('camera', renderCameraPanel);
  on('clip', () => { renderClipList(); });
  on('audio audioMove audioLevel hits', syncAudioPanel);
  on('metro grid audio', syncMetroPanel);
  on('fonts', syncFontPanel);
  on('time clips clip guides audioMove', syncTime);

  syncTopBar();
  renderPattern();
  renderClipList();
  buildInspector();
  renderCameraPanel();
  syncAudioPanel();
  syncMetroPanel();
  syncFontPanel();
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
  $('#projFile').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { deserialize(JSON.parse(await f.text())); app.timeline.fit(); toast('Project loaded'); }
    catch { toast('Could not read that file'); }
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

    el('div', { class: 'grid grid-cols-2 gap-2' },
      slider('Offset X', clip.offsetX, -0.5, 0.5, 0.005, v => updateClip(clip.id, { offsetX: v })),
      slider('Offset Y', clip.offsetY, -0.5, 0.5, 0.005, v => updateClip(clip.id, { offsetY: v }))),

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
  builtFor = 'run:' + lv.key + ':' + picked.join(',');
  $('#inspTitle').textContent = 'Reference lines';
  $('#inspChip').textContent = `${meta.cn} · ${picked.length} points`;

  const labels = picked.map(i => guideDisplay(lv.guides, i));

  host.append(
    el('div', { class: 'rounded-md border border-line bg-base-900 p-2 space-y-1.5' },
      el('div', { class: 'flex flex-wrap gap-1' },
        ...labels.map((d, k) => el('span', {
          class: 'px-1.5 py-0.5 rounded text-[10px] font-semibold',
          style: { background: d.colors.at(-1) + '22', color: d.colors.at(-1) }
        }, d.label + (k < labels.length - 1 ? '' : '')))),
      el('p', { class: 'text-[10px] leading-snug text-zinc-500' },
        'Drag either end point to rescale the run by ratio; drag one in the middle to slide it. ',
        'Points outside the run stay put.')),

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

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', {
        class: 'btn', title: 'Space the points inside the run evenly',
        onClick: () => {
          if (distributeRange(lv, i0, i1)) { commitGuides(lv.key); app.timeline.draw(); buildInspector(); toast('Points distributed evenly'); }
          else toast('Not enough points to distribute');
        }
      }, 'Distribute'),
      el('button', { class: 'btn', onClick: () => select(null, null) }, 'Clear selection')),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => app.seek(from) }, 'Go to start'),
      el('button', { class: 'btn', onClick: () => app.playRange(from, to) }, 'Preview run'))
  );
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

const fmtNum = v => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

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
      if (builtFor !== 'run:' + lv.key + ':' + picked.join(',')) { buildInspector(); return; }
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

// ══ audio ════════════════════════════════════════════════════
function buildAudioPanel() {
  $('#audioFile').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) app.importAudio(f, e.target.dataset.kind || 'bgm');
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
  if (!host) return;
  host.replaceChildren();

  for (const meta of TRACK_KINDS) {
    const tr = track(meta.kind);
    const pick = () => { const inp = $('#audioFile'); inp.dataset.kind = meta.kind; inp.click(); };

    const head = el('div', { class: 'flex items-center gap-1.5' },
      el('span', {
        class: 'w-9 shrink-0 text-[9px] font-mono uppercase tracking-wider ' +
               (tr.ready ? 'text-zinc-300' : 'text-zinc-600')
      }, meta.short),
      tr.ready
        ? el('span', { class: 'flex-1 min-w-0 truncate text-[11px] text-zinc-300', title: tr.name }, tr.name)
        : el('button', { class: 'btn flex-1 !py-1 !text-[11px]', onClick: pick }, `Import ${meta.label.toLowerCase()}…`),
      tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 ' + (tr.mute ? '!text-red-400' : ''),
        title: tr.mute ? 'Unmute' : 'Mute',
        onClick: () => { setTrackLevel(meta.kind, { mute: !tr.mute }); renderAudioLanes(); app.timeline.draw(); }
      }, tr.mute ? '⨯' : '♪') : null,
      tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6', title: 'Replace', onClick: pick
      }, '⤒') : null,
      tr.ready ? el('button', {
        class: 'btn btn-sq !w-6 !h-6 hover:!text-red-400', title: 'Remove',
        onClick: () => app.clearAudio(meta.kind)
      }, '✕') : null
    );

    const body = tr.ready
      ? el('div', { class: 'flex items-center gap-1.5 pl-9' },
          el('input', {
            type: 'range', min: 0, max: 1.5, step: 0.01, value: tr.volume, class: 'flex-1',
            title: 'Level',
            onInput: e => setTrackLevel(meta.kind, { volume: +e.target.value })
          }),
          el('input', {
            type: 'number', step: '0.05', value: round(tr.start, 2),
            class: 'inp !w-16 !py-0.5 !text-[10px] font-mono text-center',
            title: 'Start on the timeline — or drag the waveform',
            onChange: e => {
              setTrackStart(meta.kind, clamp(+e.target.value || 0, -tr.duration, state.project.duration));
              emit('audio', state.audio);
              app.timeline.draw();
            }
          }),
          el('span', { class: 'text-[9px] text-zinc-600' }, 's'))
      : null;

    host.append(el('div', {
      class: 'rounded-md border p-1.5 space-y-1 ' +
             (tr.ready ? 'border-line bg-base-900' : 'border-line/60 bg-base-900/40')
    }, head, body));
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
  const loaded = TRACK_KINDS.filter(k => track(k.kind).ready);

  $('#audioChip').textContent = loaded.length
    ? loaded.map(k => k.short).join(' · ')
    : 'no audio';
  $('#audioInfo').classList.toggle('hidden', !bgm.ready);
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
  $('#btnCamKey').addEventListener('click', () => { addCameraKey(state.ui.time); app.timeline.draw(); });
  $('#btnCamClear').addEventListener('click', () => {
    camera().keys.length = 0;
    if (state.ui.sel?.type === 'camkey') select(null, null);
    commitCameraKeys();
    app.timeline.draw();
    toast('Camera track cleared');
  });
}

function renderCameraPanel() {
  const cam = camera();
  const keys = cameraKeys();
  $('#camEnabled').checked = cam.enabled;
  $('#camChip').textContent = keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : 'no keys';

  const host = $('#camKeyPanel');
  host.replaceChildren();
  const key = selectedCamKey();

  if (!key) {
    const now = cameraAt(cam, state.ui.time);
    host.append(el('div', { class: 'rounded-md bg-base-900 border border-line p-2 text-[10px] font-mono text-zinc-500' },
      `now  x ${now.x.toFixed(3)}   y ${now.y.toFixed(3)}   zoom ${now.zoom.toFixed(2)}   roll ${(now.roll * 180 / Math.PI).toFixed(1)}°`));
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

    slider('Pan X', key.x, -1, 1, 0.005, v => upd({ x: v }), 'of frame'),
    slider('Pan Y', key.y, -1, 1, 0.005, v => upd({ y: v }), 'of frame'),
    slider('Zoom', key.zoom, 0.2, 4, 0.01, v => upd({ zoom: v })),
    slider('Roll', key.roll * 180 / Math.PI, -180, 180, 0.5, v => upd({ roll: v * Math.PI / 180 }), '°'),

    field('Easing out of this key', el('select', {
      class: 'sel', onChange: e => upd({ ease: e.target.value })
    }, ...Object.entries(EASES).map(([id, e]) =>
      el('option', { value: id, selected: key.ease === id }, e.label)))),

    el('div', { class: 'grid grid-cols-2 gap-1.5' },
      el('button', { class: 'btn', onClick: () => app.seek(key.t) }, 'Go to key'),
      el('button', { class: 'btn', onClick: () => { upd({ ...CAMERA_REST }); renderCameraPanel(); } }, 'Reset framing'))
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
    $('#safeArea').classList.toggle('hidden', !e.target.checked);
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
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const frame = 1 / state.project.fps;
    const clip = selectedClip();

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (clip) duplicateClip(clip.id);
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
        if (ck) { e.preventDefault(); removeCameraKey(ck.id); app.timeline.draw(); }
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
