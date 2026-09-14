# Diseño y Arquitectura de Asistentes de Voz Locales sin Modelos de Lenguaje para Domótica en Español Rioplatense

El procesamiento de voz en el borde (*edge voice processing*) dentro de sistemas de automatización residencial exige tiempos de respuesta inmediatos, predictibilidad estricta en la ejecución de comandos y un aislamiento total respecto a servicios en la nube. Frente a los requerimientos computacionales intensivos y el latente riesgo de alucinación inherentes a los modelos de lenguaje de gran tamaño (LLM), la arquitectura determinista basada en reconocedores de palabras de activación (*wake word*), conversión de voz a texto (STT), extracción gramatical de intenciones (NLU) y síntesis de voz (TTS) constituye la solución técnicamente óptima para el control de infraestructura doméstica en tiempo real.

Este informe analiza exhaustivamente los componentes de código abierto con actividad verificable durante el período 2025-2026 para la construcción de un asistente local en español, especializado en la variante rioplatense, ejecutable de manera autónoma tanto en entornos integrados a Home Assistant como en sistemas independientes basados en bus de mensajes MQTT.

---

## 1. Contextualización y Principios de Diseño Determinista

El diseño de un sistema de voz local sin LLM sustituye la generación probabilística de texto por un flujo de procesamiento por etapas acopladas de manera secuencial. La canalización inicia cuando el micrófono del dispositivo capta una señal de audio analógica, la cual es digitalizada en una secuencia PCM continua de 16 kHz a 16 bits.

El primer componente, el motor de palabra de activación, analiza continuamente esta secuencia en pequeñas ventanas temporales sin guardar estado de largo plazo. Al detectar el patrón acústico preconfigurado con una probabilidad superior al umbral fijado, emite una señal de interrupción que activa la grabación del comando de voz del usuario.

El segmento de audio capturado tras la activación es transferido al motor de Reconocimiento Automático del Habla (STT). En un esquema determinista, este motor convierte la onda en una cadena de texto plana utilizando modelos acústicos optimizados o delimitados por gramáticas finitas. A diferencia de las transcripciones abiertas, la delimitación gramatical restringe el espacio de búsqueda del reconocedor exclusivamente a los términos y estructuras verbales definidos en el sistema.

A continuación, la cadena de texto es procesada por el motor de comprensión del lenguaje natural (NLU). Esta etapa realiza la extracción de intenciones y el rellenado de ranuras (*slot filling*), transformando oraciones como "prendé la luz del living" en una estructura de datos JSON estandarizada que especifica la acción (`PrenderLuz`) y la entidad o área objetivo (`living`).

El orquestador del sistema recibe la estructura JSON y ejecuta la llamada correspondiente sobre la capa domótica mediante comandos dirigidos a un broker MQTT o peticiones HTTP a la API de los dispositivos. Finalmente, el resultado de la operación genera una respuesta de texto que el motor de síntesis de voz (TTS) convierte en audio analógico para informar al usuario a través del altavoz.

---

## 2. Análisis Comparativo Exhaustivo por Componente del Pipeline

### 2.1 Palabras de Activación (Wake Word)

El motor de palabra de activación opera como un filtro de baja potencia siempre activo (*always-on*). Debe evaluar continuamente tramas de audio de entre 30 ms y 80 ms con un impacto computacional mínimo en el procesador central [cite: 1, 2].

| Componente / Proyecto | Repositorio Oficial | Licencia (Código / Modelo) | Actividad / Estado (2025-2026) | Soporte Español Rioplatense | Consumo de RAM | Latencia y Hardware (Medida / Estimada) | Fuente / Nota |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **openWakeWord** | `dscripka/openWakeWord` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (Sintético multilingüe) [cite: 3] | ~50 - 80 MB | 80 ms por trama; ~15-20 modelos simultáneos por núcleo | Medido en Raspberry Pi 3 [cite: 1, 2] |
| **microWakeWord** | `esphome/microwakeword` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (Requiere entrenamiento sintético) | ~100 KB - 2 MB | ~30 - 50 ms en ESP32-S3 | Medido en ESP32-S3 (Docs ESPHome) |
| **Picovoice Porcupine** | `Picovoice/porcupine` | Comercial Restrictiva / Propietaria [cite: 4] | Activo (2025-2026) | Sí (Modelos preentrenados y Web Console) | < 1 MB | < 20 ms en Raspberry Pi / Cortex-M | Medido por fabricante (Picovoice Benchmarks) |
| **Snowboy / Precog** | `Kitt-AI/snowboy` | Archivado / No comercial | Abandono confirmado | N/A | N/A | N/A | Reemplazado por openWakeWord / microWakeWord |

* **openWakeWord**: Implementa una arquitectura modular dividida en tres fases: preprocesamiento del espectrograma Mel en ONNX, extracción de características de audio de 96 dimensiones mediante un modelo profundo congelado provisto por Google (`speech_embedding`), y un clasificador lineal o RNN liviano final (~200 KB) [cite: 1, 2, 5]. Este diseño permite evaluar múltiples palabras de activación en paralelo compartiendo la misma fase de extracción de embeddings, lo que minimiza el consumo de CPU [cite: 1, 2].
* **microWakeWord**: Diseñado por el equipo de ESPHome para ejecutarse en microcontroladores de muy bajos recursos utilizando TensorFlow Lite for Microcontrollers (TFLM). Resulta ideal para satélites basados en ESP32-S3.
* **Porcupine**: Presenta métricas de latencia y consumo de memoria sumamente bajas, pero su modelo de licenciamiento impone severas restricciones comerciales y un límite de usuarios en su nivel gratuito, lo que invalida su uso para proyectos de código abierto autogestionados sin dependencia de licenciamiento externo [cite: 4].

#### Entrenamiento de Palabras de Activación Personalizadas
El entrenamiento de un modelo propio (por ejemplo, "Che Jarvis" o "Hola Casa") en **openWakeWord** o **microWakeWord** se realiza mediante pipelines de generación de voz sintética, eliminando la necesidad de recolección manual de miles de muestras de audio [cite: 1, 2].

El proceso técnico consiste en:
1. Generar entre 5.000 y 10.000 clips de audio sintéticos con la palabra objetivo variando la velocidad, tono y acento a través de múltiples modelos TTS (como Piper) [cite: 3, 6].
2. Combinar el conjunto sintético con datasets masivos de audio negativo (ruido ambiental, música, conversaciones de fondo del dataset ACAV100M o similares) que sumen entre 2.000 y 30.000 horas [cite: 1, 6].
3. Entrenar la capa final de clasificación sobre la red de embeddings congelada de Google mediante cuadernos de Jupyter en PyTorch o TensorFlow [cite: 2, 6].

Respecto a los costos de entrenamiento:
* **Opción Local / Google Colab (USD $0)**: Se ejecuta el cuaderno oficial en una instancia gratuita de Colab con GPU T4 [cite: 2]. El modelo en formato `.onnx` o `.tflite` se obtiene en aproximadamente 45 a 60 minutos [cite: 2, 3, 4].
* **Plataformas de Autoservicio en la Nube**: Plataformas como `openwakeword.com` u `outspoken.cloud` cobran mediante un esquema de créditos [cite: 4, 7]. Los costos varían entre €0 (primer modelo de prueba) y paquetes de €9 a €59 por 3 a 25 créditos de entrenamiento computacional en sus servidores GPU [cite: 4].

Para adaptar el modelo al dialecto rioplatense se deben abordar desafíos fonéticos específicos. La aspiración de la /s/ al final de sílaba y la pronunciación de la "ll" y la "y" como fricativa postalveolar sorda o sonora (yeísmo reajustado) deben ser contempladas en la sintesis. Se recomienda mezclar fuentes de voz sintética `es_AR` con variaciones fonéticas escritas manualmente en la plantilla de entrenamiento (por ejemplo, incluir las cadenas "Che Jarvis" y "She Jarvis") para asegurar tasas de falso rechazo inferiores al 5% [cite: 1, 6].

---

### 2.2 Reconocimiento Automático del Habla (STT / ASR)

El motor STT convierte el comando de voz en texto. Para evitar la latencia de decodificación autorregresiva de modelos generalistas, el uso de reconocedores basados en gramáticas finitas ofrece ventajas estructurales deterministas.

| Componente / Proyecto | Repositorio Oficial | Licencia (Código / Modelo) | Actividad / Estado (2025-2026) | Soporte Español Rioplatense | Consumo de RAM | Latencia y Hardware (Medida / Estimada) | Fuente / Nota |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Speech-to-Phrase** | `OHF-Voice/speech-to-phrase` | Apache-2.0 / Apache-2.0 [cite: 8] | Activo (v1.4.5 en 2026) [cite: 9] | Sí (FST Kaldi + YAML) [cite: 8] | ~150 - 300 MB | < 100 ms en Raspberry Pi 4 / CM4 | Medido en HA Yellow / CM4 [cite: 8, 9, 10] |
| **Vosk** | `alphacep/vosk-api` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (`vosk-model-small-es-0.42`) | ~100 - 200 MB | ~150 - 250 ms en CPU x86 / RPi4 | Medido (Vosk Benchmarks) |
| **faster-whisper** | `SYSTRAN/faster-whisper` | MIT / MIT | Activo (2025-2026) | Sí (Excelente transcripción abierta) | ~500 MB (tiny) - 2 GB (small) | ~200 - 450 ms en CPU Intel i5 | Estimado en CPU x86 |
| **whisper.cpp** | `ggerganov/whisper.cpp` | MIT / MIT | Activo (2025-2026) | Sí (Cuantización GGML) | ~350 MB (base) | ~250 - 500 ms en Raspberry Pi 4 | Estimado en ARM64 |
| **Moonshine** | `usefulsensors/moonshine` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (Modelos comprimidos) [cite: 11, 12] | ~200 MB | ~100 - 200 ms en Edge CPUs | Medido en arquitecturas Edge [cite: 11, 12] |
| **NVIDIA Parakeet/Canary** | `NVIDIA/NeMo` | Apache-2.0 / CC-BY-4.0 | Activo (2025-2026) | Sí (Multilingüe de gran escala) | > 4 GB (Requiere GPU NVIDIA) | ~150 ms en GPU TensorRT | Estimado en servidor GPU |

* **Speech-to-Phrase**: Desarrollado por la Open Home Foundation, sustituye la transcripción de vocabulario abierto por un modelo predictivo cerrado basado en la pregunta "¿cuál de las frases conocidas fue pronunciada?" [cite: 8, 10]. Utiliza un compilador que transforma plantillas YAML en transductores de estados finitos (FST) de Kaldi mediante *opengrm* y *Phonetisaurus* (G2P) [cite: 8]. Esto garantiza tiempos de procesamiento sub-100 ms e inmunidad a palabras fuera de dominio [cite: 8, 9, 10].
* **Vosk con Gramática Restringida**: Permite inyectar una lista JSON de oraciones y entidades permitidas durante la inicialización del motor. Al limitar el grafo del modelo de lenguaje, la tasa de error de palabras (WER) cae a valores cercanos al 0% en entornos ruidosos, requiriendo menos de 200 MB de memoria RAM.
* **faster-whisper y whisper.cpp**: Modelos basados en la arquitectura Encoder-Decoder de OpenAI. Aunque su WER en lenguaje informal rioplatense es sobresaliente, su tiempo de decodificación autorregresiva genera latencias variables que pueden superar los 400 ms en procesadores de gama baja sin GPU.

---

### 2.3 Extracción de Intención y Parámetros (NLU / Gramáticas Declarativas)

El motor NLU toma el texto generado por la etapa de STT y extrae la intención y las variables (slots).

| Componente / Proyecto | Repositorio Oficial | Licencia (Código / Modelo) | Actividad / Estado (2025-2026) | Soporte Español Rioplatense | Consumo de RAM | Latencia y Hardware (Medida / Estimada) | Fuente / Nota |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Hassil** | `home-assistant/hassil` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (Reglas YAML extensibles) | < 20 MB | < 5 ms en CPU moderna | Medido en Home Assistant Core |
| **Rhasspy NLU (v2)** | `rhasspy/rhasspy` | MIT / MIT | Archivado / Reemplazado | Sí | ~50 MB | ~20 ms | Reemplazado por Wyoming/Hassil [cite: 8] |
| **Snips NLU** | `snipsco/snips-nlu` | Apache-2.0 | Abandono confirmado | Limitado | N/A | N/A | Proyecto obsoleto |
| **SetFit / Small BERT** | `huggingface/setfit` | Apache-2.0 / MIT | Activo (2025-2026) | Sí (Requiere entrenamiento local) | ~200 - 400 MB | ~15 - 30 ms en CPU | Estimado en CPU |
| **fastText** | `facebookresearch/fastText` | MIT / MIT | Mantenimiento activo | Sí | ~50 MB | < 5 ms en CPU | Estimado en CPU |

* **Hassil**: Es el estándar actual del ecosistema de automatización local. Funciona mediante la coincidencia de patrones y reglas de expansión declarativas escritas en YAML. Evalúa estructuras de sintaxis complejas, listas de dispositivos, áreas y alternativas opcionales con un consumo de RAM casi despreciable (< 20 MB) y latencias inferiores a 5 ms.
* **Snips NLU y Rhasspy v2**: Snips NLU quedó oficialmente descontinuado tras la adquisición corporativa de Snips por parte de Sonos. Rhasspy v2 fue desmontado arquitectónicamente para dar paso a la suite de microservicios **Wyoming** [cite: 8].
* **Modelos Basados en Embeddings (SetFit / fastText)**: Ofrecen flexibilidad para interpretar oraciones fuera de sintaxis o tolerar errores gramaticales. No obstante, en un pipeline determinista introducen una complejidad innecesaria en la etapa de entrenamiento y requieren más recursos que los motores de plantillas declarativas como Hassil.

#### Manejo de Fenómenos Lingüísticos y Errores
El motor NLU debe resolver cuatro problemas recurrentes en la voz interactiva:
1. **Sinónimos y Variantes Dialécticas**: Hassil permite definir reglas de expansión compuestas en YAML donde términos como "luz", "lamparita", "velador" o "foco" se mapean a la misma entidad conceptual.
2. **Transformación Numérica**: Transcripciones en texto como "veinticinco" deben mapearse a enteros (`25`) para ajustar niveles de brillo o termostatos. Módulos como Phonetisaurus en Speech-to-Phrase realizan la normalización de dígitos de forma nativa antes de la extracción de slots [cite: 8].
3. **Pertenencia por Área/Habitación**: Las intenciones pueden configurarse de forma implícita. Si el comando omite la habitación (ej. "prendé la luz"), el orquestador asigna el parámetro del área según la identidad del satélite desde donde proviene el audio.
4. **Mitigación de Errores del STT**: Al acoplar Speech-to-Phrase con Hassil, la decodificación en el STT se encuentra restringida por el mismo transductor de estados finitos que define las intenciones, eliminando de raíz la generación de cadenas irrelevantes [cite: 8].

---

### 2.4 Síntesis de Texto a Voz (TTS)

El motor de síntesis genera la confirmación audible de las acciones ejecutadas.

| Componente / Proyecto | Repositorio Oficial | Licencia (Código / Modelo) | Actividad / Estado (2025-2026) | Soporte Español Rioplatense | Consumo de RAM | Latencia y Hardware (Medida / Estimada) | Fuente / Nota |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Piper** | `OHF-Voice/piper` | MIT / Varía por voz (MIT, CC0, Custom) | Activo (2025-2026) | Sí (`es_AR-lslc-x_low`, `es_ES`, `es_MX`) | ~50 - 150 MB | RTF < 0.1 en CPU (< 100 ms latencia inicial) | Medido en Piper Benchmarks [cite: 3] |
| **Kokoro** | `hexgrad/Kokoro-82M` | Apache-2.0 / Apache-2.0 | Activo (2025-2026) | Sí (Multilingüe de alta calidad) | ~300 - 500 MB | ~150 - 300 ms en CPU | Estimado en CPU x86 |
| **Coqui TTS** | `coqui-ai/TTS` | MPL-2.0 / No comercial en varios modelos | Abandono confirmado | Sí | > 1 GB | > 500 ms en CPU | Reemplazado por Piper / Kokoro |

* **Piper**: Es el sintetizador de voz de referencia para arquitecturas en el borde. El repositorio se encuentra mantenido activamente bajo la organización `OHF-Voice` [cite: 8]. Basado en la arquitectura VITS y optimizado en ONNX, alcanza un Factor de Tiempo Real (RTF) inferior a 0.1 en procesadores ARM64 y x86, generando respuestas de voz naturales casi de forma instantánea [cite: 3]. Dispone de modelos entrenados para español de Argentina (tales como `es_AR-lslc-x_low`).
* **Licenciamiento de Voces**: El motor de ejecución Piper posee licencia MIT, pero la licencia de cada archivo `.onnx` de voz depende del creador del modelo y del dataset de entrenamiento utilizado [cite: 7]. Existen voces bajo dominio público (CC0), licencias permisivas (MIT) y licencias no comerciales (NC). Debe revisarse el archivo manifest JSON adjunto a la voz seleccionada.

---

### 2.5 Protocolos de Integración y Satélites de Voz

La distribución de micrófonos y altavoces requiere protocolos de transmisión ligera de audio PCM e intenciones.

| Componente / Proyecto | Repositorio Oficial | Licencia | Actividad / Estado (2025-2026) | Plataforma Objetivo | Función y Rol |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Wyoming Protocol** | `home-assistant/wyoming` | Apache-2.0 | Activo (2025-2026) | Linux / Python | Protocolo basado en TCP para intercambio de tramas de audio PCM e intenciones estructuradas en formato JSON. |
| **wyoming-satellite** | `rhasspy/wyoming-satellite` | MIT | Activo (2025-2026) | Linux (Raspberry Pi, Mini PC) | Servicio cliente de transmisión de audio desde el micrófono local hacia el servidor central por Wyoming. |
| **ESPHome Voice** | `esphome/esphome` | MIT / Apache-2.0 | Activo (2025-2026) | ESP32-S3 / Microcontroladores | Firmware para dispositivos integrados (como Home Assistant Voice PE). Corre microWakeWord localmente y transmite audio vía API ESPHome. |
| **linux-voice-assistant**| `rhasspy/linux-voice-assistant`| MIT | Archivado / Reemplazado | Linux | Sustituido de manera oficial por `wyoming-satellite`. |

---

## 3. Recomendación de Arquitecturas de Sistema

### 3.1 Arquitectura (a): Prototipado Monolítico Local en PC Linux
Esta arquitectura agrupa todos los microservicios en una misma máquina x86 con Linux (Ubuntu/Debian), siendo idónea para realizar pruebas de concepto y validaciones inmediatas sin necesidad de hardware dedicado adicional ni dependencias de Home Assistant.

* **Captura de Audio Local**: Un script cliente en Python lee la entrada de audio del sistema (vía PulseAudio o ALSA) y envía la secuencia de tramas PCM al contenedor de palabra de activación.
* **Servicio de Wake Word**: El contenedor `wyoming-openwakeword` evalúa en tiempo real las tramas de audio buscando la palabra clave "hey_jarvis" o un modelo propio [cite: 2].
* **Servicio STT Guiado por Gramática**: Al confirmarse la activación, el streaming de audio se deriva al contenedor `wyoming-vosk` (o `wyoming-speech-to-phrase`), el cual convierte el comando en texto restringido por reglas gramaticales [cite: 8].
* **Extracción de Intención y Lógica Domótica**: Un orquestador central en Python procesa el texto mediante el motor `Hassil`, extrayendo la intención (`PrenderLuz`, `ApagarLuz`) y los parámetros (`area: cocina`).
* **Ejecución de Acción Domótica**: El orquestador interactúa directamente con los dispositivos enviando mensajes estructurados en JSON hacia un Broker MQTT (`eclipse-mosquitto`).
* **Respuesta Auditiva**: La confirmación de texto se envía al contenedor `wyoming-piper`, que sintetiza el audio en español argentino (`es_AR`) y lo reproduce a través del altavoz de la PC [cite: 3].

---

### 3.2 Arquitectura (b): Sistema Residencial Distribuido Multihabitación
Diseñada para un despliegue de producción completo en el hogar, separando los puntos de interacción física (satélites) del motor computacional central.

* **Satélites de Habitación (Hardware Edge)**:
  * Placas **ESP32-S3** equipadas con micrófono I2S (ej. INMP441) y amplificador de audio (ej. MAX98357A), ejecutando firmware **ESPHome Voice**.
  * Cada satélite procesa la palabra de activación de forma local en el chip mediante **microWakeWord**, evitando la transmisión continua de audio a la red.
  * Al activarse, transmiten el flujo de audio del comando a través del protocolo Wyoming sobre TCP/IP hacia el servidor central.
* **Servidor Central de Procesamiento**:
  * Ejecutado en una Mini PC de bajo consumo (ejemplo: Intel N100) o servidor Linux doméstico.
  * Recibe las tramas de audio provenientes del satélite que registró la activación.
  * Procesa el reconocimiento de voz con **wyoming-speech-to-phrase** utilizando transductores FST optimizados con los dispositivos del hogar [cite: 8].
  * Resuelve la intención con **Hassil** y contextualiza la acción según la habitación desde la cual se emitió el comando (identificada por el IP/ID del satélite).
  * Emite el mensaje de control hacia el Broker MQTT conectado a las puertas de enlace Zigbee (Zigbee2MQTT) o dispositivos WiFi (Tasmota/Shelly).
  * Genera el audio de confirmación con **wyoming-piper** y lo transmite de regreso al satélite de origen para su emisión por el altavoz local [cite: 3].

---

## 4. Guía de Despliegue Práctico para la Arquitectura de Prototipado Monolítico

Esta guía detalla los pasos concretos para desplegar la arquitectura monolítica en una PC Linux sin Home Assistant, utilizando Docker Compose, servicios Wyoming y un orquestador en Python con comunicación MQTT directa.

### 4.1 Archivo de Despliegue `docker-compose.yml`

```yaml
version: '3.8'

services:
  mosquitto:
    image: eclipse-mosquitto:2.0
    container_name: voice_mosquitto
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/config:/mosquitto/config
      - ./mosquitto/data:/mosquitto/data

  wyoming-openwakeword:
    image: rhasspy/wyoming-openwakeword:latest
    container_name: voice_wakeword
    restart: unless-stopped
    ports:
      - "10400:10400"
    command:
      - --preload-model
      - "hey_jarvis"
      - --custom-model-dir
      - /custom_models
    volumes:
      - ./wyoming/custom_models:/custom_models

  wyoming-vosk:
    image: rhasspy/wyoming-vosk:latest
    container_name: voice_stt
    restart: unless-stopped
    ports:
      - "10300:10300"
    command:
      - --model
      - /models/vosk-model-small-es-0.42
      - --language
      - es
    volumes:
      - ./wyoming/models:/models

  wyoming-piper:
    image: rhasspy/wyoming-piper:latest
    container_name: voice_tts
    restart: unless-stopped
    ports:
      - "10200:10200"
    command:
      - --voice
      - es_AR-lslc-x_low
    volumes:
      - ./wyoming/piper-voices:/data
```

---

### 4.2 Configuración del Entorno y Descarga de Modelos

Ejecutar las siguientes instrucciones en la terminal del sistema anfitrión Linux para estructurar las carpetas y descargar los modelos acústicos necesarios:

```bash
# Crear estructura de directorios
mkdir -p voice_assistant/mosquitto/config
mkdir -p voice_assistant/wyoming/models
mkdir -p voice_assistant/wyoming/piper-voices
mkdir -p voice_assistant/wyoming/custom_models

cd voice_assistant

# Archivo de configuración básica para Mosquitto MQTT
cat << 'EOF' > mosquitto/config/mosquitto.conf
listener 1883
allow_anonymous true
EOF

# Descargar modelo de reconocimiento de voz Vosk en español
curl -L -o vosk-es.zip https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
unzip vosk-es.zip -d wyoming/models/
rm vosk-es.zip

# Descargar modelo de voz en español de Argentina para Piper TTS
curl -L -o wyoming/piper-voices/es_AR-lslc-x_low.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/lslc/x_low/es_AR-lslc-x_low.onnx
curl -L -o wyoming/piper-voices/es_AR-lslc-x_low.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/lslc/x_low/es_AR-lslc-x_low.onnx.json

# Iniciar los servicios de infraestructura mediante Docker Compose
docker-compose up -d
```

---

### 4.3 Script Orquestador Independiente en Python (`orchestrator.py`)

El siguiente script conecta las intenciones gramaticales definidas en español rioplatense con la ejecución de comandos MQTT. Requiere la instalación de las dependencias: `pip install hassil paho-mqtt wyoming`.

```python
import asyncio
import json
import logging
import paho.mqtt.client as mqtt
from hassil import parse_intents, match_expression

logging.basicConfig(level=logging.INFO)

# 1. Definición de Gramática e Intenciones en Español Rioplatense (Sintaxis Hassil)
INTENT_GRAMMAR = """
language: "es"
intents:
  PrenderLuz:
    data:
      - sentences:
          - "[prendé|encendé|prender|encender] [la] luz [de|del|de la] {area}"
          - "prendeme la luz [del|de la] {area}"
  ApagarLuz:
    data:
      - sentences:
          - "[apagá|apagar] [la] luz [de|del|de la] {area}"
          - "apagame la luz [del|de la] {area}"
expansion_rules:
  area: "[living|cocina|comedor|dormitorio|baño|patio]"
"""

# 2. Configuración del Cliente MQTT
MQTT_BROKER_HOST = "localhost"
MQTT_BROKER_PORT = 1883

mqtt_client = mqtt.Client(client_id="VoiceOrchestratorEngine")

def on_connect(client, userdata, flags, rc):
    logging.info(f"Conectado al Broker MQTT con código de resultado: {rc}")

mqtt_client.on_connect = on_connect
mqtt_client.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, 60)
mqtt_client.loop_start()

# 3. Compilación de Intenciones con Hassil
parsed_intents = parse_intents(INTENT_GRAMMAR)

def process_transcription(text_input: str):
    logging.info(f"Procesando transcripción de texto: '{text_input}'")
    match_result = match_expression(text_input, parsed_intents, language="es")
    
    if not match_result:
        logging.warning("No se logró mapear el texto a ninguna intención conocida.")
        return "No pude entender el comando formulado."

    intent_name = match_result.intent.name
    extracted_slots = {slot.name: slot.value for slot in match_result.entities.values()}
    target_area = extracted_slots.get("area", "general")

    logging.info(f"Intención interpretada: {intent_name} | Área: {target_area}")

    # Constantes de tópicos domóticos MQTT (compatibles con Zigbee2MQTT / Tasmota)
    mqtt_topic = f"domotica/{target_area}/luz/set"

    if intent_name == "PrenderLuz":
        payload = json.dumps({"state": "ON"})
        mqtt_client.publish(mqtt_topic, payload)
        return f"Prendiendo la luz del {target_area}."
        
    elif intent_name == "ApagarLuz":
        payload = json.dumps({"state": "OFF"})
        mqtt_client.publish(mqtt_topic, payload)
        return f"Apagando la luz del {target_area}."

    return "Comando no reconocido."

# 4. Simulación del Bucle de Eventos Principal del Asistente
async def main():
    logging.info("Orquestador de voz independiente listo para recibir eventos.")
    
    # Pruebas de validación de sintaxis rioplatense
    test_phrases = [
        "prendé la luz del living",
        "apagame la luz de la cocina",
        "encender la luz del baño"
    ]
    
    for phrase in test_phrases:
        response_tts = process_transcription(phrase)
        logging.info(f"Respuesta de voz a sintetizar (TTS): '{response_tts}'")
        await asyncio.sleep(1)

if __name__ == "__main__":asyncio.run(main())
```

---

## 5. Análisis de Riesgos, Licenciamiento y Desafíos Lingüísticos

### 5.1 Componentes Abandonados u Obsoletos
* **Snips NLU**: Descontinuado de forma definitiva tras la venta de la empresa. Las librerías de Python en las que se basaba presentan incompatibilidades severas con versiones modernas del lenguaje.
* **Rhasspy v2 (Monolítico)**: Obsoleto. Toda la arquitectura basada en la interfaz Rhasspy v2 fue sustituida por el proyecto **Wyoming** mantenido por la Open Home Foundation [cite: 8].
* **Coqui TTS**: Empresa y soporte desmantelados en 2024. Fue reemplazado por **Piper** para inferencia local liviana en CPU y por **Kokoro** para modelos de alta fidelidad.
* **Snowboy**: Los servidores de licencias y repositorios originales fueron archivados, haciendo inviable la generación de nuevos modelos para esta plataforma.

---

### 5.2 Riesgos de Licenciamiento y Restricciones de Uso
* **Picovoice Porcupine**: Posee una licencia propietaria restrictiva [cite: 4]. Su uso en entornos comerciales o de código abierto distribuido no está permitido sin la adquisición de licencias por usuario activo [cite: 4].
* **Voces de Piper TTS**: El motor de ejecución Piper se distribuye bajo licencia MIT, pero las voces individuales `.onnx` heredan los términos de los datasets con los que se entrenaron [cite: 7]. Es necesario comprobar de manera aislada la licencia de cada voz (algunas voces contienen cláusulas *Non-Commercial* - NC) si se contempla la distribución comercial del sistema [cite: 7].
* **Modelos de openWakeWord**: Las herramientas y el motor central están amparados bajo la licencia permisiva Apache-2.0 [cite: 1, 3]. Sin embargo, si se utiliza el servicio en la nube `openwakeword.com` para sintetizar y generar modelos personalizados, las condiciones del servicio establecen que los modelos ONNX resultantes son exclusivamente para uso personal y no comercial a menos que se obtenga una licencia específica de producción [cite: 7].

---

### 5.3 Desafíos Lingüísticos en Español Rioplatense y Estrategias de Mitigación

#### A. Conjugaciones Imperativas del Voseo
Los reconocedores de voz y motores de intenciones diseñados para español neutro no reconocen adecuadamente la acentuación y desinencia del voseo (*"prendé"*, *"apagá"*, *"desconectá"*). 
* **Mitigación**: En las plantillas de intenciones de Hassil y en los modelos FST de Speech-to-Phrase, se deben incluir explícitamente las reglas de alternancia sintáctica mediante corchetes opcionales `[prendé|enciende|prender]`, asegurando que la variante rioplatense posea prioridad en la coincidencia léxica [cite: 8].

#### B. Normalización de Cadenas Numéricas
El texto reconocido a partir de la voz suele transcribir los valores en formato de palabras (*"veinticinco grados"*), lo que interrumpe la ejecución si el actuador domótico espera un entero (`25`).
* **Mitigación**: Emplear motores STT como Speech-to-Phrase que incorporan transformadores G2P de Phonetisaurus para convertir cadenas textuales en enteros antes de enviarlas al motor NLU [cite: 8], o implementar un módulo intermedio en el orquestador Python que utilice la librería `text2num`.

#### C. Confusiones Acústicas de Términos Locales
Términos cotidianos del hogar en Argentina (como *"quincho"*, *"pava"*, *"sommier"* o *"velador"*) suelen sufrir una alta tasa de error de palabras (WER) en reconocedores de voz abiertos entrenados con datasets de España o México.
* **Mitigación**: Restringir el reconocimiento del habla mediante transductores FST (Speech-to-Phrase) o gramáticas cerradas en Vosk [cite: 8]. Al obligar al reconocedor a evaluar únicamente los fonemas que coinciden con la lista finita de dispositivos expuestos, se erradican los errores por desalineación léxica dialectal.