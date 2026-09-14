# Hardware para el asistente de voz local

Estimaciones y mediciones para correr **toda la cadena** del asistente en CPU, sin GPU:
openWakeWord (wake word) → STT (Whisper o Vosk) → hassil (intenciones) → Piper (voz).

**Fecha:** 2026-09-13 · **Config medida:** ver `voz-local/`.

## Lo que consume la cadena (medido en la PC de desarrollo)

Medido en un **Ryzen (16 hilos) con 14 GB de RAM**, en CPU (sin usar la GPU):

| Componente | RAM | Latencia |
|---|---|---|
| Base: Piper + hassil + vosk-gramatica | ~420 MB | — |
| + whisper-base cargado | ~660 MB | — |
| + whisper-small cargado | ~1,15 GB | — |
| openWakeWord escuchando (proceso aparte) | ~200 MB | 1,3 ms por trama de 80 ms (<2% de un núcleo) |

**Por transcripción (mismo audio sintético, 8 frases):**

| Motor STT | Aciertos | Latencia | Nota |
|---|---|---|---|
| whisper-tiny | 4/8 | ~200 ms | libre |
| whisper-base | 6/8 | ~320 ms | libre (default) |
| whisper-small | 6/8 | ~920 ms | libre |
| vosk | 2/8 | ~160 ms | libre |
| **vosk-gramatica** | **6-7/8** | **~25 ms** | vocabulario limitado a `intenciones.yaml` |

> Los aciertos son con **voz sintética (Piper)**, no con voz real. Con una persona hablando, la precisión y la wake word cambian; la calidad del micrófono pesa más que el CPU.

**Conclusión de recursos:** la cadena entra en **~1–1,5 GB de RAM** incluso con los motores de QA cargados. Cualquier PC con **AVX2** (Intel/AMD de 2013 en adelante) y **4 GB+ libres** la corre. Sin AVX2, faster-whisper no arranca.

---

## Opciones evaluadas — de menor a mayor rendimiento

Las latencias de las máquinas nuevas son **estimaciones** escaladas desde la PC de desarrollo. Se confirman midiendo por SSH cuando el equipo esté armado.

### 1. Celeron B800 (homeserver actual) — ❌ NO SIRVE
- 2 núcleos @ 1.5 GHz (2011), **sin AVX**, 1,8 GB RAM (~1 GB libre), ya con Nextcloud/Caddy.
- faster-whisper no arranca (falta AVX); onnxruntime/Vosk irían muy lentos; no entra en RAM.
- No representa a ninguna máquina nueva: no tiene sentido medir acá.

### 2. Mini PC MSI Cubi — Intel Celeron N100 (barebone)
- 4 núcleos @ hasta 3.4 GHz (6 W), **con AVX2**. Barebone: hay que sumar RAM + SSD.
- **Config sugerida:** 16 GB DDR4 SO-DIMM (confirmar 1 o 2 slots) + SSD M.2 NVMe 256–512 GB.
- Estimado: vosk-gramatica ~100 ms · whisper-base 0,6–1 s. Corre todo, incluido whisper-small.
- **A favor:** 6–10 W, ideal para dejar prendido 24/7. **En contra:** las Mini PC salen caras.
- Linux: sí (Ubuntu 24.04 / Debian 13).

### 3. PC gama baja — AMD Athlon 3000G
- **CPU:** 2 núcleos / 4 hilos @ 3.5 GHz, Vega 3, **con AVX2**.
- **Build cotizada:** Athlon 3000G + ASRock B450M-HDV + 8 GB DDR4 3200 + SSD SATA 256 GB (Adata SU650) + fuente 500 W + gabinete.
- Estimado: **vosk-gramatica ~25 ms** (sin cambios) · whisper-base **400–700 ms** (más lento por tener solo 2 núcleos).
- **A favor:** la más barata; sobra para 1 ambiente usando vosk-gramatica. **En contra:** 2 núcleos se notan si usás whisper seguido o sumás varios micrófonos.
- **Ojos:** (a) el B450M-HDV puede necesitar BIOS reciente para arrancar el 3000G — si no da video al armar, es lo primero a revisar. (b) el SSD es SATA, no NVMe (da igual para esto). (c) alcanza con **una sola fuente** de 500 W.
- Linux: sí (necesita la salida de video de la placa; el Athlon usa gráficos integrados).

### 4. PC gama baja — AMD Ryzen 3 3200G ✅ MEJOR RELACIÓN
- **CPU:** 4 núcleos / 4 hilos, Zen+, Vega 8, **con AVX2**.
- **Build cotizada:** Ryzen 3 3200G + 8 GB + SSD 256 GB + WiFi.
- Estimado: **vosk-gramatica ~25 ms** · whisper-base **~300 ms** (similar a la PC de desarrollo).
- **A favor:** más CPU que el N100, más barata que una Mini PC, margen para Home Assistant + web + varios micrófonos a futuro.
- **En contra:** 65 W (contra 6 W del N100): gasta más luz si queda prendida siempre.
- **Ojos:** confirmar que el WiFi ande en Linux (si no, cable de red). Linux: sí.

### 5. PC de desarrollo actual — Ryzen + RTX 3060
- 16 hilos, 14 GB RAM, GPU 12 GB. Ya midió todo (ver tabla de arriba).
- Sirve para desarrollo y QA, pero **consume demasiado para dejar prendida 24/7**.
- La GPU **no hace falta** para esta config; solo tendría sentido con un LLM o Whisper medium/large.

---

## Recomendación

- **Para 1 ambiente y presupuesto ajustado:** **Athlon 3000G**, usando **vosk-gramatica** como motor. Cumple y es lo más barato.
- **Mejor relación precio/rendimiento:** **Ryzen 3 3200G**. Un poco más cara, pero con margen para crecer.
- **Solo si el consumo eléctrico 24/7 es prioridad:** Mini PC N100 (más cara, pero 6 W).

## No hace falta
- **GPU:** todo corre en CPU.
- **Más de 8 GB de RAM:** salvo que se sume Home Assistant + varios servicios en la misma máquina (ahí, 16 GB).

## Lo que más impacta la precisión: el micrófono
Con voz real, la calidad del audio pesa más que el CPU.
- **Prototipo (1 ambiente):** altavoz de conferencia USB con cancelación de eco (Jabra Speak, Anker PowerConf).
- **Varias habitaciones (otra iteración):** satélites tipo Home Assistant Voice PE o ReSpeaker Lite (ESP32-S3 con cancelación de eco por hardware). Hoy el asistente lee un solo micrófono local; para satélites habría que agregar soporte Wyoming/ESPHome.

## Pendiente
Medir por SSH la latencia real cuando la PC elegida esté armada (reemplazar las estimaciones de las secciones 2-4).
