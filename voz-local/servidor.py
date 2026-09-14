#!/usr/bin/env python3
"""API HTTP de control del asistente para el front (motor y wake word en caliente, QA).

  .venv/bin/python servidor.py [--puerto 8766] [--sin-mic] [mismas opciones que asistente.py]

Endpoints (JSON, CORS abierto). Contrato completo en CONTRATO.md.
  GET  /estado                 configuración actual y motores disponibles
  POST /config                 {"motor"?, "wake"?, "umbral"?, "mudo"?, "mic_pausado"?}
  POST /escuchar               push-to-talk: graba una orden del micrófono sin wake word
  POST /texto                  {"texto", "hablar"?}
  POST /audio?motor=&hablar=   cuerpo = audio en cualquier formato (wav/webm/ogg); ciclo completo
  POST /comparar?motores=a,b&esperado=Intent   cuerpo = audio; QA sin ejecutar acciones
  POST /tts-comparar           {"frase", "motores"?, "esperado"?, "slots"?} audio generado con Piper
  POST /autotest               {"motores"?, "frases"?: [[frase, intent, slots], ...]}
  POST /recargar               relee intenciones.yaml (y regenera la gramática de Vosk)
"""
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

from asistente import SR, MOTORES_INTENT, Asistente, crear_parser, log
from motores import CATALOGO

asistente: Asistente = None


def decodificar(datos):
    """Cualquier formato de audio -> float32 mono 16 kHz (vía ffmpeg)."""
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le",
                        "-ac", "1", "-ar", str(SR), "pipe:1"],
                       input=datos, capture_output=True, check=False)
    if r.returncode != 0 or not r.stdout:
        raise ValueError(f"no se pudo decodificar el audio: {r.stderr.decode()[-200:]}")
    return (np.frombuffer(r.stdout, np.int16) / 32768).astype(np.float32)


def lista_motores(valor):
    motores = [m for m in (valor or "").split(",") if m] if isinstance(valor, str) else (valor or [])
    return motores or list(CATALOGO)


def lista_intent(valor):
    """Motores de intent a comparar. Ausente = None (usa el activo). 'all' = todos."""
    if valor in (None, ""):
        return None
    lst = [m for m in valor.split(",") if m] if isinstance(valor, str) else list(valor)
    return list(MOTORES_INTENT) if lst == ["all"] else (lst or None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _responder(self, codigo, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _cuerpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self):
        datos = self._cuerpo()
        return json.loads(datos) if datos else {}

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/estado":
            return self._responder(200, asistente.estado())
        self._responder(404, {"error": f"ruta desconocida: {url.path}"})

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        a = asistente
        try:
            if url.path == "/config":
                return self._responder(200, a.configurar(**self._json()))
            if url.path == "/escuchar":
                a.forzar_escucha = True
                return self._responder(202, {"ok": True})
            if url.path == "/recargar":
                a.recargar_intenciones()
                return self._responder(200, {"ok": True})
            if url.path == "/texto":
                b = self._json()
                with a.lock:
                    return self._responder(200, a.procesar_texto(b["texto"], b.get("hablar", False), "front"))
            if url.path == "/audio":
                audio = decodificar(self._cuerpo())
                with a.lock:
                    r = a.procesar_audio(audio, hablar=q.get("hablar") == "1",
                                         motor=q.get("motor"), origen="front")
                return self._responder(200, r)
            if url.path == "/comparar":
                audio = decodificar(self._cuerpo())
                with a.lock:
                    r = a.comparar(audio, lista_motores(q.get("motores")), q.get("esperado"),
                                   motores_intent=lista_intent(q.get("motores_intent")))
                return self._responder(200, {"resultados": r})
            if url.path == "/tts-comparar":
                b = self._json()
                with a.lock:
                    r = a.comparar(a.audio_de_frase(b["frase"]), lista_motores(b.get("motores")),
                                   b.get("esperado"), b.get("slots"),
                                   motores_intent=lista_intent(b.get("motores_intent")))
                return self._responder(200, {"frase": b["frase"], "resultados": r})
            if url.path == "/autotest":
                b = self._json()
                frases = [tuple(f) for f in b["frases"]] if b.get("frases") else None
                with a.lock:
                    return self._responder(200, a.autotest(lista_motores(b.get("motores")), frases,
                                                           motores_intent=lista_intent(b.get("motores_intent"))))
            self._responder(404, {"error": f"ruta desconocida: {url.path}"})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            self._responder(400, {"error": str(e)})
        except Exception as e:
            log("servidor", f"error en {url.path}: {e!r}")
            self._responder(500, {"error": repr(e)})


def main():
    global asistente
    p = crear_parser()
    p.add_argument("--puerto", type=int, default=8766)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--sin-mic", action="store_true", help="no abrir el micrófono (solo API)")
    args = p.parse_args()
    asistente = Asistente(args)
    asistente.motores.obtener(asistente.motor)
    if not args.sin_mic:
        threading.Thread(target=asistente.modo_microfono, daemon=True).start()
    servidor = ThreadingHTTPServer((args.host, args.puerto), Handler)
    log("servidor", f"API en http://{args.host}:{args.puerto} (motor {asistente.motor})")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
