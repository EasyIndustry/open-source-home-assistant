import { House, ROOMS } from './house3d.js';
import { Pipeline } from './pipeline.js';
import { Scope, KwsChart, LatencyChart } from './charts.js';
import { AudioIO } from './audio.js';
import { QA } from './qa.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };

async function api(path, body, type = 'application/json') {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body, headers: { 'Content-Type': type } });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { error: txt }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const post = (path, obj = {}) => api(path, JSON.stringify(obj));
// ISO en hora local (los eventos del server vienen en hora local, sin zona)
const ahoraISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23); };

// ------------------------------------------------------------------ componentes
const audio = new AudioIO($('#tts-audio'));
const pipe = new Pipeline($('#pipe-svg'));
const scope = new Scope($('#scope'), audio);
const kws = new KwsChart($('#kws'));
const lat = new LatencyChart($('#lat'));
const house = new House($('#three'), { onClickDevice: toggleDevice });
const qa = new QA({ api, audio, log: (t, m) => addLog({ tipo: t, origen: 'web', timestamp: ahoraISO(), error: m }) });

const S = { devices: {}, sensors: {}, satelite: 'living', kwsCount: 0, cycle: null, dest: store.get('dest', 'servidor'), vozOk: false };

// ------------------------------------------------------------------ estado inicial
async function boot() {
  const st = await api('/api/estado');
  S.devices = st.dispositivos; S.sensors = st.sensores;
  house.setDevices(st.dispositivos);
  house.setSensors(st.sensores);
  setSatellite(st.satelite);
  renderSensors();
  kws.umbral = st.umbral; $('#kws-th').textContent = st.umbral.toFixed(2);
  setWakeLabel(st.wake);
  $('#voz-url').textContent = st.voz_url.replace('http://', '');
  for (const [k, ok] of Object.entries(st.motor)) led(k, ok ? 'ok' : 'warn');
  st.historial.forEach(ev => addLog(ev, false));
  checkAlarm(st.dispositivos['alarma.casa']);
  $('#sel-dest').value = S.dest;
  $('#sel-voz').value = store.get('voz', 'host');
  await post('/api/destino', { destino: S.dest, tts_navegador: $('#sel-voz').value === 'navegador' });
  pollVoz();
}

function led(k, cls) {
  const id = { nlu: 'st-nlu', kws: 'st-kws', stt: 'st-stt', tts: 'st-tts' }[k] || k;
  const el = document.getElementById(id); if (!el) return;
  el.classList.remove('ok', 'warn', 'err'); if (cls) el.classList.add(cls);
}

// ------------------------------------------------------------------ servidor.py (API de control)
async function pollVoz() {
  try {
    const st = await api('/voz/estado');
    S.voz = st; S.vozOk = true;
    led('st-voz', 'ok');
    fillSelect($('#sel-motor'), st.motores.map(m => [m.id, `${m.id}${m.cargado ? '' : ' (no cargado)'}`]), st.motor);
    if (st.motores_intent) fillSelect($('#sel-intent'), st.motores_intent.map(m => [m.id, m.id]), st.motor_intent);
    else fillSelect($('#sel-intent'), [['hassil', 'hassil']], 'hassil');
    fillSelect($('#sel-wake'), st.wake_words.map(w => [w, w]), st.wake);
    if (document.activeElement !== $('#sel-wake') && S.wake !== st.wake) {
      setWakeLabel(st.wake);
      post('/api/destino', { wake: st.wake }).catch(() => { });  // el mic del navegador sigue al host
    }
    if (document.activeElement !== $('#rng-umbral')) { $('#rng-umbral').value = st.umbral; $('#umbral-v').textContent = (+st.umbral).toFixed(2); }
    $('#chk-mudo').checked = !!st.mudo; $('#chk-micpausa').checked = !!st.mic_pausado;
    if (st.mic) {
      led('st-mic', st.mic.activo ? (st.mic_pausado ? 'warn' : 'ok') : 'err');
      $('#st-mic').title = st.mic.activo ? `escuchando: ${st.mic.dispositivo}` : (st.mic.error || 'micrófono del host inactivo');
    }
    qa.setMotores(st.motores, st.motor);
    qa.setMotoresIntent(st.motores_intent || [{ id: 'hassil', descripcion: 'hassil' }]);
    pipe.set('asr', { tech: S.dest === 'servidor' ? `servidor.py · ${st.motor}` : 'embebido · whisper base' });
  } catch {
    S.vozOk = false;
    led('st-voz', 'err');
    fillSelect($('#sel-motor'), [['', 'servidor.py offline']], '');
    fillSelect($('#sel-wake'), [['', '—']], '');
    fillSelect($('#sel-intent'), [['', '—']], '');
    led('st-mic', '');
  }
  for (const id of ['#sel-motor', '#sel-intent', '#sel-wake', '#rng-umbral', '#chk-mudo', '#chk-micpausa', '#btn-recargar', '#btn-escuchar', '#qa-rec', '#qa-tts', '#qa-auto']) $(id).disabled = !S.vozOk;
  if (!S.vozOk && S.dest === 'servidor') addLog({ tipo: 'sistema', origen: 'web', timestamp: ahoraISO(), componente: 'servidor.py', ok: false, error: 'offline: usando igual el destino elegido; cambiá a "motor embebido" o levantá voz-local/servidor.py' }, true, 'voz-off');
  clearTimeout(S.vozT); S.vozT = setTimeout(pollVoz, S.vozOk ? 8000 : 4000);
}
function fillSelect(sel, opts, val) {
  const html = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  if (document.activeElement !== sel) sel.value = val;
}

$('#sel-dest').onchange = async e => {
  S.dest = e.target.value; store.set('dest', S.dest);
  await post('/api/destino', { destino: S.dest });
  pollVoz();
};
$('#sel-motor').onchange = async e => {
  const motor = e.target.value;
  await post('/api/destino', { motor });
  try { await post('/voz/config', { motor }); } catch (err) { flashErr(err); }
  pollVoz();
};
$('#sel-intent').onchange = e => post('/voz/config', { motor_intent: e.target.value }).then(pollVoz, flashErr);
$('#sel-wake').onchange = async e => {
  const wake = e.target.value;
  setWakeLabel(wake);
  // aplica a los dos micrófonos: host (servidor.py) y navegador (KWS embebido)
  const [host, web] = await Promise.allSettled([post('/voz/config', { wake }), post('/api/destino', { wake })]);
  for (const r of [host, web]) if (r.status === 'rejected') flashErr(r.reason);
  pollVoz();
};
function setWakeLabel(wake) {
  $('#kws-name').textContent = `openWakeWord · ${wake}`;
  const frase = wake.replace(/_/g, ' ');
  $('#btn-ptt').title = `Saltea la wake word ("${frase}") y graba la orden`;
  S.wake = wake;
}
$('#rng-umbral').oninput = e => $('#umbral-v').textContent = (+e.target.value).toFixed(2);
$('#rng-umbral').onchange = e => post('/voz/config', { umbral: +e.target.value }).then(pollVoz, flashErr);
$('#chk-mudo').onchange = e => post('/voz/config', { mudo: e.target.checked }).then(pollVoz, flashErr);
$('#chk-micpausa').onchange = e => {
  if (!e.target.checked && audio.micOn) flashErr(new Error('ojo: con el micrófono del navegador activo, reanudar el del host duplica las respuestas'));
  if (!e.target.checked) S.hostMicPausadoPorWeb = false;
  post('/voz/config', { mic_pausado: e.target.checked }).then(pollVoz, flashErr);
};
$('#sel-voz').onchange = e => { store.set('voz', e.target.value); post('/api/destino', { tts_navegador: e.target.value === 'navegador' }); };
$('#btn-recargar').onclick = () => post('/voz/recargar').then(() => addLog({ tipo: 'sistema', origen: 'web', timestamp: ahoraISO(), componente: 'servidor.py', ok: true, detalle: 'intenciones recargadas' }), flashErr);
$('#btn-escuchar').onclick = () => post('/voz/escuchar').then(() => { pipe.set('vad', { state: 'active', val: 'host · ptt' }); house.listening(true); }, flashErr);
function flashErr(err) { addLog({ tipo: 'sistema', origen: 'web', timestamp: ahoraISO(), ok: false, error: err.message }); }

// ------------------------------------------------------------------ SSE + reordenamiento por timestamp
const HOT = new Set(['mic', 'sensores', 'motores']);
let pend = [];
function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => led('st-conn', 'ok');
  es.onerror = () => led('st-conn', 'err');
  es.onmessage = m => {
    const ev = JSON.parse(m.data);
    if (HOT.has(ev.tipo)) return handle(ev);
    pend.push(ev);
  };
}
setInterval(() => {
  if (!pend.length) return;
  const batch = pend.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  pend = [];
  batch.forEach(handle);
}, 150);

// ------------------------------------------------------------------ manejo de eventos
function handle(ev) {
  if (ev.origen === 'asistente') { const el = $('#st-ext'); el.classList.add('ok', 'pulse'); setTimeout(() => el.classList.remove('pulse'), 1800); }
  switch (ev.tipo) {
    case 'mic': {
      // servidor.py manda scores:null mientras graba o procesa la orden
      const scores = Array.isArray(ev.scores) ? ev.scores : (ev.rms || []).map(() => null);
      // con el mic del navegador encendido, el gráfico sigue al motor embebido
      if (audio.micOn && ev.origen === 'asistente') return;
      kws.push(scores);
      if (ev.umbral != null) { kws.umbral = ev.umbral; $('#kws-th').textContent = (+ev.umbral).toFixed(2); }
      if (!audio.micOn) scope.pushRms(ev.rms || []);
      if (ev.origen === 'asistente') { $('#mic-state').textContent = `host · ${S.voz?.mic?.dispositivo || 'voz-local-mic'}`; led('st-mic', 'ok'); }
      $('#kws-max').textContent = kws.max().toFixed(3);
      scope.phase = ev.fase === 'orden' ? '● grabando orden' : ev.fase === 'procesando' ? '◌ procesando' : '';
      if (ev.fase === 'reposo') pipe.set('kws', { state: 'active', val: `score ${kws.max().toFixed(2)}` });
      return;
    }
    case 'sensores':
      S.sensors = ev.sensores; house.setSensors(ev.sensores); renderSensors(ev.potencia);
      return;
    case 'motores':
      house.motors(ev.cambios);
      for (const c of ev.cambios) Object.assign(S.devices[c.id], c);
      return;
  }
  addLog(ev);
  switch (ev.tipo) {
    case 'estado':
      house.listening(false);
      pipe.set('mic', { state: 'active', val: ev.origen === 'web' ? 'navegador' : 'host' });
      break;
    case 'wake':
      S.kwsCount++; $('#kws-count').textContent = S.kwsCount;
      kws.mark();
      newCycle();
      pipe.reset(['mic']);
      pipe.set('kws', { state: 'done', val: `${ev.palabra} ${(+ev.score).toFixed(2)}` });
      pipe.set('vad', { state: 'active', val: 'grabando…', ms: null });
      house.wake(); house.listening(true);
      showDlg('user', '…');
      break;
    case 'orden':
      house.listening(false);
      pipe.set('vad', { state: ev.hubo_voz ? 'done' : 'fail', val: ev.hubo_voz ? `${ev.duracion_s} s de audio` : 'sin voz', ms: null });
      if (S.cycle) S.cycle.rec = ev.duracion_s;
      if (ev.hubo_voz) pipe.set('asr', { state: 'active', val: 'transcribiendo…' });
      else showDlg('user', '(no se escuchó ninguna orden)');
      break;
    case 'stt': {
      const motor = ev.motor || ev.modelo;
      if (!S.cycle || S.cycle.stt) newCycle();
      S.cycle.stt = ev.ms; S.cycle.motor = motor;
      pipe.set('asr', { state: ev.texto ? 'done' : 'fail', val: ev.texto ? `"${ev.texto}"` : '(vacío)', ms: ev.ms, tech: `${ev.origen === 'asistente' ? 'servidor.py' : 'embebido'} · ${motor}` });
      pipe.set('nlu', { state: 'active', val: '…' });
      showDlg('user', ev.texto || '(vacío)');
      break;
    }
    case 'intent':
      if (!S.cycle || S.cycle.nlu !== undefined) { newCycle(); pipe.reset(['mic']); showDlg('user', ev.texto); S.cycle.motor = 'texto'; }
      S.cycle.nlu = ev.ms;
      pipe.set('nlu', { state: ev.intent ? 'done' : 'fail', val: ev.intent || 'sin match', ms: ev.ms,
        tech: `${ev.origen === 'asistente' ? (ev.motor_intent || 'hassil') : 'hassil · embebido'}` });
      pipe.set('tool', { state: ev.intent ? 'active' : '', val: ev.intent ? 'ejecutando…' : '—', ms: null });
      renderNlu(ev);
      break;
    case 'accion':
      pipe.set('tool', { state: 'active', val: ev.intent });
      S.lastAccionT = performance.now();
      break;
    case 'respuesta_sim':
      pipe.set('tool', { state: 'done', val: `${ev.afectados.length} dispositivo(s)`, ms: S.lastAccionT ? performance.now() - S.lastAccionT : null });
      $('#nlu-tool').textContent = ev.afectados.length ? ev.afectados.join(', ') : '(sin cambios)';
      house.packet(ev.afectados, S.satelite);
      break;
    case 'respuesta':
      if (ev.origen === 'web') {
        pipe.set('tool', { state: ev.entendido ? 'done' : '', val: ev.afectados?.length ? `${ev.afectados.length} dispositivo(s)` : '—' });
        $('#nlu-tool').textContent = ev.afectados?.length ? ev.afectados.join(', ') : '(sin cambios)';
        if (ev.afectados?.length) house.packet(ev.afectados, S.satelite);
      }
      showDlg('bot', ev.texto);
      pipe.set('tts', { state: 'active', val: 'sintetizando…', ms: null });
      break;
    case 'tts':
      pipe.set('tts', { state: 'done', val: ev.audio ? `${ev.duracion_s} s audio` : 'reproducido (host)', ms: ev.ms });
      if (ev.audio && $('#sel-voz').value === 'navegador') {
        audio.play(ev.audio).catch(() => { });
        $('#dlg-bot').classList.add('speaking');
        $('#tts-audio').onended = () => $('#dlg-bot').classList.remove('speaking');
      }
      if (S.cycle && !S.cycle.closed) { S.cycle.tts = ev.ms; S.cycle.closed = true; lat.add(S.cycle); }
      break;
    case 'dispositivo':
      S.devices[ev.id] = ev.estado;
      house.updateDevice(ev.estado);
      if (ev.id === 'alarma.casa') checkAlarm(ev.estado);
      break;
    case 'regla':
      break;
    case 'satelite':
      setSatellite(ev.area);
      break;
    case 'sistema':
      if (['nlu', 'kws', 'stt', 'tts'].includes(ev.componente)) led(ev.componente, ev.ok ? 'ok' : 'err');
      if (ev.componente === 'mic' && ev.origen === 'asistente') {
        led('st-mic', ev.ok ? 'ok' : 'err');
        $('#st-mic').title = ev.ok ? `escuchando: ${ev.dispositivo}` : `${ev.dispositivo}: ${ev.error}`;
        pipe.set('mic', { state: ev.ok ? 'active' : 'fail', val: ev.ok ? 'host' : 'mic caído' });
      }
      break;
    case 'config':
      if (ev.wake && ev.wake !== S.wake) { setWakeLabel(ev.wake); $('#sel-wake').value = ev.wake; }
      pollVoz();
      break;
  }
}

function newCycle() { S.cycle = { t0: performance.now() }; }

// ------------------------------------------------------------------ NLU
const SLOT_COLORS = ['area', 'dispositivo', 'brillo', 'temperatura', 'escena'];
function renderNlu(ev) {
  $('#nlu-raw').textContent = ev.texto;
  $('#nlu-raw').classList.remove('dim');
  const norm = ev.texto_normalizado || ev.texto;
  const toks = norm.split(' ');
  const tag = new Array(toks.length).fill(null);
  const spans = ev.spans && Object.keys(ev.spans).length ? ev.spans : Object.fromEntries(Object.entries(ev.slots || {}).map(([k, v]) => [k, String(v)]));
  for (const [slot, txt] of Object.entries(spans)) {
    const st = String(txt).split(' ');
    for (let i = 0; i + st.length <= toks.length; i++) {
      if (st.every((t, j) => toks[i + j] === t) && tag.slice(i, i + st.length).every(x => !x)) {
        for (let j = 0; j < st.length; j++) tag[i + j] = slot;
        break;
      }
    }
  }
  $('#nlu-norm').innerHTML = toks.map((t, i) => tag[i]
    ? `<span class="tok slot s-${SLOT_COLORS.includes(tag[i]) ? tag[i] : 'area'}" data-slot="${esc(tag[i])}">${esc(t)}</span>`
    : `<span class="tok">${esc(t)}</span>`).join('');
  const it = $('#nlu-intent');
  it.textContent = ev.intent ? `${ev.intent}  ·  ${ev.ms} ms` : 'None (no entendido)';
  it.className = 'v ' + (ev.intent ? 'hit' : 'miss');
  $('#nlu-slots').innerHTML = Object.entries(ev.slots || {}).map(([k, v]) => `<span class="sl s-${SLOT_COLORS.includes(k) ? k : 'area'}">${esc(k)}=${esc(v)}</span>`).join('') || '<span class="dim">—</span>';
  if (ev.intent && !ev.slots?.area && ev.area_satelite) $('#nlu-slots').innerHTML += `<span class="sl dim">area⇐satélite:${esc(ev.area_satelite)}</span>`;
  $('#nlu-tool').textContent = ev.intent ? '…' : '—';
  const { tipo, timestamp, spans: _s, ...rest } = ev;
  $('#nlu-json').textContent = JSON.stringify(rest, null, 1);
  $('#nlu-engine').textContent = ev.origen === 'asistente' ? `${ev.motor_intent || 'hassil'} · servidor.py` : 'hassil · motor embebido';
}

// ------------------------------------------------------------------ bus de eventos
const LOG_MAX = 250;
function summary(ev) {
  const { tipo, origen, timestamp, ...r } = ev;
  switch (tipo) {
    case 'dispositivo': return `${ev.id} ${Object.entries(ev.antes).map(([k, v]) => `${k}:${v}→${ev.estado[k]}`).join(' ')} ${ev.motivo ? `[${ev.motivo}]` : ''}`;
    case 'intent': return `${ev.intent ?? '∅'} ${JSON.stringify(ev.slots)} ← "${ev.texto}"${ev.motor_intent ? ` [${ev.motor_intent}]` : ''}`;
    case 'stt': return `"${ev.texto}" (${ev.motor || ev.modelo}, ${ev.ms} ms)`;
    case 'respuesta': case 'respuesta_sim': return `"${ev.texto}"`;
    case 'regla': return `${ev.nombre}: ${ev.detalle}`;
    case 'sistema': return `${ev.componente ?? ''} ${ev.dispositivo ? `[${ev.dispositivo}] ` : ''}${ev.ok === false ? '✗ ' + (ev.error ?? '') : '✓'} ${ev.ms ? ev.ms + ' ms' : ''} ${ev.detalle ?? ''} ${ev.destino ? `destino=${ev.destino} motor=${ev.motor ?? '(actual)'}` : ''}`;
    default: return JSON.stringify(r);
  }
}
function addLog(ev, animate = true, dedupe) {
  if (dedupe) { if (S['dd_' + dedupe]) return; S['dd_' + dedupe] = 1; setTimeout(() => S['dd_' + dedupe] = 0, 30000); }
  if (!$('#chk-noise').checked && HOT.has(ev.tipo)) return;
  const log = $('#log');
  const d = document.createElement('div');
  d.className = `ev ty-${ev.tipo} o-${ev.origen}${ev.ok === false ? ' err' : ''}${animate ? ' new' : ''}`;
  const t = (ev.timestamp || '').slice(11, 23);
  const src = ev.origen === 'asistente' ? '◆' : ev.origen === 'web' ? '◇' : ev.origen === 'manual' ? '✋' : '·';
  d.innerHTML = `<span class="t">${esc(t.slice(0, 12))}</span><span class="ty" title="${esc(ev.origen)}">${src} ${esc(ev.tipo)}</span><span class="b" title="${esc(JSON.stringify(ev))}">${esc(summary(ev))}</span>`;
  const stick = log.scrollTop < 8;
  log.prepend(d);
  while (log.children.length > LOG_MAX) log.lastChild.remove();
  if (!stick) log.scrollTop += d.offsetHeight;
}

// ------------------------------------------------------------------ sensores
function renderSensors(potencia = {}) {
  const s = S.sensors; if (!s.living) return;
  const areas = Object.keys(ROOMS);
  const cell = (v, cls = '') => `<td class="${cls}">${v}</td>`;
  let html = '<tr><th>área</th><th>T °C</th><th>HR %</th><th>lux</th><th>mov</th><th>otros</th></tr>';
  for (const a of areas) {
    const x = s[a]; if (!x) continue;
    const otros = [x.humo ? '<b style="color:#ff5c5c">HUMO</b>' : '', x.agua ? '<b style="color:#ff5c5c">AGUA</b>' : '', x.co2 ? `CO₂ ${x.co2}` : '', x.suelo !== undefined ? `suelo ${x.suelo}%` : '',
      ...Object.entries(potencia).filter(([id]) => id.endsWith('.' + a) && potencia[id]).map(([, w]) => `${w} W`)].filter(Boolean).join(' ');
    html += `<tr class="${a === S.satelite ? 'sat' : ''}">${cell(a)}${cell((+x.temp).toFixed(1))}${cell(Math.round(x.hum), x.hum > 75 ? 'flag' : '')}${cell(x.lux)}${cell(x.mov ? '◎' : '·', x.mov ? 'flag' : '')}${cell(otros, x.humo || x.agua ? 'bad' : '')}</tr>`;
  }
  if (s.exterior) html += `<tr>${cell('exterior')}${cell((+s.exterior.temp).toFixed(1))}${cell(s.exterior.hum)}${cell(s.exterior.lux)}${cell('')}${cell('')}</tr>`;
  $('#sensors').innerHTML = html;
}

// ------------------------------------------------------------------ casa: interacción
function toggleDevice(d) {
  const ch = { id: d.id };
  switch (d.tipo) {
    case 'luz': case 'aire': case 'ventilador': case 'tele': case 'enchufe': case 'riego': ch.on = !d.on; break;
    case 'persiana': case 'ventana': case 'porton': ch.objetivo = d.objetivo > 0 ? 0 : 100; break;
    case 'cerradura': ch.trabada = !d.trabada; break;
    case 'alarma': Object.assign(ch, { armada: !d.armada, disparada: false, causa: null }); break;
  }
  post('/api/dispositivo', ch).catch(flashErr);
}
function setSatellite(area) {
  S.satelite = area;
  house.setSatellite(area);
  $('#sat-list').innerHTML = Object.keys(ROOMS).map(a => `<button class="${a === area ? 'on' : ''}" data-a="${a}">${a}</button>`).join('');
  renderSensors();
}
$('#sat-list').onclick = e => { const a = e.target.dataset.a; if (a) post('/api/satelite', { area: a }); };
function checkAlarm(al) {
  $('#alarm-banner').hidden = !al?.disparada;
  $('#alarm-cause').textContent = al?.causa || '';
}
$('#btn-alarm-reset').onclick = () => post('/api/simular', { resetear_alarma: true, area: 'cocina', sensor: 'humo', valor: false }).then(() => post('/api/simular', { area: 'bano', sensor: 'agua', valor: false }));
$('#inject').onclick = e => { const b = e.target.closest('[data-sim]'); if (b) post('/api/simular', JSON.parse(b.dataset.sim)); };
$('#chk-labels').onchange = e => document.body.classList.toggle('no-labels', !e.target.checked);
$('#chk-roof').onchange = e => house.topView(e.target.checked);

// ------------------------------------------------------------------ diálogo
function showDlg(who, text) {
  const el = $(who === 'user' ? '#dlg-user' : '#dlg-bot');
  el.querySelector('b').textContent = text;
  el.classList.add('show');
  if (who === 'user') $('#dlg-bot').classList.remove('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 9000);
}

// ------------------------------------------------------------------ micrófono del navegador
let micBuf = [], micBusy = false;
audio.onPcm = pcm => {
  micBuf.push(pcm);
  if (micBusy || micBuf.length < 2) return;
  const n = micBuf.reduce((a, b) => a + b.length, 0), all = new Int16Array(n);
  let o = 0; for (const b of micBuf) { all.set(b, o); o += b.length; }
  micBuf = [];
  micBusy = true;
  fetch('/api/mic', { method: 'POST', body: all.buffer, headers: { 'Content-Type': 'application/octet-stream' } })
    .catch(() => { }).finally(() => micBusy = false);
};
$('#btn-mic').onclick = async () => {
  const b = $('#btn-mic');
  if (audio.micOn) {
    audio.stopMic(); b.classList.remove('on'); b.textContent = '● activar micrófono';
    $('#mic-state').textContent = 'mic apagado'; pipe.set('mic', { state: '', val: '—' });
    // devolver el micrófono del host a como estaba
    if (S.hostMicPausadoPorWeb) {
      S.hostMicPausadoPorWeb = false;
      post('/voz/config', { mic_pausado: false }).then(pollVoz, () => { });
      addLog({ tipo: 'sistema', origen: 'web', timestamp: ahoraISO(), componente: 'mic', ok: true, detalle: 'mic del navegador apagado → mic del host reanudado' });
    }
    return;
  }
  try {
    // dos micrófonos escuchando = dos ciclos y dos respuestas: se pausa el del host mientras tanto
    if (S.vozOk && S.voz?.mic?.activo && !S.voz?.mic_pausado) {
      await post('/voz/config', { mic_pausado: true });
      S.hostMicPausadoPorWeb = true;
      addLog({ tipo: 'sistema', origen: 'web', timestamp: ahoraISO(), componente: 'mic', ok: true, detalle: 'mic del navegador activo → mic del host pausado (evita respuestas duplicadas)' });
      pollVoz();
    }
    await audio.startMic();
    b.classList.add('on'); b.textContent = '■ apagar micrófono';
    $('#mic-state').textContent = `navegador → KWS embebido → ${S.dest === 'servidor' ? 'servidor.py' : 'embebido'}`;
    pipe.set('mic', { state: 'active', val: 'navegador' });
    pipe.set('kws', { state: 'active', val: 'escuchando' });
  } catch (err) {
    flashErr(err);
    if (S.hostMicPausadoPorWeb) {  // no dejar el host pausado si el navegador no pudo abrir el mic
      S.hostMicPausadoPorWeb = false;
      post('/voz/config', { mic_pausado: false }).then(pollVoz, () => { });
    }
  }
};
$('#btn-ptt').onclick = async () => {
  if (!audio.micOn) await $('#btn-mic').onclick();
  post('/api/wake').catch(flashErr);
};

// ------------------------------------------------------------------ orden escrita
const QUICK = ['prendé la luz del living', 'poné la luz de la cocina al cuarenta por ciento', 'poné el aire del dormitorio en veintidós grados',
  'bajá las persianas del comedor', 'abrí la ventana de la cocina', 'prendé el ventilador de la pieza', 'qué temperatura hace en la oficina',
  'activá el riego', 'abrí el portón', 'modo cine', 'hay alguna ventana abierta', 'me voy', 'buenas noches', 'qué hora es', 'apagá todo', 'prendé la tele del baño'];
$('#quick').innerHTML = QUICK.map(q => `<button class="btn" type="button">${q}</button>`).join('');
$('#quick').onclick = e => { if (e.target.tagName === 'BUTTON') sendText(e.target.textContent); };
$('#cmd-form').onsubmit = e => { e.preventDefault(); const t = $('#cmd-input').value.trim(); if (t) { sendText(t); $('#cmd-input').select(); } };
function sendText(texto) {
  audio.ensureCtx();
  post('/api/texto', { texto, via: S.dest }).catch(flashErr);
}

// ------------------------------------------------------------------ tabs + reloj
$('#tabs').onclick = e => {
  const t = e.target.dataset.tab; if (!t) return;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#tab-live').hidden = t !== 'live'; $('#tab-qa').hidden = t !== 'qa';
  if (t === 'qa') qa.render();
};
qa.setIntents(['EncenderDispositivo', 'ApagarDispositivo', 'AjustarBrillo', 'FijarTemperatura', 'SubirPersiana', 'BajarPersiana', 'ConsultarHora',
  'AbrirVentana', 'CerrarVentana', 'TrabarPuerta', 'DestrabarPuerta', 'AbrirPorton', 'CerrarPorton', 'ActivarAlarma', 'DesactivarAlarma',
  'ActivarRiego', 'DetenerRiego', 'ConsultarTemperatura', 'ConsultarHumedad', 'ConsultarAberturas', 'ActivarEscena', 'ApagarTodo']);
setInterval(() => $('#clock').textContent = new Date().toLocaleTimeString('es-AR', { hour12: false }), 1000);

// ------------------------------------------------------------------ ruteo PipeWire (voz-local-mic / voz-local-tts)
async function pollPipewire() {
  try {
    const r = await api('/api/pipewire');
    const show = (el, n, dir, label) => {
      el.classList.remove('ok', 'warn', 'err');
      if (!r.disponible) { el.textContent = `${label} sin pw-link`; return; }
      const peers = n?.[dir] || [];
      if (!n?.existe && label === 'voz' && S.voz?.mudo) { el.textContent = 'voz: host mudo'; el.title = 'Con "host mudo" servidor.py cierra el nodo voz-local-tts'; return; }
      if (!n?.existe) { el.classList.add('err'); el.textContent = `${label}: sin nodo`; el.title = 'voz-local todavía no levantó el nodo (o no está corriendo)'; return; }
      if (!peers.length) { el.classList.add('warn'); el.textContent = `${label}: sin conectar`; el.title = 'El nodo existe pero no tiene conexiones: conectalo en qpwgraph'; return; }
      el.classList.add('ok');
      const names = peers.map(p => p.nombre).join(' + ');
      el.textContent = `${label} ${dir === 'desde' ? '←' : '→'} ${names}`;
      el.title = peers.map(p => p.nodo).join('\n');
    };
    show($('#pw-mic'), r.nodos?.['voz-local-mic'], 'desde', 'mic');
    show($('#pw-tts'), r.nodos?.['voz-local-tts'], 'hacia', 'voz');
  } catch { }
  setTimeout(pollPipewire, 3000);
}

addEventListener('pagehide', () => {
  if (S.hostMicPausadoPorWeb) navigator.sendBeacon('/voz/config', new Blob([JSON.stringify({ mic_pausado: false })], { type: 'application/json' }));
});

connect();
boot().catch(flashErr);
pollPipewire();
