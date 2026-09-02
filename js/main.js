// Bootstrap: wires the store, the three.js stage, the timeline and the panels together.

import { state, clips, track, initProject, on, emit, setTime, setDuration,
         syncBeatTimes, beatTimes, setMetro, setFont, fontStack, fontsReady } from './state.js';
import { StageRenderer } from './renderer.js';
import { Timeline } from './timeline.js';
import { AudioEngine, analyze, waveformPeaks, TRACK_KINDS } from './audio/engine.js';
import { Metronome } from './audio/metronome.js';
import { Recorder } from './export.js';
import { FONT_PRESETS, loadFontFromUrl, loadFontFromFile } from './typography.js';
import { initUI, setAudioProgress, syncPlayButton } from './ui.js';
import { $, clamp, toast, download, fmtDur } from './util.js';

const canvas = $('#stageCanvas');
const renderer = new StageRenderer(canvas);
const engine = new AudioEngine();
const timeline = new Timeline($('#timelineCanvas'), $('#tlTip'));
const recorder = new Recorder(canvas, engine);
const metro = new Metronome(engine);

let dirty = true;
let stopAt = null;          // temporary out-point for "preview stage"
let firstAudio = true;

// ══ transport ════════════════════════════════════════════════
function togglePlay() { state.ui.playing ? pause() : play(); }

function play() {
  if (state.ui.time >= state.project.duration - 1e-3) seek(0);
  engine.play(state.ui.time);
  state.ui.playing = true;
  metro.start();
  syncPlayButton(true);
}

function pause() {
  engine.pause();
  metro.stop();
  state.ui.playing = false;
  stopAt = null;
  syncPlayButton(false);
}

function seek(t) {
  const v = clamp(t, 0, state.project.duration);
  engine.seek(v);
  setTime(v);
  metro._reseek();
  dirty = true;
}

function playRange(a, b) {
  seek(a);
  stopAt = b;
  play();
}

// ══ audio ════════════════════════════════════════════════════
/** Import a file into one of the three lanes. Only the music lane is analysed. */
async function importAudio(file, kind = 'bgm') {
  const tr = track(kind);
  try {
    setAudioProgress(0.02, `decoding ${kind.toUpperCase()}…`);
    const { buffer, mono, sampleRate } = await engine.decode(file);
    engine.setBuffer(kind, buffer);

    Object.assign(tr, {
      name: file.name, duration: buffer.duration, ready: true,
      peaks: waveformPeaks(mono, 2048)
    });

    if (kind === 'bgm') {
      const result = await analyze(mono, sampleRate, (v, label) => setAudioProgress(0.05 + v * 0.93, label));
      tr.peaks = result.peaks;
      Object.assign(state.audio, {
        beats: Array.from(result.beats),
        onsets: Array.from(result.onsets),
        onsetStrength: Array.from(result.onsetStrength ?? []),
        envelope: result.envelope,
        bpm: result.bpm,
        offset: 0
      });
      setMetro({ source: 'track', bpm: result.bpm });
      syncBeatTimes();
      toast(`${result.bpm.toFixed(1)} BPM · ${result.beats.length} beats · ${state.audio.hits.length} peaks`);
    } else {
      toast(`${kind.toUpperCase()}: ${file.name} · ${fmtDur(buffer.duration)}`);
    }

    setAudioProgress(1.1, '');
    emit('audio', state.audio);

    if (kind === 'bgm' && firstAudio && Math.abs(buffer.duration - state.project.duration) > 0.5) {
      setDuration(buffer.duration, { scale: true });
      timeline.fit();
    }
    if (kind === 'bgm') firstAudio = false;
    timeline.draw();
    dirty = true;
  } catch (err) {
    console.error(err);
    setAudioProgress(-1, '');
    toast(`Could not read that ${kind.toUpperCase()} file`);
  }
}

function clearAudio(kind = 'bgm') {
  if (state.ui.playing) pause();
  engine.clearTrack(kind);
  Object.assign(track(kind), {
    name: '', duration: 0, peaks: null, start: 0, ready: false
  });
  if (kind === 'bgm') {
    Object.assign(state.audio, {
      beats: [], onsets: [], onsetStrength: [], envelope: null, bpm: 0, offset: 0, hits: []
    });
    setMetro({ source: 'manual' });
    syncBeatTimes();
  }
  emit('audio', state.audio);
  timeline.draw();
  dirty = true;
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
    const font = await loadFontFromUrl(preset.url, preset.label);
    setFont(slot, { font, name: preset.label, preset: preset.id });
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
    setFont(slot, { font, name: file.name.replace(/\.[^.]+$/, ''), preset: null });
    renderer.invalidate();
    dirty = true;
    toast(`${slot === 0 ? 'Typeface' : `Fallback ${slot + 1}`}: ${file.name}`);
  } catch (err) {
    console.error(err);
    toast('That file is not a readable font');
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
      download(`${name}.webm`, blob);
      toast('Recording saved');
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

  if (dirty || state.ui.playing) {
    renderer.render({
      time: state.ui.time,
      project: state.project,
      clips: clips(),
      fonts: fontStack(),
      beats: beatTimes().length ? beatTimes() : null
    });
    dirty = false;
  }
}

// ══ boot ═════════════════════════════════════════════════════
async function boot() {
  initProject();

  initUI({
    engine, timeline, renderer,
    togglePlay, play, pause, seek, playRange,
    importAudio, clearAudio, loadFontUrl, loadFontFile, clearFont, toggleRecord,
    syncMetro, setMetroEnabled
  });

  on('render time fonts audio guides clips clip audioMove', () => { dirty = true; });
  on('seek', t => seek(t));

  // the track can be slipped along the timeline; keep playback aligned with it
  // keep the engine's lanes aligned with the timeline
  on('audio audioMove', () => {
    for (const { kind } of TRACK_KINDS) engine.setStart(kind, track(kind).start);
    if (state.ui.playing) engine.play(state.ui.time);
  });
  on('audioLevel', ({ kind }) => {
    const tr = track(kind);
    engine.setLevel(kind, { volume: tr.volume, mute: tr.mute });
  });
  on('grid metro', syncMetro);
  on('project duration guides clips clip', () => { dirty = true; timeline.draw(); });
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
  $('#bootMsg').textContent = 'loading typefaces…';
  for (let i = 0; i < defaults.length; i++) {
    const preset = FONT_PRESETS.find(f => f.id === defaults[i]);
    if (preset) await loadFontUrl(preset, i);
  }
  if (!fontsReady()) $('#bootMsg').textContent = 'typeface unavailable — load one from the panel';
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 500);
}

boot();
