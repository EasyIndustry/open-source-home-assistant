#!/usr/bin/env bash
# Levanta voz-local/servidor.py (API de voz, :8766) y el simulador web (:8765).
#   ./run.sh              servidor.py con micrófono del host + simulador
#   ./run.sh --sin-mic    servidor.py solo API (usás el micrófono del navegador)
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
VOZ="${VOZ_LOCAL:-$AQUI/../voz-local}"
PY="$VOZ/.venv/bin/python"
EXTRA=()
[[ "${1:-}" == "--sin-mic" ]] && EXTRA=(--sin-mic)

for puerto in 8765 8766; do
  if ss -ltnp 2>/dev/null | grep -q ":$puerto "; then
    echo "El puerto $puerto está ocupado por:" >&2
    ss -ltnp | grep ":$puerto " | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r ps -o pid=,args= -p >&2
    echo "Cerralo (kill <pid>) y volvé a correr ./run.sh" >&2
    exit 1
  fi
done

export EVENTOS_URL=http://127.0.0.1:8765/eventos ACCIONES_URL=http://127.0.0.1:8765/acciones
(cd "$VOZ" && exec "$PY" servidor.py --puerto 8766 --intenciones "$AQUI/intenciones-casa.yaml" "${EXTRA[@]}") &
VOZ_PID=$!
trap 'kill $VOZ_PID 2>/dev/null' EXIT
cd "$AQUI" && "$PY" server.py
