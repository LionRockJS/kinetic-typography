// Word-level VO analysis.
//
// The model runs in a module worker so Whisper inference never blocks the
// editor. The audio samples are copied into that worker and are not uploaded;
// Transformers.js only fetches the runtime and model weights on first use.

export const VOICE_MODEL = 'Xenova/whisper-tiny';

/** Analyse one decoded mono source and return relative word timestamps. */
export function analyzeSpeech(mono, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./speech.worker.js', import.meta.url), { type: 'module' });
    const finish = fn => value => { worker.terminate(); fn(value); };

    worker.onmessage = event => {
      const message = event.data;
      if (message?.type === 'progress') onProgress?.(message.value, message.label);
      else if (message?.type === 'done') finish(resolve)(message.result);
      else if (message?.type === 'error') finish(reject)(new Error(message.message || 'Speech analysis failed'));
    };
    worker.onerror = finish(reject);

    try {
      const samples = mono instanceof Float32Array ? mono.slice() : Float32Array.from(mono ?? []);
      worker.postMessage({ type: 'analyze', samples, sampleRate }, [samples.buffer]);
    } catch (error) {
      worker.terminate();
      reject(error);
    }
  });
}
