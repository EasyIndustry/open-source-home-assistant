# Pulir y "entrenar" los intents

Sí, se puede mejorar el reconocimiento sin tocar código. Hay dos niveles:

## 1. Editar la gramática (afecta a los tres motores)
La fuente de verdad es `intenciones.yaml` (o el que uses con `--intenciones`, ej. la web usa
`web-app-assistant/intenciones-casa.yaml`). Ahí agregás:
- **Sinónimos y variantes** en las `sentences` de cada intent (ej. sumar "poné"/"encendé"/"activá").
- **Valores nuevos** en las `lists` (ej. una habitación nueva en `area`, un dispositivo en `dispositivo`).
- **Intenciones nuevas** (bloque nuevo bajo `intents:` + su respuesta en `respuestas:`).

Después:
- En vivo: botón "↻ intenciones" de la web, o `POST /recargar`.
- Esto **reconstruye** la gramática de hassil, el vocabulario de la corrección difusa y la
  gramática de `vosk-gramatica`. El clasificador `intent-ml` se reentrena solo la próxima vez
  que se use (detecta que el YAML cambió por su hash).

## 2. Medir con casos de prueba (para no romper lo que andaba)
`casos-prueba.yaml` tiene una lista de `[frase, intent_esperado, slots_esperados]`.
Agregá ahí cada comando que falle en la vida real (mirá el panel NLU de la web para copiar
la transcripción exacta) y corré el benchmark:

```bash
.venv/bin/python asistente.py --autotest --casos casos-prueba.yaml \
  --comparar whisper-base,vosk-gramatica --comparar-intent hassil,hassil-fuzzy
```

Te da la matriz motor STT × motor de intent con aciertos y tiempos. Así ves si un cambio en
`intenciones.yaml` mejora o empeora, y con qué combinación conviene ir.

> El audio de los casos lo genera Piper (voz sintética). Para probar con tu voz real, grabá
> desde la web (QA) que manda el audio a `/comparar`.

## 3. El clasificador entrenado (intent-ml) — experimental
`intent-ml` (ver `intent_ml.py`) aprende de las mismas frases de `intenciones.yaml`, así que
"entrenar" es, otra vez, mejorar el YAML. Está **solo como infraestructura**: se usa por CLI
(`--motor-intent intent-ml` / `--comparar-intent ...,intent-ml`) o por API, y **no aparece en
el front**. Pendiente para otra sesión: agregarle una clase "ninguno" con frases fuera de
dominio para bajar falsos positivos (hoy, sin negativos, a veces clasifica de más — ej.
"hola qué tal" → ConsultarHora).
