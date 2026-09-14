#!/usr/bin/env bash
# Instala lo pesado para entrenar wake words. Corré esto en la sesión donde vayas a entrenar.
# Requiere GPU NVIDIA (hay una RTX 3060) y el venv de voz-local.
set -e
VENV="$(cd "$(dirname "$0")/.." && pwd)/.venv"
PIP="$VENV/bin/pip"
echo ">> torch con CUDA 12.1 (~2.5 GB)"
"$PIP" install torch --index-url https://download.pytorch.org/whl/cu121
echo ">> piper-sample-generator (genera voz sintética para los positivos)"
"$PIP" install piper-sample-generator
echo ">> verificando GPU"
"$VENV/bin/python" -c "import torch; print('CUDA disponible:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'sin GPU')"
cat <<'MSG'

Listo el entorno. Próximos pasos (ver README.md):
  1. Editá config.yaml con tu palabra.
  2. Bajá los datasets negativos del notebook oficial de openWakeWord.
  3. Corré el flujo de automatic_model_training.ipynb.
MSG
