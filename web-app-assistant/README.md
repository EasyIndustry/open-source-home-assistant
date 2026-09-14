# CASA/SIM · web-app-assistant

Banco de pruebas visual para el asistente de voz local (`../voz-local`) antes de instalarlo en una casa real.
Una casa 3D simulada (7 ambientes, ~30 dispositivos, sensores y automatizaciones) recibe las *tool calls* del asistente
y muestra en vivo cada etapa del pipeline: **MIC → KWS (wake word) → ORDEN (VAD) → ASR → NLU → TOOL → TTS**.

## Arranque

```bash
./run.sh              # servidor.py con micrófono del host + simulador  → http://localhost:8765
./run.sh --sin-mic    # solo API de voz; hablás desde el micrófono del navegador
```

O por separado:

```bash
cd ../voz-local && EVENTOS_URL=http://127.0.0.1:8765/eventos ACCIONES_URL=http://127.0.0.1:8765/acciones \
  .venv/bin/python servidor.py --puerto 8766 --intenciones ../web-app-assistant/intenciones-casa.yaml
cd ../web-app-assistant && ../voz-local/.venv/bin/python server.py
```

Sin dependencias nuevas: `server.py` es stdlib y usa el venv de `voz-local`. Three.js está vendorizado en `static/vendor` (funciona offline).

## Qué hay en la pantalla

| zona | qué muestra |
|---|---|
| barra de control | estado de `servidor.py`, **destino** de las órdenes, motor ASR, wake word, umbral, mudo/pausa del host, recargar intenciones |
| pipeline | cada etapa con su valor, latencia y barra contra el presupuesto del documento (< 600 ms total) |
| 01 señal | osciloscopio + espectro del micrófono (cian) y de la voz del asistente (ámbar) |
| 02 KWS | score de openWakeWord en el tiempo, umbral y marcas de detección |
| 03 latencia | barras apiladas ASR / NLU / TTS de los últimos ciclos |
| 04 sensores | temperatura, humedad, lux, movimiento, humo, agua, CO₂, humedad de suelo, consumo |
| maqueta 3D | luces reales, persianas y ventanas motorizadas, portón, aire con flujo, ventiladores, teles, riego, alarma; satélites de micrófono por ambiente y paquetes satélite → servidor → dispositivo. Click en un dispositivo lo acciona |
| 05 NLU | texto crudo, normalizado con los *slots* subrayados, intent, slots, dispositivos afectados, JSON |
| 06 bus | todos los eventos ordenados por timestamp (◆ servidor.py · ◇ web · ✋ manual · · simulación) |
| 07 inyectar | humo, fuga, movimiento, ducha → prueba de automatizaciones |
| QA | comparar motores con grabación (MediaRecorder), con frase sintética (Piper) o autotest completo |

## Caminos de una orden

- **Micrófono del host** (`servidor.py`): la web solo observa los eventos del contrato.
- **Micrófono del navegador**: KWS + VAD corren en `server.py`; la orden grabada va a `servidor.py /audio` con el motor elegido
  (destino `servidor.py`) o al Whisper embebido (destino `motor embebido`). "hablar sin wake word" saltea el KWS.
- **Texto**: `servidor.py /texto` o motor embebido.

El **área** de una orden sin área ("prendé la luz") es la del **satélite activo** (selector sobre la maqueta).

## Intenciones

`intenciones-casa.yaml` tiene las 7 originales de `voz-local` sin cambios + ventanas, puerta, portón, alarma, riego,
consultas de temperatura/humedad/aberturas, escenas (noche, cine, fuera, día) y apagar todo.
La usan los dos motores: el embebido y `servidor.py` (`run.sh` le pasa `--intenciones intenciones-casa.yaml`).
Después de editarla: botón "↻ intenciones" en la web (servidor.py) y reiniciar `server.py` (motor embebido).

## Endpoints de `server.py`

`POST /eventos`, `POST /acciones` (contrato de `voz-local/CONTRATO.md`) · `GET /api/stream` (SSE) · `GET /api/estado` ·
`POST /api/texto {texto, via}` · `POST /api/mic` (PCM int16 16 kHz) · `POST /api/wake` · `POST /api/destino {destino, motor, tts_navegador}` ·
`POST /api/dispositivo {id, ...}` · `POST /api/simular {area, sensor, valor}` · `POST /api/satelite {area}` · `/voz/*` → proxy a `servidor.py`.

Variables: `PUERTO` (8765), `VOZ_URL` (http://127.0.0.1:8766), `VOZ_LOCAL`, `INTENCIONES`, `MODELO_STT` (base), `WAKE` (hey_jarvis), `UMBRAL_WAKE` (0.5).
