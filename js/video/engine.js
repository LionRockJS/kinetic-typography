// Backdrop video sources.
//
// Each V1/V2/V3 lane can contain any number of clips. Video files stay as
// runtime object URLs rather than becoming part of the project JSON. The state
// store owns the editable clip settings; this module owns HTMLVideoElements
// and keeps them aligned with composition time. Videos are muted deliberately:
// audio belongs to the dedicated audio lanes and the recorder already captures
// those lanes separately.

export const VIDEO_CHANNEL_KINDS = [
  { kind: 'v1', label: 'Video 1', short: 'V1', color: '#38bdf8' },
  { kind: 'v2', label: 'Video 2', short: 'V2', color: '#a78bfa' },
  { kind: 'v3', label: 'Video 3', short: 'V3', color: '#f472b6' }
];

export const VIDEO_EFFECTS = [
  { kind: 'none', label: 'Cut' },
  { kind: 'fade', label: 'Fade' }
];

const DRIFT = 0.1;

function disposeVideo(video, url) {
  video?.pause();
  video?.removeAttribute('src');
  video?.load();
  if (url) URL.revokeObjectURL(url);
}

export class VideoEngine {
  constructor() {
    // clip id → { kind, video, url, token }
    this.channels = new Map();
  }

  channel(id) { return this.channels.get(id); }

  _ensureClip(id, kind) {
    if (!id) return null;
    if (!this.channels.has(id)) {
      this.channels.set(id, { kind, video: null, url: '', token: 0 });
    }
    const entry = this.channels.get(id);
    entry.kind = kind;
    return entry;
  }

  /** Decode metadata and create a muted, inline video element for one clip. */
  load(kind, id, file) {
    // Keep this small compatibility path for callers using the original
    // load(kind, file) signature while all new callers pass a clip id.
    if (file === undefined) { file = id; id = kind; }
    const entry = this._ensureClip(id, kind);
    if (!entry) return Promise.reject(new Error('Unknown video clip'));

    // Keep an already loaded source alive until the replacement has valid
    // metadata. A bad replacement should not blank a working clip.
    const token = ++entry.token;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.volume = 0;
    video.loop = false;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.src = url;

    return new Promise((resolve, reject) => {
      const finish = () => {
        if (entry.token !== token) { URL.revokeObjectURL(url); return; }
        const oldVideo = entry.video, oldUrl = entry.url;
        disposeVideo(oldVideo, oldUrl);
        entry.video = video;
        entry.url = url;
        resolve({ video, duration: Number.isFinite(video.duration) ? video.duration : 0 });
      };
      const fail = () => {
        if (entry.token !== token) { URL.revokeObjectURL(url); return; }
        URL.revokeObjectURL(url);
        reject(new Error('Could not read that video'));
      };
      video.addEventListener('loadedmetadata', finish, { once: true });
      video.addEventListener('error', fail, { once: true });
      video.load();
    });
  }

  _clearId(id) {
    const entry = this.channels.get(id);
    if (!entry) return;
    entry.token++;
    disposeVideo(entry.video, entry.url);
    this.channels.delete(id);
  }

  clear(kind, id = null) {
    if (id !== null && id !== undefined) {
      this._clearId(id);
      return;
    }
    for (const [clipId, entry] of this.channels) {
      if (entry.kind === kind) this._clearId(clipId);
    }
  }

  clearAll() {
    for (const id of [...this.channels.keys()]) this._clearId(id);
  }

  _clipList(channels, kind) {
    const lane = channels?.[kind] ?? channels?.get?.(kind);
    if (Array.isArray(lane)) return lane;
    if (Array.isArray(lane?.clips)) return lane.clips;
    // Accept the original one-object-per-channel shape during a transition.
    return lane?.name || lane?.duration ? [lane] : [];
  }

  /**
   * Keep every element at its composition time represented by its clip.
   * While playing, normal video playback carries the clock; only material drift
   * is corrected so decoders are not forced to seek every animation frame.
   */
  sync(channels, time, playing, { force = false } = {}) {
    const seen = new Set();

    for (const meta of VIDEO_CHANNEL_KINDS) {
      for (const settings of this._clipList(channels, meta.kind)) {
        const id = settings?.id;
        if (!id) continue;
        seen.add(id);
        const entry = this.channel(id);
        const video = entry?.video;
        if (!settings || !video || settings.ready === false) continue;

        const duration = Number.isFinite(video.duration) && video.duration > 0
          ? video.duration : Number(settings.duration) || 0;
        if (!duration) continue;

        const local = time - (Number(settings.start) || 0);
        const looping = settings.loop === true;
        let active = local >= 0 && (looping || local < duration);
        let target = local;
        if (local < 0) target = 0;
        else if (looping) target = local % duration;
        else if (local > duration) { target = duration; active = false; }
        target = Math.max(0, Math.min(duration, target));

        if (force || Math.abs((video.currentTime || 0) - target) > DRIFT) {
          try { video.currentTime = target; } catch { /* metadata may still be settling */ }
        }

        const visible = settings.visible !== false && Number(settings.opacity) > 0;
        if (playing && active && visible) {
          video.play().catch(() => { /* autoplay policy or decoder warm-up */ });
        } else if (!playing || !active || !visible) {
          video.pause();
        }
      }
    }

    // A clip may have been removed from a lane without its runtime source
    // getting an explicit clear call. Do not keep those decoders alive.
    for (const id of this.channels.keys()) if (!seen.has(id)) this._clearId(id);
  }

  play(channels, time) { this.sync(channels, time, true, { force: true }); }
  pause(channels, time) { this.sync(channels, time, false, { force: true }); }
  seek(channels, time, playing = false) { this.sync(channels, time, playing, { force: true }); }

  dispose() { this.clearAll(); }
}
