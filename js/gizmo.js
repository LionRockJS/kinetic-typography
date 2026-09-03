// The on-stage move control.
//
// Selecting a text layer draws a box over the output preview: the layer's own
// text block, projected through the output camera, so the control sits exactly
// where the layer sits in the frame. Dragging the box — or its centre handle —
// moves the layer in the plane it already occupies, which is what "move it on
// screen" means once a camera can be anywhere in the scene.
//
// The control is DOM over the canvas rather than geometry inside it, so it can
// never leak into a recording, and it is only offered in Output mode while the
// transport is stopped: during playback the glyphs are being animated away
// from their layout anyway, and a box that no longer describes them is noise.
//
//   drag the box or the handle → move the layer
//   ⇧ while dragging           → lock to one axis
//   esc                        → put it back
//
// With several layers selected the box still belongs to the primary one, but
// the drag carries the rest of the selection along by the same offset.

import { state, clips, selectedClips, updateClip } from './state.js';
import { $, clamp, round } from './util.js';

// The unrotated corners of the text block, as fractions of its half extents.
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

export class StageGizmo {
  constructor(renderer) {
    this.renderer = renderer;
    this.svg = $('#stageGizmo');
    this.box = $('#gzBox');
    this.handle = $('#gzHandle');
    this.crossH = $('#gzCrossH');
    this.crossV = $('#gzCrossV');
    this.corners = [$('#gzC0'), $('#gzC1'), $('#gzC2'), $('#gzC3')];
    this.readout = $('#gzReadout');
    this.drag = null;
    this._sig = '';
    this._bind();
  }

  /** The layer the control currently belongs to, or null when there is none. */
  _target() {
    if (this.drag) return clips().find(c => c.id === this.drag.id) ?? null;
    const sel = state.ui.sel;
    if (sel?.type !== 'clip') return null;
    if (state.ui.viewMode !== 'output' || state.ui.playing || state.ui.recording) return null;
    const clip = clips().find(c => c.id === sel.id);
    if (!clip) return null;
    // Only while the layer is actually on screen — otherwise the control would
    // point at empty frame, and the inspector fields are the honest editor.
    const t = state.ui.time;
    return t >= clip.start && t < clip.end ? clip : null;
  }

  static _pos(clip) {
    const p = clip.position ?? {};
    return { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 };
  }

  /** Recompute the control from the camera as of the last rendered frame. */
  sync() {
    const clip = this._target();
    const bounds = clip ? this.renderer.clipBounds(clip.id) : null;
    if (!clip || !bounds) { this._hide(); return; }

    const pos = StageGizmo._pos(clip);
    const hw = Math.max(2, bounds.width / 2), hh = Math.max(2, bounds.height / 2);
    const pts = CORNERS.map(([sx, sy]) =>
      this.renderer.stagePoint(pos.x + sx * hw, pos.y + sy * hh, pos.z));
    const centre = this.renderer.stagePoint(pos.x, pos.y, pos.z);
    if (!centre || pts.some(p => !p)) { this._hide(); return; }

    const points = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const sig = `${points}|${centre.x.toFixed(1)},${centre.y.toFixed(1)}`;
    this.svg.classList.remove('hidden');
    if (sig !== this._sig) {
      this._sig = sig;
      this.box.setAttribute('points', points);
      pts.forEach((p, i) => {
        this.corners[i].setAttribute('cx', p.x.toFixed(1));
        this.corners[i].setAttribute('cy', p.y.toFixed(1));
      });
      this.handle.setAttribute('cx', centre.x.toFixed(1));
      this.handle.setAttribute('cy', centre.y.toFixed(1));
      for (const [line, x1, y1, x2, y2] of [
        [this.crossH, centre.x - 7, centre.y, centre.x + 7, centre.y],
        [this.crossV, centre.x, centre.y - 7, centre.x, centre.y + 7]
      ]) {
        line.setAttribute('x1', x1.toFixed(1)); line.setAttribute('y1', y1.toFixed(1));
        line.setAttribute('x2', x2.toFixed(1)); line.setAttribute('y2', y2.toFixed(1));
      }
    }
    if (this.drag) this._showReadout(centre, pos);
  }

  _hide() {
    if (!this.svg.classList.contains('hidden')) {
      this.svg.classList.add('hidden');
      this._sig = '';
    }
    this.readout.classList.add('hidden');
  }

  _showReadout(centre, pos) {
    const frame = this.svg.getBoundingClientRect();
    const n = this.drag?.group?.length ?? 1;
    this.readout.textContent =
      `x ${pos.x.toFixed(1)}   y ${pos.y.toFixed(1)}${n > 1 ? `   · ${n} layers` : ''}`;
    this.readout.classList.remove('hidden');
    const w = this.readout.offsetWidth, h = this.readout.offsetHeight;
    this.readout.style.left = `${clamp(centre.x + 14, 4, Math.max(4, frame.width - w - 4))}px`;
    this.readout.style.top = `${clamp(centre.y + 14, 4, Math.max(4, frame.height - h - 4))}px`;
  }

  _point(e) {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _bind() {
    const begin = e => {
      if (e.button !== 0) return;
      const clip = this._target();
      if (!clip) return;
      const pos = StageGizmo._pos(clip);
      const p = this._point(e);
      const grab = this.renderer.stageToWorld(p.x, p.y, pos.z);
      if (!grab) return;
      // Every selected layer moves by the same offset, each keeping its own
      // depth, so a group holds its arrangement on screen.
      this.drag = { id: clip.id, pos, grab,
                    group: selectedClips().map(c => ({ id: c.id, ...StageGizmo._pos(c) })) };
      this.svg.classList.add('is-dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
      // The stage is the timeline's neighbour, not its child: a drag here must
      // not also scrub, orbit, or drop the selection.
      e.preventDefault();
      e.stopPropagation();
      this.sync();
    };
    this.box.addEventListener('pointerdown', begin);
    this.handle.addEventListener('pointerdown', begin);

    window.addEventListener('pointermove', e => {
      const d = this.drag;
      if (!d) return;
      const p = this._point(e);
      const now = this.renderer.stageToWorld(p.x, p.y, d.pos.z);
      if (!now) return;
      // Measured from where the pointer first grabbed the layer, so the drag
      // never accumulates rounding and the text stays under the cursor.
      let dx = now.x - d.grab.x, dy = now.y - d.grab.y;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      this._move(round(d.pos.x + dx, 2), round(d.pos.y + dy, 2));
    });

    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      this.svg.classList.remove('is-dragging');
      this.readout.classList.add('hidden');
      this.sync();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.drag) return;
      this._move(this.drag.pos.x, this.drag.pos.y);
      end();
      e.stopPropagation();
    }, true);
  }

  _move(x, y) {
    const d = this.drag;
    const dx = x - d.pos.x, dy = y - d.pos.y;
    const group = d.group?.length ? d.group : [{ id: d.id, ...d.pos }];
    for (const g of group) {
      const clip = clips().find(c => c.id === g.id);
      if (!clip) continue;
      const lead = g.id === d.id;
      updateClip(g.id, {
        position: { ...(clip.position ?? {}),
                    x: lead ? x : round(g.x + dx, 2),
                    y: lead ? y : round(g.y + dy, 2),
                    z: lead ? d.pos.z : g.z }
      });
    }
    this.sync();
  }
}
