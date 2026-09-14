#!/usr/bin/env python3
"""Simulador web de casa domótica para el asistente de voz local.

Correr con el venv de voz-local (trae hassil, faster-whisper, openwakeword y piper):

    ../voz-local/.venv/bin/python server.py            # http://localhost:8765

Entradas:
  POST /eventos      telemetría del asistente externo (voz-local/CONTRATO.md)
  POST /acciones     tool call del asistente externo -> aplica a la casa -> {"respuesta"}
  POST /api/texto    orden escrita, procesada por el motor embebido o por asistente.py
  POST /api/mic      audio PCM int16 16 kHz del navegador (wake word + VAD + STT)
  POST /api/wake     fuerza la escucha (push-to-talk, sin wake word)
  POST /api/dispositivo   cambio manual desde la maqueta 3D
  POST /api/simular  inyecta eventos de sensores (humo, fuga, movimiento...)
  POST /api/satelite área donde está el micrófono (área por defecto de las órdenes)
  *    /voz/...      proxy a la API de control de voz-local/servidor.py ($VOZ_URL, CONTRATO.md §3)
Salidas:
  GET  /api/stream   SSE con todos los eventos
  GET  /api/estado   snapshot de la casa
  GET  /api/tts/<id>.wav  respuesta sintetizada por el motor embebido
"""
import copy
import datetime
import io
import json
import math
import os
import queue
import random
import sys
import threading
import time
import uuid
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
VOZ_LOCAL = Path(os.environ.get("VOZ_LOCAL", BASE.parent / "voz-local")).resolve()
PUERTO = int(os.environ.get("PUERTO", "8765"))
INTENCIONES = Path(os.environ.get("INTENCIONES", BASE / "intenciones-casa.yaml"))
MODELO_STT = os.environ.get("MODELO_STT", "base")
WAKE = os.environ.get("WAKE", "hey_jarvis")  # inicial; se cambia en caliente con /api/destino {wake}
UMBRAL_WAKE = float(os.environ.get("UMBRAL_WAKE", "0.5"))
VOZ_URL = os.environ.get("VOZ_URL", "http://127.0.0.1:8766").rstrip("/")  # voz-local/servidor.py

sys.path.insert(0, str(VOZ_LOCAL))


def ahora():
    return datetime.datetime.now().isoformat(timespec="milliseconds")


# ---------------------------------------------------------------- bus de eventos
class Bus:
    def __init__(self):
        self.clientes = []
        self.lock = threading.Lock()
        self.historial = []

    def publicar(self, tipo, origen="sim", **datos):
        ev = {"tipo": tipo, "origen": origen, "timestamp": datos.pop("timestamp", None) or ahora(), **datos}
        if tipo not in ("mic", "sensores", "motores"):
            self.historial = (self.historial + [ev])[-200:]
        linea = json.dumps(ev, ensure_ascii=False)
        with self.lock:
            for q in self.clientes:
                try:
                    q.put_nowait(linea)
                except queue.Full:
                    pass
        return ev

    def suscribir(self):
        q = queue.Queue(maxsize=500)
        with self.lock:
            self.clientes.append(q)
        return q

    def desuscribir(self, q):
        with self.lock:
            if q in self.clientes:
                self.clientes.remove(q)


bus = Bus()

# ---------------------------------------------------------------- modelo de la casa
AREAS = ["living", "cocina", "comedor", "dormitorio", "bano", "oficina", "patio"]
NOMBRE_AREA = {"living": "el living", "cocina": "la cocina", "comedor": "el comedor",
               "dormitorio": "el dormitorio", "bano": "el baño", "patio": "el patio",
               "oficina": "la oficina"}
ARTICULO = {"luz": "la luz", "ventilador": "el ventilador", "aire": "el aire",
            "tele": "la tele", "enchufe": "el enchufe"}


def _dispositivos():
    d = {}

    def add(tipo, area, **estado):
        did = f"{tipo}.{area}"
        d[did] = {"id": did, "tipo": tipo, "area": area, **estado}

    for a in AREAS:
        add("luz", a, on=False, brillo=100)
    for a in ["living", "comedor", "dormitorio", "oficina"]:
        add("persiana", a, pos=100, objetivo=100)
    for a in ["living", "cocina", "dormitorio", "bano", "oficina"]:
        add("ventana", a, pos=0, objetivo=0)
    for a in ["living", "dormitorio", "oficina"]:
        add("aire", a, on=False, setpoint=24)
    for a in ["dormitorio", "bano", "comedor"]:
        add("ventilador", a, on=False)
    for a in ["living", "dormitorio"]:
        add("tele", a, on=False)
    for a in ["cocina", "oficina"]:
        add("enchufe", a, on=False, w=0)
    add("cerradura", "living", trabada=True)
    add("porton", "patio", pos=0, objetivo=0)
    add("riego", "patio", on=False)
    add("alarma", "casa", armada=False, disparada=False, causa=None)
    return d


def _sensores():
    s = {}
    for a in AREAS:
        base = 14.0 if a == "patio" else 21.5 + random.uniform(-1, 1)
        s[a] = {"temp": round(base, 1), "hum": 45 if a != "bano" else 60,
                "mov": False, "lux": 300}
    s["cocina"].update(humo=False, agua=False, co2=520)
    s["bano"].update(agua=False)
    s["patio"].update(suelo=38)
    s["exterior"] = {"temp": 14.0, "hum": 70, "lux": 12000}
    return s


class Casa:
    def __init__(self):
        self.lock = threading.RLock()
        self.dispositivos = _dispositivos()
        self.sensores = _sensores()
        self.satelite = "living"
        self.hora_inicio = time.time()

    def snapshot(self):
        with self.lock:
            return {"dispositivos": copy.deepcopy(self.dispositivos),
                    "sensores": copy.deepcopy(self.sensores),
                    "satelite": self.satelite, "areas": AREAS}

    def set(self, did, origen="sim", motivo=None, **cambios):
        with self.lock:
            dev = self.dispositivos.get(did)
            if not dev:
                return None
            antes = {k: dev.get(k) for k in cambios}
            dev.update(cambios)
            if dev["tipo"] == "enchufe":
                dev["w"] = random.randint(600, 1400) if dev["on"] else 0
            despues = copy.deepcopy(dev)
        if antes != {k: despues.get(k) for k in cambios}:
            bus.publicar("dispositivo", origen=origen, id=did, antes=antes, estado=despues, motivo=motivo)
        return despues

    def de_tipo(self, tipo, area=None):
        return [d for d in self.dispositivos.values()
                if d["tipo"] == tipo and (area is None or d["area"] == area)]


casa = Casa()


# ---------------------------------------------------------------- acciones (tool calls)
def _en_area(area):
    return f" en {NOMBRE_AREA.get(area, area)}" if area else ""


def aplicar_accion(intent, slots, origen):
    """Ejecuta la intención sobre la casa. Devuelve (respuesta, ids_afectados)."""
    s = dict(slots or {})
    area = s.get("area")
    area_ef = area or casa.satelite
    tag = f"intent:{intent}"
    afectados = []

    def fijar(did, **c):
        if casa.set(did, origen=origen, motivo=tag, **c) is not None:
            afectados.append(did)

    if intent in ("EncenderDispositivo", "ApagarDispositivo"):
        on = intent == "EncenderDispositivo"
        tipo = s.get("dispositivo", "luz")
        devs = casa.de_tipo(tipo, area_ef)
        if not devs:
            donde = [d["area"] for d in casa.de_tipo(tipo)]
            return (f"No hay {ARTICULO.get(tipo, tipo).split(' ', 1)[1]} en {NOMBRE_AREA.get(area_ef, area_ef)}. "
                    f"Hay en: {', '.join(donde)}."), afectados
        for d in devs:
            fijar(d["id"], on=on)
        verbo = "prendí" if on else "apagué"
        return f"Listo, {verbo} {ARTICULO.get(tipo, tipo)}{_en_area(area_ef)}.", afectados

    if intent == "AjustarBrillo":
        b = int(s.get("brillo", 100))
        fijar(f"luz.{area_ef}", on=b > 0, brillo=max(b, 1))
        return f"Luz{_en_area(area_ef)} al {b} por ciento.", afectados

    if intent == "FijarTemperatura":
        t = int(s["temperatura"])
        devs = casa.de_tipo("aire", area_ef)
        if not devs:
            return f"No hay aire en {NOMBRE_AREA[area_ef]}.", afectados
        fijar(devs[0]["id"], on=True, setpoint=t)
        return f"Temperatura{_en_area(area_ef)} en {t} grados.", afectados

    if intent in ("SubirPersiana", "BajarPersiana"):
        obj = 100 if intent == "SubirPersiana" else 0
        devs = casa.de_tipo("persiana", area) if area else casa.de_tipo("persiana", area_ef)
        if not devs:
            return f"No hay persianas en {NOMBRE_AREA[area_ef]}.", afectados
        for d in devs:
            fijar(d["id"], objetivo=obj)
        return f"{'Subiendo' if obj else 'Bajando'} la persiana{_en_area(area_ef)}.", afectados

    if intent in ("AbrirVentana", "CerrarVentana"):
        obj = 100 if intent == "AbrirVentana" else 0
        devs = casa.de_tipo("ventana", area_ef)
        if not devs:
            return f"No hay ventanas motorizadas en {NOMBRE_AREA[area_ef]}.", afectados
        fijar(devs[0]["id"], objetivo=obj)
        return f"{'Abriendo' if obj else 'Cerrando'} la ventana{_en_area(area_ef)}.", afectados

    if intent in ("TrabarPuerta", "DestrabarPuerta"):
        trabada = intent == "TrabarPuerta"
        fijar("cerradura.living", trabada=trabada)
        return f"Puerta principal {'trabada' if trabada else 'destrabada'}.", afectados

    if intent in ("AbrirPorton", "CerrarPorton"):
        obj = 100 if intent == "AbrirPorton" else 0
        fijar("porton.patio", objetivo=obj)
        return f"{'Abriendo' if obj else 'Cerrando'} el portón.", afectados

    if intent in ("ActivarAlarma", "DesactivarAlarma"):
        armar = intent == "ActivarAlarma"
        if armar:
            abiertas = [d["area"] for d in casa.de_tipo("ventana") if d["objetivo"] > 0]
            fijar("alarma.casa", armada=True, disparada=False, causa=None)
            if abiertas:
                return f"Alarma armada, pero hay ventanas abiertas en: {', '.join(abiertas)}.", afectados
            return "Alarma armada.", afectados
        fijar("alarma.casa", armada=False, disparada=False, causa=None)
        return "Alarma desactivada.", afectados

    if intent in ("ActivarRiego", "DetenerRiego"):
        on = intent == "ActivarRiego"
        fijar("riego.patio", on=on)
        return ("Riego del patio activado." if on else "Riego detenido."), afectados

    if intent in ("ConsultarTemperatura", "ConsultarHumedad"):
        clave = "temp" if intent == "ConsultarTemperatura" else "hum"
        sen = casa.sensores.get(area_ef, {})
        ext = casa.sensores["exterior"][clave]
        v = sen.get(clave)
        if clave == "temp":
            return f"En {NOMBRE_AREA[area_ef]} hay {round(v)} grados. Afuera {round(ext)}.", afectados
        return f"La humedad en {NOMBRE_AREA[area_ef]} es de {round(v)} por ciento.", afectados

    if intent == "ConsultarAberturas":
        abiertas = [f"ventana del {d['area']}" for d in casa.de_tipo("ventana") if d["pos"] > 0]
        if casa.dispositivos["porton.patio"]["pos"] > 0:
            abiertas.append("el portón")
        if not casa.dispositivos["cerradura.living"]["trabada"]:
            abiertas.append("la puerta principal sin trabar")
        return ("Todo cerrado." if not abiertas else "Quedó abierto: " + ", ".join(abiertas) + "."), afectados

    if intent == "ApagarTodo":
        for d in casa.dispositivos.values():
            if d["tipo"] in ("luz", "tele", "ventilador", "enchufe") and d["on"]:
                fijar(d["id"], on=False)
        return f"Apagué {len(afectados)} dispositivos.", afectados

    if intent == "ActivarEscena":
        return escena(s.get("escena"), fijar), afectados

    if intent == "ConsultarHora":
        return f"Son las {datetime.datetime.now():%H:%M}.", afectados

    return None, afectados


def escena(nombre, fijar):
    if nombre == "noche":
        for d in casa.de_tipo("luz"):
            fijar(d["id"], on=d["area"] in ("dormitorio", "patio"), brillo=10 if d["area"] == "dormitorio" else 60)
        for d in casa.de_tipo("persiana"):
            fijar(d["id"], objetivo=0)
        for d in casa.de_tipo("tele"):
            fijar(d["id"], on=False)
        fijar("cerradura.living", trabada=True)
        return "Modo noche: persianas abajo, puerta trabada, velador al diez por ciento."
    if nombre == "cine":
        fijar("luz.living", on=True, brillo=15)
        fijar("persiana.living", objetivo=0)
        fijar("tele.living", on=True)
        return "Modo cine en el living."
    if nombre == "fuera":
        for d in casa.dispositivos.values():
            if d["tipo"] in ("luz", "tele", "ventilador", "enchufe", "aire"):
                fijar(d["id"], on=False)
            if d["tipo"] in ("ventana", "porton"):
                fijar(d["id"], objetivo=0)
        fijar("cerradura.living", trabada=True)
        fijar("alarma.casa", armada=True, disparada=False, causa=None)
        return "Modo fuera: todo apagado, aberturas cerradas y alarma armada."
    if nombre == "dia":
        for d in casa.de_tipo("persiana"):
            fijar(d["id"], objetivo=100)
        fijar("alarma.casa", armada=False, disparada=False, causa=None)
        fijar("luz.patio", on=False)
        fijar("luz.dormitorio", on=False)
        return "Buen día. Subí las persianas y desarmé la alarma."
    return "No conozco esa escena."


# ---------------------------------------------------------------- simulación física + reglas
class Simulador(threading.Thread):
    daemon = True

    def run(self):
        tick = 0
        while True:
            time.sleep(0.25)
            tick += 1
            self.motores()
            if motor.fase == "orden" and time.time() - motor.ultimo_audio > 2.5:
                bus.publicar("orden", origen="web", duracion_s=0, hubo_voz=False, nota="sin audio del micrófono")
                motor._reset()
            if tick % 8 == 0:
                self.sensores()
                self.reglas()

    def motores(self):
        cambios = []
        with casa.lock:
            for d in casa.dispositivos.values():
                if "objetivo" in d and d["pos"] != d["objetivo"]:
                    paso = 4 if d["tipo"] == "porton" else 6
                    delta = max(-paso, min(paso, d["objetivo"] - d["pos"]))
                    d["pos"] += delta
                    cambios.append({"id": d["id"], "pos": d["pos"], "objetivo": d["objetivo"]})
        if cambios:
            bus.publicar("motores", cambios=cambios)

    def sensores(self):
        with casa.lock:
            ext = casa.sensores["exterior"]
            h = datetime.datetime.now().hour + datetime.datetime.now().minute / 60
            sol = max(0.0, math.sin((h - 6.5) / 13 * math.pi))
            ext["lux"] = round(15000 * sol + 2)
            ext["temp"] = round(ext["temp"] + (12 + 8 * sol - ext["temp"]) * 0.05 + random.uniform(-.05, .05), 2)
            for a in AREAS:
                s = casa.sensores[a]
                if a == "patio":
                    s["temp"], s["lux"] = ext["temp"], ext["lux"]
                    riego = casa.dispositivos["riego.patio"]["on"]
                    s["suelo"] = round(min(95, s["suelo"] + 1.5) if riego else max(10, s["suelo"] - 0.05), 1)
                else:
                    aire = next(iter(casa.de_tipo("aire", a)), None)
                    ventana = next(iter(casa.de_tipo("ventana", a)), None)
                    obj = 21.5
                    k = 0.02
                    if aire and aire["on"]:
                        obj, k = aire["setpoint"], 0.08
                    if ventana and ventana["pos"] > 0:
                        obj, k = (obj + ext["temp"]) / 2, k + 0.03 * ventana["pos"] / 100
                    s["temp"] = round(s["temp"] + (obj - s["temp"]) * k + random.uniform(-.04, .04), 2)
                    hum_obj = 55 if a != "bano" else 62
                    s["hum"] = round(s["hum"] + (hum_obj - s["hum"]) * 0.03 + random.uniform(-.3, .3), 1)
                    per = next(iter(casa.de_tipo("persiana", a)), None)
                    apertura = per["pos"] / 100 if per else 0.6
                    luz = casa.dispositivos[f"luz.{a}"]
                    s["lux"] = round(ext["lux"] * 0.03 * apertura + (luz["brillo"] * 3 if luz["on"] else 0))
                # con la alarma armada la casa está vacía: el movimiento solo se inyecta desde la web
                prob = 0.0 if casa.dispositivos["alarma.casa"]["armada"] else 0.04
                if s.get("mov_forzado"):
                    s["mov"] = True
                    s["mov_forzado"] = max(0, s["mov_forzado"] - 1)
                elif random.random() < prob:
                    s["mov"] = True
                elif s["mov"] and random.random() < 0.5:
                    s["mov"] = False
            coc = casa.sensores["cocina"]
            coc["co2"] = round(coc["co2"] + (480 + (0 if casa.dispositivos["ventana.cocina"]["pos"] else 250) - coc["co2"]) * 0.05)
            snap = copy.deepcopy(casa.sensores)
            enchufes = {d["id"]: d["w"] for d in casa.de_tipo("enchufe")}
        bus.publicar("sensores", sensores=snap, potencia=enchufes)

    def reglas(self):
        s = casa.sensores
        alarma = casa.dispositivos["alarma.casa"]
        if s["cocina"].get("humo") and not alarma["disparada"]:
            bus.publicar("regla", nombre="humo_cocina", detalle="Humo en cocina: sirena + abrir ventana cocina")
            casa.set("alarma.casa", motivo="regla:humo_cocina", disparada=True, causa="humo")
            casa.set("ventana.cocina", motivo="regla:humo_cocina", objetivo=100)
        for a in ("cocina", "bano"):
            if s[a].get("agua") and not alarma["disparada"]:
                bus.publicar("regla", nombre="fuga_agua", detalle=f"Fuga de agua en {a}: sirena")
                casa.set("alarma.casa", motivo="regla:fuga_agua", disparada=True, causa=f"agua {a}")
        if alarma["armada"] and not alarma["disparada"]:
            for a in AREAS:
                if s[a]["mov"]:
                    bus.publicar("regla", nombre="intrusion", detalle=f"Movimiento en {a} con alarma armada")
                    casa.set("alarma.casa", motivo="regla:intrusion", disparada=True, causa=f"movimiento {a}")
                    break
        for aire in casa.de_tipo("aire"):
            ventana = next(iter(casa.de_tipo("ventana", aire["area"])), None)
            if aire["on"] and ventana and ventana["pos"] >= 30:
                bus.publicar("regla", nombre="ahorro_aire", detalle=f"Ventana abierta en {aire['area']}: se apaga el aire")
                casa.set(aire["id"], motivo="regla:ahorro_aire", on=False)
        vb = casa.dispositivos["ventilador.bano"]
        if s["bano"]["hum"] > 75 and not vb["on"]:
            bus.publicar("regla", nombre="extractor_bano", detalle="Humedad > 75% en baño: extractor on")
            casa.set("ventilador.bano", motivo="regla:extractor_bano", on=True)
        if s["patio"]["suelo"] >= 90 and casa.dispositivos["riego.patio"]["on"]:
            bus.publicar("regla", nombre="riego_completo", detalle="Suelo saturado: se corta el riego")
            casa.set("riego.patio", motivo="regla:riego_completo", on=False)
        if s["patio"]["mov"] and s["exterior"]["lux"] < 50 and not casa.dispositivos["luz.patio"]["on"]:
            bus.publicar("regla", nombre="luz_patio_mov", detalle="Movimiento nocturno en patio: luz patio")
            casa.set("luz.patio", motivo="regla:luz_patio_mov", on=True)


# ---------------------------------------------------------------- motor embebido (pipeline en el server)
class VozPiper:
    """Piper directo (independiente de la clase Voz de voz-local, que cambia de firma)."""

    def __init__(self, modelo):
        from piper import PiperVoice
        self.voz = PiperVoice.load(str(modelo))
        self.sr = self.voz.config.sample_rate

    def sintetizar(self, texto):
        import numpy as np
        partes = [c.audio_int16_array for c in self.voz.synthesize(texto)]
        return np.concatenate(partes) if partes else np.zeros(0, np.int16)


class Motor:
    """Reutiliza las clases de voz-local/asistente.py y emite los mismos eventos del contrato."""

    def __init__(self):
        self.listo = {"nlu": False, "tts": False, "stt": False, "kws": False}
        self.intenciones = self.voz = self.stt = self.ww = None
        self.audios = {}
        self.lock = threading.Lock()
        self.fase = "reposo"      # reposo | orden | procesando
        self.buffer = None
        self.rec = None
        self.pend = []
        self.ultimo_audio = 0
        self.wake = WAKE
        self.destino = "web"       # web (motor embebido) | servidor (voz-local/servidor.py)
        self.motor_stt = None      # motor de servidor.py (None = el que tenga configurado)
        self.tts_navegador = False     # False: habla servidor.py por su nodo voz-local-tts
        self.lock_mic = threading.Lock()
        self.lock_tts = threading.Lock()

    def cargar(self):
        import numpy as np  # noqa
        import asistente
        self.a = asistente
        pasos = [
            ("nlu", lambda: asistente.Intenciones(INTENCIONES)),
            ("tts", lambda: VozPiper(VOZ_LOCAL / "modelos" / "es_AR-daniela-high.onnx")),
            ("kws", self._cargar_kws),
            ("stt", self._cargar_stt),
        ]
        for clave, f in pasos:
            t0 = time.perf_counter()
            try:
                obj = f()
                setattr(self, {"nlu": "intenciones", "tts": "voz", "kws": "ww", "stt": "stt"}[clave], obj)
                self.listo[clave] = True
                bus.publicar("sistema", componente=clave, ok=True, ms=round((time.perf_counter() - t0) * 1000))
            except Exception as e:
                bus.publicar("sistema", componente=clave, ok=False, error=str(e))
        bus.publicar("estado", origen="web", estado="escuchando")

    def _cargar_stt(self):
        try:  # voz-local >= motores.py
            from motores import Whisper
            return Whisper(MODELO_STT)
        except ImportError:
            return self.a.Transcriptor(MODELO_STT, "cpu")

    def _cargar_kws(self):
        from openwakeword.model import Model
        return Model(wakeword_models=[self.wake], inference_framework="onnx")

    def cambiar_wake(self, wake):
        """Recarga el modelo de openWakeWord del micrófono del navegador."""
        if wake == self.wake and self.ww:
            return
        from openwakeword.model import Model
        t0 = time.perf_counter()
        modelo = Model(wakeword_models=[wake], inference_framework="onnx")
        with self.lock_mic:
            self.ww, self.wake = modelo, wake
        bus.publicar("sistema", componente="kws", ok=True, wake=wake, ms=round((time.perf_counter() - t0) * 1000))

    # --- texto -> intención -> acción -> voz
    def procesar_texto(self, texto, origen="web", t_stt=None):
        import numpy as np
        if not self.intenciones:
            bus.publicar("sistema", componente="nlu", ok=False, error="NLU no cargado")
            return
        t0 = time.perf_counter()
        norm = self.a.normalizar(texto)
        from hassil import recognize
        r = recognize(norm, self.intenciones.intents, language="es")
        ms = round((time.perf_counter() - t0) * 1000, 2)
        if r:
            slots, spans = {}, {}
            for k, e in r.entities.items():
                v = e.value
                slots[k] = int(v) if isinstance(v, float) and v.is_integer() else v
                spans[k] = e.text
            bus.publicar("intent", origen=origen, texto=texto, texto_normalizado=norm, intent=r.intent.name,
                         slots=slots, spans=spans, ms=ms, area_satelite=casa.satelite)
            respuesta, afectados = aplicar_accion(r.intent.name, slots, origen)
            if respuesta is None:
                respuesta = self.intenciones.responder({"intent": r.intent.name, "slots": slots})
        else:
            bus.publicar("intent", origen=origen, texto=texto, texto_normalizado=norm, intent=None,
                         slots={}, spans={}, ms=ms, area_satelite=casa.satelite)
            respuesta, afectados = self.intenciones.respuestas["_no_entendido"], []
        bus.publicar("respuesta", origen=origen, texto=respuesta, entendido=r is not None, afectados=afectados)
        self.sintetizar(respuesta, origen)

    def sintetizar(self, respuesta, origen):
        import numpy as np
        if self.voz and respuesta and self.tts_navegador:
            t0 = time.perf_counter()
            with self.lock_tts:
                audio = self.voz.sintetizar(respuesta)
            aid = uuid.uuid4().hex[:10]
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(self.voz.sr)
                w.writeframes(np.asarray(audio, np.int16).tobytes())
            self.audios[aid] = buf.getvalue()
            if len(self.audios) > 30:
                self.audios.pop(next(iter(self.audios)))
            bus.publicar("tts", origen=origen, ms=round((time.perf_counter() - t0) * 1000),
                         audio=f"/api/tts/{aid}.wav", duracion_s=round(len(audio) / self.voz.sr, 2))

    # --- audio del navegador
    def forzar_escucha(self, motivo="ptt"):
        with self.lock:
            if self.fase != "reposo":
                return False
            self.fase = "orden"
            self.ultimo_audio = time.time()
            self.rec = {"trozos": [], "ruido": [], "hablo": False, "silencio": 0, "i": 0, "t0": time.perf_counter()}
        bus.publicar("wake", origen="web", palabra=motivo, score=1.0)
        return True

    def mic(self, pcm_bytes):
        with self.lock_mic:
            self.ultimo_audio = time.time()
            return self._mic(pcm_bytes)

    def _mic(self, pcm_bytes):
        import numpy as np
        if not self.listo["kws"]:
            return {"fase": self.fase, "scores": [], "error": "kws no cargado"}
        self.pend.append(np.frombuffer(pcm_bytes, np.int16))
        datos = np.concatenate(self.pend)
        n = len(datos) // 1280
        self.pend = [datos[n * 1280:]]
        scores, rms = [], []
        for i in range(n):
            chunk = datos[i * 1280:(i + 1) * 1280]
            r = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)))
            rms.append(round(r))
            with self.lock:
                fase = self.fase
            if fase == "reposo":
                sc = float(self.ww.predict(chunk)[self.wake])
                scores.append(round(sc, 3))
                if sc >= UMBRAL_WAKE:
                    with self.lock:
                        self.fase = "orden"
                        self.rec = {"trozos": [], "ruido": [], "hablo": False, "silencio": 0, "i": 0,
                                    "t0": time.perf_counter()}
                    bus.publicar("wake", origen="web", palabra=self.wake, score=round(sc, 3))
            elif fase == "orden":
                scores.append(None)
                self._grabar(chunk, r)
            else:
                scores.append(None)
        bus.publicar("mic", origen="web", scores=scores, rms=rms, fase=self.fase, umbral=UMBRAL_WAKE)
        return {"fase": self.fase, "scores": scores}

    def _grabar(self, chunk, rms):
        """Misma lógica que Asistente.grabar_orden pero incremental."""
        import numpy as np
        rec = self.rec
        rec["trozos"].append(chunk)
        i = rec["i"]
        rec["i"] += 1
        fin = False
        if i < 3:
            rec["ruido"].append(rms)
            return
        umbral = max(float(np.mean(rec["ruido"])) * 3.0, 250)
        if rms > umbral:
            rec["hablo"], rec["silencio"] = True, 0
        elif rec["hablo"]:
            rec["silencio"] += 1
            fin = rec["silencio"] >= 10
        elif i > int(3 * 16000 / 1280):
            fin = True
        if i >= int(7 * 16000 / 1280):
            fin = True
        if fin:
            self.fase = "procesando"
            dur = round(len(rec["trozos"]) * 1280 / 16000, 2)
            bus.publicar("orden", origen="web", duracion_s=dur, hubo_voz=rec["hablo"])
            if rec["hablo"]:
                audio = (np.concatenate(rec["trozos"]) / 32768).astype(np.float32)
                threading.Thread(target=self._cerrar_ciclo, args=(audio,), daemon=True).start()
            else:
                self._reset()

    def via_servidor_texto(self, texto):
        code, data, _ = proxy_voz("POST", "/texto", json.dumps({"texto": texto, "hablar": not self.tts_navegador}).encode(),
                                  "application/json")
        self._resultado_servidor(code, data)

    def _resultado_servidor(self, code, data):
        try:
            r = json.loads(data or b"{}")
        except json.JSONDecodeError:
            r = {"error": data[:200].decode(errors="replace")}
        if code != 200:
            bus.publicar("sistema", componente="servidor.py", ok=False, error=r.get("error", code))
            return
        self.sintetizar(r.get("respuesta"), "web")

    def _cerrar_ciclo(self, audio):
        try:
            if self.destino == "servidor":
                import numpy as np
                buf = io.BytesIO()
                with wave.open(buf, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
                ruta = f"/audio?hablar={0 if self.tts_navegador else 1}" + (f"&motor={self.motor_stt}" if self.motor_stt else "")
                code, data, _ = proxy_voz("POST", ruta, buf.getvalue(), "audio/wav")
                self._resultado_servidor(code, data)
            elif self.stt:
                t0 = time.perf_counter()
                texto = self.stt.transcribir(audio)
                bus.publicar("stt", origen="web", texto=texto, modelo=MODELO_STT,
                             ms=round((time.perf_counter() - t0) * 1000))
                self.procesar_texto(texto)
            else:
                bus.publicar("sistema", componente="stt", ok=False, error="whisper todavía cargando")
        finally:
            self._reset()

    def _reset(self):
        with self.lock:
            self.fase = "reposo"
            self.rec = None
            if self.ww:
                self.ww.reset()
        bus.publicar("estado", origen="web", estado="escuchando")


motor = Motor()


def proxy_voz(metodo, ruta, cuerpo, content_type):
    """Reenvía a servidor.py. Devuelve (código, bytes, content-type)."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(VOZ_URL + ruta, data=cuerpo if metodo == "POST" else None, method=metodo,
                                 headers={"Content-Type": content_type or "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")
    except Exception as e:
        return 502, json.dumps({"error": f"servidor.py no responde en {VOZ_URL}: {e}"}).encode(), "application/json"


_descripciones = {}


def ruteo_pipewire():
    """Conexiones de los nodos voz-local-* según pw-link -l (el usuario los conecta en qpwgraph)."""
    import shutil
    import subprocess
    if not shutil.which("pw-link"):
        return {"disponible": False}
    try:
        salida = subprocess.run(["pw-link", "-l"], capture_output=True, text=True, timeout=2).stdout
        puertos = subprocess.run(["pw-link", "-io"], capture_output=True, text=True, timeout=2).stdout
    except Exception as e:
        return {"disponible": False, "error": str(e)}
    nodos = {n: {"existe": False, "desde": set(), "hacia": set()} for n in ("voz-local-mic", "voz-local-tts")}
    for linea in puertos.splitlines():
        nodo = linea.strip().rsplit(":", 1)[0]
        if nodo in nodos:
            nodos[nodo]["existe"] = True
    actual = None
    for linea in salida.splitlines():
        if not linea.startswith(" "):
            actual = linea.strip().rsplit(":", 1)[0]
            continue
        flecha, par = linea.strip()[:3], linea.strip()[3:].strip().rsplit(":", 1)[0]
        if actual in nodos:
            nodos[actual]["existe"] = True
            nodos[actual]["desde" if flecha == "|<-" else "hacia"].add(par)
    faltan = {p for n in nodos.values() for p in n["desde"] | n["hacia"]} - set(_descripciones)
    if faltan:
        try:
            for obj in json.loads(subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=3).stdout):
                props = obj.get("info", {}).get("props", {}) if isinstance(obj.get("info"), dict) else {}
                if "node.name" in props:
                    _descripciones[props["node.name"]] = props.get("node.description") or props.get("node.nick") or props["node.name"]
        except Exception:
            pass
    for n in nodos.values():
        for k in ("desde", "hacia"):
            n[k] = [{"nodo": p, "nombre": _descripciones.get(p, p)} for p in sorted(n[k])]
    return {"disponible": True, "nodos": nodos}


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(BASE / "static"), **kw)

    def log_message(self, fmt, *args):
        linea = str(args[0] if args else "")
        ruidoso = "/api/mic" in linea or "/api/pipewire" in linea or ("/eventos" in linea and " 204 " in f" {args[1] if len(args) > 1 else ''} ")
        if not ruidoso:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _vacio(self, code=204):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _proxy(self, metodo):
        cuerpo = self._body() if metodo == "POST" else None
        code, data, ctype = proxy_voz(metodo, self.path[len("/voz"):], cuerpo, self.headers.get("Content-Type"))
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        ruta = urlparse(self.path).path
        if ruta.startswith("/voz/"):
            return self._proxy("GET")
        if ruta == "/api/stream":
            return self._stream()
        if ruta == "/api/estado":
            return self._json({**casa.snapshot(), "motor": motor.listo, "fase": motor.fase,
                               "historial": bus.historial[-80:], "wake": motor.wake, "umbral": UMBRAL_WAKE,
                               "modelo_stt": MODELO_STT, "intenciones": INTENCIONES.name, "voz_url": VOZ_URL,
                               "destino": motor.destino, "motor_servidor": motor.motor_stt})
        if ruta == "/api/pipewire":
            return self._json(ruteo_pipewire())
        if ruta.startswith("/api/tts/"):
            aid = ruta.rsplit("/", 1)[-1].removesuffix(".wav")
            data = motor.audios.get(aid)
            if not data:
                return self._vacio(404)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        return super().do_GET()

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = bus.suscribir()
        try:
            self.wfile.write(b": ok\n\n")
            self.wfile.flush()
            while True:
                try:
                    linea = q.get(timeout=15)
                    self.wfile.write(f"data: {linea}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            bus.desuscribir(q)

    def do_POST(self):
        ruta = urlparse(self.path).path
        if ruta.startswith("/voz/"):
            return self._proxy("POST")
        raw = self._body()
        if ruta == "/api/mic":
            return self._json(motor.mic(raw))
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "json inválido"}, 400)

        if ruta == "/eventos":  # contrato §2
            tipo = data.pop("tipo", "desconocido")
            if "origen" in data:  # mic|front|texto|wav del asistente
                data["fuente"] = data.pop("origen")
            bus.publicar(tipo, origen="asistente", **data)
            return self._vacio(204)

        if ruta == "/acciones":  # contrato §1
            bus.publicar("accion", origen="asistente",
                         **{("fuente" if k == "origen" else k): v for k, v in data.items() if k != "timestamp"})
            respuesta, afectados = aplicar_accion(data.get("intent"), data.get("slots"), "asistente")
            bus.publicar("respuesta_sim", origen="asistente", texto=respuesta, afectados=afectados)
            return self._json({"respuesta": respuesta} if respuesta else {})

        if ruta == "/api/texto":
            texto = (data.get("texto") or "").strip()
            if not texto:
                return self._json({"error": "texto vacío"}, 400)
            destino = motor.via_servidor_texto if data.get("via") == "servidor" else motor.procesar_texto
            threading.Thread(target=destino, args=(texto,), daemon=True).start()
            return self._json({"ok": True})

        if ruta == "/api/destino":
            if data.get("destino") in ("web", "servidor"):
                motor.destino = data["destino"]
            if "motor" in data:
                motor.motor_stt = data["motor"] or None
            if data.get("wake"):
                try:
                    motor.cambiar_wake(data["wake"])
                except Exception as e:
                    return self._json({"error": f"wake word inválida: {e}"}, 400)
            if "tts_navegador" in data:
                motor.tts_navegador = bool(data["tts_navegador"])
            bus.publicar("sistema", componente="destino", ok=True, destino=motor.destino, motor=motor.motor_stt)
            return self._json({"destino": motor.destino, "motor": motor.motor_stt, "tts_navegador": motor.tts_navegador,
                               "wake": motor.wake})

        if ruta == "/api/wake":
            return self._json({"ok": motor.forzar_escucha()})

        if ruta == "/api/satelite":
            if data.get("area") in AREAS:
                casa.satelite = data["area"]
                bus.publicar("satelite", area=casa.satelite)
            return self._json({"satelite": casa.satelite})

        if ruta == "/api/dispositivo":
            did = data.pop("id", None)
            dev = casa.set(did, origen="manual", motivo="ui", **data)
            return self._json(dev or {"error": "no existe"}, 200 if dev else 404)

        if ruta == "/api/simular":
            area, clave, valor = data.get("area"), data.get("sensor"), data.get("valor")
            with casa.lock:
                if area in casa.sensores and clave == "mov":
                    casa.sensores[area]["mov_forzado"] = 3 if valor else 0
                    casa.sensores[area]["mov"] = bool(valor)
                elif area in casa.sensores and clave:
                    casa.sensores[area][clave] = valor
            if data.get("resetear_alarma"):
                casa.set("alarma.casa", origen="manual", disparada=False, causa=None)
            bus.publicar("simulacion", area=area, sensor=clave, valor=valor)
            return self._json({"ok": True})

        return self._json({"error": "ruta desconocida"}, 404)


def main():
    Simulador().start()
    threading.Thread(target=motor.cargar, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PUERTO), Handler)
    srv.daemon_threads = True
    print(f"Simulador en http://localhost:{PUERTO}  (voz-local: {VOZ_LOCAL})", flush=True)
    print(f"API de voz (proxy /voz): {VOZ_URL}", flush=True)
    print(f"Asistente externo: EVENTOS_URL=http://localhost:{PUERTO}/eventos "
          f"ACCIONES_URL=http://localhost:{PUERTO}/acciones", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
