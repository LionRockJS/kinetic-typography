/* Module worker for local Whisper word timing. */

'use strict';

const TARGET_SAMPLE_RATE = 16000;
const MODEL = 'Xenova/whisper-tiny';
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
let transcriberPromise = null;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function progress(value, label) {
  self.postMessage({ type: 'progress', value: clamp(value, 0, 0.99), label });
}

/** Small linear resampler; Whisper expects a mono 16 kHz waveform. */
function resample(samples, sourceRate, targetRate) {
  if (!samples?.length || !Number.isFinite(sourceRate) || sourceRate <= 0 || sourceRate === targetRate) {
    return samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  }
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const out = new Float32Array(length);
  const scale = sourceRate / targetRate;
  for (let i = 0; i < length; i++) {
    const at = i * scale;
    const left = Math.min(samples.length - 1, Math.floor(at));
    const right = Math.min(samples.length - 1, left + 1);
    const mix = at - left;
    out[i] = samples[left] + (samples[right] - samples[left]) * mix;
  }
  return out;
}

async function transcriber() {
  if (transcriberPromise) return transcriberPromise;

  transcriberPromise = (async () => {
    progress(0.04, 'loading local speech model');
    const { env, pipeline } = await import(TRANSFORMERS_URL);
    // Do not look for application-bundled model files. The model is fetched as
    // data and kept in the browser cache for subsequent VO clips.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

    return pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      progress_callback: info => {
        const p = finite(info?.progress);
        const file = typeof info?.file === 'string' ? info.file.split('/').at(-1) : '';
        if (p !== null) progress(0.05 + 0.52 * clamp(p / 100, 0, 1), `downloading ${file || 'speech model'}`);
        else if (info?.status === 'ready') progress(0.58, 'speech model ready');
      }
    });
  })().catch(error => {
    transcriberPromise = null;
    throw error;
  });

  return transcriberPromise;
}

function textOf(chunk) {
  return String(chunk?.text ?? '').replace(/\s+/g, ' ').trim();
}

function wordTimings(chunks, duration) {
  const items = (Array.isArray(chunks) ? chunks : [])
    .map(chunk => {
      const timestamp = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [];
      return {
        text: textOf(chunk),
        start: finite(timestamp[0]),
        end: finite(timestamp[1]),
        score: finite(chunk?.score)
      };
    })
    .filter(item => item.text && item.text !== '[BLANK_AUDIO]');

  const out = [];
  let previousEnd = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const nextStart = items.slice(i + 1).find(next => next.start !== null)?.start ?? null;
    const start = clamp(item.start ?? previousEnd, 0, duration);
    let end = item.end ?? nextStart ?? Math.min(duration, start + 0.18);
    end = clamp(end, start, duration);
    if (end <= start) end = Math.min(duration, start + Math.min(0.08, Math.max(0, duration - start)));
    if (end <= start) continue;
    out.push({
      text: item.text,
      start,
      end,
      ...(item.score !== null ? { score: item.score } : {})
    });
    previousEnd = end;
  }
  return out;
}

self.onmessage = async event => {
  if (event.data?.type !== 'analyze') return;
  const { samples, sampleRate } = event.data;

  try {
    if (!(samples instanceof Float32Array) || !samples.length) throw new Error('The VO source is empty');
    const sourceRate = finite(sampleRate);
    if (!sourceRate) throw new Error('The VO sample rate is unavailable');

    progress(0.02, 'preparing voiceover');
    const audio = resample(samples, sourceRate, TARGET_SAMPLE_RATE);
    const duration = samples.length / sourceRate;
    const pipe = await transcriber();
    progress(0.62, 'recognising words');

    const result = await pipe(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe'
    });
    const words = wordTimings(result?.chunks, duration);
    const text = textOf(result?.text) || words.map(word => word.text).join(' ');

    progress(1, 'done');
    self.postMessage({ type: 'done', result: { text, words, duration, model: MODEL } });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};
