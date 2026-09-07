// Bootstrap: wires the store, the three.js stage, the timeline and the panels together.

import { state, clips, track, audioClips, savedAudioClips, audioClip, addAudioClip, removeAudioClip,
         initProject, on, emit, setTime, setDuration,
         normalizeAudioVolumeKeys,
         syncBeatTimes, beatTimes, setMetro, setFont, fontSlots, fontsReady, select,
         fontAssets, registerFontAsset, setClipFont,
         selectCameraKey,
         videoChannels, videoChannel, videoClips, videoClip, addVideoClip,
         removeVideoClip, makeVideoChannel } from './state.js';
import { initHistory } from './history.js';
import { readAutosave, restoreAutosave, startAutosave } from './autosave.js';
import { StageRenderer } from './renderer.js';
import { StageGizmo } from './gizmo.js';
import { Timeline } from './timeline.js';
import { AudioEngine, analyze, waveformPeaks, TRACK_KINDS } from './audio/engine.js';
import { analyzeSpeech } from './audio/speech.js';
import { VideoEngine, VIDEO_CHANNEL_KINDS } from './video/engine.js';
import { Metronome } from './audio/metronome.js';
import { rememberMedia, recallMedia } from './media/store.js';
import { Recorder } from './export.js';
import { FONT_PRESETS, loadFontFromUrl, loadFontFromFile } from './typography.js';
import { initUI, setAudioProgress, syncPlayButton } from './ui.js';
import { $, clamp, toast, download, fmtDur } from './util.js';

const canvas = $('#stageCanvas');
const renderer = new StageRenderer(canvas);
const engine = new AudioEngine();
const videoEngine = new VideoEngine();
const timeline = new Timeline($('#timelineCanvas'), $('#tlTip'), $('#timelineHeaderCanvas'));
const gizmo = new StageGizmo(renderer);
const recorder = new Recorder(canvas, engine);
const metro = new Metronome(engine);

renderer.onPick = id => select('clip', id);
renderer.onPickCamera = (id, axis = null) => axis
  ? selectCameraKey(axis, id)
  : select('camkey', id);
renderer.onViewChange = () => { dirty = true; };

let dirty = true;
let stopAt = null;          // temporary out-point for "preview stage"
let firstAudio = true;
const speechRuns = new Map();
const speechTokens = new Map();

// ══ transport ════════════════════════════════════════════════
function togglePlay() { state.ui.playing ? pause() : play(); }

function play() {
  if (state.ui.time >= state.project.duration - 1e-3) seek(0);
  engine.play(state.ui.time);
  state.ui.playing = true;
  videoEngine.play(videoChannels(), state.ui.time);
  metro.start();
  syncPlayButton(true);
}

function pause() {
  engine.pause();
  videoEngine.pause(videoChannels(), state.ui.time);
  metro.stop();
  state.ui.playing = false;
  stopAt = null;
  syncPlayButton(false);
}

function seek(t) {
  const v = clamp(t, 0, state.project.duration);
  engine.seek(v);
  setTime(v);
  videoEngine.seek(videoChannels(), v, state.ui.playing);
  metro._reseek();
  dirty = true;
}

function playRange(a, b) {
  seek(a);
  stopAt = b;
  play();
}

// ══ audio ════════════════════════════════════════════════════
function audioInsertStart(kind, duration) {
  const end = audioClips(kind).filter(clip => clip.ready).reduce((latest, clip) =>
    Math.max(latest, clip.start + clip.duration), 0);
  return clamp(Math.max(state.ui.time, end), -duration, state.project.duration);
}

/** Import a file into one of the three lanes. Music gets beat analysis; VO can
 * be sent through the separate word-timing pass from its lane controls. */
async function importAudio(file, kind = 'bgm', attachId = null, { handle = null, quiet = false } = {}) {
  const tr = kind === 'bgm' ? track('bgm') : null;
  let clip = null;
  let createdClip = false;
  try {
    setAudioProgress(0.02, `decoding ${kind.toUpperCase()}…`);
    const { buffer, mono, sampleRate } = await engine.decode(file);

    const props = {
      name: file.name, size: file.size, duration: buffer.duration, ready: true,
      peaks: waveformPeaks(mono, 2048)
    };
    // Keep the bytes (and the handle, where the browser has one) so the next
    // Open can attach this source without sending the user back to the dialog.
    rememberMedia(file, { duration: buffer.duration, handle })
      .catch(err => console.warn('Could not cache media', err));

    if (kind === 'bgm') {
      engine.setBuffer(kind, buffer);
      Object.assign(tr, props, {
        volumeKeys: normalizeAudioVolumeKeys(tr.volumeKeys, buffer.duration, tr.volume)
      });
    } else {
      // Opening a project restores reference-only VO/SFX clips as pending.
      // Attaching from a saved clip's own button targets it by id; otherwise a
      // matching filename attaches to the saved clip so its timing and mix
      // settings survive, rather than creating a duplicate.
      clip = (attachId ? audioClips(kind).find(saved => saved.id === attachId) : null)
        ?? audioClips(kind).find(saved => !saved.ready && saved.name === file.name)
        ?? null;
      if (!clip) {
        clip = addAudioClip(kind, { ...props, start: audioInsertStart(kind, buffer.duration) }, { notify: false });
        createdClip = true;
      } else {
        Object.assign(clip, props, {
          volumeKeys: normalizeAudioVolumeKeys(clip.volumeKeys, buffer.duration, clip.volume)
        });
      }
      if (!clip) throw new Error(`Unknown audio lane: ${kind}`);
      engine.setBuffer(kind, buffer, clip.id);
    }

    if (kind === 'bgm') {
      const result = await analyze(mono, sampleRate, (v, label) => setAudioProgress(0.05 + v * 0.93, label));
      tr.peaks = result.peaks;
      Object.assign(state.audio, {
        beats: Array.from(result.beats),
        onsets: Array.from(result.onsets),
        onsetStrength: Array.from(result.onsetStrength ?? []),
        envelope: result.envelope,
        bpm: result.bpm,
        // Reattaching a project's own music re-derives the grid, but the offset
        // and click-track settings it was saved with are the user's, not ours.
        ...(quiet ? {} : { offset: 0 })
      });
      if (!quiet) setMetro({ source: 'track', bpm: result.bpm });
      syncBeatTimes();
      if (!quiet) toast(`${result.bpm.toFixed(1)} BPM · ${result.beats.length} beats · ${state.audio.hits.length} peaks`);
    } else if (!quiet) {
      toast(`${kind.toUpperCase()}: ${file.name} · ${fmtDur(buffer.duration)} · added to lane`);
    }

    setAudioProgress(1.1, '');
    emit('audio', state.audio);

    if (kind === 'bgm' && firstAudio && !quiet && Math.abs(buffer.duration - state.project.duration) > 0.5) {
      setDuration(buffer.duration, { scale: true });
      timeline.fit();
    }
    if (kind === 'bgm') firstAudio = false;
    timeline.draw();
    dirty = true;
  } catch (err) {
    console.error(err);
    if (clip && createdClip) {
      engine.clearTrack(kind, clip.id);
      removeAudioClip(kind, clip.id);
    }
    setAudioProgress(-1, '');
    toast(`Could not read that ${kind.toUpperCase()} file`);
    return false;
  }
  return true;
}

/** Run local Whisper on one loaded VO clip and keep its timings relative to the source. */
async function analyzeVoice(kind = 'vo', id) {
  if (kind !== 'vo') return;
  const clip = audioClip(kind, id);
  if (!clip?.ready) { toast('Import a voiceover first'); return; }
  if (speechRuns.has(id)) return;

  const source = engine.getSourceData(kind, id);
  if (!source) { toast('That voiceover is not decoded'); return; }

  const token = (speechTokens.get(id) ?? 0) + 1;
  speechTokens.set(id, token);
  speechRuns.set(id, token);
  clip.speechStatus = 'analyzing';
  clip.speechError = '';
  emit('audio', state.audio);
  timeline.draw();

  try {
    const result = await analyzeSpeech(source.mono, source.sampleRate, (value, label) => {
      setAudioProgress(value, `VO · ${label}`);
    });
    const live = audioClip(kind, id);
    if (!live || speechRuns.get(id) !== token) return;
    live.transcript = result.text || '';
    live.words = Array.isArray(result.words) ? result.words : [];
    live.speechStatus = live.words.length ? 'ready' : 'error';
    live.speechError = live.words.length ? '' : 'No word timestamps were returned';
    emit('audio', state.audio);
    timeline.draw();
    dirty = true;
    toast(live.words.length
      ? `${live.words.length} VO words detected — text snapping is ready`
      : 'VO was recognised, but no word timings were returned');
  } catch (err) {
    console.error(err);
    const live = audioClip(kind, id);
    if (live && speechRuns.get(id) === token) {
      live.speechStatus = 'error';
      live.speechError = String(err?.message || err);
      emit('audio', state.audio);
    }
    toast('Could not analyse that voiceover');
  } finally {
    if (speechRuns.get(id) === token) {
      speechRuns.delete(id);
      setAudioProgress(-1, '');
    }
  }
}

function clearAudio(kind = 'bgm', id = null) {
  if (state.ui.playing) pause();
  if (kind === 'bgm') {
    engine.clearTrack(kind);
    Object.assign(track(kind), {
      name: '', duration: 0, peaks: null, start: 0, ready: false, volumeKeys: []
    });
    Object.assign(state.audio, {
      beats: [], onsets: [], onsetStrength: [], envelope: null, bpm: 0, offset: 0, hits: []
    });
    setMetro({ source: 'manual' });
    syncBeatTimes();
  } else if (id) {
    speechTokens.set(id, (speechTokens.get(id) ?? 0) + 1);
    speechRuns.delete(id);
    engine.clearTrack(kind, id);
    removeAudioClip(kind, id);
  } else {
    engine.clearTrack(kind);
    for (const clip of [...audioClips(kind)]) {
      speechTokens.set(clip.id, (speechTokens.get(clip.id) ?? 0) + 1);
      speechRuns.delete(clip.id);
      removeAudioClip(kind, clip.id);
    }
  }
  // Removing a VO while its worker is finishing invalidates the result above;
  // do not leave the shared progress bar hanging once no analysis is live.
  if (!speechRuns.size) setAudioProgress(-1, '');
  emit('audio', state.audio);
  timeline.draw();
  dirty = true;
}

// ══ backdrop video ═════════════════════════════════════════
/** Import a muted visual source into one of the independent backdrop lanes. */
function videoInsertStart(kind, duration) {
  const end = videoClips(kind).filter(clip => clip.ready).reduce((latest, clip) =>
    Math.max(latest, clip.start + clip.duration), 0);
  return clamp(Math.max(state.ui.time, end), -duration, state.project.duration);
}

async function importVideo(file, kind = 'v1', replaceId = null, { handle = null, quiet = false } = {}) {
  let clip = replaceId ? videoClip(kind, replaceId) : null;
  let createdClip = false;
  try {
    if (!clip) {
      // Opening a project restores reference-only backdrop clips as pending.
      // Re-importing the same filename re-attaches that saved clip so its
      // timing and transition settings survive instead of creating a duplicate.
      clip = videoClips(kind).find(saved => !saved.ready && saved.name === file.name) ?? null;
      if (!clip) {
        clip = addVideoClip(kind, { start: videoInsertStart(kind, 0) }, { notify: false });
        createdClip = true;
      }
    }
    if (!clip) throw new Error(`Unknown backdrop lane: ${kind}`);

    const { duration } = await videoEngine.load(kind, clip.id, file);
    rememberMedia(file, { duration, handle })
      .catch(err => console.warn('Could not cache media', err));
    Object.assign(clip, {
      name: file.name,
      size: file.size,
      duration,
      start: clamp(clip.start, -duration, state.project.duration),
      inDuration: clamp(Number(clip.inDuration) || 0, 0, duration),
      outDuration: clamp(Number(clip.outDuration) || 0, 0, duration),
      ready: true
    });
    videoEngine.sync(videoChannels(), state.ui.time, state.ui.playing, { force: true });
    emit('video', state.video);
    timeline.draw();
    dirty = true;
    if (!quiet) {
      const short = VIDEO_CHANNEL_KINDS.find(v => v.kind === kind)?.short ?? kind;
      toast(`${short}: ${file.name} · ${fmtDur(duration)} · added to lane`);
    }
  } catch (err) {
    console.error(err);
    if (clip && createdClip) {
      videoEngine.clear(kind, clip.id);
      removeVideoClip(kind, clip.id);
    }
    toast('Could not read that video file');
    return false;
  }
  return true;
}

/**
 * Reattach the media a freshly opened project points at. Sources cached by an
 * earlier session come back silently; those that survive only as a file handle
 * need the user's permission, so they are counted and left for the ↗ button.
 */
async function relinkSavedMedia() {
  const pending = [];
  for (const { kind } of TRACK_KINDS) {
    for (const clip of savedAudioClips(kind)) {
      if (!clip.ready && clip.name) pending.push({ media: 'audio', kind, clip });
    }
  }
  for (const { kind } of VIDEO_CHANNEL_KINDS) {
    for (const clip of [...videoClips(kind)]) {
      if (!clip.ready && clip.name) pending.push({ media: 'video', kind, clip });
    }
  }

  let attached = 0;
  let needsPermission = 0;
  // One at a time: decoding several sources at once only fights for the same
  // audio context and video elements.
  for (const { media, kind, clip } of pending) {
    const found = await recallMedia(clip).catch(() => null);
    if (found?.file) {
      const ok = media === 'audio'
        ? await importAudio(found.file, kind, clip.id, { quiet: true })
        : await importVideo(found.file, kind, clip.id, { quiet: true });
      if (ok) attached++;
    } else if (found?.needsPermission) {
      needsPermission++;
    }
  }

  if (attached) {
    emit('audio', state.audio);
    emit('video', state.video);
    timeline.draw();
    dirty = true;
  }
  return { pending: pending.length, attached, needsPermission };
}

function clearVideo(kind = 'v1', id = null) {
  const lane = videoChannel(kind);
  if (!lane) return;
  if (id) {
    videoEngine.clear(kind, id);
    removeVideoClip(kind, id);
  } else {
    videoEngine.clear(kind);
    lane.clips.splice(0, lane.clips.length);
  }
  emit('video', state.video);
  timeline.draw();
  dirty = true;
}

function clearVideos() {
  videoEngine.clearAll();
  state.video.channels = Object.fromEntries(VIDEO_CHANNEL_KINDS.map(({ kind }) =>
    [kind, makeVideoChannel(kind)]));
  emit('video', state.video);
}

// ══ metronome ════════════════════════════════════════════════
/** Push the current settings and beat grid into the click bus. */
function syncMetro() {
  const m = state.metro;
  metro.voice = m.voice;
  metro.accent = m.accent;
  metro.setVolume(m.volume);
  metro.setInRecording(m.inRecording);
  metro.setGrid(beatTimes(), state.audio.beatsPerBar);
  metro.setEnabled(m.on);
}

function setMetroEnabled(on) {
  setMetro({ on });
  syncMetro();
  if (on && !beatTimes().length) toast('No beat grid yet — set a manual BPM');
}

// ══ fonts ════════════════════════════════════════════════════
async function loadFontUrl(preset, slot = 0) {
  try {
    emit('fontBusy', slot);
    const entry = await loadPresetAsset(preset);
    setFont(slot, entry);
    renderer.invalidate();
    dirty = true;
    if (slot > 0) toast(`Fallback ${slot + 1}: ${preset.label}`);
  } catch (err) {
    console.error(err);
    toast('Could not load that typeface');
    emit('fonts', state.fonts);
  }
}

async function loadFontFile(file, slot = 0) {
  try {
    const font = await loadFontFromFile(file);
    const entry = registerFontAsset({
      font, name: file.name.replace(/\.[^.]+$/, ''), preset: null,
      family: font.__familyName, weight: font.__weight
    });
    setFont(slot, entry);
    renderer.invalidate();
    dirty = true;
    toast(`${slot === 0 ? 'Typeface' : `Fallback ${slot + 1}`}: ${file.name}`);
  } catch (err) {
    console.error(err);
    toast('That file is not a readable font');
  }
}

/** Decode one bundled face once and keep it available to any text layer. */
async function loadPresetAsset(preset) {
  const existing = fontAssets().find(entry => entry.preset === preset.id);
  if (existing) return existing;
  const font = await loadFontFromUrl(preset.url, preset.label, preset);
  return registerFontAsset({
    font, name: preset.label, preset: preset.id,
    family: preset.family, weight: preset.weight
  });
}

/** Apply a bundled face to one layer without changing the stage slots. */
async function loadClipFontPreset(clipId, preset) {
  const clip = clips().find(item => item.id === clipId);
  if (!clip || !preset) return;
  const previous = {
    family: clip.fontFamily, weight: clip.fontWeight,
    stageSlot: Number.isFinite(Number(clip.font)) ? Number(clip.font) : null
  };
  setClipFont(clipId, {
    family: preset.family, weight: preset.weight, stageSlot: null
  });
  try {
    await loadPresetAsset(preset);
    emit('fonts', state.fonts);
    renderer.invalidate();
    dirty = true;
    toast(`${preset.family} ${preset.weight} applied to this layer`);
  } catch (err) {
    console.error(err);
    setClipFont(clipId, {
      family: previous.family ?? null, weight: previous.weight ?? null,
      stageSlot: previous.family ? null : previous.stageSlot
    });
    toast('Could not load that layer typeface');
  }
}

/** Load a user-supplied face into the runtime library for one layer only. */
async function loadClipFontFile(file, clipId) {
  try {
    const font = await loadFontFromFile(file);
    const entry = registerFontAsset({
      font, name: file.name.replace(/\.[^.]+$/, ''), preset: null,
      family: font.__familyName, weight: font.__weight
    });
    setClipFont(clipId, {
      family: entry.family, weight: entry.weight, stageSlot: null
    });
    renderer.invalidate();
    dirty = true;
    toast(`${entry.family} ${entry.weight} applied to this layer`);
  } catch (err) {
    console.error(err);
    toast('That layer typeface is not readable');
  }
}

/** Rehydrate bundled faces referenced by layers after opening a project. */
async function ensureClipFonts() {
  const wanted = new Map();
  for (const clip of clips()) {
    const family = String(clip.fontFamily ?? '').trim();
    const weight = Number(clip.fontWeight);
    const preset = FONT_PRESETS.find(item => item.family === family && item.weight === weight);
    if (preset) wanted.set(preset.id, preset);
  }
  for (const preset of wanted.values()) {
    try { await loadPresetAsset(preset); }
    catch (err) { console.warn(`Could not restore layer typeface ${preset.label}`, err); }
  }
  if (wanted.size) {
    emit('fonts', state.fonts);
    renderer.invalidate();
    dirty = true;
  }
}

function clearFont(slot) {
  if (slot === 0) { toast('The primary typeface cannot be empty'); return; }
  setFont(slot, null);
  renderer.invalidate();
  dirty = true;
}

// ══ recording ════════════════════════════════════════════════
async function toggleRecord() {
  const btn = $('#btnRecord');
  if (recorder.active) {
    const blob = await recorder.stop();
    state.ui.recording = false;
    btn.classList.remove('is-recording', 'btn-pri');
    btn.lastChild.textContent = ' Record';
    pause();
    if (blob) {
      const name = (state.project.name || 'composition').replace(/[^\w\-. ]+/g, '_');
      const ext = Recorder.extFor(blob.type);
      download(`${name}.${ext}`, blob);
      toast(`Recording saved as ${ext.toUpperCase()}`);
    }
    return;
  }
  if (!Recorder.supported()) { toast('This browser cannot record canvas video'); return; }
  seek(0);
  recorder.start(state.project.fps);
  state.ui.recording = true;
  btn.classList.add('is-recording', 'btn-pri');
  btn.lastChild.textContent = ' Stop';
  play();
  toast('Recording in real time — playback speed is capture speed');
}

// ══ viewport fit ═════════════════════════════════════════════
function fitViewport() {
  const vp = $('#viewport');
  const frame = $('#stageFrame');
  const pad = 48;
  const aw = vp.clientWidth - pad, ah = vp.clientHeight - pad;
  const { width: W, height: H } = state.project;
  const k = Math.min(aw / W, ah / H, 1.5);
  frame.style.width = `${Math.round(W * k)}px`;
  frame.style.height = `${Math.round(H * k)}px`;
  canvas.style.width = `${Math.round(W * k)}px`;
  canvas.style.height = `${Math.round(H * k)}px`;
}

// ══ frame loop ═══════════════════════════════════════════════
function frame() {
  requestAnimationFrame(frame);

  if (state.ui.playing) {
    let t = engine.now();
    const end = stopAt ?? state.project.duration;
    if (t >= end) {
      if (stopAt !== null) { stopAt = null; pause(); t = end; }
      else if (state.ui.loop) { seek(0); t = 0; play(); }
      else { pause(); t = state.project.duration; if (recorder.active) toggleRecord(); }
    }
    setTime(Math.min(t, state.project.duration), 'play');
    timeline.draw();
    dirty = true;
  }

  // Let the browser play video normally, correcting only material decoder
  // drift so a backdrop stays aligned without seeking every animation frame.
  videoEngine.sync(videoChannels(), state.ui.time, state.ui.playing);

  if (dirty || state.ui.playing) {
    renderer.render({
      time: state.ui.time,
      project: state.project,
      clips: clips(),
      fonts: fontSlots(),
      videos: { channels: videoChannels(), runtime: videoEngine.channels },
      beats: beatTimes().length ? beatTimes() : null,
      mode: state.ui.recording ? 'output' : state.ui.viewMode,
      selection: state.ui.sel
    });
    dirty = false;
  }

  // The move control is projected through the camera of the frame just drawn,
  // so it is refreshed after the render rather than from the event bus.
  gizmo.sync();
}

// ══ boot ═════════════════════════════════════════════════════
async function boot() {
  initProject();
  // A session that ended badly — a crash, a closed tab, a reload — comes back
  // where it left off instead of at the demo arrangement.
  const recovered = restoreAutosave(readAutosave());
  // Whatever is on screen now is the floor of the undo stack, not a step in it.
  initHistory();

  initUI({
    engine, timeline, renderer,
    togglePlay, play, pause, seek, playRange,
    importAudio, analyzeVoice, clearAudio, loadFontUrl, loadFontFile, clearFont, toggleRecord,
    loadClipFontPreset, loadClipFontFile, ensureClipFonts,
    importVideo, clearVideo, clearVideos, relinkSavedMedia,
    syncMetro, setMetroEnabled
  });

  on('render time fonts audio guides clips clip audioMove video videoMove videoLevel backdrop view', () => { dirty = true; });
  on('seek', t => seek(t));
  on('pause', pause);

  // Keep every decoded source aligned with the state. VO and SFX may have
  // several clips, so the runtime source is addressed by its clip id.
  const syncAudioEngine = () => {
    const bgm = track('bgm');
    if (bgm.ready) {
      engine.setStart('bgm', bgm.start);
      engine.setLevel('bgm', { volume: bgm.volume, mute: bgm.mute });
      engine.setVolumeKeys('bgm', bgm.volumeKeys);
    }
    for (const { kind } of TRACK_KINDS) {
      if (kind === 'bgm') continue;
      for (const clip of audioClips(kind)) {
        if (!clip.ready) continue;
        engine.setStart(kind, clip.start, clip.id);
        engine.setLevel(kind, { volume: clip.volume, mute: clip.mute }, clip.id);
        engine.setVolumeKeys(kind, clip.volumeKeys, clip.id);
      }
    }
  };
  on('audio audioMove', () => {
    syncAudioEngine();
    if (state.ui.playing) engine.play(state.ui.time);
    timeline.draw();
  });
  on('audioLevel', ({ kind, id }) => {
    if (kind === 'bgm') {
      const bgm = track('bgm');
      engine.setLevel(kind, { volume: bgm.volume, mute: bgm.mute });
      engine.setVolumeKeys(kind, bgm.volumeKeys);
    } else {
      const clip = audioClips(kind).find(c => c.id === id);
      if (clip) {
        engine.setLevel(kind, { volume: clip.volume, mute: clip.mute }, clip.id);
        engine.setVolumeKeys(kind, clip.volumeKeys, clip.id);
      }
    }
  });
  on('video videoMove videoLevel', () => {
    videoEngine.sync(videoChannels(), state.ui.time, state.ui.playing, { force: true });
    timeline.draw();
  });
  on('grid metro', syncMetro);
  on('project duration guides clips clip backdrop particles', () => { dirty = true; timeline.draw(); });
  // Selection moves the highlight between lanes — the emitter blocks have to
  // repaint even when nothing about the project itself changed.
  on('selection', () => { timeline.draw(); });
  on('project', fitViewport);
  on('duration', () => { timeline.draw(); });
  window.addEventListener('resize', () => { fitViewport(); timeline.resize(); });

  syncBeatTimes();
  syncMetro();
  fitViewport();
  timeline.fit();
  frame();

  const splash = $('#boot');
  // A Latin display face up front, a CJK face behind it — the stack in miniature.
  const defaults = ['inter-700', 'noto-tc-700'];
  // A recovered session brings its typefaces back as far as they can come: a
  // preset reloads from its URL, a font file the user supplied cannot, so that
  // slot falls back to the default rather than leaving the stage blank.
  const savedPresets = recovered?.fonts?.some(f => f?.preset)
    ? recovered.fonts.map(f => f?.preset ?? null)
    : null;
  const wanted = [...(savedPresets ?? defaults)];
  if (!wanted[0]) wanted[0] = defaults[0];
  $('#bootMsg').textContent = 'loading typefaces…';
  for (let i = 0; i < wanted.length; i++) {
    const preset = FONT_PRESETS.find(f => f.id === wanted[i]);
    if (preset) await loadFontUrl(preset, i);
  }
  await ensureClipFonts();
  if (!fontsReady()) $('#bootMsg').textContent = 'typeface unavailable — load one from the panel';
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 500);

  // Media is a reference in the snapshot, exactly as it is in a saved file, so
  // recovery finishes the same way opening a project does — through the cache.
  if (recovered) {
    const { pending = 0, attached = 0 } = await relinkSavedMedia();
    const media = !pending ? ''
      : attached === pending ? ` · ${attached} media file${attached === 1 ? '' : 's'} reattached`
      : ` · ${pending - attached} media file${pending - attached === 1 ? '' : 's'} to re-import`;
    toast(`Recovered your last session from ${timeAgo(recovered.savedAt)}${media}`, 4200);
  }
  // Only now: a snapshot taken mid-boot would record a project without fonts.
  startAutosave();
}

/** How long ago the recovered snapshot was written, in words. */
function timeAgo(at) {
  const s = at ? Math.max(0, (Date.now() - at) / 1000) : 0;
  if (!at || s < 90) return 'a moment ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

boot();
