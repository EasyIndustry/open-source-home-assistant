#!/usr/bin/env bash
# Descarga los modelos que NO están en el repo (voz-local/modelos/).
# faster-whisper baja Whisper solo en el primer uso; acá bajamos voz (Piper) y Vosk.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)/modelos"
VENV="$(cd "$(dirname "$0")" && pwd)/.venv"
mkdir -p "$DIR"

echo ">> Voz Piper es_AR-daniela-high"
"$VENV/bin/python" -m piper.download_voices --download-dir "$DIR" es_AR-daniela-high

echo ">> Modelo Vosk español (small)"
if [ ! -d "$DIR/vosk-model-small-es-0.42" ]; then
  curl -L -o "$DIR/vosk.zip" https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
  unzip -q -o "$DIR/vosk.zip" -d "$DIR" && rm "$DIR/vosk.zip"
fi

echo ">> Modelos de wake word y features de openWakeWord"
"$VENV/bin/python" -c "from openwakeword import utils; utils.download_models(['hey_jarvis','alexa','hey_mycroft','hey_rhasspy'])"

echo ">> Whisper (base) se baja solo en el primer uso; forzamos la descarga ahora"
"$VENV/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8', download_root='$DIR/whisper')"

echo "Listo. El clasificador intent-ml (modelos/intent_clf_*.joblib) se genera solo al usarlo."
