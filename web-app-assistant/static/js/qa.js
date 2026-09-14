// QA de motores contra la API de control de voz-local/servidor.py (proxy /voz).
// Dos ejes: motor STT × motor de intent. Resultados en matriz + detalle por frase.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class QA {
  constructor({ api, audio, log }) {
    this.api = api; this.audio = audio; this.log = log;
    this.rows = [];

    const rec = $('#qa-rec');
    let stop;
    const start = async e => {
      e.preventDefault();
      if (stop) return;
      let release; const hasta = new Promise(r => release = r); stop = release;
      rec.classList.add('rec'); $('#qa-rec-st').textContent = 'grabando…';
      try {
        const blob = await this.audio.record(hasta);
        $('#qa-rec-st').textContent = `${(blob.size / 1024).toFixed(0)} KB → comparando…`;
        const q = new URLSearchParams({ motores: this.motores().join(','), motores_intent: this.motoresIntent().join(',') });
        const esperado = $('#qa-esperado').value.trim(); if (esperado) q.set('esperado', esperado);
        const r = await this.api(`/voz/comparar?${q}`, blob, blob.type);
        this.addRows('🎙 grabación', r.resultados, esperado);
        $('#qa-rec-st').textContent = '';
      } catch (err) { $('#qa-rec-st').textContent = '✗ ' + err.message; }
    };
    const end = () => { if (stop) { stop(); stop = null; rec.classList.remove('rec'); } };
    rec.addEventListener('pointerdown', start);
    rec.addEventListener('pointerup', end);
    rec.addEventListener('pointerleave', end);

    $('#qa-tts').onclick = async () => {
      const frase = $('#qa-frase').value.trim(); if (!frase) return;
      const esperado = $('#qa-esperado').value.trim();
      $('#qa-tts').disabled = true;
      try {
        const r = await this.api('/voz/tts-comparar', JSON.stringify({ frase, motores: this.motores(), motores_intent: this.motoresIntent(), esperado: esperado || undefined }));
        this.addRows(frase, r.resultados, esperado);
      } catch (err) { this.log?.('qa', err.message); }
      $('#qa-tts').disabled = false;
    };

    $('#qa-auto').onclick = async () => {
      $('#qa-auto').disabled = true;
      const t0 = performance.now();
      const n = this.motores().length * this.motoresIntent().length;
      $('#qa-auto-st').textContent = `corriendo ${n} combinaciones… (puede tardar)`;
      try {
        const r = await this.api('/voz/autotest', JSON.stringify({ motores: this.motores(), motores_intent: this.motoresIntent() }));
        for (const f of r.filas) this.addRows(f.frase, f.resultados, f.esperado, false);
        this.render();
        $('#qa-auto-st').textContent = `listo en ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      } catch (err) { $('#qa-auto-st').textContent = '✗ ' + err.message; }
      $('#qa-auto').disabled = false;
    };

    $('#qa-clear').onclick = () => { this.rows = []; this.render(); };
  }

  _checks(box, list, defaultAll) {
    const prev = new Set([...box.querySelectorAll('input:checked')].map(i => i.value));
    const html = list.map(m => `<label class="chk" title="${esc(m.descripcion)}"><input type="checkbox" value="${esc(m.id)}"> ${esc(m.id)}${m.cargado ? ' ·' : ''}</label>`).join('');
    if (box.dataset.html === html) return;
    box.innerHTML = html; box.dataset.html = html;
    box.querySelectorAll('input').forEach((i, k) => i.checked = prev.size ? prev.has(i.value) : defaultAll(i.value, k));
  }
  setMotores(list) { this._checks($('#qa-motores'), list, () => true); }
  setMotoresIntent(list) { this._checks($('#qa-motores-intent'), list, () => true); }
  setIntents(list) { $('#qa-intents').innerHTML = list.map(i => `<option value="${esc(i)}">`).join(''); }
  motores() { return [...document.querySelectorAll('#qa-motores input:checked')].map(i => i.value); }
  motoresIntent() { return [...document.querySelectorAll('#qa-motores-intent input:checked')].map(i => i.value); }

  addRows(entrada, resultados, esperado, render = true) {
    resultados.forEach(r => this.rows.unshift({ entrada, esperado, motor_intent: r.motor_intent || 'hassil', ...r }));
    this.rows = this.rows.slice(0, 600);
    if (render) this.render();
  }

  render() {
    this.renderMatrix();
    const tb = $('#qa-table tbody');
    let prev = null;
    tb.innerHTML = this.rows.map(r => {
      const first = r.entrada !== prev; prev = r.entrada;
      const ok = r.acierto === true ? '<span class="y">✓</span>' : r.acierto === false ? '<span class="n">✗</span>' : '·';
      const intent = r.accion?.intent ? esc(r.accion.intent) : '<span class="n">∅</span>';
      return `<tr class="${first ? 'grp' : ''}"><td class="txt" title="${esc(r.entrada)}">${first ? esc(r.entrada) : ''}</td><td>${esc(r.motor)}</td><td>${esc(r.motor_intent)}</td><td class="txt" title="${esc(r.texto)}">${esc(r.texto)}</td><td>${intent}</td><td>${ok}</td><td class="num" title="carga ${r.carga_ms ?? 0} ms">${r.stt_ms ?? ''}/${r.intent_ms ?? '–'}</td></tr>`;
    }).join('');
  }

  renderMatrix() {
    const t = $('#qa-matrix');
    const stt = [...new Set(this.rows.map(r => r.motor))];
    const nlu = [...new Set(this.rows.map(r => r.motor_intent))];
    if (!stt.length) { t.innerHTML = '<tr><td class="dim" style="border:0">sin resultados: grabá, compará una frase o corré el autotest</td></tr>'; return; }
    const cell = {};
    for (const r of this.rows) {
      const c = cell[`${r.motor}|${r.motor_intent}`] ??= { ok: 0, n: 0, stt: [], nlu: [] };
      if (r.acierto != null) { c.n++; c.ok += r.acierto ? 1 : 0; }
      if (r.stt_ms != null) c.stt.push(r.stt_ms);
      if (r.intent_ms != null) c.nlu.push(r.intent_ms);
    }
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const score = c => c.n ? c.ok / c.n : -1;
    const best = Object.entries(cell).sort(([, a], [, b]) => score(b) - score(a) || (avg(a.stt) ?? 1e9) - (avg(b.stt) ?? 1e9))[0]?.[0];
    const color = k => k >= .75 ? 'var(--green)' : k >= .5 ? 'var(--amber)' : 'var(--red)';
    t.innerHTML = `<tr><th class="row">stt \\ intent</th>${nlu.map(n => `<th>${esc(n)}</th>`).join('')}</tr>` +
      stt.map(s => `<tr><th class="row">${esc(s)}</th>${nlu.map(n => {
        const c = cell[`${s}|${n}`]; if (!c) return '<td class="dim">—</td>';
        const k = score(c), a = avg(c.stt), b = avg(c.nlu);
        return `<td class="${`${s}|${n}` === best && c.n ? 'best' : ''}" title="${c.ok}/${c.n} aciertos"><b style="color:${c.n ? color(k) : 'var(--dim)'}">${c.n ? `${c.ok}/${c.n}` : '·'}</b><span>${a != null ? Math.round(a) : '–'} ms · ${b != null ? b.toFixed(1) : '–'} ms</span></td>`;
      }).join('')}</tr>`).join('') +
      `<tr><td colspan="${nlu.length + 1}" class="dim" style="border:0;text-align:left">celda: aciertos · stt ms · intent ms (promedios acumulados) · ▢ mejor combinación</td></tr>`;
  }
}
