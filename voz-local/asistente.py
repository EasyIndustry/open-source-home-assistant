#!/usr/bin/env python3
"""Asistente de voz local sin LLM.

Pipeline: openWakeWord -> STT (Whisper o Vosk, ver motores.py) -> hassil (intenciones) -> acción -> Piper TTS.

Modos:
  python asistente.py                     micrófono en loop (decí "hey jarvis" y la orden)
  python asistente.py --texto "prendé la luz del living"
  python asistente.py --wav orden.wav
  python asistente.py --autotest [--comparar whisper-base,vosk-gramatica]
  python servidor.py                      API HTTP para el front (motor/wake en caliente, QA)

Acciones: cada intención se imprime como JSON. Si ACCIONES_URL está definida se hace
POST de ese JSON; si la respuesta trae {"respuesta": "..."} se usa como texto hablado.
Si EVENTOS_URL está definida se hace POST (sin bloquear) de cada evento del pipeline:
wake, orden, stt, intent, respuesta, tts, estado, config, qa. Contrato completo en CONTRATO.md.
"""
import argparse
import datetime
import json
import os
import queue
import re
import subprocess
import threading
import time
import unicodedata
import urllib.request
import wave
from pathlib import Path

import numpy as np
import yaml

BASE = Path(__file__).parent
MODELOS = BASE / "modelos"
SR = 16000
CHUNK = 1280  # 80 ms, lo que espera openWakeWord

NUMEROS = {
    "cero": 0, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6,
    "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12, "trece": 13,
    "catorce": 14, "quince": 15, "dieciseis": 16, "diecisiete": 17, "dieciocho": 18,
    "diecinueve": 19, "veinte": 20, "veintiuno": 21, "veintidos": 22, "veintitres": 23,
    "veinticuatro": 24, "veinticinco": 25, "veintiseis": 26, "veintisiete": 27,
    "veintiocho": 28, "veintinueve": 29, "treinta": 30, "cuarenta": 40, "cincuenta": 50,
    "sesenta": 60, "setenta": 70, "ochenta": 80, "noventa": 90, "cien": 100,
}
ARTICULO = {"luz": "la luz", "ventilador": "el ventilador", "aire": "el aire",
            "tele": "la tele", "enchufe": "el enchufe"}
NOMBRE_AREA = {"living": "el living", "cocina": "la cocina", "comedor": "el comedor",
               "dormitorio": "el dormitorio", "bano": "el baño", "patio": "el patio",
               "oficina": "la oficina"}


def log(etapa, msg, t0=None):
    extra = f" ({(time.perf_counter() - t0) * 1000:.0f} ms)" if t0 else ""
    print(f"[{etapa}] {msg}{extra}", flush=True)


def emitir(tipo, **datos):
    """Evento de observabilidad para la web. Fire-and-forget en un hilo."""
    url = os.environ.get("EVENTOS_URL")
    if not url:
        return
    evento = {"tipo": tipo, **datos, "timestamp": datetime.datetime.now().isoformat(timespec="milliseconds")}

    def enviar():
        try:
            req = urllib.request.Request(url, data=json.dumps(evento).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=2).close()
        except Exception:
            pass
    hilo = threading.Thread(target=enviar, daemon=True)
    hilo.start()
    _ENVIOS.append(hilo)


_ENVIOS = []


def normalizar(texto):
    t = unicodedata.normalize("NFD", texto.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^\w%\s]", " ", t)
    # "treinta y cinco" -> 35, "veintidos" -> 22
    t = re.sub(r"\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa) y "
               r"(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b",
               lambda m: str(NUMEROS[m[1]] + NUMEROS[m[2]]), t)
    t = re.sub(r"\b(" + "|".join(NUMEROS) + r")\b", lambda m: str(NUMEROS[m[1]]), t)
    return re.sub(r"\s+", " ", t).strip()


# Motores de intent expuestos al front (los que aparecen en /estado.motores_intent).
MOTORES_INTENT = {
    "hassil": "hassil · gramática declarativa, determinista (default)",
    "hassil-fuzzy": "hassil + corrección difusa del texto (tolera errores del STT)",
}
# Motores de intent solo-infraestructura: usables por CLI/API para experimentar,
# NO se listan en el front (a retomar en otra sesión). Se cargan perezosamente.
MOTORES_INTENT_INFRA = {
    "intent-ml": "clasificador entrenado (TF-IDF + LogReg) desde intenciones.yaml [experimental]",
}
MOTORES_INTENT_TODOS = {**MOTORES_INTENT, **MOTORES_INTENT_INFRA}


class Intenciones:
    def __init__(self, ruta, numeros=None):
        from hassil import Intents
        from motores import vocabulario
        self.ruta = ruta
        self.numeros = numeros or {}
        datos = yaml.safe_load(open(ruta, encoding="utf-8"))
        self.respuestas = datos.pop("respuestas", {})
        self.intents = Intents.from_dict(datos)
        # vocabulario normalizado para la corrección difusa (formas que hassil reconoce)
        crudo = vocabulario(ruta, numeros or {}) if numeros is not None else []
        self.vocab = sorted({p for w in crudo for p in normalizar(w).split() if p})
        self.vocab_set = set(self.vocab)
        self._ml = None  # MotorIntentML perezoso (solo si se pide intent-ml)

    def _motor_ml(self):
        if self._ml is None:
            from intent_ml import MotorIntentML
            self._ml = MotorIntentML(self.ruta, self.numeros)
        return self._ml

    def _corregir_difuso(self, texto, umbral=75):
        """Acerca cada palabra al vocabulario conocido (RapidFuzz). Corrige errores del STT."""
        from rapidfuzz import process, fuzz
        if not self.vocab:
            return texto
        salida = []
        for palabra in texto.split():
            if palabra.isdigit() or palabra in self.vocab_set or len(palabra) <= 2:
                salida.append(palabra)
                continue
            m = process.extractOne(palabra, self.vocab, scorer=fuzz.ratio, score_cutoff=umbral)
            salida.append(m[0] if m else palabra)
        return " ".join(salida)

    def reconocer(self, texto, motor="hassil"):
        from hassil import recognize
        if motor == "intent-ml":
            return self._motor_ml().reconocer(texto)
        norm = normalizar(texto)
        if motor == "hassil-fuzzy":
            norm = self._corregir_difuso(norm)
        r = recognize(norm, self.intents, language="es")
        if not r:
            return None
        slots = {}
        for k, e in r.entities.items():
            v = e.value
            slots[k] = int(v) if isinstance(v, float) and v.is_integer() else v
        return {"intent": r.intent.name, "slots": slots}

    def responder(self, accion):
        if not accion:
            return self.respuestas.get("_no_entendido", "No te entendí.")
        s = dict(accion["slots"])
        area = s.get("area")
        s["en_area"] = f" en {NOMBRE_AREA.get(area, area)}" if area else ""
        if "dispositivo" in s:
            s["dispositivo"] = ARTICULO.get(s["dispositivo"], s["dispositivo"])
        s["hora"] = datetime.datetime.now().strftime("%H:%M")
        plantilla = self.respuestas.get(accion["intent"])
        if not plantilla:  # intent sin respuesta local (ej. YAML externo): confirmación genérica
            return "Listo."
        try:
            return plantilla.format(**s)
        except (KeyError, IndexError):
            return "Listo."


def ejecutar(accion, texto):
    """Punto de integración con dispositivos reales o la simulación web."""
    evento = {"texto": texto, **(accion or {"intent": None, "slots": {}}),
              "timestamp": datetime.datetime.now().isoformat(timespec="seconds")}
    print("ACCION " + json.dumps(evento, ensure_ascii=False), flush=True)
    url = os.environ.get("ACCIONES_URL")
    if not url or not accion:
        return None
    try:
        req = urllib.request.Request(url, data=json.dumps(evento).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            cuerpo = resp.read()
        return (json.loads(cuerpo) if cuerpo else {}).get("respuesta")
    except Exception as e:  # la simulación puede no estar levantada
        log("accion", f"POST a {url} falló: {e}")
        return None


OUT_SR = 48000  # frecuencia fija del nodo de salida (nodo PipeWire estable)


def hay_pipewire():
    import shutil
    return shutil.which("pw-link") is not None


def props_pipewire(nombre, descripcion, autoconectar=True):
    """Variable de entorno PIPEWIRE_PROPS para nombrar el nodo en qpwgraph.

    Sin media.class: el plugin ALSA de PipeWire ya la fija bien y crea los puertos.
    Fijarla a mano (p. ej. "Stream/Input") deja el nodo SIN puertos.
    """
    auto = "" if autoconectar else " node.autoconnect = false"
    return {"PIPEWIRE_PROPS": f'{{ node.name = "{nombre}" node.description = "{descripcion}" '
                              f'application.name = "voz-local"{auto} }}'}


def _remuestrear(audio_int16, sr_origen, sr_destino):
    if sr_origen == sr_destino:
        return audio_int16
    from scipy.signal import resample_poly
    from math import gcd
    g = gcd(sr_origen, sr_destino)
    return resample_poly(audio_int16.astype(np.float32), sr_destino // g, sr_origen // g).astype(np.int16)


class Reproductor:
    """Un único proceso aplay abierto todo el tiempo, para que el nodo PipeWire sea estable.

    Se escribe PCM int16 mono a OUT_SR por stdin, así qpwgraph conserva las conexiones
    manuales entre respuestas (abrir un aplay por frase haría aparecer/desaparecer el nodo).
    """
    def __init__(self, backend="alsa", dispositivo=None, autoconectar=True):
        self.backend = backend
        self.dispositivo = dispositivo
        self.autoconectar = autoconectar
        self.proc = None
        self.lock = threading.Lock()

    def _asegurar(self):
        if self.proc and self.proc.poll() is None:
            return
        cmd = ["aplay", "-q", "-f", "S16_LE", "-r", str(OUT_SR), "-c", "1", "-t", "raw"]
        env = dict(os.environ)
        if self.backend == "pipewire":
            cmd[1:1] = ["-D", "pipewire"]
            env.update(props_pipewire("voz-local-tts", "Asistente · voz", self.autoconectar))
        elif self.dispositivo:
            cmd[1:1] = ["-D", self.dispositivo]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

    def reproducir(self, audio_int16, sr):
        pcm = _remuestrear(audio_int16, sr, OUT_SR)
        with self.lock:
            try:
                self._asegurar()
                self.proc.stdin.write(pcm.tobytes())
                self.proc.stdin.write(np.zeros(int(OUT_SR * 0.1), np.int16).tobytes())  # colita de silencio
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                log("audio", f"reproductor cayó, se reabre en la próxima ({e})")
                self.proc = None

    def pitido(self):
        t = np.arange(int(OUT_SR * 0.12)) / OUT_SR
        self.reproducir((np.sin(2 * np.pi * 880 * t) * 0.3 * 32767).astype(np.int16), OUT_SR)

    def abrir(self):
        """Pre-abre el nodo de salida (solo PipeWire) para poder rutearlo en qpwgraph antes de hablar.

        En ALSA no se pre-abre para no retener la placa mientras no se habla.
        """
        if self.backend != "pipewire":
            return
        with self.lock:
            try:
                self._asegurar()
            except OSError as e:
                log("audio", f"no se pudo pre-abrir el nodo de voz ({e})")

    def cerrar(self):
        with self.lock:
            if self.proc:
                self.proc.terminate()
                try:  # reapear para que no quede zombie
                    self.proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=1)
                self.proc = None


class Voz:
    def __init__(self, modelo, reproductor):
        from piper import PiperVoice
        self.voz = PiperVoice.load(str(modelo))
        self.sr = self.voz.config.sample_rate
        self.reproductor = reproductor

    def sintetizar(self, texto):
        """Devuelve audio int16 a la frecuencia de la voz."""
        partes = [c.audio_int16_array for c in self.voz.synthesize(texto)]
        return np.concatenate(partes) if partes else np.zeros(0, np.int16)

    def hablar(self, texto):
        self.reproductor.reproducir(self.sintetizar(texto), self.sr)


FRASES_AUTOTEST = [
    ("Prendé la luz del living", "EncenderDispositivo", {"dispositivo": "luz", "area": "living"}),
    ("Apagá el ventilador de la pieza", "ApagarDispositivo", {"dispositivo": "ventilador", "area": "dormitorio"}),
    ("Poné la luz de la cocina al cuarenta por ciento", "AjustarBrillo", {"area": "cocina", "brillo": 40}),
    ("Poné el aire del dormitorio en veintidós grados", "FijarTemperatura", {"area": "dormitorio", "temperatura": 22}),
    ("Bajá las persianas del comedor", "BajarPersiana", {"area": "comedor"}),
    ("Subí la persiana del living", "SubirPersiana", {"area": "living"}),
    ("Prendé la tele", "EncenderDispositivo", {"dispositivo": "tele"}),
    ("Qué hora es", "ConsultarHora", {}),
]
WAKE_WORDS = ["hey_jarvis", "alexa", "hey_mycroft", "hey_rhasspy"]


class Asistente:
    def __init__(self, args):
        from motores import Motores
        t0 = time.perf_counter()
        self.args = args
        self.ruta_intenciones = Path(getattr(args, "intenciones", None) or BASE / "intenciones.yaml")
        self.intenciones = Intenciones(self.ruta_intenciones, NUMEROS)
        self.motor_intent = getattr(args, "motor_intent", "hassil")
        self.audio_backend = args.audio if args.audio != "auto" else ("pipewire" if hay_pipewire() else "alsa")
        self.autoconectar = not getattr(args, "no_autoconectar", False)
        self.reproductor = Reproductor(self.audio_backend, args.mic, self.autoconectar)
        self.voz = Voz(MODELOS / args.voz, self.reproductor)
        self.motores = Motores(self.ruta_intenciones, NUMEROS)
        self.motor = args.motor
        self.wake = args.wake
        self.umbral = args.umbral
        self.mudo = args.mudo
        self.mic_pausado = False
        self.forzar_escucha = False  # push-to-talk desde el front
        self.lock = threading.Lock()  # un ciclo de pipeline a la vez
        disp = "pipewire (voz-local-mic)" if self.audio_backend == "pipewire" else (args.mic or "default")
        self.mic = {"activo": False, "dispositivo": disp, "error": None}
        if not self.mudo:  # pre-abre voz-local-tts para poder rutearlo antes de la primera respuesta
            self.reproductor.abrir()
        log("carga", f"intenciones + voz (audio: {self.audio_backend})", t0)

    # --- configuración en caliente ---
    def estado(self):
        return {"motor": self.motor, "motores": self.motores.disponibles(), "wake": self.wake,
                "wake_words": WAKE_WORDS, "umbral": self.umbral, "mudo": self.mudo,
                "mic_pausado": self.mic_pausado, "mic": dict(self.mic),
                "motor_intent": self.motor_intent,
                "motores_intent": [{"id": k, "descripcion": v} for k, v in MOTORES_INTENT.items()],
                "audio": {"backend": self.audio_backend, "autoconectar": self.autoconectar,
                          "nodo_mic": "voz-local-mic", "nodo_tts": "voz-local-tts"}}

    def configurar(self, motor=None, wake=None, umbral=None, mudo=None, mic_pausado=None,
                   motor_intent=None):
        if motor is not None:
            _, carga = self.motores.obtener(motor)  # valida y precarga
            self.motor = motor
            log("config", f"motor {motor} (carga {carga} ms)")
        if motor_intent is not None:
            if motor_intent not in MOTORES_INTENT_TODOS:
                raise ValueError(f"motor de intent desconocido: {motor_intent}. "
                                 f"Opciones: {', '.join(MOTORES_INTENT_TODOS)}")
            self.motor_intent = motor_intent
            log("config", f"motor_intent {motor_intent}")
        if wake is not None:
            if wake not in WAKE_WORDS:
                raise ValueError(f"wake word desconocida: {wake}. Opciones: {', '.join(WAKE_WORDS)}")
            self.wake = wake
        if umbral is not None:
            self.umbral = float(umbral)
        if mudo is not None:
            self.mudo = bool(mudo)
            self.reproductor.cerrar() if self.mudo else self.reproductor.abrir()
        if mic_pausado is not None:
            self.mic_pausado = bool(mic_pausado)
        estado = self.estado()
        emitir("config", **{k: v for k, v in estado.items()
                            if k not in ("motores", "wake_words", "motores_intent")})
        return estado

    def recargar_intenciones(self):
        self.intenciones = Intenciones(self.ruta_intenciones, NUMEROS)
        self.motores.recargar_gramatica()

    # --- pipeline ---
    def procesar_texto(self, texto, hablar=True, origen="texto"):
        t0 = time.perf_counter()
        ts = datetime.datetime.now().isoformat(timespec="milliseconds")
        accion = self.intenciones.reconocer(texto, self.motor_intent)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        log("nlu", json.dumps(accion, ensure_ascii=False), t0)
        emitir("intent", texto=texto, texto_normalizado=normalizar(texto), ms=ms, origen=origen,
               motor_intent=self.motor_intent, **(accion or {"intent": None, "slots": {}}))
        respuesta = ejecutar(accion, texto) or self.intenciones.responder(accion)
        log("respuesta", respuesta)
        emitir("respuesta", texto=respuesta, entendido=accion is not None, origen=origen)
        if hablar and not self.mudo:
            t0 = time.perf_counter()
            self.voz.hablar(respuesta)
            log("tts", "reproducido", t0)
            emitir("tts", ms=round((time.perf_counter() - t0) * 1000), origen=origen)
        return {"accion": accion, "respuesta": respuesta, "nlu_ms": ms, "timestamp": ts}

    def procesar_audio(self, audio, hablar=True, motor=None, origen="mic"):
        motor = motor or self.motor
        texto, ms = self.motores.transcribir(motor, audio)
        log("stt", f"[{motor}] {texto!r} ({ms} ms)")
        emitir("stt", texto=texto, motor=motor, ms=ms, origen=origen)
        return {"motor": motor, "texto": texto, "stt_ms": ms,
                **self.procesar_texto(texto, hablar, origen)}

    # --- QA ---
    def comparar(self, audio, motores, esperado=None, slots=None, motores_intent=None):
        """Mismo audio por cada motor STT × cada motor de intent. No ejecuta acciones.

        Cada STT transcribe una sola vez (tiempo justo); ese texto se prueba con cada
        motor de intent. `motores_intent` omitido = solo el motor de intent activo.
        """
        motores_intent = motores_intent or [self.motor_intent]
        resultados = []
        for m in motores:
            _, carga = self.motores.obtener(m)
            texto, ms = self.motores.transcribir(m, audio)
            for mi in motores_intent:
                t0 = time.perf_counter()
                accion = self.intenciones.reconocer(texto, mi)
                intent_ms = round((time.perf_counter() - t0) * 1000, 1)
                acierto = None
                if esperado is not None:
                    acierto = bool(accion) and accion["intent"] == esperado and (
                        slots is None or accion["slots"] == slots)
                resultados.append({"motor": m, "motor_intent": mi, "texto": texto, "stt_ms": ms,
                                   "intent_ms": intent_ms, "carga_ms": carga,
                                   "accion": accion, "acierto": acierto})
                log("qa", f"[{m} · {mi}] {texto!r} -> {accion and accion['intent']} "
                          f"({ms}+{intent_ms} ms)"
                          + ("" if acierto is None else (" OK" if acierto else " FALLO")))
        emitir("qa", resultados=resultados, esperado=esperado, slots_esperados=slots)
        return resultados

    def audio_de_frase(self, frase):
        from scipy.signal import resample_poly
        audio = resample_poly(self.voz.sintetizar(frase).astype(np.float32), SR, self.voz.sr)
        return (audio / 32768).astype(np.float32)

    def autotest(self, motores, frases=None, motores_intent=None):
        motores_intent = motores_intent or [self.motor_intent]
        combo = len(motores_intent) > 1  # con >1 motor de intent, el resumen es matriz STT×intent
        filas = []
        for frase, esperado, slots in (frases or FRASES_AUTOTEST):
            filas.append({"frase": frase, "esperado": esperado, "slots_esperados": slots,
                          "resultados": self.comparar(self.audio_de_frase(frase), motores,
                                                       esperado, slots, motores_intent)})
        resumen = {}
        for m in motores:
            for mi in motores_intent:
                rs = [r for f in filas for r in f["resultados"]
                      if r["motor"] == m and r["motor_intent"] == mi]
                clave = f"{m} · {mi}" if combo else m
                resumen[clave] = {"aciertos": sum(bool(r["acierto"]) for r in rs), "total": len(rs),
                                  "stt_ms_promedio": round(sum(r["stt_ms"] for r in rs) / len(rs)),
                                  "intent_ms_promedio": round(sum(r["intent_ms"] for r in rs) / len(rs), 1)}
        return {"filas": filas, "resumen": resumen}

    # --- modos CLI ---
    def modo_wav(self, ruta):
        with wave.open(ruta) as w:
            sr, datos = w.getframerate(), w.readframes(w.getnframes())
            canales = w.getnchannels()
        audio = np.frombuffer(datos, np.int16).reshape(-1, canales).mean(axis=1)
        if sr != SR:
            from scipy.signal import resample_poly
            audio = resample_poly(audio, SR, sr)
        self.procesar_audio((audio / 32768).astype(np.float32), origen="wav")

    def modo_autotest(self, motores, motores_intent=None, frases=None):
        r = self.autotest(motores, frases=frases, motores_intent=motores_intent)
        ancho = max((len(k) for k in r["resumen"]), default=18)
        print(f"\n{'motor':<{ancho}}  aciertos  stt_ms  intent_ms")
        for m, v in r["resumen"].items():
            print(f"{m:<{ancho}}  {v['aciertos']}/{v['total']:<6}  {v['stt_ms_promedio']:<6}  {v['intent_ms_promedio']}")

    def _abrir_arecord(self):
        """Lanza arecord y un hilo lector. Devuelve (proc, cola) o (None, None) si falla al abrir."""
        cola = queue.Queue()
        cmd = ["arecord", "-f", "S16_LE", "-r", str(SR), "-c", "1", "-t", "raw"]
        env = dict(os.environ)
        if self.audio_backend == "pipewire":
            cmd[1:1] = ["-D", "pipewire"]
            env.update(props_pipewire("voz-local-mic", "Asistente · micrófono", self.autoconectar))
        elif self.args.mic:
            cmd[1:1] = ["-D", self.args.mic]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        except FileNotFoundError:
            self._mic_falla("no se encontró 'arecord' (instalá alsa-utils)")
            return None, None

        def leer():
            while True:
                b = proc.stdout.read(CHUNK * 2)
                if not b:
                    break
                cola.put(np.frombuffer(b, np.int16))
            cola.put(None)  # centinela: arecord terminó
        threading.Thread(target=leer, daemon=True).start()
        return proc, cola

    def _mic_falla(self, error):
        self.mic.update(activo=False, error=error)
        log("mic", f"ERROR: {error}")
        emitir("sistema", componente="mic", ok=False, error=error, dispositivo=self.mic["dispositivo"])

    def modo_microfono(self, detener=None):
        """Loop de micrófono con supervisión de arecord (reintenta cada 2 s si se cae)."""
        from openwakeword.model import Model
        self.motores.obtener(self.motor)
        wake_cargada, ww = None, None

        def vaciar(cola):
            while not cola.empty():
                try:
                    cola.get_nowait()
                except queue.Empty:
                    break

        while not (detener and detener.is_set()):
            proc, cola = self._abrir_arecord()
            if proc is None:
                time.sleep(2)
                continue
            # el primer chunk confirma que arecord realmente abrió el dispositivo
            try:
                primero = cola.get(timeout=2)
            except queue.Empty:
                primero = None
            if primero is None:
                err = (proc.stderr.read().decode(errors="replace").strip().splitlines() or ["arecord no entregó audio"])[-1]
                self._mic_falla(err)
                proc.terminate()
                time.sleep(2)
                continue

            self.mic.update(activo=True, error=None)
            log("mic", f"micrófono OK ({self.mic['dispositivo']})")
            emitir("sistema", componente="mic", ok=True, dispositivo=self.mic["dispositivo"])
            emitir("estado", estado="escuchando")
            pendiente = primero  # el chunk ya leído se procesa primero
            buf_scores, buf_rms = [], []

            try:
                while not (detener and detener.is_set()):
                    if wake_cargada != self.wake:
                        ww = Model(wakeword_models=[self.wake], inference_framework="onnx")
                        wake_cargada = self.wake
                        log("mic", f"escuchando... decí '{self.wake.replace('_', ' ')}' (Ctrl+C para salir)")
                    if pendiente is not None:
                        chunk, pendiente = pendiente, None
                    else:
                        try:
                            chunk = cola.get(timeout=0.5)
                        except queue.Empty:
                            continue
                    if chunk is None:  # arecord se cayó
                        self._mic_falla("arecord terminó inesperadamente")
                        break
                    if self.mic_pausado:
                        continue
                    if self.forzar_escucha:
                        self.forzar_escucha = False
                        log("wake", "push-to-talk")
                        emitir("wake", palabra="push-to-talk", score=1.0)
                    else:
                        score = float(ww.predict(chunk)[self.wake])
                        rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)))
                        buf_scores.append(round(score, 3))
                        buf_rms.append(round(rms))
                        if len(buf_scores) >= 5:  # ~400 ms
                            emitir("mic", scores=buf_scores, rms=buf_rms, fase="reposo", umbral=self.umbral)
                            buf_scores, buf_rms = [], []
                        if score < self.umbral:
                            continue
                        log("wake", f"detectado (score {score:.2f})")
                        emitir("wake", palabra=self.wake, score=round(score, 3))
                    if buf_rms:  # descargar telemetría parcial antes de grabar
                        emitir("mic", scores=buf_scores, rms=buf_rms, fase="reposo", umbral=self.umbral)
                        buf_scores, buf_rms = [], []
                    if not self.mudo:
                        self.reproductor.pitido()
                    vaciar(cola)
                    audio = self.grabar_orden(cola)
                    if audio is None:
                        log("mic", "no se escuchó ninguna orden")
                        emitir("orden", duracion_s=0, hubo_voz=False)
                    else:
                        emitir("mic", scores=None, rms=[], fase="procesando", umbral=self.umbral)
                        with self.lock:
                            self.procesar_audio(audio, origen="mic")
                    vaciar(cola)
                    ww.reset()
                    emitir("estado", estado="escuchando")
            except KeyboardInterrupt:
                self.mic["activo"] = False
                proc.terminate()
                return
            finally:
                proc.terminate()
            self.mic["activo"] = False
            if not (detener and detener.is_set()):
                time.sleep(2)  # antes de reintentar abrir el micrófono

    def grabar_orden(self, cola):
        """Graba hasta 0.8 s de silencio tras hablar. Umbral de energía adaptativo.

        Emite telemetría `mic` con fase="orden" (score en null) agrupada cada ~400 ms.
        """
        t0 = time.perf_counter()
        trozos, ruido, hablo, silencio = [], [], False, 0
        buf_rms = []
        max_chunks, espera_max = int(7 * SR / CHUNK), int(3 * SR / CHUNK)
        for i in range(max_chunks):
            c = cola.get()
            if c is None:  # arecord se cayó mientras grabábamos
                return None
            trozos.append(c)
            rms = float(np.sqrt(np.mean(c.astype(np.float32) ** 2)))
            buf_rms.append(round(rms))
            if len(buf_rms) >= 5:
                emitir("mic", scores=None, rms=buf_rms, fase="orden", umbral=self.umbral)
                buf_rms = []
            if i < 3:  # primeros 240 ms: estimar ruido de fondo
                ruido.append(rms)
                continue
            umbral = max(np.mean(ruido) * self.args.sensibilidad, 250)
            if rms > umbral:
                hablo, silencio = True, 0
            elif hablo:
                silencio += 1
                if silencio >= 10:
                    break
            elif i > espera_max:
                if buf_rms:
                    emitir("mic", scores=None, rms=buf_rms, fase="orden", umbral=self.umbral)
                return None
        if buf_rms:
            emitir("mic", scores=None, rms=buf_rms, fase="orden", umbral=self.umbral)
        log("mic", f"orden grabada {len(trozos) * CHUNK / SR:.1f} s", t0)
        emitir("orden", duracion_s=round(len(trozos) * CHUNK / SR, 2), hubo_voz=hablo)
        return (np.concatenate(trozos) / 32768).astype(np.float32) if hablo else None


def crear_parser():
    from motores import CATALOGO
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--texto")
    p.add_argument("--wav")
    p.add_argument("--autotest", action="store_true")
    p.add_argument("--casos", help="YAML de casos de prueba para --autotest (ej: casos-prueba.yaml)")
    p.add_argument("--comparar", default="whisper-base,vosk,vosk-gramatica",
                   help="motores STT para --autotest, separados por coma")
    p.add_argument("--comparar-intent", default=None,
                   help="motores de intent para --autotest (coma), ej: hassil,hassil-fuzzy,intent-ml")
    p.add_argument("--motor", default="whisper-base", choices=list(CATALOGO))
    p.add_argument("--motor-intent", default="hassil", choices=list(MOTORES_INTENT_TODOS),
                   help="motor de extracción de intención (intent-ml es experimental, no va al front)")
    p.add_argument("--voz", default="es_AR-daniela-high.onnx")
    p.add_argument("--intenciones", help="ruta a un YAML de intenciones (default: voz-local/intenciones.yaml)")
    p.add_argument("--wake", default="hey_jarvis", choices=WAKE_WORDS)
    p.add_argument("--umbral", type=float, default=0.5, help="umbral wake word 0-1")
    p.add_argument("--sensibilidad", type=float, default=3.0, help="multiplicador de ruido para detectar voz")
    p.add_argument("--mic", help="dispositivo ALSA, ej: plughw:3,0 (ver arecord -l); solo con --audio alsa")
    p.add_argument("--audio", default="auto", choices=["auto", "pipewire", "alsa"],
                   help="backend de audio (auto: pipewire si hay pw-link, si no alsa)")
    p.add_argument("--no-autoconectar", action="store_true",
                   help="no dejar que WirePlumber autoconecte los nodos voz-local-mic/tts")
    p.add_argument("--mudo", action="store_true", help="no reproducir audio")
    return p


def main():
    args = crear_parser().parse_args()
    a = Asistente(args)
    if args.texto:
        a.procesar_texto(args.texto)
    elif args.wav:
        a.modo_wav(args.wav)
    elif args.autotest:
        frases = None
        if args.casos:
            frases = [tuple(c) for c in yaml.safe_load(open(args.casos, encoding="utf-8"))["casos"]]
        a.modo_autotest(args.comparar.split(","),
                        args.comparar_intent.split(",") if args.comparar_intent else None,
                        frases)
    else:
        a.modo_microfono()
    for hilo in _ENVIOS:  # no perder los últimos eventos al salir
        hilo.join(timeout=2)


if __name__ == "__main__":
    main()
