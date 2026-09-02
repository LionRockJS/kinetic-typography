// three.js stage renderer.
//
// The canvas is always rendered at the project's real pixel dimensions (so a
// recording is pixel-exact) and CSS-scaled to fit the viewport. Every glyph is
// its own mesh with its own material, which is what the effects animate.
//
// Any number of clips can be live at the same moment; each one runs its own
// effect over its own span, and the track index decides what sits in front.

import * as THREE from 'three';
import { layoutText, glyphGeometry, pruneGeometryCache } from './typography.js';
import { applyEffect, resolveParams } from './effects.js';
import { cameraAt } from './camera.js';
import { clamp } from './util.js';

const FOV = 40;

const OVERLAY_FRAG = `
uniform float uVignette, uGrain, uTime;
varying vec2 vUv;
float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.40, 0.98, length(d) * 1.30) * uVignette;      // darken toward the edges
  float n = (rnd(vUv * 900.0 + floor(uTime * 24.0)) - 0.5) * uGrain;   // film grain, stable per frame
  float ga = abs(n);
  float a = clamp(v + ga, 0.0, 1.0);
  vec3 grainCol = n > 0.0 ? vec3(1.0) : vec3(0.0);
  vec3 col = (vec3(0.0) * v + grainCol * ga) / max(a, 1e-4);
  gl_FragColor = vec4(col, a);
}`;

const OVERLAY_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x08090c, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 40000);
    this.scene.add(this.camera);

    this.key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.key.position.set(0.4, 0.8, 1);
    this.rim = new THREE.DirectionalLight(0x88bbff, 1.1);
    this.rim.position.set(-0.7, -0.3, 0.6);
    this.scene.add(this.key, this.rim, new THREE.AmbientLight(0xffffff, 0.85));

    this.overlayMat = new THREE.ShaderMaterial({
      uniforms: { uVignette: { value: 0.45 }, uGrain: { value: 0.06 }, uTime: { value: 0 } },
      vertexShader: OVERLAY_VERT, fragmentShader: OVERLAY_FRAG,
      transparent: true, depthTest: false, depthWrite: false
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.overlayMat);
    this.overlay.position.z = -10;
    this.overlay.renderOrder = 999;
    this.overlay.frustumCulled = false;
    this.camera.add(this.overlay);

    this.groups = new Map();      // clip.id → { key, group, glyphs, layout }
    this.W = 1080; this.H = 1080;
    this.setDesign(1080, 1080);
  }

  setDesign(w, h) {
    if (this.W === w && this.H === h && this._sized) return;
    this.W = w; this.H = h; this._sized = true;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.baseZ = (h / 2) / Math.tan((FOV / 2) * Math.PI / 180);
    this.camera.position.set(0, 0, this.baseZ);
    this.camera.updateProjectionMatrix();

    const oh = 2 * Math.tan((FOV / 2) * Math.PI / 180) * 10;
    this.overlay.scale.set(oh * this.camera.aspect, oh, 1);
    this.invalidate();
  }

  setBackground(hex) { this.renderer.setClearColor(new THREE.Color(hex), 1); }

  /** Force every clip group to be rebuilt on the next frame. */
  invalidate() { for (const g of this.groups.values()) g.key = ''; }

  dispose() {
    for (const id of [...this.groups.keys()]) this._destroy(id);
    this.renderer.dispose();
  }

  _destroy(id) {
    const rec = this.groups.get(id);
    if (!rec) return;
    for (const gl of rec.glyphs) gl.mesh.material.dispose();
    this.scene.remove(rec.group);
    this.groups.delete(id);
  }

  _clipKey(clip, project, fonts) {
    return [fonts.map(f => f.__id).join(','), clip.text, clip.size, clip.lineHeight,
            clip.tracking, clip.align, clip.color, project.depth,
            project.width, project.height].join('|');
  }

  _group(clip, project, fonts) {
    const key = this._clipKey(clip, project, fonts);
    const cur = this.groups.get(clip.id);
    if (cur && cur.key === key) return cur;
    if (cur) this._destroy(clip.id);

    const group = new THREE.Group();
    const glyphs = [];
    const sizePx = Math.max(4, clip.size * Math.min(project.width, project.height));
    const depth = project.depth || 0;
    const layout = layoutText(fonts, clip.text, sizePx, {
      lineHeight: clip.lineHeight, tracking: clip.tracking, align: clip.align
    });

    for (const item of layout.items) {
      if (item.blank) continue;
      const geo = glyphGeometry(item.font, item.glyph, sizePx, depth);
      if (!geo.geometry) continue;
      const material = depth > 0
        ? new THREE.MeshStandardMaterial({ color: clip.color, roughness: 0.42, metalness: 0.08, transparent: true })
        // depthFunc LessDepth rejects coplanar re-draws, so overlapping strokes
        // inside one glyph never double-blend while the glyph fades.
        : new THREE.MeshBasicMaterial({
            color: clip.color, transparent: true, side: THREE.DoubleSide,
            depthWrite: true, depthFunc: THREE.LessDepth
          });
      const mesh = new THREE.Mesh(geo.geometry, material);
      mesh.frustumCulled = false;
      const base = { x: item.x + geo.center.x, y: item.y + geo.center.y };
      mesh.position.set(base.x, base.y, 0);
      group.add(mesh);
      glyphs.push({ mesh, material, base, index: glyphs.length, char: item.char });
    }

    this.scene.add(group);
    const rec = { key, group, glyphs, layout, sizePx };
    this.groups.set(clip.id, rec);
    pruneGeometryCache();
    return rec;
  }

  /**
   * @param {object} ctx { time, project, clips, fonts, beats }
   * The camera track reframes everything at once, so it is applied before any clip.
   * @returns {{ live: number, glyphs: number }|null}
   */
  render({ time, project, clips, fonts, beats }) {
    this.setDesign(project.width, project.height);
    this.setBackground(project.bg);
    this.overlayMat.uniforms.uVignette.value = project.vignette;
    this.overlayMat.uniforms.uGrain.value = project.grain;
    this.overlayMat.uniforms.uTime.value = time;

    const lit = (project.depth || 0) > 0;
    this.key.visible = this.rim.visible = lit;

    const cam = cameraAt(project.camera, time);
    this.camera.position.set(cam.x * project.width, cam.y * project.height,
                             this.baseZ / Math.max(0.05, cam.zoom));
    this.camera.rotation.z = cam.roll;

    const stack = (fonts ?? []).filter(Boolean);
    if (!stack.length) { this.renderer.render(this.scene, this.camera); return null; }

    // drop groups for clips that no longer exist
    const live = new Set(clips.map(c => c.id));
    for (const id of [...this.groups.keys()]) if (!live.has(id)) this._destroy(id);
    for (const rec of this.groups.values()) rec.group.visible = false;

    // beat context is shared by every clip on screen
    let sinceBeat = 999, beatIndex = -1;
    if (beats?.length) {
      for (let i = beats.length - 1; i >= 0; i--) {
        if (beats[i] <= time) { sinceBeat = time - beats[i]; beatIndex = i; break; }
      }
    }

    // higher track index renders further back, so track 0 sits in front
    const active = clips
      .filter(c => time >= c.start && time < c.end)
      .sort((a, b) => b.track - a.track);

    let glyphCount = 0;
    for (const clip of active) {
      const rec = this._group(clip, project, stack);
      rec.group.visible = true;
      rec.group.position.set((clip.offsetX || 0) * project.width, (clip.offsetY || 0) * project.height, 0);
      rec.group.renderOrder = 10 - clip.track;

      const react = clamp(clip.beatReact ?? 0, 0, 1);
      const pulse = beats?.length ? Math.exp(-sinceBeat * 9) * react : 0;
      const dur = Math.max(1e-4, clip.end - clip.start);
      const u = clamp((time - clip.start) / dur, 0, 1);
      const p = resolveParams(clip.effect, clip.params);
      const n = rec.glyphs.length;
      glyphCount += n;

      const c = {
        i: 0, n, u, t: time - clip.start, time, pulse, react, sinceBeat, beatIndex,
        p, W: project.width, H: project.height, size: rec.sizePx, clip
      };

      for (let i = 0; i < n; i++) {
        const gl = rec.glyphs[i];
        const g = {
          x: gl.base.x, y: gl.base.y, z: 0,
          rx: 0, ry: 0, rz: 0,
          sx: 1, sy: 1, sz: 1,
          opacity: 1
        };
        c.i = i;
        applyEffect(clip.effect, g, c);

        gl.mesh.position.set(g.x, g.y, g.z);
        gl.mesh.rotation.set(g.rx, g.ry, g.rz);
        gl.mesh.scale.set(g.sx || 1e-4, g.sy || 1e-4, g.sz || 1e-4);
        const o = clamp(g.opacity, 0, 1);
        gl.material.opacity = o;
        gl.mesh.visible = o > 0.002;
      }
    }

    this.renderer.render(this.scene, this.camera);
    return { live: active.length, glyphs: glyphCount };
  }
}
