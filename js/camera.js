// Camera track — keyframed framing over the whole composition.
//
// The camera is not a layer: it moves the view, so every live clip is affected
// at once, and because the stage is rendered in perspective a pan gives real
// parallax against glyphs that effects have pushed in z.
//
// Values are resolution independent: x and y are fractions of the frame, zoom
// is a multiple of the default framing, roll is radians.

import { clamp, lerp, easeInCubic, easeOutCubic, easeInOutCubic } from './util.js';

export const CAMERA_REST = { x: 0, y: 0, zoom: 1, roll: 0 };

export const EASES = {
  smooth: { label: 'Smooth', fn: easeInOutCubic },
  linear: { label: 'Linear', fn: t => t },
  in:     { label: 'Ease in', fn: easeInCubic },
  out:    { label: 'Ease out', fn: easeOutCubic },
  hold:   { label: 'Hold', fn: () => 0 }
};

export const easeFn = id => (EASES[id] ?? EASES.smooth).fn;

/** Keys are kept sorted by time; this is the only place that assumption lives. */
export function sortKeys(camera) {
  camera.keys.sort((a, b) => a.t - b.t);
  return camera.keys;
}

/**
 * Framing at a moment. Before the first key and after the last one the camera
 * simply holds that key, so a single key acts as a static reframe.
 */
export function cameraAt(camera, t) {
  if (!camera?.enabled || !camera.keys?.length) return CAMERA_REST;
  const keys = camera.keys;
  if (t <= keys[0].t) return keys[0];
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1];

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = easeFn(a.ease)(clamp((t - a.t) / span, 0, 1));

  return {
    x: lerp(a.x, b.x, u),
    y: lerp(a.y, b.y, u),
    zoom: lerp(a.zoom, b.zoom, u),
    roll: lerp(a.roll, b.roll, u)
  };
}

/** True when the camera actually does something — used to skip work. */
export const cameraActive = camera => !!(camera?.enabled && camera.keys?.length);
