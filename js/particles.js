// A small CPU particle system that knows about the letterforms.
//
// A composition holds any number of emitters. Each one owns its position, its
// own live window on the timeline, and its own look — so a slow drift over the
// whole piece and a one-second burst off a single word are two entries in the
// same list rather than two settings fighting over one global layer.
//
// Particles are simple procedural shapes drawn as point sprites: the shader
// evaluates a signed distance field in gl_PointCoord, so a circle, a ring or a
// cross costs one quad and no texture. The simulation runs on fixed steps in
// world space — the same space the glyph meshes live in — which is what lets it
// read the *real* glyph outlines and bounce, cling or swirl against them rather
// than against a bounding box.
//
// The renderer hands over a flat list of outline points, already transformed by
// whatever the effects did to each glyph this frame, and the field buckets them
// into a uniform grid for nearest-point lookups.

import * as THREE from 'three';
import { clamp, uid } from './util.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const FIXED_STEP = 1 / 60;

export const MAX_PARTICLES = 4000;      // per emitter
export const MAX_COLLIDERS = 4000;
export const MAX_EMITTERS = 8;

export const PARTICLE_SHAPES = [
  { id: 'circle',   label: 'Circle' },
  { id: 'square',   label: 'Square' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'diamond',  label: 'Diamond' },
  { id: 'ring',     label: 'Ring' },
  { id: 'cross',    label: 'Cross' },
  { id: 'streak',   label: 'Streak' }
];

export const PARTICLE_ORIGINS = [
  { id: 'area',    label: 'Whole frame' },
  { id: 'box',     label: 'Box volume' },
  { id: 'point',   label: 'Point' },
  { id: 'bottom',  label: 'Bottom edge' },
  { id: 'top',     label: 'Top edge' },
  { id: 'outline', label: 'Off the text outline' }
];

export const TEXT_MODES = [
  { id: 'none',    label: 'Ignore the text' },
  { id: 'collide', label: 'Bounce off outlines' },
  { id: 'attract', label: 'Cling to outlines' },
  { id: 'repel',   label: 'Push away from outlines' },
  { id: 'orbit',   label: 'Swirl around outlines' }
];

const SHAPE_INDEX = Object.fromEntries(PARTICLE_SHAPES.map((s, i) => [s.id, i]));
const shapeIds = PARTICLE_SHAPES.map(s => s.id);
const originIds = PARTICLE_ORIGINS.map(o => o.id);
const textModeIds = TEXT_MODES.map(m => m.id);

const num = (v, def, min, max) => clamp(Number.isFinite(Number(v)) ? Number(v) : def, min, max);
const pick = (v, list, def) => (list.includes(v) ? v : def);
const hex = (v, def) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : def);

/** Defaults and clamping for one emitter — the serialisable half of the system. */
export function makeEmitter(props = {}, { duration = 24 } = {}) {
  const s = props && typeof props === 'object' ? props : {};
  const start = num(s.start, 0, 0, 1e5);
  return {
    id: typeof s.id === 'string' && s.id ? s.id : uid('pe'),
    name: typeof s.name === 'string' ? s.name.slice(0, 60) : '',
    on: s.on !== false,

    // The window this emitter is alive for. Particles already born keep
    // flying past the out-point and fade out on their own.
    start,
    end: Math.max(start + 0.05, num(s.end, duration, 0.05, 1e5)),

    shape: pick(s.shape, shapeIds, 'circle'),
    // Where a particle is born. (`emitter` is the pre-list field name.)
    origin: pick(s.origin ?? s.emitter, originIds, 'area'),

    // Emitter placement, in the same world units as a text layer's position.
    x: num(s.x, 0, -8000, 8000),
    y: num(s.y, 0, -8000, 8000),
    z: num(s.z, 0, -8000, 8000),
    spawnDepth: num(s.spawnDepth, 0, 0, 2000),

    // The 'box' origin's extent, centred on the emitter position. It replaces
    // `spawnDepth` on that origin: the box carries its own depth.
    boxW: num(s.boxW, 800, 0, 8000),
    boxH: num(s.boxH, 800, 0, 8000),
    boxD: num(s.boxD, 400, 0, 8000),

    rate: num(s.rate, 90, 0, 400),
    burst: num(s.burst, 0, 0, 200),           // extra particles on every beat
    life: num(s.life, 2.2, 0.1, 6),
    lifeJitter: num(s.lifeJitter, 0.4, 0, 1),

    size: num(s.size, 9, 0.5, 120),
    sizeJitter: num(s.sizeJitter, 0.5, 0, 1),
    spin: num(s.spin, 0.6, 0, 12),

    speed: num(s.speed, 90, 0, 2000),
    direction: num(s.direction, 90, 0, 360),  // degrees, 0 = +x
    spread: num(s.spread, 1, 0, 1),           // 1 = a full circle
    gravity: num(s.gravity, -40, -1500, 1500),
    wind: num(s.wind, 0, -1500, 1500),
    drag: num(s.drag, 0.6, 0, 6),
    turbulence: num(s.turbulence, 40, 0, 800),
    swirl: num(s.swirl, 0.6, 0, 6),

    colorA: hex(s.colorA, '#7dd3fc'),
    colorB: hex(s.colorB, '#f472b6'),
    opacity: num(s.opacity, 0.85, 0, 1),
    additive: s.additive !== false,

    textMode: pick(s.textMode, textModeIds, 'collide'),
    textRadius: num(s.textRadius, 70, 4, 600),
    textForce: num(s.textForce, 700, 0, 6000),
    bounce: num(s.bounce, 0.55, 0, 1),

    seed: Math.max(1, Math.round(num(s.seed, 1, 1, 1e6))),
    // Bumped on every edit so a paused stage can re-simulate and show the change.
    revision: Math.round(num(s.revision, 0, 0, 1e9))
  };
}

/** The particle layer: an ordered list of emitters. */
export function makeParticles(props = {}, opts = {}) {
  const s = props && typeof props === 'object' ? props : {};
  // A pre-list project saved one flat emitter under `particles` — carry it in.
  const list = Array.isArray(s.emitters) ? s.emitters
             : (s.shape || s.origin || s.emitter ? [s] : []);
  return { emitters: list.slice(0, MAX_EMITTERS).map(e => makeEmitter(e, opts)) };
}

// ── shaders ──────────────────────────────────────────────────
//
// vAA carries one pixel expressed in point-coord units, so the SDF edge can be
// antialiased without asking for derivative support.

const VERT = `
attribute float aSize;
attribute float aAge;
attribute float aRot;
attribute float aAlpha;
uniform float uScale;
varying float vAge;
varying float vRot;
varying float vAlpha;
varying float vAA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = max(1.0, aSize * uScale / max(-mv.z, 1.0));
  gl_PointSize = px;
  vAge = aAge; vRot = aRot; vAlpha = aAlpha;
  vAA = 1.5 / px;
}`;

const FRAG = `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform int uShape;
varying float vAge;
varying float vRot;
varying float vAlpha;
varying float vAA;

float sdBox(vec2 p, vec2 b) { vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
float sdTriangle(vec2 p) {
  const float k = 1.7320508;
  p.x = abs(p.x) - 0.5;
  p.y = p.y + 0.5 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -1.0, 0.0);
  return -length(p) * sign(p.y);
}

void main() {
  vec2 p = gl_PointCoord - 0.5;
  p.y = -p.y;
  float c = cos(vRot), s = sin(vRot);
  p = mat2(c, -s, s, c) * p;

  float d;
  if      (uShape == 1) d = sdBox(p, vec2(0.5));
  else if (uShape == 2) d = sdTriangle(p);
  else if (uShape == 3) d = abs(p.x) + abs(p.y) - 0.5;
  else if (uShape == 4) d = abs(length(p) - 0.36) - 0.1;
  else if (uShape == 5) d = min(sdBox(p, vec2(0.5, 0.13)), sdBox(p, vec2(0.13, 0.5)));
  else if (uShape == 6) d = sdBox(p, vec2(0.5, 0.09));
  else                  d = length(p) - 0.5;

  float a = (1.0 - smoothstep(-vAA, vAA, d)) * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColorA, uColorB, clamp(vAge, 0.0, 1.0)), a);
}`;

/** mulberry32 — a seeded stream, so scrubbing back to a moment rebuilds it. */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ParticleField {
  constructor(capacity = MAX_PARTICLES) {
    this.capacity = capacity;
    this.count = 0;

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.aSize = new Float32Array(capacity);
    this.aAge = new Float32Array(capacity);
    this.aRot = new Float32Array(capacity);
    this.aAlpha = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    this.geometry.setAttribute('aAge', new THREE.BufferAttribute(this.aAge, 1));
    this.geometry.setAttribute('aRot', new THREE.BufferAttribute(this.aRot, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color('#7dd3fc') },
        uColorB: { value: new THREE.Color('#f472b6') },
        uOpacity: { value: 0.85 },
        uShape: { value: 0 },
        uScale: { value: 1000 }
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;

    this.simTime = null;
    this.emitAcc = 0;
    this.beatIndex = 0;
    this.rng = makeRng(1);
    this._seeded = 1;
    this._revision = -1;

    // Uniform grid over the outline points, rebuilt once per frame.
    this.grid = { cell: 1, minX: 0, minY: 0, cols: 0, rows: 0, heads: new Int32Array(0), next: new Int32Array(0) };
  }

  hide() {
    this.points.visible = false;
    this.geometry.setDrawRange(0, 0);
    this.simTime = null;
  }

  /** Point sprites are sized in pixels, so world size needs the projection scale. */
  setProjection(fovDeg, renderHeight) {
    this.material.uniforms.uScale.value =
      renderHeight / (2 * Math.tan((fovDeg / 2) * DEG));
  }

  reset(seed = 1) {
    this.count = 0;
    this.emitAcc = 0;
    this.beatIndex = 0;
    this.rng = makeRng(seed);
    this._seeded = seed;
  }

  /**
   * Advance the simulation to `time`.
   * @param {object} ctx { time, project, settings, colliders, beats }
   *   colliders — { points: Float32Array of x,y pairs, count } in world space
   */
  update({ time, project, settings, colliders = null, beats = null }) {
    // Outside its own window an emitter is either not born yet, or its last
    // particle has long since aged out — either way there is nothing to draw.
    const tail = settings ? settings.life * (1 + settings.lifeJitter * 0.5) : 0;
    if (!settings?.on || time < settings.start || time >= settings.end + tail) {
      this.hide();
      return;
    }
    this.points.visible = true;
    this._syncMaterial(settings);

    // A jump backwards, a big jump forwards or a changed seed all mean the
    // running cloud is meaningless: rebuild it by simulating a short warm-up
    // window so a scrubbed frame still looks lived-in.
    // While the transport is paused the clock does not move, so an edit would
    // otherwise leave the last simulated cloud on screen: rebuild it instead.
    const paused = this.simTime !== null && Math.abs(time - this.simTime) < 1e-6;
    const edited = paused && this._revision !== settings.revision;
    this._revision = settings.revision;

    const warm = Math.min(settings.life * 1.4, 2.5);
    if (this.simTime === null || edited || time < this.simTime - 1e-4 ||
        time - this.simTime > 1 || this._seeded !== settings.seed) {
      this.reset(settings.seed);
      this.simTime = Math.max(settings.start, time - warm);
      this._syncBeatCursor(beats, this.simTime);
    }

    this._buildGrid(colliders, Math.max(settings.textRadius, 24));

    let guard = 300;
    while (this.simTime < time - 1e-6 && guard-- > 0) {
      const dt = Math.min(FIXED_STEP, time - this.simTime);
      this._step(this.simTime + dt, dt, settings, project, colliders, beats);
      this.simTime += dt;
    }
    this.simTime = time;
    this._upload();
  }

  _syncMaterial(s) {
    const u = this.material.uniforms;
    u.uColorA.value.set(s.colorA);
    u.uColorB.value.set(s.colorB);
    u.uOpacity.value = s.opacity;
    u.uShape.value = SHAPE_INDEX[s.shape] ?? 0;
    const blending = s.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (this.material.blending !== blending) {
      this.material.blending = blending;
      this.material.needsUpdate = true;
    }
  }

  _syncBeatCursor(beats, t) {
    this.beatIndex = 0;
    if (!beats?.length) return;
    while (this.beatIndex < beats.length && beats[this.beatIndex] <= t) this.beatIndex++;
  }

  // ── one fixed step ─────────────────────────────────────────
  _step(t, dt, s, project, colliders, beats) {
    const emitting = t >= s.start && t < s.end;
    if (emitting) {
      this.emitAcc += s.rate * dt;
      const born = Math.floor(this.emitAcc);
      this.emitAcc -= born;
      for (let k = 0; k < born; k++) this._spawn(s, project, colliders);
    }

    if (s.burst > 0 && beats?.length) {
      while (this.beatIndex < beats.length && beats[this.beatIndex] <= t) {
        if (emitting) for (let k = 0; k < s.burst; k++) this._spawn(s, project, colliders);
        this.beatIndex++;
      }
    }

    const W = project.width, H = project.height;
    const boundX = W * 1.6, boundY = H * 1.6;
    const drag = Math.max(0, 1 - s.drag * dt);
    const turb = s.turbulence;
    const phase = t * s.swirl;
    const mode = s.textMode;
    const useText = mode !== 'none' && colliders && colliders.count > 0;
    const radius = s.textRadius;
    const streak = s.shape === 'streak';

    for (let i = this.count - 1; i >= 0; i--) {
      const p3 = i * 3;
      let px = this.pos[p3], py = this.pos[p3 + 1], pz = this.pos[p3 + 2];
      let vx = this.vel[p3], vy = this.vel[p3 + 1], vz = this.vel[p3 + 2];

      let ax = s.wind, ay = s.gravity;
      if (turb > 0) {
        // Cheap divergence-free-ish swirl: each axis reads the other's phase.
        ax += Math.sin(py * 0.006 + phase * 1.3) * Math.cos(pz * 0.004 - phase) * turb;
        ay += Math.cos(px * 0.006 - phase * 1.1) * turb;
      }
      vx = (vx + ax * dt) * drag;
      vy = (vy + ay * dt) * drag;
      vz *= drag;

      if (useText) {
        const near = this._nearest(colliders, px, py, radius);
        if (near) {
          const { dist, nx, ny, qx, qy } = near;
          if (mode === 'collide') {
            const hit = Math.max(1.5, this.aSize[i] * 0.5);
            if (dist < hit) {
              px = qx + nx * hit;
              py = qy + ny * hit;
              const vn = vx * nx + vy * ny;
              if (vn < 0) { vx -= (1 + s.bounce) * vn * nx; vy -= (1 + s.bounce) * vn * ny; }
            }
          } else {
            const fall = 1 - dist / radius;
            const f = s.textForce * fall * fall * dt;
            if (mode === 'attract')      { vx -= nx * f; vy -= ny * f; }
            else if (mode === 'repel')   { vx += nx * f; vy += ny * f; }
            else /* orbit */             { vx += -ny * f; vy += nx * f; }
          }
        }
      }

      px += vx * dt; py += vy * dt; pz += vz * dt;
      this.pos[p3] = px; this.pos[p3 + 1] = py; this.pos[p3 + 2] = pz;
      this.vel[p3] = vx; this.vel[p3 + 1] = vy; this.vel[p3 + 2] = vz;

      const age = this.age[i] + dt;
      if (age >= this.ttl[i] || px < -boundX || px > boundX || py < -boundY || py > boundY) {
        this._kill(i);
        continue;
      }
      this.age[i] = age;
      const u = age / this.ttl[i];
      this.aAge[i] = u;
      this.aAlpha[i] = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.35);
      this.aRot[i] = streak ? Math.atan2(vy, vx) : this.aRot[i] + this.spin[i] * dt;
    }
  }

  _kill(i) {
    const last = --this.count;
    if (i !== last) {
      const a = i * 3, b = last * 3;
      this.pos[a] = this.pos[b]; this.pos[a + 1] = this.pos[b + 1]; this.pos[a + 2] = this.pos[b + 2];
      this.vel[a] = this.vel[b]; this.vel[a + 1] = this.vel[b + 1]; this.vel[a + 2] = this.vel[b + 2];
      this.age[i] = this.age[last]; this.ttl[i] = this.ttl[last];
      this.aSize[i] = this.aSize[last]; this.aAge[i] = this.aAge[last];
      this.aRot[i] = this.aRot[last]; this.aAlpha[i] = this.aAlpha[last];
      this.spin[i] = this.spin[last];
    }
  }

  _spawn(s, project, colliders) {
    if (this.count >= this.capacity) return;
    const r = this.rng;
    const W = project.width, H = project.height;
    let px = s.x, py = s.y, angle = s.direction * DEG;
    const cone = s.spread * Math.PI;

    switch (s.origin) {
      case 'point':
        angle += (r() * 2 - 1) * cone;
        break;
      // A point given volume: born anywhere inside the box, but still fired
      // along the emitter's direction cone.
      case 'box':
        px = s.x + (r() - 0.5) * s.boxW;
        py = s.y + (r() - 0.5) * s.boxH;
        angle += (r() * 2 - 1) * cone;
        break;
      case 'bottom':
        px = s.x + (r() - 0.5) * W; py = s.y - H / 2;
        angle = Math.PI / 2 + (r() * 2 - 1) * cone * 0.5;
        break;
      case 'top':
        px = s.x + (r() - 0.5) * W; py = s.y + H / 2;
        angle = -Math.PI / 2 + (r() * 2 - 1) * cone * 0.5;
        break;
      case 'outline': {
        if (!colliders || !colliders.count) return;      // nothing on screen to shed from
        const k = Math.min(colliders.count - 1, (r() * colliders.count) | 0);
        px = colliders.points[k * 2] + s.x;
        py = colliders.points[k * 2 + 1] + s.y;
        angle = r() * TAU;
        break;
      }
      default:      // 'area'
        px = s.x + (r() - 0.5) * W; py = s.y + (r() - 0.5) * H;
        angle = r() * TAU;
    }

    const i = this.count++;
    const p3 = i * 3;
    const speed = s.speed * (0.55 + 0.9 * r());
    this.pos[p3] = px;
    this.pos[p3 + 1] = py;
    const depth = s.origin === 'box' ? s.boxD : s.spawnDepth;
    this.pos[p3 + 2] = s.z + (r() - 0.5) * depth;
    this.vel[p3] = Math.cos(angle) * speed;
    this.vel[p3 + 1] = Math.sin(angle) * speed;
    this.vel[p3 + 2] = (r() - 0.5) * depth * 0.25;
    this.age[i] = 0;
    this.ttl[i] = Math.max(0.05, s.life * (1 - s.lifeJitter * 0.5 + r() * s.lifeJitter));
    this.aSize[i] = Math.max(0.4, s.size * (1 - s.sizeJitter * 0.5 + r() * s.sizeJitter));
    this.aAge[i] = 0;
    this.aRot[i] = r() * TAU;
    this.aAlpha[i] = 0;
    this.spin[i] = (r() * 2 - 1) * s.spin;
  }

  // ── outline lookup ─────────────────────────────────────────
  _buildGrid(colliders, cell) {
    const g = this.grid;
    g.cols = 0; g.rows = 0;
    if (!colliders || !colliders.count) return;

    const pts = colliders.points, n = colliders.count;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cols = Math.min(512, Math.max(1, Math.ceil((maxX - minX) / cell) + 1));
    const rows = Math.min(512, Math.max(1, Math.ceil((maxY - minY) / cell) + 1));

    if (g.heads.length < cols * rows) g.heads = new Int32Array(cols * rows);
    if (g.next.length < n) g.next = new Int32Array(n);
    g.heads.fill(-1, 0, cols * rows);

    Object.assign(g, { cell, minX, minY, cols, rows });
    for (let i = 0; i < n; i++) {
      const cx = clamp(((pts[i * 2] - minX) / cell) | 0, 0, cols - 1);
      const cy = clamp(((pts[i * 2 + 1] - minY) / cell) | 0, 0, rows - 1);
      const b = cy * cols + cx;
      g.next[i] = g.heads[b];
      g.heads[b] = i;
    }
  }

  /** Nearest outline point within `radius`, with the unit vector pointing at the particle. */
  _nearest(colliders, x, y, radius) {
    const g = this.grid;
    if (!g.cols) return null;
    const pts = colliders.points;
    const cx = clamp(((x - g.minX) / g.cell) | 0, 0, g.cols - 1);
    const cy = clamp(((y - g.minY) / g.cell) | 0, 0, g.rows - 1);

    let best = -1, bestSq = radius * radius;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = cy + oy;
      if (yy < 0 || yy >= g.rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = cx + ox;
        if (xx < 0 || xx >= g.cols) continue;
        for (let i = g.heads[yy * g.cols + xx]; i !== -1; i = g.next[i]) {
          const dx = x - pts[i * 2], dy = y - pts[i * 2 + 1];
          const sq = dx * dx + dy * dy;
          if (sq < bestSq) { bestSq = sq; best = i; }
        }
      }
    }
    if (best < 0) return null;
    const qx = pts[best * 2], qy = pts[best * 2 + 1];
    const dist = Math.sqrt(bestSq) || 1e-4;
    return { dist, qx, qy, nx: (x - qx) / dist, ny: (y - qy) / dist };
  }

  _upload() {
    this.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'aSize', 'aAge', 'aRot', 'aAlpha']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
