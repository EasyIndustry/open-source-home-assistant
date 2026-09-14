# Entrenar una wake word propia (openWakeWord)

Andamiaje para entrenar una palabra de activación en español (ej. "che casa", "hola casa").
**No está corrido todavía** — es para retomar en otra sesión. Requiere GPU (hay una RTX 3060).

## Estado actual (lo que YA está listo)
- Los modelos de *features* que usa el entrenamiento ya vienen con openWakeWord y están en disco:
  `melspectrogram.onnx` y `embedding_model.onnx` (en `.venv/.../openwakeword/resources/models/`).
  El entrenamiento **no** entrena esos; entrena solo el clasificador final (la capa que decide "es la palabra / no lo es"), que es lo liviano.
- El asistente ya sabe cargar cualquier `.onnx` de wake word (ver "Usar el modelo entrenado").

## Lo que falta instalar (pesado, por eso no se hizo ahora)
```bash
# desde voz-local/, con el venv activo
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121   # ~2.5 GB, usa la GPU
.venv/bin/pip install piper-sample-generator                                     # genera voz sintética
```
Corré `preparar_entorno.sh` que hace esto y baja el modelo generador de voz.

## Cómo funciona el entrenamiento (resumen)
openWakeWord entrena con muestras **sintéticas**, no hace falta grabar tu voz:
1. **Positivos:** se generan miles de clips diciendo la palabra con `piper-sample-generator`
   (muchas voces, velocidades y tonos distintos).
2. **Negativos / fondo:** clips que NO son la palabra (habla, ruido, música) + impulsos de sala
   para simular reverberación. openWakeWord publica estos datasets (ACAV100M, FMA, RIRs).
3. Se calculan los *embeddings* de todos los clips con los modelos de features (ya presentes).
4. Se entrena un clasificador chico sobre esos embeddings. Sale un `.onnx` de <100 KB.

Referencia oficial (la fuente de verdad, seguir esto):
- https://github.com/dscripka/openWakeWord  → carpeta `notebooks/` (`automatic_model_training.ipynb`)
- El notebook automático baja los datasets negativos y hace los 4 pasos. Corre en Colab o local con GPU.

## Pasos para retomar
1. `bash preparar_entorno.sh` (instala torch + piper-sample-generator, baja el generador).
2. Editar `config.yaml` (la palabra, cantidad de muestras).
3. Bajar los datasets negativos que indica el notebook oficial (varios GB, una sola vez).
4. Correr el flujo del notebook `automatic_model_training.ipynb` apuntando a `config.yaml`.
5. Copiar el `.onnx` resultante a `voz-local/modelos/wakeword/<nombre>.onnx`.

## Usar el modelo entrenado
Cuando exista el `.onnx`, hay que registrar la palabra en `asistente.py` (lista `WAKE_WORDS`)
y que `openwakeword.model.Model` lo cargue por ruta. Ver la nota en `config.yaml`.
Esto es un cambio chico que se hace al final, cuando el modelo esté entrenado.

## Costos y expectativas
- Generar positivos + entrenar: ~30-90 min en la RTX 3060 (una vez bajados los negativos).
- Los datasets negativos: descarga grande (varios GB), se hace una sola vez.
- Precisión: una palabra de 3-4 sílabas y poco común anda mejor; palabras cortas dan más falsos disparos.
