# Arquitectura de Procesamiento de Voz en el Borde para Domótica Local: Alternativas Livianas a Modelos de Gran Lenguaje

La evolución de los asistentes de voz en entornos domóticos ha estado marcada por la dependencia histórica de servicios en la nube o, más recientemente, por la integración de Modelos de Gran Lenguaje (LLM) locales. Sin embargo, la ejecución de LLMs habilitados para la invocación de herramientas (*tool calling*) impone requerimientos de infraestructura significativos, superando con frecuencia los 20 GB de memoria RAM y demandando unidades de procesamiento gráfico (GPU) dedicadas. Para entornos de automatización residencial privativos, eficientes y de bajo consumo, esta aproximación generativa resulta sobredimensionada e ineficiente en términos energéticos y de latencia de cómputo.

La alternativa técnica eficiente reside en la construcción de una canalización (*pipeline*) modular de Inteligencia Artificial especializada. Este enfoque desacopla la asistencia de voz en tres etapas secuenciales de Machine Learning (ML) ligero: Detección de Palabra de Activación (*Keyword Spotting* o KWS), Reconocimiento Automático del Habla (*Automatic Speech Recognition* o ASR) y Entendimiento del Lenguaje Natural (*Natural Language Understanding* o NLU) enfocado en la extracción determinista de intenciones y entidades [cite: 1, 2]. Este informe examina exhaustivamente los modelos de código abierto y la arquitectura de hardware requerida para implementar un sistema de control por voz en español, completamente local, privativo y con una huella de memoria global inferior a 1 GB de RAM [cite: 1, 3, 4].

| Dimensión Técnica | Canalización Generativa (LLM Local) | Canalización Especializada Modular (ML Ligero) |
| :--- | :--- | :--- |
| **Consumo de Memoria RAM** | 16 GB – 32 GB+ | 500 MB – 1 GB [cite: 1, 4] |
| **Aceleración por Hardware** | Requerida (GPU de alto rendimiento / VRAM) | Opcional (Optimizado para CPU ARM/x86) [cite: 5, 6] |
| **Latencia Total de Respuesta** | 3,000 ms – 10,000 ms | 200 ms – 800 ms [cite: 3, 5, 7] |
| **Determinismo en Ejecución** | Estocástico (Riesgo de alucinación) | Determinista (Mapeo directo de intenciones) [cite: 2] |
| **Hardware de Control Típico** | Servidor dedicado con GPU comercial | Raspberry Pi 4/5, Mini PC pasivo [cite: 1, 7] |

## Detección de Palabras de Activación (Keyword Spotting)

La primera etapa de la arquitectura consiste en la detección local de la palabra de activación (*wake word*). Este componente ejecuta un modelo de clasificación de audio continuo que analiza el flujo del micrófono en reposo, manteniendo un consumo de recursos computacionales marginal antes de despertar a los motores de transcripción más complejos [cite: 8, 9].

El motor `openWakeWord` destaca como una solución basada en redes neuronales profundas exportadas al formato ONNX [cite: 8, 9]. Su diseño utiliza representaciones intermedias de audio (*audio embeddings*) generadas por arquitecturas de audio comprimidas, sobre las cuales se entrena un clasificador denso altamente optimizado [cite: 8]. Para el idioma español, la generación de modelos personalizados se logra mediante el sintetizado de muestras de voz sintética multilingüe, eliminando la necesidad de recolección manual de audio [cite: 8, 9]. El modelo resultante en disco no supera los 100 KB y ofrece latencias de inferencia inferiores a 5 ms por trama en arquitecturas ARM y x86 [cite: 3, 9].

En escenarios donde se requiere trasladar la captura inicial a nodos periféricos de ultra bajo consumo, la arquitectura se beneficia del motor `microWakeWord` o del marco `Voicute` [cite: 3, 10]. `microWakeWord` se implementa sobre TensorFlow Lite for Microcontrollers, ejecutando la inferencia directamente en chips ESP32-S3 [cite: 10, 11]. Por su parte, `Voicute` utiliza cuantización INT8 para ofrecer modelos ONNX de entre 74 KB y 128 KB con latencias menores a 10 ms, permitiendo ejecutar la activación tanto en microcontroladores como en servicios centralizados mediante el protocolo Wyoming [cite: 3].

| Motor KWS | Formato del Modelo | Consumo de RAM | Latencia por Trama | Plataforma de Ejecución |
| :--- | :--- | :--- | :--- | :--- |
| **openWakeWord** | ONNX / TFLite | ~20 MB – 35 MB [cite: 3] | < 5 ms [cite: 3] | Linux PC, Raspberry Pi 4/5 [cite: 8, 9] |
| **microWakeWord** | TFLite Micro | < 100 KB [cite: 10] | Tiempo Real (< 1 ms) [cite: 10] | ESP32-S3, Microcontroladores [cite: 10, 11] |
| **Voicute** | ONNX (INT8/FP32) | ~1 MB – 5 MB [cite: 3] | < 10 ms [cite: 3] | ESP32-S3, Linux Edge [cite: 3] |

## Reconocimiento Automático del Habla (Speech-to-Text)

Una vez confirmada la palabra de activación, la señal de audio se redirige al motor de Reconocimiento Automático del Habla (ASR). Para evitar el sobrecoste operacional de frameworks pesados basados en Python o PyTorch, la implementación eficiente emplea librerías escritas en C/C++ que aprovechan las extensiones vectoriales SIMD (NEON en procesadores ARM y AVX2 en procesadores x86) [cite: 5, 6].

La arquitectura Whisper desarrollada por OpenAI es la referencia dominante por su precisión multilingüe [cite: 1, 6]. La optimización `whisper.cpp`, desarrollada en C/C++ sobre la biblioteca GGML, elimina completamente las dependencias de entornos complejos y permite ejecutar cuantización de pesos en formatos INT8, Q5 y Q4 [cite: 6]. Alternativamente, el motor `faster-whisper`, sustentado en CTranslate2, reescribe los kernels de atencion para lograr aceleraciones sustanciales en CPU x86 mediante cuantización INT8 [cite: 7, 12].

Para órdenes de automatización residencial en español, la velocidad de procesamiento prima sobre la capacidad de transcripción de textos extensos. La variante `Whisper Base` cuantizada representa la opción idónea, logrando transcribir comandos de 3 segundos en menos de 600 ms sobre una Raspberry Pi 5, consumiendo únicamente 390 MB de RAM y manteniendo una tasa de error de palabra (WER) baja para el idioma español [cite: 1, 4, 5, 7].

| Variante Whisper | Parámetros | Tamaño GGML (Disco) | Consumo de RAM | Factor de Tiempo Real (RTF) en RPi 5 | Desempeño en Español |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **tiny** | 39 M | ~75 MB [cite: 4, 6] | ~270 MB [cite: 4] | ~0.10x [cite: 5, 7] | Velocidad máxima; tildes y ruidos afectan la precisión [cite: 4, 13] |
| **base** | 74 M | ~142 MB [cite: 4, 6] | ~390 MB [cite: 4] | ~0.20x [cite: 5, 7] | Equilibrio óptimo para comandos de voz directos [cite: 1, 4] |
| **small** | 244 M | ~466 MB [cite: 4, 6] | ~850 MB [cite: 4] | ~0.60x [cite: 5, 7] | Elevada precisión; recomendado para acentos regionales [cite: 4, 5] |
| **medium** | 769 M | ~1.5 GB [cite: 4, 6] | ~2.1 GB [cite: 4] | > 1.2x [cite: 5] | Alta precisión; innecesario para frases estructuradas [cite: 4, 5] |

## Entendimiento del Lenguaje Natural (NLU) y Extracción de Intenciones

El equivalente liviano y determinista a la capacidad de *tool calling* de un LLM se ejecuta mediante motores NLU probabilísticos o basados en gramáticas libres de contexto [cite: 1, 2]. Estos sistemas analizan la cadena de texto producida por el motor ASR para clasificar la **intención** (*intent*) deseada y extraer los parámetros clave (**entidades** o *slots*) en una única pasada computacional de pocos milisegundos [cite: 2].

El framework `Snips NLU` representa una solución histórica orientada al procesamiento en el borde [cite: 14, 15]. Mediante el uso combinado de clasificadores lineales y Campos Aleatorios Condicionales (CRF), Snips NLU realiza la extracción de entidades sin requerir modelos basados en atenciones ponderadas [cite: 2]. Con una huella de memoria inferior a 30 MB y tiempos de inferencia menores a 20 ms, procesa frases complejas en español determinando si la intención corresponde a una acción válida o a un evento no reconocido (*None intent*) [cite: 2, 15].

En arquitecturas más complejas, `Rasa NLU` con el clasificador DIET (*Dual Intent and Entity Transformer*) ofrece un modelo multitarea que procesa intenciones y entidades de forma simultánea [cite: 16]. Si bien DIET ofrece una mayor flexibilidad semántica frente a variaciones gramaticales, su footprint de memoria se sitúa entre los 2 GB y 4 GB de RAM, lo que lo desplaza hacia servidores domésticos centrales en lugar de dispositivos integrados [cite: 17, 18].

Para la gestión domótica estandarizada, el motor de coincidencia sintáctica de `Home Assistant Assist` utiliza expresiones regulares estructuradas y mapeo directo de entidades [cite: 1]. Este enfoque ofrece un consumo de memoria inferior a 1 MB y latencias nulas (< 5 ms), garantizando la ejecución inmediata de la herramienta domótica cuando la transcripción coincide con los nombres de las entidades registradas [cite: 1].

| Motor NLU | Arquitectura de Inferencia | Consumo de RAM | Latencia | Precisión Semántica en Español |
| :--- | :--- | :--- | :--- | :--- |
| **HA Assist Regex Engine** | Patrones Gramaticales / Regex | < 1 MB | < 5 ms | Determinista; requiere coincidencia con entidades registradas [cite: 1] |
| **Snips NLU** | Estadístico (CRF + Linear) | ~20 MB – 50 MB [cite: 2, 15] | < 20 ms [cite: 15] | Elevada; flexible ante pequeñas variaciones en la transcripción [cite: 2] |
| **Rasa DIET** | Transformer Multitarea Ligero | ~2 GB – 4 GB [cite: 17, 18] | ~100 ms | Muy elevada; soporta contexto y sintaxis compleja [cite: 16] |

## Síntesis de Voz (Text-to-Speech)

Para completar la interacción sin requerir llamadas a APIs de terceros, el sistema convierte la respuesta de confirmación en señal audible a través de un motor de síntesis local [cite: 1, 8, 19].

El motor `Piper TTS` destaca como la solución estándar en sistemas embebidos [cite: 1, 8]. Desarrollado sobre la arquitectura de síntesis neuronal VITS y exportado al formato ONNX, Piper genera voz natural en tiempo real en procesadores ARM de bajo consumo [cite: 5, 8]. Dispone de modelos específicos entrenados para el idioma español (como las voces `es_ES` y `es_MX`) en distintos grados de resolución (`low`, `medium`, `high`) [cite: 5]. La variante `medium` requiere aproximadamente 85 MB de RAM y presenta un factor de tiempo real inferior a 0.15x en procesadores Quad-Core ARM64, entregando la respuesta de audio de manera instantánea [cite: 5].

## Protocolo de Integración Modular: Wyoming

La orquestación desacoplada de los modelos descritos se resuelve mediante el protocolo abierto **Wyoming** [cite: 1, 19]. Wyoming define un estándar de comunicación liviano orientado a eventos sobre sockets TCP, permitiendo que la captura de audio, la detección de palabras de activación, el reconocimiento de habla, el procesamiento NLU y la síntesis de voz funcionen como microservicios aislados [cite: 1, 19].

| Etapa del Pipeline | Componente Wyoming | Datos de Entrada | Datos de Salida | Protocolo / Función |
| :--- | :--- | :--- | :--- | :--- |
| **1. Captura y KWS** | `wyoming-openwakeword` | Flujo Audio WAV (PCM 16kHz) [cite: 1] | Evento `detection` (Wake Word) [cite: 8, 20] | Filtra el audio localmente hasta detectar la activación [cite: 1, 8] |
| **2. Transcripción ASR** | `wyoming-whisper` | Ráfaga de Audio WAV post-activación [cite: 1] | Cadena de Texto Transcrita [cite: 1] | Procesa el audio mediante `whisper.cpp` o `faster-whisper` [cite: 1, 6, 7] |
| **3. Extracción de Intención** | `wyoming-intent` / HA Engine | Cadena de Texto Transcrita [cite: 1] | Estructura JSON (Intent + Slots) [cite: 2] | Ejecuta la llamada a la herramienta domótica objetivo [cite: 1, 2] |
| **4. Síntesis de Respuesta** | `wyoming-piper` | Texto de Confirmación [cite: 1] | Flujo de Audio WAV de Salida [cite: 1] | Sintetiza la respuesta hablada mediante Piper TTS [cite: 1, 8, 19] |

Esta modularidad permite que la captura del sonido sea delegada a satélites distribuidos de bajo costo instalados en diferentes habitaciones (por ejemplo, placas ESP32-S3 o dispositivos con `wyoming-satellite`), mientras que el procesamiento de las capas de Machine Learning se centraliza en un único servidor doméstico modesto [cite: 1, 19, 21].

## Evaluación de Hardware y Matriz de Despliegue

La viabilidad operativa de una canalización integral libre de LLMs (compuesta por `openWakeWord`, `Whisper Base`, `Snips NLU` y `Piper TTS`) se analiza a continuación sobre tres plataformas de hardware habituales para servidores de automatización doméstica.

| Plataforma de Hardware | Arquitectura de CPU | RAM del Sistema | Latencia de Procesamiento Total | Carga Media de CPU | Evaluación de Viabilidad |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Raspberry Pi 4B** | 4x Cortex-A72 @ 1.5GHz | 4 GB / 8 GB [cite: 1] | 800 ms – 1,200 ms | < 5% en reposo / ~60% en pico | **Viable**: Ejecución fluida para un único canal de voz [cite: 1, 22] |
| **Raspberry Pi 5** | 4x Cortex-A76 @ 2.4GHz | 4 GB / 8 GB | 350 ms – 600 ms | < 2% en reposo / ~35% en pico | **Excelente**: Respuesta percibida como instantánea [cite: 7] |
| **Mini PC x86 (Intel N100)** | 4x Alder Lake-N @ 3.4GHz | 8 GB / 16 GB | 200 ms – 400 ms | < 1% en reposo / ~20% en pico | **Óptima**: Permite procesamiento simultáneo multicanal |

### Desglose del Consumo de Memoria RAM en Inferencia Concurrent

En el pico de procesamiento de un comando de voz en español, el consumo de memoria asignado a los componentes de la canalización en el servidor central se distribuye de la siguiente forma:

1. Servicio `wyoming-openwakeword`: 35 MB [cite: 3]
2. Servicio `wyoming-whisper` (Whisper Base INT8): 390 MB [cite: 4]
3. Motor NLU (Snips / HA Assist Engine): 30 MB [cite: 2, 15]
4. Servicio `wyoming-piper` (Modelo Medium): 85 MB [cite: 5]
5. Orquestador del Sistema / Protocolo Wyoming: 200 MB [cite: 1]

El consumo global del sistema de voz se consolida en aproximadamente **740 MB de RAM**, representando una fracción mínima de los recursos del sistema en comparación con los más de 20 GB requeridos por las arquitecturas basadas en Modelos de Gran Lenguaje.

## Conclusiones

La integración de Modelos de Gran Lenguaje en la infraestructura de voz de una casa inteligente introduce requerimientos de cómputo, consumo energético y latencia que resultan desproporcionados para la ejecución de tareas domóticas deterministas. Además de exigir arquitecturas con más de 20 GB de memoria RAM y unidades GPU dedicadas, la naturaleza estocástica de los LLMs introduce variabilidad en la interpretación de comandos sencillos.

La implementación de una arquitectura especializada basada en **openWakeWord**, **whisper.cpp (Whisper Base INT8)**, **Snips NLU** (o motores de patrones gramaticales) y **Piper TTS**, integrados bajo el protocolo **Wyoming**, demuestra ser la alternativa técnica óptima [cite: 1, 2, 6, 8]. Esta combinación garantiza un procesamiento local de voz en español con un consumo de RAM inferior a 1 GB, latencias de respuesta globales por debajo de los 600 ms en plataformas como la Raspberry Pi 5 y un cumplimiento estricto de los requisitos de código abierto y privacidad local en el hogar [cite: 1, 3, 4, 7, 8].