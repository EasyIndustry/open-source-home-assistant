"""Motor de intent entrenado: clasificador ligero sobre frases generadas desde intenciones.yaml.

- Datos de entrenamiento: hassil muestrea miles de frases válidas por intent (sin depender de
  audio real). Los slots de rango ({brillo}/{temperatura}) se reemplazan por números al azar.
- Modelo: TF-IDF (palabras 1-2 + n-gramas de caracteres 3-5) + Regresión Logística. Los n-gramas
  de caracteres lo hacen tolerante a errores del STT. Pesa ~1-2 MB, entrena en pocos segundos.
- Slots: se extraen del texto con las listas del propio YAML (fuzzy para texto, regex para números).
- Fuera de dominio: si la confianza del clasificador es baja, devuelve None (no inventa intent).

Se cachea a disco por hash del YAML; se reentrena solo si el YAML cambió.
"""
import hashlib
import random
import re
import unicodedata
from pathlib import Path

import yaml

MODELOS = Path(__file__).parent / "modelos"
UMBRAL_CONFIANZA = 0.35


def _norm(t):
    t = unicodedata.normalize("NFD", t.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^\w%\s]", " ", t)).strip()


class MotorIntentML:
    def __init__(self, ruta_yaml, numeros):
        self.ruta = Path(ruta_yaml)
        self.numeros = numeros
        datos = yaml.safe_load(open(self.ruta, encoding="utf-8"))
        datos.pop("respuestas", None)
        self._analizar_slots(datos)
        h = hashlib.md5(open(self.ruta, "rb").read()).hexdigest()[:10]
        self.cache = MODELOS / f"intent_clf_{self.ruta.stem}_{h}.joblib"
        self.clf = self._cargar_o_entrenar(datos)

    # --- slots desde el YAML ---
    def _analizar_slots(self, datos):
        self.intent_slots = {}
        for name, d in datos["intents"].items():
            ss = set()
            for b in d["data"]:
                for s in b["sentences"]:
                    ss |= set(re.findall(r"\{(\w+)\}", s))
            self.intent_slots[name] = ss
        self.text_slots = {}   # slot -> [(surfaces_normalizadas[], out)]
        self.range_slots = {}  # slot -> (from, to)
        for ln, lv in datos.get("lists", {}).items():
            if "range" in lv:
                self.range_slots[ln] = (lv["range"]["from"], lv["range"]["to"])
                continue
            opciones = []
            for v in lv["values"]:
                if isinstance(v, dict):
                    surfaces = [_norm(x) for x in v["in"].strip("()").split("|")]
                    opciones.append((surfaces, v.get("out", surfaces[0])))
                else:
                    opciones.append(([_norm(v)], v))
            self.text_slots[ln] = opciones

    def _extraer_slots(self, intent, texto):
        from rapidfuzz import fuzz
        norm = _norm(texto)
        palabras = norm.split()
        slots = {}
        for slot in self.intent_slots.get(intent, ()):
            if slot in self.range_slots:
                lo, hi = self.range_slots[slot]
                for n in re.findall(r"\d+", norm):
                    if lo <= int(n) <= hi:
                        slots[slot] = int(n)
                        break
            elif slot in self.text_slots:
                mejor, mejor_score = None, 0
                for surfaces, out in self.text_slots[slot]:
                    for surf in surfaces:
                        sp = surf.split()
                        # ventana de tamaño de la superficie sobre las palabras del texto
                        for i in range(len(palabras) - len(sp) + 1):
                            cand = " ".join(palabras[i:i + len(sp)])
                            sc = fuzz.ratio(cand, surf)
                            if sc > mejor_score:
                                mejor, mejor_score = out, sc
                if mejor is not None and mejor_score >= 80:
                    slots[slot] = mejor
        return slots

    # --- entrenamiento del clasificador ---
    def _datos_entrenamiento(self, datos):
        from hassil import Intents
        from hassil.sample import sample_intents
        it = Intents.from_dict(datos)
        X, y = [], []
        for name, sent in sample_intents(it, language="es", expand_ranges=False,
                                          max_sentences_per_intent=4000):
            s = _norm(sent)
            # reemplazar placeholders de rango por números al azar en el rango
            for slot, (lo, hi) in self.range_slots.items():
                while "{" + slot + "}" in sent or "{" + slot.lower() + "}" in sent:
                    break
            s = re.sub(r"\{(\w+)\}", lambda m: str(random.randint(*self.range_slots.get(m[1], (0, 99)))), s)
            X.append(s)
            y.append(name)
        return X, y

    def _construir(self):
        from sklearn.pipeline import Pipeline, FeatureUnion
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        return Pipeline([
            ("feat", FeatureUnion([
                ("palabra", TfidfVectorizer(analyzer="word", ngram_range=(1, 2))),
                ("caracter", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5))),
            ])),
            ("clf", LogisticRegression(max_iter=1000, class_weight="balanced", C=8)),
        ])

    def _cargar_o_entrenar(self, datos):
        import joblib
        if self.cache.exists():
            try:
                return joblib.load(self.cache)
            except Exception:
                pass
        random.seed(0)
        X, y = self._datos_entrenamiento(datos)
        clf = self._construir()
        clf.fit(X, y)
        MODELOS.mkdir(exist_ok=True)
        joblib.dump(clf, self.cache)
        return clf

    # --- inferencia ---
    def reconocer(self, texto):
        s = _norm(texto)
        if not s:
            return None
        probs = self.clf.predict_proba([s])[0]
        i = probs.argmax()
        conf = float(probs[i])
        if conf < UMBRAL_CONFIANZA:
            return None
        intent = self.clf.classes_[i]
        return {"intent": intent, "slots": self._extraer_slots(intent, texto),
                "confianza": round(conf, 3)}
