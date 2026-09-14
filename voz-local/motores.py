"""Motores de voz a texto intercambiables. Se cargan bajo demanda y quedan en caché."""
import json
import re
import threading
import time
from pathlib import Path

import numpy as np
import yaml

BASE = Path(__file__).parent
MODELOS = BASE / "modelos"
SR = 16000
VOSK_ES = MODELOS / "vosk-model-small-es-0.42"

PROMPT_WHISPER = ("Prendé la luz del living. Apagá el ventilador de la pieza. "
                  "Poné el aire en 22 grados.")

# Formas con tilde que el léxico de Vosk puede tener; las ausentes se ignoran.
TILDES = {
    "prende": "prendé", "apaga": "apagá", "pone": "poné", "encende": "encendé",
    "subi": "subí", "baja": "bajá", "abri": "abrí", "cerra": "cerrá", "ajusta": "ajustá",
    "deja": "dejá", "fija": "fijá", "activa": "activá", "desactiva": "desactivá",
    "corta": "cortá", "levanta": "levantá", "bano": "baño", "habitacion": "habitación",
    "calefaccion": "calefacción", "lampara": "lámpara", "television": "televisión",
    "que": "qué", "dieciseis": "dieciséis", "veintidos": "veintidós",
    "veintitres": "veintitrés", "veintiseis": "veintiséis", "decime": "decíme",
}

CATALOGO = {
    "whisper-tiny": "Whisper tiny (CPU int8) · transcripción libre",
    "whisper-base": "Whisper base (CPU int8) · transcripción libre",
    "whisper-small": "Whisper small (CPU int8) · transcripción libre",
    "vosk": "Vosk small es · transcripción libre",
    "vosk-gramatica": "Vosk small es · vocabulario restringido a intenciones.yaml",
}


def vocabulario(ruta_yaml, numeros):
    """Palabras de todas las plantillas y listas de intenciones + números + variantes con tilde."""
    datos = yaml.safe_load(open(ruta_yaml, encoding="utf-8"))
    textos = list(datos.get("expansion_rules", {}).values())
    for intent in datos["intents"].values():
        for bloque in intent["data"]:
            textos += bloque["sentences"]
    for lista in datos.get("lists", {}).values():
        for v in lista.get("values", []):
            textos.append(v["in"] if isinstance(v, dict) else str(v))
    palabras = set(re.findall(r"[a-zñ]+", " ".join(textos).lower()))
    palabras |= set(numeros) | {"y", "por", "ciento", "grados"}
    palabras |= {TILDES[p] for p in palabras if p in TILDES}
    return sorted(palabras)


class Whisper:
    def __init__(self, tamano):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(tamano, device="cpu", compute_type="int8",
                                  download_root=str(MODELOS / "whisper"))

    def transcribir(self, audio):
        segs, _ = self.model.transcribe(audio, language="es", beam_size=1, vad_filter=False,
                                        condition_on_previous_text=False,
                                        initial_prompt=PROMPT_WHISPER)
        return " ".join(s.text.strip() for s in segs).strip()


class Vosk:
    _modelo = None  # compartido entre vosk y vosk-gramatica

    def __init__(self, gramatica=None):
        from vosk import Model, SetLogLevel
        SetLogLevel(-1)
        if Vosk._modelo is None:
            Vosk._modelo = Model(str(VOSK_ES))
        self.gramatica = json.dumps(gramatica + ["[unk]"], ensure_ascii=False) if gramatica else None

    def transcribir(self, audio):
        from vosk import KaldiRecognizer
        rec = (KaldiRecognizer(Vosk._modelo, SR, self.gramatica) if self.gramatica
               else KaldiRecognizer(Vosk._modelo, SR))
        rec.AcceptWaveform((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
        texto = json.loads(rec.FinalResult()).get("text", "")
        return re.sub(r"\s+", " ", texto.replace("[unk]", "")).strip()


class Motores:
    def __init__(self, ruta_intenciones, numeros):
        self.ruta_intenciones = ruta_intenciones
        self.numeros = numeros
        self._cache = {}
        self._locks = {n: threading.Lock() for n in CATALOGO}

    def disponibles(self):
        return [{"id": n, "descripcion": d, "cargado": n in self._cache} for n, d in CATALOGO.items()]

    def obtener(self, nombre):
        """Devuelve (motor, ms_de_carga). ms_de_carga es 0 si ya estaba cargado."""
        if nombre not in CATALOGO:
            raise ValueError(f"motor desconocido: {nombre}. Opciones: {', '.join(CATALOGO)}")
        with self._locks[nombre]:
            if nombre in self._cache:
                return self._cache[nombre], 0
            t0 = time.perf_counter()
            if nombre.startswith("whisper-"):
                motor = Whisper(nombre.split("-", 1)[1])
            elif nombre == "vosk":
                motor = Vosk()
            else:
                motor = Vosk(vocabulario(self.ruta_intenciones, self.numeros))
            self._cache[nombre] = motor
            return motor, round((time.perf_counter() - t0) * 1000)

    def recargar_gramatica(self):
        """Tras editar intenciones.yaml: descarta vosk-gramatica para regenerar el vocabulario."""
        self._cache.pop("vosk-gramatica", None)

    def transcribir(self, nombre, audio):
        motor, _ = self.obtener(nombre)
        with self._locks[nombre]:
            t0 = time.perf_counter()
            texto = motor.transcribir(audio)
            return texto, round((time.perf_counter() - t0) * 1000)
