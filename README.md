# open-source-home-assistant

Asistente de voz **100 % local y en español** para domótica, **sin LLM ni nube**, con un banco de pruebas web
que simula una casa completa para validarlo antes de instalarlo en una casa real.

```
micrófono ─▶ wake word ─▶ STT ─────────────▶ intención ─────────▶ acción ─▶ voz
            openWakeWord  Whisper / Vosk     hassil / fuzzy       HTTP     Piper
```

Todo corre en CPU con ~1–1,5 GB de RAM y latencias de cientos de milisegundos: una cadena de modelos chicos
y deterministas en lugar de un modelo de lenguaje generativo. El fundamento está en [`docs/`](docs/).

## Estructura

| carpeta | qué es |
|---|---|
| [`voz-local/`](voz-local/) | El asistente: pipeline de voz, motores STT e intención intercambiables, API HTTP de control, nodos PipeWire (`voz-local-mic` / `voz-local-tts`). Contrato con la web en [`CONTRATO.md`](voz-local/CONTRATO.md). |
| [`web-app-assistant/`](web-app-assistant/) | Simulador web: casa 3D (Three.js) con ~30 dispositivos, sensores y automatizaciones; visualiza cada etapa del pipeline en vivo y compara motores (matriz STT × intención). |
| [`docs/`](docs/) | Investigación: arquitectura de voz en el borde y alternativas livianas a los LLM. |

## Inicio rápido

Requiere Linux, Python 3.10+, `ffmpeg`, `alsa-utils` y, opcionalmente, PipeWire para rutear el audio.

```bash
git clone https://github.com/EasyIndustry/open-source-home-assistant.git
cd open-source-home-assistant/voz-local
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./descargar_modelos.sh                     # ~800 MB de modelos, no se versionan

cd ../web-app-assistant
./run.sh                                   # asistente con micrófono + simulador → http://localhost:8765
./run.sh --sin-mic                         # usar el micrófono del navegador
```

Decí **"hey Jarvis"** (o la wake word elegida en la web) y una orden: *"prendé la luz del living"*,
*"poné el aire del dormitorio en 22 grados"*, *"modo cine"*, *"hay alguna ventana abierta"*.
Sin micrófono, escribí la orden en la barra inferior de la web.

## Qué se puede probar en el simulador

- **Pipeline en vivo:** score del wake word, grabación, transcripción, intención con slots resaltados, dispositivos afectados y latencia de cada etapa contra el objetivo (< 600 ms).
- **Casa 3D:** luces, persianas y ventanas motorizadas, portón, aire, ventiladores, teles, riego, cerradura y alarma; satélites de micrófono por ambiente.
- **Automatizaciones:** inyectar humo, fugas, movimiento o humedad y ver las reglas actuar.
- **QA de motores:** grabar una frase, sintetizarla con Piper o correr el autotest contra todas las combinaciones de STT × intención.
- **Audio real:** en `qpwgraph` se conectan los nodos `voz-local-mic` y `voz-local-tts` al micrófono y a los parlantes que quieras.

Detalles de cada parte en [`voz-local/README.md`](voz-local/README.md) y [`web-app-assistant/README.md`](web-app-assistant/README.md).

## Licencia

El código de este repositorio se publica bajo la [licencia MIT](LICENSE).

### Licencias de terceros

Las dependencias y los modelos **no están incluidos en el repo**: se instalan con `pip` y `descargar_modelos.sh`,
y cada uno conserva su propia licencia. Tres de ellos tienen condiciones a tener en cuenta:

| componente | licencia | nota |
|---|---|---|
| faster-whisper, CTranslate2, onnxruntime, rapidfuzz, PyYAML, Three.js, modelos Whisper | MIT | — |
| hassil, openWakeWord (código), Vosk y su modelo `small-es-0.42` | Apache-2.0 | — |
| numpy, scipy, scikit-learn, joblib | BSD | — |
| **piper-tts** | **GPL-3.0** | Quien distribuya el conjunto armado con Piper debe cumplir la GPL. |
| **Voz `es_AR-daniela-high`** | dataset **CC BY-SA 4.0** ([OpenSLR 61](https://www.openslr.org/61/)) | Requiere atribución; los derivados de la voz se comparten con la misma licencia. |
| **Wake words pre-entrenadas de openWakeWord** (`hey_jarvis`, `alexa`, …) | **CC BY-NC-SA 4.0** | **Uso no comercial.** Para un uso comercial, entrená una wake word propia (`voz-local/entrenar-wakeword/`). |
