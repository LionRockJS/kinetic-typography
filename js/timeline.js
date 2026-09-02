// The timeline.
//
// Three things share one time axis:
//
//   overall 起承轉合    the arc of the whole video — reference lines, no content
//   animation 起承轉合  the finer arc inside it, with its own span
//   clips               the text layers that actually render, on three tracks
//
// Guides are drawn straight through every lane the way a grid runs through a
// canvas. They carry nothing; they mark the shape of the piece and everything
// snaps to them.
//
//   drag a 起承轉合 point      → move that reference line
//   drag the animation ends   → move / stretch the animation arc
//   drag the end cap          → stretch the whole composition (⌥ keeps positions)
//   drag a clip               → move it (up/down changes track)
//   drag a clip edge          → trim it
//   double-click a track      → new clip in that phase
//   drag the ruler            → scrub · wheel → zoom · ⇧wheel → pan · ⇧drag → no snap

import { state, level, guides, clips, track, camera, cameraKeys, select, selectGuide,
         selectGuidesInRange, selectedGuideIds, selectedGuideIndices, setDuration,
         commitClips, commitGuides, commitCameraKeys, addClip, addCameraKey, updateCameraKey,
         setTrackStart, beatTimes, barTimes, emit, TRACKS, MIN_CLIP } from './state.js';
import { TRACK_KINDS } from './audio/engine.js';
import { ROLES, LEVELS, LEVEL_KEYS, guideDisplay, guideHandles, drivingRegion, headIsCombined,
         scaleFromHead, headRange, scaleRange, translateRange,
         normalizeGuides, reframeLevel, MIN_REGION } from './structure.js';
import { clamp, fmtTime, nearest } from './util.js';
import { cameraAt } from './camera.js';

const LANE = {
  ruler: [0, 18],
  beats: [18, 30],
  bgm:   [32, 64],
  vo:    [66, 86],
  sfx:   [88, 108],
  camera:    [112, 134],
  overall:   [138, 162],
  animation: [164, 186]
};
const AUDIO_LANES = ['bgm', 'vo', 'sfx'];
const KIND = Object.fromEntries(TRACK_KINDS.map(k => [k.kind, k]));
const ROW = {
  overall:   { lane: LANE.overall,   r: 10, font: 12, label: '整體 Overall' },
  animation: { lane: LANE.animation, r: 8,  font: 10, label: '動態 Animation' }
};
const TRACK_TOP = 192;
const TRACK_H = 26;
const TRACK_GAP = 4;
const HIT = 14;
const EDGE = 7;

export const TIMELINE_HEIGHT = TRACK_TOP + TRACKS * (TRACK_H + TRACK_GAP) + 6;

const rowCenter = key => (ROW[key].lane[0] + ROW[key].lane[1]) / 2;

export class Timeline {
  constructor(canvas, tipEl) {
    this.canvas = canvas;
    this.tip = tipEl;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0;
    this.hover = null;
    this.drag = null;
    canvas.style.height = `${TIMELINE_HEIGHT}px`;
    this._bind();
    this.resize();
  }

  // ── geometry ───────────────────────────────────────────────
  get view() { return state.ui.view; }
  get span() { return Math.max(1e-6, this.view.end - this.view.start); }
  x(t) { return (t - this.view.start) / this.span * this.w; }
  t(x) { return this.view.start + (x / this.w) * this.span; }
  get pxPerSec() { return this.w / this.span; }
  trackTop(i) { return TRACK_TOP + i * (TRACK_H + TRACK_GAP); }
  trackAt(y) {
    const i = Math.floor((y - TRACK_TOP) / (TRACK_H + TRACK_GAP));
    return i >= 0 && i < TRACKS ? i : -1;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** A little slack past the end so the stretch handle is always grabbable. */
  get viewMax() {
    const d = state.project.duration;
    return d + Math.max(0.3, d * 0.05);
  }

  fit() {
    state.ui.view = { start: 0, end: this.viewMax };
    this.draw();
  }

  zoomBy(k, anchorT = null) {
    const v = this.view;
    const a = anchorT ?? (v.start + v.end) / 2;
    const span = clamp(this.span / k, 0.25, this.viewMax * 1.5);
    let s = a - (a - v.start) * (span / this.span);
    let e = s + span;
    const max = this.viewMax;
    if (s < 0) { e -= s; s = 0; }
    if (e > max) { const d = e - max; e = max; s = Math.max(0, s - d); }
    state.ui.view = { start: s, end: e };
    this.draw();
  }

  // ── snapping ───────────────────────────────────────────────
  /** Overall guides first, then animation guides, then bars, beats, clip edges. */
  snap(t, { ignore = false, exceptClip = null, exceptGuide = null } = {}) {
    if (ignore) return { t, kind: null };
    const px = 9 / this.pxPerSec;
    const a = state.audio;

    if (state.ui.snapGuides) {
      for (const key of LEVEL_KEYS) {
        const times = guides(key).filter(g => g.id !== exceptGuide).map(g => g.t);
        const lv = level(key);
        if (lv) times.push(lv.start, lv.end);
        const hit = nearest(times.sort((x, y) => x - y), t, key === 'overall' ? px : px * 0.8);
        if (hit !== null) return { t: hit, kind: LEVELS[key].cn };
      }
    }
    if (state.ui.snap && a.times.length) {
      const bar = nearest(barTimes(), t, px);
      if (bar !== null) return { t: bar, kind: 'bar' };
    }
    if (state.ui.snapPeaks && a.hits.length) {
      const hit = nearest(a.hits, t, px * 0.85);
      if (hit !== null) return { t: hit, kind: 'peak' };
    }
    if (state.ui.snap && a.times.length) {
      const beat = nearest(beatTimes(), t, px * 0.7);
      if (beat !== null) return { t: beat, kind: 'beat' };
    }
    const edges = [];
    for (const c of clips()) if (c.id !== exceptClip) edges.push(c.start, c.end);
    edges.push(0, state.project.duration);
    const e = nearest(edges.sort((x, y) => x - y), t, px * 0.6);
    if (e !== null) return { t: e, kind: 'edge' };
    return { t, kind: null };
  }

  // ── hit testing ────────────────────────────────────────────
  hitTest(px, py) {
    for (const key of LEVEL_KEYS) {
      const [y0, y1] = ROW[key].lane;
      if (py < y0 - 4 || py > y1 + 4) continue;
      const lv = level(key);
      if (!lv) continue;

      if (key === 'overall') {
        if (Math.abs(px - this.x(state.project.duration)) <= HIT) return { type: 'end' };
      } else {
        if (Math.abs(px - this.x(lv.end)) <= 9) return { type: 'levelEdge', key, edge: 'end' };
        if (Math.abs(px - this.x(lv.start)) <= 9) return { type: 'levelEdge', key, edge: 'start' };
      }
      const gs = lv.guides;
      const handles = guideHandles(gs);
      for (let k = handles.length - 1; k >= 0; k--) {
        const i = handles[k];
        if (i === 0) continue;                        // folded into the 起承 handle
        if (Math.abs(px - this.x(gs[i].t)) <= HIT) return { type: 'guide', key, index: i };
      }
      return { type: 'guideLane', key };
    }

    const track = this.trackAt(py);
    if (track >= 0) {
      const t = this.t(px);
      const list = clips().filter(c => c.track === track);
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        const x0 = this.x(c.start), x1 = this.x(c.end);
        if (px >= x0 - 2 && px <= x1 + 2) {
          const edge = px - x0 <= EDGE ? 'start' : x1 - px <= EDGE ? 'end' : null;
          return { type: 'clip', id: c.id, edge, track };
        }
      }
      return { type: 'track', track, t };
    }
    if (py <= LANE.beats[1]) return { type: 'ruler' };
    {
      const [y0, y1] = LANE.camera;
      if (py >= y0 && py <= y1) {
        const keys = cameraKeys();
        for (let i = keys.length - 1; i >= 0; i--) {
          if (Math.abs(px - this.x(keys[i].t)) <= 9) return { type: 'camkey', id: keys[i].id };
        }
        return { type: 'cameraLane', t: this.t(px) };
      }
    }
    for (const kind of AUDIO_LANES) {
      const [y0, y1] = LANE[kind];
      if (py < y0 || py > y1) continue;
      const tr = track(kind);
      if (tr.ready && px >= this.x(tr.start) && px <= this.x(tr.start + tr.duration)) {
        return { type: 'audio', kind };
      }
      return { type: 'audioLane', kind };
    }
    return { type: 'wave' };
  }

  // ── events ─────────────────────────────────────────────────
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    c.addEventListener('pointerleave', () => { this.hover = null; this._tip(null); this.draw(); });
    c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', e => this.onDblClick(e));
    window.addEventListener('resize', () => this.resize());
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  onDown(e) {
    const { px, py } = this._pos(e);
    const hit = this.hitTest(px, py);
    this.canvas.setPointerCapture(e.pointerId);

    if (hit.type === 'guide') {
      const gs = guides(hit.key);
      const g = gs[hit.index];

      if (e.metaKey || e.ctrlKey) {          // ⌘-click adds or removes a point
        selectGuide(hit.key, g.id, 'toggle');
        this.draw();
        return;
      }
      let picked = selectedGuideIndices(hit.key);
      if (picked.includes(hit.index)) state.ui.sel.id = g.id;   // keep the run, retarget the primary
      else { selectGuide(hit.key, g.id, 'set'); picked = [hit.index]; }

      if (picked.length > 1) {
        // dragging either end rescales the run; anything inside slides it
        const i0 = picked[0], i1 = picked.at(-1);
        this.drag = {
          type: 'guideRange', key: hit.key, i0, i1, moving: hit.index,
          mode: hit.index === i0 || hit.index === i1 ? 'scale' : 'translate',
          snapshot: gs.map(x => x.t), grab: this.t(px) - g.t
        };
      } else {
        // the 起承 handle stretches the arc behind it, the way the end cap does
        const head = hit.index === 1 && headIsCombined(gs);
        this.drag = { type: 'guide', key: hit.key, index: hit.index, grab: this.t(px) - g.t,
                      head, keep: e.altKey, snapshot: head ? gs.map(x => x.t) : null };
      }
    } else if (hit.type === 'guideLane') {
      this.drag = { type: 'marquee', key: hit.key, x0: px, x1: px };
    } else if (hit.type === 'levelEdge') {
      const lv = level(hit.key);
      this.drag = { type: 'levelEdge', key: hit.key, edge: hit.edge,
                    start: lv.start, end: lv.end, grab: this.t(px) - lv[hit.edge] };
    } else if (hit.type === 'end') {
      this.drag = {
        type: 'end', from: state.project.duration, keep: e.altKey,
        levels: Object.fromEntries(LEVEL_KEYS.map(k => [k, {
          start: level(k).start, end: level(k).end, guides: guides(k).map(g => g.t)
        }])),
        clips: clips().map(c => ({ start: c.start, end: c.end }))
      };
    } else if (hit.type === 'camkey') {
      select('camkey', hit.id);
      const k = cameraKeys().find(x => x.id === hit.id);
      this.drag = { type: 'camkey', id: hit.id, grab: this.t(px) - k.t };
    } else if (hit.type === 'audio') {
      const tr = track(hit.kind);
      this.drag = { type: 'audio', kind: hit.kind, grab: this.t(px) - tr.start };
    } else if (hit.type === 'clip') {
      const c = clips().find(x => x.id === hit.id);
      select('clip', c.id);
      this.drag = { type: 'clip', id: c.id, edge: hit.edge,
                    grab: this.t(px) - c.start, len: c.end - c.start };
    } else {
      if (hit.type === 'track') select(null, null);
      this.drag = { type: 'scrub' };
      emit('seek', this.t(px));
    }
    this.draw();
  }

  onMove(e) {
    const { px, py } = this._pos(e);
    const d = this.drag;

    if (!d) {
      const hit = this.hitTest(px, py);
      this.hover = hit;
      this.canvas.style.cursor =
        hit.type === 'guide' || hit.type === 'end' || hit.type === 'levelEdge' ? 'ew-resize'
        : hit.type === 'clip' ? (hit.edge ? 'ew-resize' : 'grab')
        : hit.type === 'camkey' ? 'ew-resize'
        : hit.type === 'cameraLane' ? 'copy'
        : hit.type === 'audio' ? (this.drag ? 'grabbing' : 'grab')
        : hit.type === 'audioLane' ? 'default'
        : hit.type === 'guideLane' ? 'crosshair'
        : hit.type === 'ruler' ? 'text' : 'default';
      this.draw();
      return;
    }

    const free = e.shiftKey;
    const dur = state.project.duration;

    if (d.type === 'scrub') {
      emit('seek', this.t(px));

    } else if (d.type === 'guide') {
      const lv = level(d.key);
      const gs = lv.guides;
      const i = d.index;
      const { t, kind } = this.snap(this.t(px) - d.grab, { ignore: free, exceptGuide: gs[i].id });
      const keep = d.keep || e.altKey;
      let note = '';
      if (d.head && !keep) {
        const { lo, hi } = headRange(lv);
        scaleFromHead(lv, d.snapshot, clamp(t, lo, hi));
        note = '  (scaled)';
      } else {
        const lo = gs[i - 1].t + MIN_REGION;
        const hi = (gs[i + 1]?.t ?? lv.end) - MIN_REGION;
        gs[i].t = clamp(t, lo, Math.max(lo, hi));
        if (d.head) note = '  (boundary only)';
      }
      this._tip(`${LEVELS[d.key].label} · ${guideDisplay(gs, i).label} · ${fmtTime(gs[i].t)}${note}${kind ? '  ⟡' + kind : ''}`,
                px, ROW[d.key].lane[0]);
      emit('render');

    } else if (d.type === 'marquee') {
      d.x1 = px;
      if (Math.abs(d.x1 - d.x0) >= 4) selectGuidesInRange(d.key, this.t(d.x0), this.t(d.x1));

    } else if (d.type === 'camkey') {
      const { t, kind } = this.snap(this.t(px) - d.grab, { ignore: free });
      updateCameraKey(d.id, { t: clamp(t, 0, dur) });
      const k = cameraKeys().find(x => x.id === d.id);
      this._tip(`camera · ${fmtTime(k.t)}${kind ? '  ⟡' + kind : ''}`, px, LANE.camera[0]);

    } else if (d.type === 'audio') {
      const tr = track(d.kind);
      const { t, kind } = this.snap(this.t(px) - d.grab, { ignore: free });
      setTrackStart(d.kind, t);
      this._tip(`${KIND[d.kind].short} · starts ${fmtTime(Math.max(0, t))}${t < 0 ? '  (trimmed in)' : ''}${kind ? '  ⟡' + kind : ''}`,
                px, LANE[d.kind][0]);

    } else if (d.type === 'guideRange') {
      const lv = level(d.key);
      const gs = lv.guides;
      const { t, kind } = this.snap(this.t(px) - d.grab, { ignore: free, exceptGuide: gs[d.moving].id });
      if (d.mode === 'scale') scaleRange(lv, d.snapshot, d.i0, d.i1, d.moving, t);
      else translateRange(lv, d.snapshot, d.i0, d.i1, t - d.snapshot[d.moving]);
      const span = gs[d.i1].t - gs[d.i0].t;
      this._tip(`${d.i1 - d.i0 + 1} points · ${span.toFixed(2)}s  (${d.mode === 'scale' ? 'scaled' : 'moved'})${kind ? '  ⟡' + kind : ''}`,
                px, ROW[d.key].lane[0]);
      emit('render');

    } else if (d.type === 'levelEdge') {
      const lv = level(d.key);
      const { t, kind } = this.snap(this.t(px) - d.grab, { ignore: free });
      const minSpan = MIN_REGION * lv.guides.length;
      if (d.edge === 'start') {
        const v = clamp(t, 0, d.end - minSpan);
        reframeLevel(lv, v, d.end);
      } else {
        const v = clamp(t, d.start + minSpan, dur);
        reframeLevel(lv, d.start, v);
      }
      this._tip(`${LEVELS[d.key].label} span ${fmtTime(lv.start)} → ${fmtTime(lv.end)}${kind ? '  ⟡' + kind : ''}`,
                px, ROW[d.key].lane[0]);
      emit('render');

    } else if (d.type === 'clip') {
      const c = clips().find(x => x.id === d.id);
      if (!c) return;
      const opts = { ignore: free, exceptClip: c.id };
      if (d.edge === 'start') {
        const { t, kind } = this.snap(this.t(px), opts);
        c.start = clamp(t, 0, c.end - MIN_CLIP);
        this._tip(`in ${fmtTime(c.start)} · ${(c.end - c.start).toFixed(2)}s${kind ? '  ⟡' + kind : ''}`, px, this.trackTop(c.track));
      } else if (d.edge === 'end') {
        const { t, kind } = this.snap(this.t(px), opts);
        c.end = clamp(t, c.start + MIN_CLIP, dur);
        this._tip(`out ${fmtTime(c.end)} · ${(c.end - c.start).toFixed(2)}s${kind ? '  ⟡' + kind : ''}`, px, this.trackTop(c.track));
      } else {
        const { t, kind } = this.snap(this.t(px) - d.grab, opts);
        c.start = clamp(t, 0, dur - d.len);
        c.end = c.start + d.len;
        const tr = this.trackAt(py);
        if (tr >= 0) c.track = tr;
        this._tip(`${fmtTime(c.start)} → ${fmtTime(c.end)}  ·  track ${c.track + 1}${kind ? '  ⟡' + kind : ''}`, px, this.trackTop(c.track));
      }
      emit('render');

    } else if (d.type === 'end') {
      const { t, kind } = this.snap(this.t(px), { ignore: free });
      const nd = clamp(t, MIN_REGION * 4, 900);
      const keep = d.keep || e.altKey;
      const k = nd / d.from;
      for (const key of LEVEL_KEYS) {
        const lv = level(key);
        const snap = d.levels[key];
        lv.start = keep ? snap.start : snap.start * k;
        lv.end = keep ? snap.end : snap.end * k;
        lv.guides.forEach((g, i) => { g.t = keep ? snap.guides[i] : snap.guides[i] * k; });
      }
      clips().forEach((c, i) => {
        c.start = keep ? d.clips[i].start : d.clips[i].start * k;
        c.end = keep ? d.clips[i].end : d.clips[i].end * k;
      });
      state.project.duration = nd;
      const ov = level('overall');
      ov.start = 0; ov.end = nd;
      for (const key of LEVEL_KEYS) {
        const lv = level(key);
        lv.end = clamp(lv.end, lv.start + 0.001, nd);
        normalizeGuides(lv);
      }
      this._tip(`length ${nd.toFixed(2)}s  ${keep ? '(positions kept)' : '(scaled)'}${kind ? '  ⟡' + kind : ''}`,
                px, LANE.overall[0]);
      emit('duration', nd);
      emit('render');
    }

    this.draw();
  }

  onUp() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this._tip(null);
    if (d.type === 'audio') emit('audio', state.audio);   // resyncs playback and the panel
    else if (d.type === 'end') setDuration(state.project.duration, { scale: false });
    else if (d.type === 'guide' || d.type === 'levelEdge' || d.type === 'guideRange') commitGuides(d.key);
    else if (d.type === 'clip') commitClips();
    else if (d.type === 'camkey') commitCameraKeys();
    else if (d.type === 'marquee' && Math.abs(d.x1 - d.x0) < 4) {
      select(null, null);                     // a plain click in the lane clears and scrubs
      emit('seek', this.t(d.x0));
    }
    this.draw();
  }

  onWheel(e) {
    e.preventDefault();
    const { px } = this._pos(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.deltaX || e.deltaY) / this.pxPerSec;
      const max = this.viewMax;
      const s = clamp(this.view.start + dt, 0, Math.max(0, max - this.span));
      state.ui.view = { start: s, end: s + this.span };
      this.draw();
    } else {
      this.zoomBy(Math.exp(-e.deltaY * 0.0016), this.t(px));
    }
  }

  onDblClick(e) {
    const { px, py } = this._pos(e);
    const hit = this.hitTest(px, py);
    if (hit.type === 'cameraLane') {
      addCameraKey(this.snap(hit.t).t);
      this.draw();
      return;
    }
    if (hit.type === 'track') {
      const region = drivingRegion(state.project.levels, hit.t);
      const start = this.snap(hit.t).t;
      const end = Math.min(state.project.duration,
        Math.max(start + MIN_CLIP, Math.min(region.end || start + 4, start + 4)));
      addClip(start, end, hit.track);
    } else if (hit.type === 'clip') {
      const c = clips().find(x => x.id === hit.id);
      const pad = (c.end - c.start) * 0.2;
      state.ui.view = { start: Math.max(0, c.start - pad), end: Math.min(this.viewMax, c.end + pad) };
    } else this.fit();
    this.draw();
  }

  _tip(text, x = 0, y = 0) {
    if (!this.tip) return;
    if (!text) { this.tip.classList.add('hidden'); return; }
    this.tip.textContent = text;
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${clamp(x + 10, 4, this.w - this.tip.offsetWidth - 6)}px`;
    this.tip.style.top = `${Math.max(2, y - 22)}px`;
  }

  // ── drawing ────────────────────────────────────────────────
  draw() {
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = '#0d0f14';
    g.fillRect(0, 0, this.w, this.h);

    this._drawRuler(g);
    this._drawBeats(g);
    for (const kind of AUDIO_LANES) this._drawAudioLane(g, kind);
    this._drawCameraLane(g);
    this._drawTracks(g);
    this._drawGuideLines(g, 'overall');
    this._drawGuideLines(g, 'animation');
    this._drawClips(g);
    this._drawRow(g, 'overall');
    this._drawRow(g, 'animation');
    this._drawPlayhead(g);
  }

  _drawRuler(g) {
    const [y0, y1] = LANE.ruler;
    g.fillStyle = '#0a0c11';
    g.fillRect(0, y0, this.w, y1 - y0);

    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find(s => s * this.pxPerSec > 62) ?? 300;
    const start = Math.floor(this.view.start / step) * step;
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    for (let t = start; t <= this.view.end; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      if (x < -40 || x > this.w + 40) continue;
      g.strokeStyle = '#232a36';
      g.beginPath(); g.moveTo(x, y0 + 10); g.lineTo(x, y1); g.stroke();
      g.fillStyle = '#5b6577';
      g.fillText(fmtTime(Math.max(0, t)).replace(/\.\d+$/, m => (step < 1 ? m : '')), x + 3, y0 + 10);
    }
  }

  _drawBeats(g) {
    const a = state.audio;
    const [y0, y1] = LANE.beats;
    const times = beatTimes();
    if (!times.length) {
      g.fillStyle = '#12151c';
      g.fillRect(0, y0, this.w, y1 - y0);
      g.fillStyle = '#39414f';
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'left';
      g.fillText('no beat grid — import audio, or set a manual BPM', 8, y1 - 2);
      return;
    }
    // a manual grid gets a cooler colour than a grid detected from a track
    const fromTrack = a.gridSource === 'track';
    const spacing = ((times[1] ?? times[0] + 0.5) - times[0]) * this.pxPerSec;
    const showAll = spacing > 4;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < this.view.start - 1 || t > this.view.end + 1) continue;
      const bar = i % a.beatsPerBar === 0;
      if (!bar && !showAll) continue;
      const x = Math.round(this.x(t)) + 0.5;
      g.strokeStyle = bar ? (fromTrack ? '#4b7fb5' : '#6b6394') : (fromTrack ? '#2b3341' : '#2f2b3d');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, bar ? y0 : y0 + 5); g.lineTo(x, y1); g.stroke();
      if (bar && spacing * a.beatsPerBar > 46) {
        g.fillStyle = fromTrack ? '#4b6180' : '#6a6390';
        g.font = '9px ui-monospace, monospace';
        g.textAlign = 'left';
        g.fillText(String(Math.floor(i / a.beatsPerBar) + 1), x + 2, y0 + 9);
      }
    }
  }

  /** One audio lane: the track as a slippable region, plus its peaks for BGM. */
  _drawAudioLane(g, kind) {
    const tr = track(kind);
    const meta = KIND[kind];
    const [y0, y1] = LANE[kind];
    const h = y1 - y0;
    const mid = (y0 + y1) / 2, half = h / 2 - 4;

    g.fillStyle = '#0a0c11';
    g.fillRect(0, y0, this.w, h);
    g.fillStyle = '#242b37';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(meta.short, 4, mid);

    if (!tr.ready || !tr.peaks) {
      g.strokeStyle = '#161c25';
      g.beginPath(); g.moveTo(26, mid + 0.5); g.lineTo(this.w, mid + 0.5); g.stroke();
      g.fillStyle = '#2b3340';
      g.fillText(`no ${meta.label.toLowerCase()} loaded`, 30, mid);
      return;
    }

    const rx0 = this.x(tr.start), rx1 = this.x(tr.start + tr.duration);
    const hot = (this.hover?.type === 'audio' && this.hover.kind === kind) ||
                (this.drag?.type === 'audio' && this.drag.kind === kind);
    const dim = tr.mute ? 0.35 : 1;

    g.save();
    this._roundRect(g, rx0, y0 + 2, rx1 - rx0, h - 4, 4);
    g.fillStyle = hot ? '#101a24' : '#0c1219';
    g.fill();
    g.strokeStyle = hot ? '#5fb3e6' : '#26374a';
    g.lineWidth = 1;
    g.stroke();
    g.clip();

    const N = tr.peaks.length / 2;
    const grad = g.createLinearGradient(0, y0, 0, y1);
    const tint = kind === 'bgm' ? ['#2f6f9e', '#5fb3e6']
               : kind === 'vo'  ? ['#3f7d5e', '#63c497']
                                : ['#7a5f9e', '#b18fe0'];
    grad.addColorStop(0, tint[0]); grad.addColorStop(0.5, tint[1]); grad.addColorStop(1, tint[0]);
    g.globalAlpha = dim;
    g.fillStyle = grad;
    g.beginPath();
    for (let px = Math.max(0, Math.floor(rx0)); px < Math.min(this.w, Math.ceil(rx1)); px++) {
      const t0 = this.t(px) - tr.start, t1 = this.t(px + 1) - tr.start;
      if (t1 < 0 || t0 > tr.duration) continue;
      let i0 = Math.floor(t0 / tr.duration * N), i1 = Math.ceil(t1 / tr.duration * N);
      i0 = clamp(i0, 0, N - 1); i1 = clamp(i1, i0 + 1, N);
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) {
        const lo = tr.peaks[i * 2], hi = tr.peaks[i * 2 + 1];
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      const top = mid - mx * half, bot = mid - mn * half;
      g.rect(px, top, 1, Math.max(1, bot - top));
    }
    g.fill();
    g.globalAlpha = 1;

    // the transients layers can snap to
    if (kind === 'bgm' && state.ui.snapPeaks) {
      g.strokeStyle = '#f0a54a';
      g.lineWidth = 1;
      g.beginPath();
      for (const t of state.audio.hits) {
        const x = Math.round(this.x(t)) + 0.5;
        if (x < rx0 - 1 || x > rx1 + 1 || x < -1 || x > this.w + 1) continue;
        g.moveTo(x, y1 - 7); g.lineTo(x, y1 - 2);
      }
      g.stroke();
    }

    g.fillStyle = hot ? '#9fd4f5' : '#4e6b85';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left'; g.textBaseline = 'top';
    const slip = tr.start === 0 ? '' : `   ⇥ ${tr.start > 0 ? '+' : ''}${tr.start.toFixed(2)}s`;
    g.fillText(`${tr.mute ? '⨯ ' : ''}${tr.name}${slip}`, rx0 + 6, y0 + 4);
    g.restore();
  }

  /** The camera track: keys as diamonds, with the framing curve between them. */
  _drawCameraLane(g) {
    const cam = camera();
    const [y0, y1] = LANE.camera;
    const h = y1 - y0;
    const mid = (y0 + y1) / 2;

    g.fillStyle = '#0a0c11';
    g.fillRect(0, y0, this.w, h);
    g.fillStyle = cam.enabled && cam.keys.length ? '#7d6cb0' : '#242b37';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('CAM', 4, mid);

    if (!cam.keys.length) {
      g.fillStyle = '#2b3340';
      g.fillText('double-click to add a camera key', 30, mid);
      return;
    }

    // zoom drawn as a curve so the move is readable at a glance
    const zooms = cam.keys.map(k => k.zoom);
    const zMin = Math.min(1, ...zooms), zMax = Math.max(1, ...zooms);
    const zy = z => mid + (h / 2 - 6) * (1 - 2 * ((z - zMin) / Math.max(0.001, zMax - zMin)));
    g.strokeStyle = cam.enabled ? '#7d6cb0' : '#3a4152';
    g.lineWidth = 1.5;
    g.beginPath();
    const first = cam.keys[0], last = cam.keys[cam.keys.length - 1];
    g.moveTo(Math.max(-5, this.x(0)), zy(first.zoom));
    g.lineTo(this.x(first.t), zy(first.zoom));
    for (let i = 0; i < cam.keys.length - 1; i++) {
      const a = cam.keys[i], b = cam.keys[i + 1];
      const steps = Math.max(2, Math.min(48, Math.round((this.x(b.t) - this.x(a.t)) / 6)));
      for (let s = 1; s <= steps; s++) {
        const t = a.t + (b.t - a.t) * (s / steps);
        g.lineTo(this.x(t), zy(cameraAt(cam, t).zoom));
      }
    }
    g.lineTo(Math.min(this.w + 5, this.x(state.project.duration)), zy(last.zoom));
    g.stroke();

    for (const k of cam.keys) {
      const x = this.x(k.t);
      if (x < -10 || x > this.w + 10) continue;
      const on = state.ui.sel?.type === 'camkey' && state.ui.sel.id === k.id;
      const hov = this.hover?.type === 'camkey' && this.hover.id === k.id;
      const r = on || hov ? 6 : 5;
      const y = zy(k.zoom);
      g.beginPath();
      g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
      g.closePath();
      g.fillStyle = on ? '#e4e8ef' : cam.enabled ? '#9b86d8' : '#4a5364';
      g.fill();
      g.strokeStyle = '#0d0f14';
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  _drawTracks(g) {
    for (let i = 0; i < TRACKS; i++) {
      const y = this.trackTop(i);
      g.fillStyle = i % 2 ? '#0a0c11' : '#0b0e13';
      g.fillRect(0, y, this.w, TRACK_H);
      g.fillStyle = '#242b37';
      g.font = '9px ui-monospace, monospace';
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(`T${i + 1}`, 4, y + TRACK_H / 2);
    }
  }

  /** The reference lines themselves — the grid the composition is built on. */
  _drawGuideLines(g, key) {
    const lv = level(key);
    if (!lv) return;
    const overall = key === 'overall';
    const top = overall ? LANE.beats[0] : ROW.animation.lane[0];
    const sel = state.ui.sel;

    g.save();
    g.setLineDash(overall ? [3, 4] : [2, 5]);
    for (const i of guideHandles(lv.guides)) {
      const x = Math.round(this.x(lv.guides[i].t)) + 0.5;
      if (x < -2 || x > this.w + 2) continue;
      const on = sel?.type === 'guide' && sel.id === lv.guides[i].id;
      g.strokeStyle = ROLES[lv.guides[i].role].color + (on ? '99' : overall ? '3d' : '2b');
      g.lineWidth = on ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, this.h); g.stroke();
    }
    if (overall) {
      const xe = Math.round(this.x(state.project.duration)) + 0.5;
      g.strokeStyle = '#5c677955';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(xe, top); g.lineTo(xe, this.h); g.stroke();
    }
    g.restore();
  }

  _drawRow(g, key) {
    const lv = level(key);
    if (!lv) return;
    const row = ROW[key];
    const [y0, y1] = row.lane;
    const cy = rowCenter(key);
    const gs = lv.guides;
    const sel = state.ui.sel;
    const selIds = new Set(selectedGuideIds(key));
    const overall = key === 'overall';

    // lane ground + phase wash
    g.fillStyle = '#0a0c11';
    g.fillRect(0, y0, this.w, y1 - y0);
    for (let i = 0; i < gs.length; i++) {
      const x0 = this.x(gs[i].t), x1 = this.x(gs[i + 1]?.t ?? lv.end);
      if (x1 < 0 || x0 > this.w) continue;
      g.fillStyle = ROLES[gs[i].role].color + (overall ? '16' : '10');
      g.fillRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
    }
    g.fillStyle = '#2b3340';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(row.label, 4, y0 + 2);

    // rail
    const xs = this.x(lv.start), xe = this.x(lv.end);
    g.strokeStyle = '#232a36';
    g.lineWidth = overall ? 2 : 1.5;
    g.beginPath(); g.moveTo(xs, cy); g.lineTo(xe, cy); g.stroke();
    for (let i = 0; i < gs.length; i++) {
      const a = ROLES[gs[i].role].color;
      const b = ROLES[gs[i + 1]?.role ?? gs[i].role].color;
      const x0 = this.x(gs[i].t), x1 = this.x(gs[i + 1]?.t ?? lv.end);
      if (x1 < 0 || x0 > this.w) continue;
      const grad = g.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, a + 'cc'); grad.addColorStop(1, b + 'cc');
      g.strokeStyle = grad;
      g.lineWidth = overall ? 2.5 : 2;
      g.beginPath(); g.moveTo(Math.max(-5, x0), cy); g.lineTo(Math.min(this.w + 5, x1), cy); g.stroke();
    }

    // nodes
    for (const i of guideHandles(gs)) {
      const x = this.x(gs[i].t);
      if (x < -34 || x > this.w + 34) continue;
      const disp = guideDisplay(gs, i);
      const on = selIds.has(gs[i].id);
      const primary = sel?.type === 'guide' && sel.id === gs[i].id;
      const hov = (this.hover?.type === 'guide' && this.hover.key === key && this.hover.index === i) ||
                  (this.drag?.type === 'guide' && this.drag.key === key && this.drag.index === i);
      const r = row.r + (on ? 1.5 : 0) + (hov ? 1.5 : 0);
      const wide = disp.combined;
      const halfW = wide ? r + row.r : r;

      if (on || hov) {
        g.fillStyle = disp.colors[0] + (primary ? '44' : '2a');
        g.beginPath();
        g.roundRect(x - halfW - 5, cy - r - 5, (halfW + 5) * 2, (r + 5) * 2, r + 5);
        g.fill();
        if (on) {
          g.strokeStyle = primary ? '#e4e8ef' : disp.colors[0] + 'aa';
          g.lineWidth = primary ? 1.5 : 1;
          g.beginPath();
          g.roundRect(x - halfW - 5, cy - r - 5, (halfW + 5) * 2, (r + 5) * 2, r + 5);
          g.stroke();
        }
      }
      if (wide) {
        // one control for 起承: left half is the strike, right half the stretch
        g.save();
        g.beginPath(); g.roundRect(x - halfW, cy - r, halfW * 2, r * 2, r); g.clip();
        g.fillStyle = disp.colors[0]; g.fillRect(x - halfW, cy - r, halfW, r * 2);
        g.fillStyle = disp.colors[1]; g.fillRect(x, cy - r, halfW, r * 2);
        g.restore();
        g.strokeStyle = '#0d0f14'; g.lineWidth = 2;
        g.beginPath(); g.roundRect(x - halfW, cy - r, halfW * 2, r * 2, r); g.stroke();
      } else {
        g.fillStyle = disp.colors[0];
        g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#0d0f14'; g.lineWidth = 2; g.stroke();
      }
      g.fillStyle = '#08090c';
      g.font = `600 ${row.font}px "PingFang TC", "Noto Sans TC", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(disp.label, x, cy + 0.5);

      if (overall && this.pxPerSec > 6) {
        g.fillStyle = primary ? '#96a2b4' : '#4a5364';
        g.font = '9px ui-monospace, monospace';
        g.fillText(gs[i].t.toFixed(2), x, y1 - 5);
      }
    }

    this._drawSelectionRun(g, key, lv, y0);
    this._drawMarquee(g, key, y0, y1);
    if (overall) this._drawEndCap(g, cy, y1);
    else this._drawLevelEdges(g, lv, cy);
  }

  /** Bracket over a multi-point selection — drag either end to rescale the run. */
  _drawSelectionRun(g, key, lv, y0) {
    const picked = selectedGuideIndices(key);
    if (picked.length < 2) return;
    const i0 = picked[0], i1 = picked.at(-1);
    const x0 = this.x(lv.guides[i0].t), x1 = this.x(lv.guides[i1].t);
    const y = y0 + 4;
    g.strokeStyle = '#e4e8ef';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x0, y + 4); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y + 4);
    g.stroke();
    const label = `${picked.length} pts · ${(lv.guides[i1].t - lv.guides[i0].t).toFixed(2)}s`;
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    const mid = (x0 + x1) / 2;
    const w = g.measureText(label).width + 8;
    g.fillStyle = '#0d0f14';
    g.fillRect(mid - w / 2, y - 10, w, 10);
    g.fillStyle = '#c3cad6';
    g.fillText(label, mid, y);
  }

  _drawMarquee(g, key, y0, y1) {
    const d = this.drag;
    if (d?.type !== 'marquee' || d.key !== key) return;
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    g.fillStyle = '#e4e8ef18';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = '#e4e8ef66';
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }

  /** Drag to stretch the whole composition. */
  _drawEndCap(g, cy, y1) {
    const dur = state.project.duration;
    const xe = this.x(dur);
    const hot = this.hover?.type === 'end' || this.drag?.type === 'end';
    g.strokeStyle = hot ? '#e4e8ef' : '#5c6779';
    g.lineWidth = hot ? 2.5 : 2;
    g.beginPath(); g.moveTo(xe, cy - 14); g.lineTo(xe, cy + 14); g.stroke();
    g.fillStyle = hot ? '#e4e8ef' : '#5c6779';
    g.beginPath();
    g.moveTo(xe - 9, cy); g.lineTo(xe - 3, cy - 5); g.lineTo(xe - 3, cy + 5); g.closePath(); g.fill();
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(`${dur.toFixed(2)}s`, xe - 12, y1 - 5);
  }

  /** Brackets that move and stretch the animation arc inside the video. */
  _drawLevelEdges(g, lv, cy) {
    for (const edge of ['start', 'end']) {
      const x = this.x(lv[edge]);
      if (x < -12 || x > this.w + 12) continue;
      const hot = (this.hover?.type === 'levelEdge' && this.hover.key === lv.key && this.hover.edge === edge) ||
                  (this.drag?.type === 'levelEdge' && this.drag.key === lv.key && this.drag.edge === edge);
      const dir = edge === 'start' ? 1 : -1;
      g.strokeStyle = hot ? '#e4e8ef' : '#4a5364';
      g.lineWidth = hot ? 2 : 1.5;
      g.beginPath();
      g.moveTo(x + dir * 5, cy - 11); g.lineTo(x, cy - 11);
      g.lineTo(x, cy + 11); g.lineTo(x + dir * 5, cy + 11);
      g.stroke();
    }
  }

  _drawClips(g) {
    const sel = state.ui.sel;
    for (const c of clips()) {
      const x0 = this.x(c.start), x1 = this.x(c.end);
      if (x1 < -20 || x0 > this.w + 20) continue;
      const y = this.trackTop(c.track);
      const w = Math.max(2, x1 - x0);
      const role = ROLES[drivingRegion(state.project.levels, c.start).role];
      const on = sel?.type === 'clip' && sel.id === c.id;
      const hov = this.hover?.type === 'clip' && this.hover.id === c.id;

      g.fillStyle = on ? role.color + '40' : hov ? role.color + '2a' : role.color + '1e';
      this._roundRect(g, x0, y + 1, w, TRACK_H - 2, 4); g.fill();
      g.strokeStyle = on ? role.color : role.color + '66';
      g.lineWidth = on ? 1.5 : 1;
      this._roundRect(g, x0 + 0.5, y + 1.5, w - 1, TRACK_H - 3, 4); g.stroke();

      g.fillStyle = role.color;
      g.fillRect(x0 + 1, y + 2, 2.5, TRACK_H - 4);

      if (w > 20) {
        g.save();
        g.beginPath(); g.rect(x0 + 5, y, w - 8, TRACK_H); g.clip();
        g.fillStyle = '#e6eaf1';
        g.font = '600 10px system-ui, "PingFang TC", "Noto Sans TC", sans-serif';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText((c.text || '—').replace(/\n/g, ' '), x0 + 8, y + TRACK_H / 2 - 4);
        if (w > 70) {
          g.fillStyle = '#7d8798';
          g.font = '9px ui-monospace, monospace';
          g.fillText(`${c.effect} · ${(c.end - c.start).toFixed(2)}s`, x0 + 8, y + TRACK_H / 2 + 7);
        }
        g.restore();
      }
      if (on && w > 14) {
        g.fillStyle = '#e4e8ef';
        g.fillRect(x0 + 1, y + TRACK_H / 2 - 5, 2, 10);
        g.fillRect(x1 - 3, y + TRACK_H / 2 - 5, 2, 10);
      }
    }
  }

  _drawPlayhead(g) {
    const x = Math.round(this.x(state.ui.time)) + 0.5;
    if (x < -2 || x > this.w + 2) return;
    g.strokeStyle = '#ff5f56';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.h); g.stroke();
    g.fillStyle = '#ff5f56';
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.closePath(); g.fill();
  }

  _roundRect(g, x, y, w, h, r) {
    w = Math.max(0.5, w); h = Math.max(0.5, h);
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}
