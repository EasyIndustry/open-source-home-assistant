// Esquema del pipeline: MIC → KWS → VAD → ASR → NLU → TOOL → TTS
const NS = 'http://www.w3.org/2000/svg';
export const STAGES = [
  { id: 'mic', name: 'MIC', tech: 'PCM 16 kHz · 80 ms', budget: 0 },
  { id: 'kws', name: 'KWS', tech: 'openWakeWord · ONNX', budget: 5 },
  { id: 'vad', name: 'ORDEN', tech: 'VAD energía · 0.8 s sil.', budget: 0 },
  { id: 'asr', name: 'ASR', tech: 'faster-whisper base', budget: 600 },
  { id: 'nlu', name: 'NLU', tech: 'hassil · intents+slots', budget: 20 },
  { id: 'tool', name: 'TOOL', tech: 'POST /acciones', budget: 50 },
  { id: 'tts', name: 'TTS', tech: 'Piper · es_AR daniela', budget: 1000 },
];

export class Pipeline {
  constructor(svg) {
    this.svg = svg;
    this.el = {};
    const n = STAGES.length, W = 1200, bw = 140, gap = (W - n * bw - 20) / (n - 1);
    STAGES.forEach((s, i) => {
      const x = 10 + i * (bw + gap), y = 14;
      if (i > 0) {
        const px = x - gap;
        const wire = this.mk('path', { class: 'wire', d: `M${px} ${y + 40} L${x} ${y + 40}` });
        svg.appendChild(wire);
        const arrow = this.mk('path', { d: `M${x - 6} ${y + 36} L${x} ${y + 40} L${x - 6} ${y + 44}`, class: 'wire' });
        svg.appendChild(arrow);
        this.el[s.id + '_wire'] = wire;
      }
      const g = this.mk('g', { class: 'stage', transform: `translate(${x},${y})` });
      g.appendChild(this.mk('rect', { class: 'box', width: bw, height: 86 }));
      g.appendChild(this.mk('rect', { x: 0, y: 0, width: 3, height: 86, fill: '#263341' }));
      const t = (cls, yy, txt) => { const e = this.mk('text', { class: cls, x: 10, y: yy }); e.textContent = txt; g.appendChild(e); return e; };
      const idx = this.mk('text', { class: 'tech', x: bw - 8, y: 16, 'text-anchor': 'end' }); idx.textContent = String(i).padStart(2, '0'); g.appendChild(idx);
      t('name', 18, s.name);
      const tech = t('tech', 32, s.tech);
      const val = t('val', 52, '—');
      const ms = t('ms', 76, '');
      g.appendChild(this.mk('rect', { class: 'bar', x: 10, y: 80, width: bw - 20, height: 2 }));
      const fill = this.mk('rect', { class: 'barfill', x: 10, y: 80, width: 0, height: 2 });
      g.appendChild(fill);
      svg.appendChild(g);
      this.el[s.id] = { g, val, ms, fill, tech, bw, budget: s.budget };
    });
    const leg = this.mk('text', { x: 10, y: 114, class: 'tech', fill: '#5d6d7a' });
    leg.textContent = '▸ barra = latencia medida / presupuesto de la etapa (doc: pipeline total < 600 ms en RPi 5, < 1 GB RAM)';
    leg.style.fill = '#5d6d7a'; leg.style.fontSize = '10px';
    svg.appendChild(leg);
    this.timers = {};
  }
  mk(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

  set(id, { state, val, ms, tech } = {}) {
    const e = this.el[id]; if (!e) return;
    if (state !== undefined) {
      e.g.classList.remove('active', 'done', 'fail');
      if (state) e.g.classList.add(state);
      const w = this.el[id + '_wire'];
      if (w) w.classList.toggle('hot', state === 'active');
      clearTimeout(this.timers[id]);
      if (state === 'done' || state === 'fail') this.timers[id] = setTimeout(() => e.g.classList.remove('done', 'fail'), 6000);
    }
    if (val !== undefined) e.val.textContent = String(val).length > 20 ? String(val).slice(0, 19) + '…' : val;
    if (tech !== undefined) e.tech.textContent = tech;
    if (ms !== undefined) {
      e.ms.textContent = ms === null ? '' : `${typeof ms === 'number' ? (ms < 10 ? ms.toFixed(1) : Math.round(ms)) : ms} ms`;
      if (e.budget && typeof ms === 'number') {
        const k = ms / e.budget;
        e.fill.setAttribute('width', Math.min(1, k) * (e.bw - 20));
        e.fill.style.fill = k > 1 ? '#ff5c5c' : k > 0.7 ? '#ffb454' : '#3fd0e0';
      }
    }
  }
  reset(except = []) {
    for (const s of STAGES) if (!except.includes(s.id)) this.set(s.id, { state: '' });
  }
}
