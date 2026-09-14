# Contrato asistente de voz ↔ simulador web

Proceso Python local, **sin Docker, sin MQTT y sin WebSocket**. Dos direcciones:
- **Asistente → web** (secciones 1 y 2): POST salientes a `ACCIONES_URL` y `EVENTOS_URL`.
- **Web → asistente** (sección 3): API de control en `servidor.py` (default `http://127.0.0.1:8766`, CORS abierto).

```bash
cd voz-local
EVENTOS_URL=http://localhost:8765/eventos ACCIONES_URL=http://localhost:8765/acciones \
  .venv/bin/python servidor.py --puerto 8766        # API + micrófono ("hey jarvis")
  .venv/bin/python servidor.py --sin-mic --mudo     # solo API, sin audio local
  .venv/bin/python servidor.py --intenciones otro.yaml   # usar otro set de intenciones
```

`timestamp` (ISO con ms) en las respuestas de `/texto` y `/audio` correlaciona con los eventos del mismo ciclo.
El YAML de intenciones puede omitir la sección `respuestas`: si un intent no tiene plantilla local, el asistente responde "Listo." (o usa lo que devuelva `/acciones`).

## 1. `POST $ACCIONES_URL` — ejecución de la herramienta (síncrono, timeout 3 s)
Se llama solo cuando se reconoció una intención.
```json
{"texto": "Poné el aire del dormitorio en 22 grados.",
 "intent": "FijarTemperatura",
 "slots": {"area": "dormitorio", "temperatura": 22},
 "timestamp": "2026-09-13T22:33:13"}
```
Respuesta opcional: `{"respuesta": "Texto que dirá el asistente"}`. Si no hay respuesta, falla o tarda,
el asistente usa su respuesta local (definida en `intenciones.yaml`).

## 2. `POST $EVENTOS_URL` — telemetría del pipeline (fire-and-forget, timeout 2 s)
Todos llevan `tipo` y `timestamp` (ISO con ms). Se envían en hilos: **pueden llegar desordenados, ordenar por `timestamp`**. Responder 2xx con cuerpo vacío.

| tipo | campos | cuándo |
|---|---|---|
| `estado` | `estado: "escuchando"` | al arrancar y tras cada ciclo |
| `wake` | `palabra`, `score` (0-1) | se detectó la palabra de activación |
| `orden` | `duracion_s`, `hubo_voz` | terminó la grabación de la orden |
| `stt` | `texto`, `modelo`, `ms` | transcripción de Whisper |
| `intent` | `texto`, `texto_normalizado`, `intent` (null = no entendido), `slots`, `ms` | resultado de hassil |
| `respuesta` | `texto`, `entendido` | texto que se va a hablar |
| `tts` | `ms` | terminó de reproducirse |
| `config` | `motor`, `wake`, `umbral`, `mudo`, `mic_pausado` | cambió la configuración |
| `qa` | `resultados` (ver /comparar), `esperado`, `slots_esperados` | terminó una comparación de motores |
| `sistema` | `componente:"mic"`, `ok` (bool), `dispositivo`, `error?` | el micrófono abrió (ok:true) o falló (ok:false); reintenta cada 2 s |
| `mic` | `scores` (o `null`), `rms`, `fase`, `umbral` | nivel de audio, agrupado cada ~400 ms (5 valores por chunk de 80 ms) |

En `mic`: `fase` ∈ `reposo` (escuchando la wake word) · `orden` (grabando el comando, `scores`=null) · `procesando` (transcribiendo). `scores`/`rms` traen un valor por chunk de 80 ms.

`stt`, `intent`, `respuesta` y `tts` llevan `origen`: `mic` · `front` · `texto` · `wav`. Los `qa` no ejecutan acciones.

En modo `--texto` solo se emiten `intent` y `respuesta` (y `tts` si no es `--mudo`).

## Intenciones y slots
| intent | slots |
|---|---|
| `EncenderDispositivo` / `ApagarDispositivo` | `dispositivo`: luz, ventilador, aire, tele, enchufe · `area`? |
| `AjustarBrillo` | `brillo`: 0-100 · `area`? |
| `FijarTemperatura` | `temperatura`: 16-30 · `area`? |
| `SubirPersiana` / `BajarPersiana` | `area`? |
| `ConsultarHora` | — |

`area`: living, cocina, comedor, dormitorio, bano, patio, oficina. `?` = opcional.
Fuente de verdad: `voz-local/intenciones.yaml`.

## 3. API de control (`servidor.py`)
Todas devuelven JSON. Errores: `400 {"error"}` (parámetro inválido) · `500 {"error"}`.
Las operaciones de pipeline se serializan (un ciclo a la vez), así los tiempos de QA son comparables.

| Método y ruta | Cuerpo / query | Respuesta |
|---|---|---|
| `GET /estado` | — | `{motor, motores:[...], wake, wake_words:[...], umbral, mudo, mic_pausado, mic:{activo, dispositivo, error}, audio:{backend, autoconectar, nodo_mic, nodo_tts}}` |
| `POST /config` | JSON con cualquiera de `motor`, `motor_intent`, `wake`, `umbral` (0-1), `mudo`, `mic_pausado` | igual a `/estado`. Cambiar `motor` lo precarga (el primer uso de whisper-small tarda ~1 s) |
| `POST /escuchar` | — | `202`. Push-to-talk: el próximo audio del micrófono se toma como orden sin wake word |
| `POST /texto` | `{"texto", "hablar"?: false}` | `{accion, respuesta, nlu_ms, timestamp}` — ejecuta la acción |
| `POST /audio?motor=&hablar=1` | cuerpo binario: audio wav/webm/ogg/mp3 (ej. MediaRecorder) | `{motor, texto, stt_ms, accion, respuesta, nlu_ms, timestamp}` — ciclo completo, ejecuta la acción |
| `POST /comparar?motores=a,b&esperado=Intent&motores_intent=hassil,hassil-fuzzy` | cuerpo binario: audio | `{resultados:[{motor, motor_intent, texto, stt_ms, intent_ms, carga_ms, accion, acierto}]}` — sin acciones |
| `POST /tts-comparar` | `{"frase", "motores"?, "motores_intent"?, "esperado"?, "slots"?}` | `{frase, resultados}` — genera el audio con Piper |
| `POST /autotest` | `{"motores"?, "motores_intent"?, "frases"?: [[frase, intent, slots], ...]}` | `{filas:[...], resumen:{clave:{aciertos, total, stt_ms_promedio, intent_ms_promedio}}}` |
| `POST /recargar` | — | `{ok}` — relee `intenciones.yaml` tras editarlo |

`motores` omitido = todos los STT. `motores_intent` omitido = solo el motor de intent activo; `"all"` (query) o `["all"]` (JSON) = todos. Con 1 motor de intent, la clave del `resumen` es el STT (`"whisper-base"`); con varios es la matriz `"whisper-base · hassil-fuzzy"`. `acierto` es `null` si no se pasó `esperado`; si se pasan `slots` deben coincidir exactos.

### Motores de intent
| id | qué es |
|---|---|
| `hassil` | gramática declarativa, determinista (default) |
| `hassil-fuzzy` | corrige el texto por similitud (RapidFuzz) contra el vocabulario de `intenciones.yaml` antes de hassil; recupera errores del STT ("pesianas"→"persianas", "tela"→"tele") manteniendo los slots |

El evento `intent` ahora lleva `motor_intent`.

### Motores STT
| id | qué es | autotest sintético (8 frases) |
|---|---|---|
| `whisper-tiny` | Whisper tiny, libre | 4/8 · ~200 ms |
| `whisper-base` | Whisper base, libre (default) | 6/8 · ~320 ms |
| `whisper-small` | Whisper small, libre | 6/8 · ~920 ms |
| `vosk` | Vosk small es, libre | 2/8 · ~160 ms |
| `vosk-gramatica` | Vosk con vocabulario de `intenciones.yaml` | 6-7/8 · ~25 ms |

Wake words (pre-entrenadas, en inglés): `hey_jarvis` (default), `alexa` (una sola palabra), `hey_mycroft`, `hey_rhasspy`.

### Audio y PipeWire
El asistente crea dos nodos PipeWire con nombre fijo para rutearlos en qpwgraph:
- **`voz-local-mic`** (captura, puertos `input_FL/FR`)
- **`voz-local-tts`** (salida de voz, puertos `output_FL/FR`) — un único `aplay` persistente. Se pre-abre al arrancar (si no está mudo) para poder rutearlo en qpwgraph **antes** de la primera respuesta, y se mantiene entre frases. `POST /config {"mudo":true}` lo cierra; `{"mudo":false}` lo reabre.

Backend: `--audio auto` (default; usa pipewire si hay `pw-link`, si no alsa) · `--audio pipewire` · `--audio alsa` (con `--mic <dispositivo ALSA>`). `--no-autoconectar` agrega `node.autoconnect = false` para rutear todo a mano. Los puertos conectados se ven con `pw-link -l`.

Si el micrófono falla o se cae, emite `sistema {componente:"mic", ok:false, error}` y reintenta cada 2 s (antes se colgaba en silencio).

## CLI sin servidor
```bash
.venv/bin/python asistente.py --texto "prendé la luz del living"
.venv/bin/python asistente.py --autotest --comparar whisper-base,vosk-gramatica
.venv/bin/python asistente.py --motor vosk-gramatica --wake alexa      # micrófono
```
