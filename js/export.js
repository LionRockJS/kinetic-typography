// Real-time video capture: the stage canvas is already rendered at the project's
// true pixel size, so the recording is 1:1 with the composition. MP4/H.264 is
// preferred where the browser can mux it (Safari, Chrome 130+); WebM elsewhere.

export class Recorder {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.rec = null;
    this.chunks = [];
    this.active = false;
  }

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }

  static mime() {
    const list = [
      // MP4 first — plays anywhere without a transcode step.
      'video/mp4;codecs=avc1.640033,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm'
    ];
    return list.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  }

  // File extension matching whatever the browser actually produced.
  static extFor(type = '') {
    return type.includes('mp4') ? 'mp4' : 'webm';
  }

  start(fps = 30) {
    if (this.active) return;
    const stream = this.canvas.captureStream(fps);
    const audioTrack = this.engine?.streamDest?.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);

    const mimeType = Recorder.mime();
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(200);
    this.active = true;
  }

  stop() {
    return new Promise(resolve => {
      if (!this.active || !this.rec) return resolve(null);
      this.rec.onstop = () => {
        this.active = false;
        resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'video/webm' }));
      };
      this.rec.stop();
    });
  }
}
