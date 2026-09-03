// Font outlines → three.js geometry.
//
// opentype.js gives us real glyph contours; we turn each one into a THREE.Shape
// (with proper holes, so 合 and 起 don't come out as solid blobs) and hand it to
// ShapeGeometry / ExtrudeGeometry. One mesh per glyph — that is what lets the
// effects treat every character as an independent object.
//
// Text is laid out against a *stack* of fonts: each character is drawn with the
// first font in the stack that actually has a glyph for it, so a Latin display
// face can carry the headline while a CJK face picks up 起承轉合.

import * as THREE from 'three';
import * as opentype from 'opentype.js';

export const FONT_PRESETS = [
  { id: 'noto-tc-700', label: 'Noto Sans TC · Bold（中文）', cjk: true,
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-tc@5.0.20/files/noto-sans-tc-chinese-traditional-700-normal.woff' },
  { id: 'noto-tc-400', label: 'Noto Sans TC · Regular（中文）', cjk: true,
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-tc@5.0.20/files/noto-sans-tc-chinese-traditional-400-normal.woff' },
  { id: 'inter-700', label: 'Inter · Bold',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.20/files/inter-latin-700-normal.woff' },
  { id: 'inter-400', label: 'Inter · Regular',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.20/files/inter-latin-400-normal.woff' },
  { id: 'bebas', label: 'Bebas Neue',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/bebas-neue@5.0.20/files/bebas-neue-latin-400-normal.woff' },
  { id: 'playfair-700', label: 'Playfair Display · Bold',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/playfair-display@5.0.20/files/playfair-display-latin-700-normal.woff' }
];

let fontSerial = 0;

export async function parseFont(arrayBuffer, name = 'font') {
  const font = opentype.parse(arrayBuffer);
  font.__id = `f${++fontSerial}`;
  font.__label = font.names?.fullName?.en || font.names?.fontFamily?.en || name;
  await registerFace(font, arrayBuffer);
  return font;
}

export async function loadFontFromUrl(url, name) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFont(await res.arrayBuffer(), name);
}

export const loadFontFromFile = async file => parseFont(await file.arrayBuffer(), file.name);

// ── kerning ──────────────────────────────────────────────────
//
// opentype.js reads kerning out of the legacy `kern` table and out of plain
// GPOS PairPos lookups, but it does not resolve GPOS lookup type 9 (Extension
// Positioning) — and that is exactly where many modern families keep their real
// pair kerning: Inter's letter pairs and the whole of Playfair Display's kern
// feature live behind an extension lookup, so opentype reports 0 for every one
// of them.
//
// So metrics come from the browser instead. The same font file is registered as
// a FontFace and measured on a canvas, which runs the platform shaper over the
// complete GPOS table. A pair's kern is what the pair measures minus what its
// two glyphs measure alone. Outlines still come from opentype.

const MEASURE_EM = 1000;      // measure big, scale down: keeps rounding out of the way
const kernCache = new Map();
let measureCtx = null;

async function registerFace(font, arrayBuffer) {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
  const family = `ktc-${font.__id}`;
  try {
    const face = new FontFace(family, arrayBuffer.slice(0));
    await face.load();
    document.fonts.add(face);
    font.__family = family;
  } catch {
    font.__family = null;      // fall back to opentype's own kern data
  }
}

/** Kern for one pair, as a fraction of the em. Null when it cannot be measured. */
function measuredKern(font, a, b) {
  if (!font.__family) return null;
  const key = `${font.__id}|${a}|${b}`;
  const hit = kernCache.get(key);
  if (hit !== undefined) return hit;

  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const spec = `${MEASURE_EM}px "${font.__family}"`;
    if (!document.fonts.check(spec)) return null;      // not ready yet — ask again later
    measureCtx.font = spec;
    const w = t => measureCtx.measureText(t).width;
    const k = (w(a + b) - w(a) - w(b)) / MEASURE_EM;
    // a ligature or a substituted form would read as an absurd "kern" — ignore those
    const v = Math.abs(k) > 0.5 ? 0 : k;
    kernCache.set(key, v);
    return v;
  } catch {
    return null;
  }
}

/** Kern between two adjacent glyphs of one font, in em fractions. */
export function pairKern(font, prevChar, prevGlyph, char, glyph) {
  const measured = measuredKern(font, prevChar, char);
  if (measured !== null) return measured;
  return font.getKerningValue(prevGlyph, glyph) / font.unitsPerEm;
}

// ── outline → shapes ─────────────────────────────────────────

/** opentype Path (y-down) → array of THREE.Path contours (y-up). */
function pathToContours(otPath) {
  const out = [];
  let cur = null;
  for (const c of otPath.commands) {
    switch (c.type) {
      case 'M': cur = new THREE.Path(); cur.moveTo(c.x, -c.y); out.push(cur); break;
      case 'L': cur?.lineTo(c.x, -c.y); break;
      case 'C': cur?.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y); break;
      case 'Q': cur?.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y); break;
      case 'Z': cur?.closePath(); break;
    }
  }
  return out.filter(p => p.curves.length > 0);
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Sort contours into filled shapes and counters (holes).
 *
 * Winding direction alone is unreliable across foundries, and a bare
 * point-in-polygon test breaks on CJK faces, where separate strokes routinely
 * overlap — one stroke's start point can land inside a neighbouring stroke and
 * get punched out. A counter is therefore only a counter when it is *wholly*
 * inside another contour (bounding box included) and wound the other way.
 */
function contoursToShapes(contours, divisions = 6) {
  const polys = contours.map(c => c.getPoints(divisions));
  const n = contours.length;

  const boxes = polys.map(pts => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  });
  const areas = polys.map(signedArea);
  const eps = 0.5;
  const encloses = (i, j) =>
    boxes[i].x0 >= boxes[j].x0 - eps && boxes[i].x1 <= boxes[j].x1 + eps &&
    boxes[i].y0 >= boxes[j].y0 - eps && boxes[i].y1 <= boxes[j].y1 + eps &&
    pointInPoly(polys[i][0], polys[j]);

  const depth = new Array(n).fill(0);
  const inside = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (polys[i].length < 3) continue;
    for (let j = 0; j < n; j++) {
      if (i === j || polys[j].length < 3) continue;
      if (encloses(i, j)) { depth[i]++; inside[i].push(j); }
    }
  }
  // immediate parent = the deepest contour enclosing this one
  const parent = inside.map(list =>
    list.reduce((best, j) => (best === -1 || depth[j] > depth[best] ? j : best), -1));

  const isHole = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p >= 0 && depth[i] % 2 === 1 && Math.sign(areas[i]) !== Math.sign(areas[p])) isHole[i] = true;
  }

  const shapes = new Map();
  for (let i = 0; i < n; i++) {
    if (isHole[i] || polys[i].length < 3) continue;
    const sh = new THREE.Shape();
    sh.curves = contours[i].curves;
    sh.autoClose = true;
    shapes.set(i, sh);
  }
  for (let i = 0; i < n; i++) {
    if (!isHole[i]) continue;
    let host = parent[i];
    while (host >= 0 && !shapes.has(host)) host = parent[host];   // skip over nested holes
    const target = shapes.get(host);
    if (!target) continue;
    const h = new THREE.Path();
    h.curves = contours[i].curves;
    h.autoClose = true;
    target.holes.push(h);
  }
  return [...shapes.values()];
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

// ── geometry cache ───────────────────────────────────────────
const geoCache = new Map();

export function glyphGeometry(font, glyph, size, depth = 0, curveSegments = 8) {
  const key = `${font.__id}|${glyph.index}|${size.toFixed(2)}|${depth}|${curveSegments}`;
  const hit = geoCache.get(key);
  if (hit) { hit.refs++; return hit; }

  const otPath = glyph.getPath(0, 0, size);
  const shapes = contoursToShapes(pathToContours(otPath), curveSegments <= 4 ? 4 : 6);

  let geometry = null, box = new THREE.Box3();
  if (shapes.length) {
    geometry = depth > 0
      ? new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments, steps: 1 })
      : new THREE.ShapeGeometry(shapes, curveSegments);
    geometry.computeBoundingBox();
    box = geometry.boundingBox.clone();
    // Re-centre on the glyph's own ink so rotation and scaling pivot correctly.
    const c = box.getCenter(new THREE.Vector3());
    geometry.translate(-c.x, -c.y, depth > 0 ? -depth / 2 : 0);
    geometry.userData.center = { x: c.x, y: c.y };
  }
  const entry = { geometry, box, center: geometry?.userData.center ?? { x: 0, y: 0 }, refs: 1, key };
  geoCache.set(key, entry);
  return entry;
}

export function pruneGeometryCache(max = 600) {
  if (geoCache.size <= max) return;
  const keys = [...geoCache.keys()].slice(0, geoCache.size - max);
  for (const k of keys) { geoCache.get(k)?.geometry?.dispose(); geoCache.delete(k); }
  if (outlineCache.size > max) {
    const stale = [...outlineCache.keys()].slice(0, outlineCache.size - max);
    for (const k of stale) outlineCache.delete(k);
  }
}

// ── outline sampling ─────────────────────────────────────────
const outlineCache = new Map();

/**
 * Points spaced evenly along a glyph's contours, in the same re-centred local
 * space as `glyphGeometry` — pass that entry's `center` so the samples land on
 * the mesh. This is what lets particles read the real letterform (counters and
 * every CJK stroke included) rather than its bounding box.
 *
 * @returns {Float32Array} flat x,y pairs
 */
export function glyphOutline(font, glyph, size, center = { x: 0, y: 0 }, spacing = 0.075, max = 120) {
  const key = `${font.__id}|${glyph.index}|${size.toFixed(2)}|${spacing}|${max}|` +
              `${center.x.toFixed(1)},${center.y.toFixed(1)}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;

  const step = Math.max(1, size * spacing);
  const pts = [];
  for (const contour of pathToContours(glyph.getPath(0, 0, size))) {
    const poly = contour.getPoints(6);
    if (poly.length < 2) continue;
    let carry = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      let d = carry;
      for (; d < len; d += step) pts.push(a.x + dx * d / len, a.y + dy * d / len);
      carry = d - len;
    }
  }

  // Dense faces (and big sizes) would swamp the collider grid — thin them out
  // evenly rather than dropping the tail of the outline.
  const total = pts.length / 2;
  const stride = total > max ? Math.ceil(total / max) : 1;
  const out = new Float32Array(Math.ceil(total / stride) * 2);
  for (let i = 0, j = 0; i < total; i += stride, j++) {
    out[j * 2] = pts[i * 2] - center.x;
    out[j * 2 + 1] = pts[i * 2 + 1] - center.y;
  }
  outlineCache.set(key, out);
  return out;
}

// ── text layout ──────────────────────────────────────────────

/** First font in the stack that actually has a glyph for this character. */
export function pickFont(fonts, ch) {
  for (const f of fonts) {
    if (!f) continue;
    try { if (f.charToGlyphIndex(ch) > 0) return f; } catch { /* fall through */ }
  }
  return fonts.find(Boolean) ?? null;
}

/**
 * Lay a string out in a y-up space centred on (0,0), resolving every character
 * against the font stack. Line metrics come from the primary font so mixed
 * scripts still sit on one baseline.
 *
 * @param {object|object[]} fonts primary font, or an ordered fallback stack
 */
export function layoutText(fonts, text, size, opts = {}) {
  const { lineHeight = 1.25, tracking = 0, align = 'center' } = opts;
  const stack = (Array.isArray(fonts) ? fonts : [fonts]).filter(Boolean);
  const primary = stack[0];
  const lineStep = size * lineHeight;
  if (!primary) return { items: [], width: 0, height: lineStep, lineCount: 0, lineStep, scale: 1 };

  const scale = size / primary.unitsPerEm;
  const lines = String(text ?? '').split('\n');
  const asc = primary.ascender * scale;
  const desc = primary.descender * scale;      // negative

  const laid = lines.map(line => {
    const chars = Array.from(line);
    const items = [];
    let pen = 0, prev = null, prevFont = null, prevChar = '';
    for (const ch of chars) {
      const font = pickFont(stack, ch);
      const sc = size / font.unitsPerEm;
      const g = font.charToGlyph(ch);
      // kerning pairs only exist within one font
      if (prev && prevFont === font) pen += pairKern(font, prevChar, prev, ch, g) * size;
      items.push({ glyph: g, font, char: ch, x: pen, advance: g.advanceWidth * sc });
      pen += g.advanceWidth * sc + tracking * size;
      prev = g; prevFont = font; prevChar = ch;
    }
    const width = Math.max(0, pen - (items.length ? tracking * size : 0));
    return { items, width };
  });

  const blockW = Math.max(1, ...laid.map(l => l.width));
  const blockH = lineStep * lines.length;

  const out = [];
  let index = 0;
  laid.forEach((line, li) => {
    const cy = ((lines.length - 1) / 2 - li) * lineStep;
    const baseY = cy - (asc + desc) / 2;
    let ox;
    if (align === 'left')       ox = -blockW / 2;
    else if (align === 'right') ox =  blockW / 2 - line.width;
    else                        ox = -line.width / 2;

    for (const it of line.items) {
      out.push({
        ...it,
        index: index++,
        line: li,
        x: ox + it.x,
        y: baseY,
        blank: /\s/.test(it.char)
      });
    }
  });

  return { items: out, width: blockW, height: blockH, lineCount: lines.length, lineStep, scale };
}
