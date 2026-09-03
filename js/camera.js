// Camera track — keyframed framing over the whole composition.
//
// The camera is not a layer: it moves the view, so every live clip is affected
// at once, and because the stage is rendered in perspective a pan gives real
// parallax against glyphs that effects have pushed in z.
//
// Camera and text now share one world-space coordinate system. Camera keys keep
// an explicit `position: { x, y, z }`; roll remains the camera's Z rotation.
// X/Y/Z are scene units (the same units as the glyph geometry), so the 3D
// editor can show the authored transforms without translating offsets on the
// fly.

import { clamp, lerp, easeInCubic, easeOutCubic, easeInOutCubic } from './util.js';

export const FOV = 40;
const HALF_FOV = (FOV / 2) * Math.PI / 180;

/** Distance at which a camera frames the full project height at z = 0. */
export const defaultCameraZ = (width = 1080, height = 1080) =>
  (height / 2) / Math.tan(HALF_FOV);

export const defaultCameraPosition = (width = 1080, height = 1080) => ({
  x: 0, y: 0, z: defaultCameraZ(width, height)
});

export const CAMERA_AXES = Object.freeze(['x', 'y', 'z']);

export const CAMERA_REST = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }), roll: 0
});

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

/** Sort one of the independent position channels. */
export function sortChannelKeys(keys) {
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

/**
 * Return a key's world-space position. The legacy fallback is deliberately
 * kept here as well as in project loading, so a hand-authored object from an
 * older integration cannot silently put the camera at the wrong depth.
 */
export function cameraPosition(key, width = 1080, height = 1080) {
  if (key?.position && typeof key.position === 'object') {
    return {
      x: finite(key.position.x),
      y: finite(key.position.y),
      z: finite(key.position.z, defaultCameraZ(width, height))
    };
  }
  const restZ = defaultCameraZ(width, height);
  return {
    x: finite(key?.x) * width,
    y: finite(key?.y) * height,
    z: Number.isFinite(Number(key?.z)) ? Number(key.z)
      : restZ / Math.max(0.05, finite(key?.zoom, 1))
  };
}

/** Convert an old flat key into the current explicit 3D representation. */
export function normalizeCameraKey(key, width = 1080, height = 1080) {
  if (!key || typeof key !== 'object') return key;
  key.position = cameraPosition(key, width, height);
  key.roll = finite(key.roll);
  key.ease = EASES[key.ease] ? key.ease : 'smooth';
  delete key.x;
  delete key.y;
  delete key.z;
  delete key.zoom;
  return key;
}

/**
 * Read a split-channel key. `value` is the canonical field; the other
 * fallbacks make hand-authored files a little more forgiving.
 */
export function cameraChannelValue(key, axis, width = 1080, height = 1080) {
  if (key?.value !== undefined) return finite(key.value);
  if (key?.position && typeof key.position === 'object') {
    const fallback = axis === 'z' ? defaultCameraZ(width, height) : 0;
    return finite(key.position[axis], fallback);
  }
  return finite(key?.[axis], axis === 'z' ? defaultCameraZ(width, height) : 0);
}

/** Normalize an independent X/Y/Z key at the project boundary. */
export function normalizeCameraChannelKey(key, axis, width = 1080, height = 1080) {
  if (!key || typeof key !== 'object') return key;
  key.t = finite(key.t);
  key.value = cameraChannelValue(key, axis, width, height);
  key.ease = EASES[key.ease] ? key.ease : 'smooth';
  delete key.position;
  delete key.x;
  delete key.y;
  delete key.z;
  return key;
}

function cameraValue(key, width, height) {
  const p = cameraPosition(key, width, height);
  return { position: p, roll: finite(key?.roll) };
}

function channelValueAt(keys, t, fallback, axis, width, height) {
  if (!keys?.length) return fallback;
  const first = keys[0], last = keys[keys.length - 1];
  if (t <= first.t) return cameraChannelValue(first, axis, width, height);
  if (t >= last.t) return cameraChannelValue(last, axis, width, height);

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = easeFn(a.ease)(clamp((t - a.t) / span, 0, 1));
  return lerp(cameraChannelValue(a, axis, width, height),
              cameraChannelValue(b, axis, width, height), u);
}

/** Evaluate one independent position channel. */
export function cameraChannelAt(camera, axis, t, { width = 1080, height = 1080 } = {}) {
  const base = defaultCameraPosition(width, height)[axis];
  return channelValueAt(camera?.channels?.[axis], t, base, axis, width, height);
}

export const isSplitCamera = camera => camera?.mode === 'split' &&
  camera?.channels && typeof camera.channels === 'object';

export const cameraHasKeys = camera => isSplitCamera(camera)
  ? CAMERA_AXES.some(axis => camera.channels[axis]?.length) || !!camera.keys?.length
  : !!camera?.keys?.length;

/** All times represented by the active camera channels. */
export function cameraKeyTimes(camera) {
  const times = isSplitCamera(camera)
    ? [...(camera.keys ?? []).map(k => k.t),
       ...CAMERA_AXES.flatMap(axis => (camera.channels[axis] ?? []).map(k => k.t))]
    : (camera?.keys ?? []).map(k => k.t);
  return [...new Set(times.filter(t => Number.isFinite(Number(t))).map(Number))]
    .sort((a, b) => a - b);
}

/**
 * Entries used by the 3D editor. Split channels share one marker when several
 * axes have a key at the same time, while retaining an axis/id for selection.
 */
export function cameraKeyEntries(camera, width = 1080, height = 1080) {
  if (!isSplitCamera(camera)) {
    return (camera?.keys ?? []).map(key => ({
      id: key.id, axis: null, t: key.t, position: cameraPosition(key, width, height)
    }));
  }
  const enabled = { ...camera, enabled: true };
  return cameraKeyTimes(camera).map(t => {
    let selected = null;
    for (const axis of CAMERA_AXES) {
      selected = (camera.channels[axis] ?? []).find(key => Math.abs(key.t - t) < 1e-4);
      if (selected) return {
        id: selected.id, axis, t,
        position: cameraAt(enabled, t, { width, height }).position
      };
    }
    const master = (camera.keys ?? []).find(key => Math.abs(key.t - t) < 1e-4);
    return {
      id: master?.id ?? `camtime:${t}`,
      axis: null, t,
      position: cameraAt(enabled, t, { width, height }).position
    };
  });
}

/**
 * Framing at a moment. Before the first key and after the last one the camera
 * simply holds that key, so a single key acts as a static reframe.
 */
export function cameraAt(camera, t, { width = 1080, height = 1080 } = {}) {
  if (!camera?.enabled || !cameraHasKeys(camera)) {
    return { position: defaultCameraPosition(width, height), roll: 0 };
  }

  if (isSplitCamera(camera)) {
    const position = defaultCameraPosition(width, height);
    for (const axis of CAMERA_AXES) {
      position[axis] = cameraChannelAt(camera, axis, t, { width, height });
    }
    // Roll stays on the master key list. Position channels do not need to
    // carry duplicate roll values just because an axis gets another key.
    const keys = camera.keys ?? [];
    let roll = 0;
    if (keys.length) {
      if (t <= keys[0].t) roll = finite(keys[0].roll);
      else if (t >= keys[keys.length - 1].t) roll = finite(keys[keys.length - 1].roll);
      else {
        let i = 0;
        while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
        const a = keys[i], b = keys[i + 1];
        const span = Math.max(1e-6, b.t - a.t);
        const u = easeFn(a.ease)(clamp((t - a.t) / span, 0, 1));
        roll = lerp(finite(a.roll), finite(b.roll), u);
      }
    }
    return { position, roll };
  }

  const keys = camera.keys;
  if (t <= keys[0].t) return cameraValue(keys[0], width, height);
  if (t >= keys[keys.length - 1].t) return cameraValue(keys[keys.length - 1], width, height);

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = easeFn(a.ease)(clamp((t - a.t) / span, 0, 1));
  const av = cameraValue(a, width, height), bv = cameraValue(b, width, height);

  return {
    position: {
      x: lerp(av.position.x, bv.position.x, u),
      y: lerp(av.position.y, bv.position.y, u),
      z: lerp(av.position.z, bv.position.z, u)
    },
    roll: lerp(av.roll, bv.roll, u)
  };
}

/** True when the camera actually does something — used to skip work. */
export const cameraActive = camera => !!(camera?.enabled && cameraHasKeys(camera));
