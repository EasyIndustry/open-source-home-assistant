# voz-local — Asistente de voz local en español, sin LLM

Cadena modular que corre 100% local en CPU:
**wake word (openWakeWord) → STT (Whisper / Vosk) → intención (hassil) → acción → voz (Piper)**,
orquestada con nodos PipeWire y expuesta por una API HTTP para la web de simulación.

Sin nube, sin LLM, ~1–1,5 GB de RAM. Pensado para domótica en español rioplatense.

## Instalación
Requiere **Python 3.10+**, `ffmpeg`, `alsa-utils` (y PipeWire para el ruteo de audio).
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./descargar_modelos.sh          # baja Piper es_AR, Vosk y Whisper base (~800 MB, no van al repo)
```

## Uso
```bash
# Un comando por texto (sin micrófono)
.venv/bin/python asistente.py --texto "prendé la luz del living"

# Micrófono: decí "hey jarvis" (o alexa) y después la orden
.venv/bin/python asistente.py

# API HTTP para la web (motor/wake en caliente, QA)
.venv/bin/python servidor.py            # + micrófono
.venv/bin/python servidor.py --sin-mic  # solo API

# Benchmark de motores (STT × intent)
.venv/bin/python asistente.py --autotest --casos casos-prueba.yaml \
  --comparar whisper-base,vosk-gramatica --comparar-intent hassil,hassil-fuzzy
```

## Componentes intercambiables
- **STT:** `whisper-tiny/base/small`, `vosk`, `vosk-gramatica` (Vosk limitado al vocabulario de las intenciones).
- **Intención:** `hassil` (determinista), `hassil-fuzzy` (corrige errores del STT). `intent-ml` (clasificador entrenado) es experimental, solo por CLI/API.
- **Wake word:** `hey_jarvis` (default), `alexa`, `hey_mycroft`, `hey_rhasspy`. Entrenar una propia: ver `entrenar-wakeword/`.

## Archivos
- `asistente.py` — cadena de voz y modos CLI.
- `servidor.py` — API HTTP de control (contrato en `CONTRATO.md`).
- `motores.py` — motores STT.
- `intent_ml.py` — motor de intención experimental (clasificador).
- `intenciones.yaml` — gramática de comandos (fuente de verdad).
- `casos-prueba.yaml` — set de QA; ver `PULIR-INTENTS.md` para mejorar los intents.
- `CONTRATO.md` — API y eventos hacia la web. `HARDWARE.md` — opciones de PC.
- `entrenar-wakeword/` — andamiaje para entrenar wake words (a futuro).

## No se versiona
`.venv/` y `modelos/` (los baja `descargar_modelos.sh`). El clasificador `modelos/intent_clf_*.joblib`
se regenera solo desde `intenciones.yaml`.
