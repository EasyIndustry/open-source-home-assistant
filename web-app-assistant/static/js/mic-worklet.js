// Baja la señal del micrófono a PCM int16 16 kHz en bloques de 1280 muestras (80 ms, lo que espera openWakeWord).
class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.n = 0;
    this.out = new Int16Array(1280); this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.sum += ch[k]; this.n++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0; this.n = 0;
        this.out[this.i++] = v * 32767;
        if (this.i === 1280) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(1280); this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('downsampler', Downsampler);
