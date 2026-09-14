// Micrófono del navegador + reproducción de TTS, ambos con analizadores para el osciloscopio.
export class AudioIO {
  constructor(ttsEl) {
    this.ctx = null;
    this.ttsEl = ttsEl;
    this.micAn = null;
    this.ttsAn = null;
    this.stream = null;
    this.onPcm = null;
  }

  ensureCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.ttsAn) {
      const src = this.ctx.createMediaElementSource(this.ttsEl);
      this.ttsAn = this.ctx.createAnalyser();
      this.ttsAn.fftSize = 2048;
      src.connect(this.ttsAn);
      this.ttsAn.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async startMic() {
    const ctx = this.ensureCtx();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = ctx.createMediaStreamSource(this.stream);
    this.micAn = ctx.createAnalyser();
    this.micAn.fftSize = 2048;
    src.connect(this.micAn);
    await ctx.audioWorklet.addModule('js/mic-worklet.js');
    this.node = new AudioWorkletNode(ctx, 'downsampler');
    this.node.port.onmessage = e => this.onPcm?.(new Int16Array(e.data));
    src.connect(this.node);
    this.src = src;
  }

  stopMic() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.src?.disconnect(); this.node?.disconnect();
    this.stream = this.micAn = this.node = this.src = null;
  }

  get micOn() { return !!this.stream; }

  play(url) {
    this.ensureCtx();
    this.ttsEl.src = url;
    return this.ttsEl.play();
  }

  // Graba con MediaRecorder (webm/opus) mientras dure la promesa `hasta`.
  async record(hasta) {
    const stream = this.stream || await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(r => rec.onstop = r);
    rec.start();
    await hasta;
    rec.stop();
    await done;
    if (!this.stream) stream.getTracks().forEach(t => t.stop());
    return new Blob(chunks, { type: rec.mimeType });
  }
}
