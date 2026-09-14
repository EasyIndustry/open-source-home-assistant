// Gráficos técnicos: osciloscopio (mic + tts), score del wake word y latencias por ciclo.
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(canvas.height === 0 ? r.height : parseInt(canvas.getAttribute('height')) * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; canvas.style.height = (h / dpr) + 'px'; }
  return [w, h, dpr];
}

export class Scope {
  constructor(canvas, audio) {
    this.c = canvas; this.audio = audio;
    this.rmsHist = new Array(160).fill(0); // desde el server cuando el mic está en otro lado
    this.buf = new Uint8Array(2048);
    this.fbuf = new Uint8Array(1024);
    this.phase = '';
    requestAnimationFrame(() => this.draw());
  }
  pushRms(values) { for (const v of values) { this.rmsHist.push(Math.min(1, v / 6000)); this.rmsHist.shift(); } }
  draw() {
    requestAnimationFrame(() => this.draw());
    const [w, h, dpr] = fit(this.c);
    const g = this.c.getContext('2d');
    g.clearRect(0, 0, w, h);
    // retícula
    g.strokeStyle = '#141c24'; g.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += h / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // espectro del mic (barras tenues)
    const mic = this.audio.micAn, tts = this.audio.ttsAn;
    if (mic) {
      mic.getByteFrequencyData(this.fbuf);
      g.fillStyle = 'rgba(63,208,224,.13)';
      const n = 96, bw = w / n;
      for (let i = 0; i < n; i++) { const v = this.fbuf[Math.floor(i * i / n / 1.2)] / 255; g.fillRect(i * bw, h - v * h, bw - 1, v * h); }
    }
    const trace = (an, color) => {
      an.getByteTimeDomainData(this.buf);
      g.strokeStyle = color; g.lineWidth = 1.2 * dpr; g.beginPath();
      for (let i = 0; i < this.buf.length; i += 2) {
        const x = i / this.buf.length * w, y = (this.buf[i] / 255) * h;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    };
    if (mic) trace(mic, css('--cyan'));
    if (tts && !this.audio.ttsEl.paused) trace(tts, css('--amber'));
    if (!mic) {
      // envolvente RMS recibida del server
      g.strokeStyle = '#2b3b48'; g.beginPath();
      this.rmsHist.forEach((v, i) => { const x = i / (this.rmsHist.length - 1) * w; g.lineTo(x, h / 2 - v * h / 2); });
      this.rmsHist.slice().reverse().forEach((v, i) => { const x = (1 - i / (this.rmsHist.length - 1)) * w; g.lineTo(x, h / 2 + v * h / 2); });
      g.stroke();
      if (!tts || this.audio.ttsEl.paused) { g.strokeStyle = '#2b3b48'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); }
    }
    g.fillStyle = css('--dim'); g.font = `${10 * dpr}px ui-monospace, monospace`;
    g.fillText(mic ? 'mic 16k ─ ' : 'mic off ─ ', 6 * dpr, 12 * dpr);
    g.fillStyle = css('--amber'); g.fillText('tts', 70 * dpr, 12 * dpr);
    if (this.phase) { g.fillStyle = css('--cyan'); g.textAlign = 'right'; g.fillText(this.phase, w - 6 * dpr, 12 * dpr); g.textAlign = 'left'; }
  }
}

export class KwsChart {
  constructor(canvas) {
    this.c = canvas;
    this.data = new Array(250).fill(null); // ~20 s a 80 ms
    this.marks = [];
    this.umbral = 0.5;
    requestAnimationFrame(() => this.draw());
  }
  push(scores) {
    for (const s of scores) { this.data.push(s); this.data.shift(); this.marks = this.marks.map(m => m - 1).filter(m => m >= 0); }
  }
  mark() { this.marks.push(this.data.length - 1); }
  max() { return Math.max(0, ...this.data.slice(-62).filter(v => v != null)); }
  draw() {
    requestAnimationFrame(() => this.draw());
    const [w, h, dpr] = fit(this.c);
    const g = this.c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const y = v => h - 4 * dpr - v * (h - 10 * dpr);
    g.strokeStyle = '#141c24';
    [0.25, 0.5, 0.75, 1].forEach(v => { g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke(); });
    // umbral
    g.strokeStyle = css('--amber'); g.setLineDash([4 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(0, y(this.umbral)); g.lineTo(w, y(this.umbral)); g.stroke(); g.setLineDash([]);
    // zonas sin score (grabando orden)
    const dx = w / (this.data.length - 1);
    g.fillStyle = 'rgba(63,208,224,.07)';
    this.data.forEach((v, i) => { if (v === null && i > 0 && this.data.slice(0, i).some(x => x !== null)) g.fillRect(i * dx, 0, dx + 1, h); });
    g.strokeStyle = css('--cyan'); g.lineWidth = 1.3 * dpr; g.beginPath();
    let pen = false;
    this.data.forEach((v, i) => { if (v == null) { pen = false; return; } pen ? g.lineTo(i * dx, y(v)) : g.moveTo(i * dx, y(v)); pen = true; });
    g.stroke();
    g.fillStyle = 'rgba(63,208,224,.12)';
    this.data.forEach((v, i) => { if (v != null && v > 0.02) g.fillRect(i * dx, y(v), dx, h - y(v)); });
    for (const m of this.marks) {
      g.strokeStyle = css('--green'); g.beginPath(); g.moveTo(m * dx, 0); g.lineTo(m * dx, h); g.stroke();
      g.fillStyle = css('--green'); g.font = `${9 * dpr}px ui-monospace, monospace`; g.fillText('WAKE', m * dx + 3 * dpr, 10 * dpr);
    }
    g.fillStyle = css('--dim'); g.font = `${9 * dpr}px ui-monospace, monospace`;
    g.fillText('1.0', 2 * dpr, y(1) + 8 * dpr); g.fillText('−20 s', 2 * dpr, h - 2 * dpr);
  }
}

export class LatencyChart {
  constructor(svg) { this.svg = svg; this.cycles = []; this.render(); }
  add(c) { this.cycles.push(c); this.cycles = this.cycles.slice(-8); this.render(); }
  render() {
    const W = 300, H = 150, left = 34, barH = 13, gap = 4;
    const max = Math.max(1200, ...this.cycles.map(c => (c.stt || 0) + (c.nlu || 0) + (c.tts || 0)));
    const sx = v => (v / max) * (W - left - 6);
    let out = '';
    [0, 600, max].forEach(v => {
      const x = left + sx(v);
      out += `<line x1="${x}" x2="${x}" y1="0" y2="${H - 12}" stroke="${v === 600 ? '#ffb454' : '#1a232d'}" stroke-dasharray="${v === 600 ? '3 3' : ''}"/>`;
      out += `<text x="${x}" y="${H - 2}" text-anchor="middle">${v} ms</text>`;
    });
    this.cycles.forEach((c, i) => {
      const y = 4 + i * (barH + gap);
      let x = left;
      out += `<text x="2" y="${y + 10}">${(c.motor || c.label || '').slice(0, 7)}</text>`;
      const seg = (v, color, name) => {
        if (!v) return;
        const w = Math.max(1, sx(v));
        out += `<rect x="${x}" y="${y}" width="${w}" height="${barH}" fill="${color}"><title>${name}: ${Math.round(v)} ms</title></rect>`;
        x += w;
      };
      seg(c.stt, '#6aa8ff', 'asr'); seg(c.nlu, '#d38cff', 'nlu'); seg(c.tts, '#ffb454', 'tts');
      const tot = (c.stt || 0) + (c.nlu || 0) + (c.tts || 0);
      out += `<text x="${x + 3}" y="${y + 10}" style="fill:${tot > 600 ? '#ff5c5c' : '#7ee787'}">${Math.round(tot)}${c.rec ? ` +${c.rec}s rec` : ''}</text>`;
    });
    if (!this.cycles.length) out += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">sin ciclos todavía</text>`;
    this.svg.innerHTML = out;
  }
}
