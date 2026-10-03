#!/usr/bin/env python3
"""Publica los cuentos de cuentos/*.md: genera el audio con la voz clonada y lo sube a Supabase.

Uso:
  python3 herramientas/publicar.py           publica los cuentos nuevos o modificados y retira los borrados
  python3 herramientas/publicar.py --forzar  regenera el audio de todos
  python3 herramientas/publicar.py --demo    prueba local con la voz del Mac (sin claves ni Supabase)
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent
CUENTOS = RAIZ / "cuentos"
DEMO = RAIZ / "app" / "demo"
BUCKET = "cuentos-audio"
MAX_TROZO = 4000  # caracteres por petición a ElevenLabs
KBPS = 128


def cargar_env():
    fichero = RAIZ / ".env"
    if not fichero.exists():
        return
    for linea in fichero.read_text().splitlines():
        if "=" in linea and not linea.strip().startswith("#"):
            clave, valor = linea.split("=", 1)
            os.environ.setdefault(clave.strip(), valor.strip().strip("\"'"))


def leer_cuento(ruta):
    crudo = ruta.read_text(encoding="utf-8")
    meta = {}
    if crudo.startswith("---"):
        _, cabecera, crudo = crudo.split("---", 2)
        for linea in cabecera.strip().splitlines():
            clave, _, valor = linea.partition(":")
            meta[clave.strip()] = valor.strip()
    titulo = meta.get("titulo", ruta.stem)
    texto = crudo.strip()
    return {
        "slug": ruta.stem,
        "titulo": titulo,
        "descripcion": meta.get("descripcion", ""),
        "orden": int(meta.get("orden", 0)),
        "texto": texto,
        "narracion": f"{titulo}.\n\n{texto}",
    }


def trocear(texto):
    """Agrupa párrafos en trozos que caben en una petición."""
    trozos, actual = [], ""
    for parrafo in re.split(r"\n\s*\n", texto):
        if actual and len(actual) + len(parrafo) > MAX_TROZO:
            trozos.append(actual)
            actual = ""
        actual = f"{actual}\n\n{parrafo}" if actual else parrafo
    if actual:
        trozos.append(actual)
    return trozos


def voz_elevenlabs(narracion, clave, voz, modelo):
    trozos = trocear(narracion)
    audio = b""
    for i, trozo in enumerate(trozos):
        cuerpo = {
            "text": trozo,
            "model_id": modelo,
            "voice_settings": {"stability": 0.6, "similarity_boost": 0.8},
        }
        # El contexto de los trozos vecinos mantiene la entonación entre peticiones.
        if i > 0:
            cuerpo["previous_text"] = trozos[i - 1][-500:]
        if i < len(trozos) - 1:
            cuerpo["next_text"] = trozos[i + 1][:500]
        r = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voz}",
            params={"output_format": f"mp3_44100_{KBPS}"},
            headers={"xi-api-key": clave},
            json=cuerpo,
            timeout=300,
        )
        if not r.ok:
            sys.exit(f"ElevenLabs respondió {r.status_code}: {r.text[:300]}")
        audio += r.content
    return audio


class Supabase:
    def __init__(self, url, clave):
        self.url = url.rstrip("/")
        self.sesion = requests.Session()
        self.sesion.headers.update({"apikey": clave, "Authorization": f"Bearer {clave}"})

    def _pedir(self, metodo, ruta, **kw):
        r = self.sesion.request(metodo, f"{self.url}{ruta}", timeout=120, **kw)
        if not r.ok:
            sys.exit(f"Supabase respondió {r.status_code} en {ruta}: {r.text[:300]}")
        return r

    def publicados(self):
        filas = self._pedir("GET", "/rest/v1/cuentos", params={"select": "slug,texto_hash,audio_url"}).json()
        return {f["slug"]: f for f in filas}

    def subir_audio(self, nombre, audio):
        self._pedir(
            "POST",
            f"/storage/v1/object/{BUCKET}/{nombre}",
            data=audio,
            headers={"Content-Type": "audio/mpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000"},
        )
        return f"{self.url}/storage/v1/object/public/{BUCKET}/{nombre}"

    def guardar(self, fila):
        self._pedir(
            "POST",
            "/rest/v1/cuentos",
            params={"on_conflict": "slug"},
            json=fila,
            headers={"Prefer": "resolution=merge-duplicates"},
        )

    def actualizar(self, slug, campos):
        self._pedir("PATCH", "/rest/v1/cuentos", params={"slug": f"eq.{slug}"}, json=campos)

    def borrar_audio(self, url):
        self._pedir("DELETE", f"/storage/v1/object/{BUCKET}/{url.rsplit('/', 1)[-1]}")

    def borrar(self, fila):
        self._pedir("DELETE", "/rest/v1/cuentos", params={"slug": f"eq.{fila['slug']}"})
        self.borrar_audio(fila["audio_url"])


def publicar(cuentos, forzar):
    cargar_env()
    necesarias = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]
    faltan = [v for v in necesarias if not os.environ.get(v)]
    if faltan:
        sys.exit(f"Faltan variables en .env: {', '.join(faltan)}")
    voz = os.environ["ELEVENLABS_VOICE_ID"]
    modelo = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
    supa = Supabase(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    publicados = supa.publicados()

    for c in cuentos:
        # La huella incluye voz y modelo: cambiar cualquiera de los dos regenera el audio.
        huella = hashlib.sha256(f"{voz}|{modelo}|{c['narracion']}".encode()).hexdigest()[:12]
        datos = {"titulo": c["titulo"], "descripcion": c["descripcion"], "orden": c["orden"]}
        anterior = publicados.pop(c["slug"], None)
        if anterior and anterior["texto_hash"] == huella and not forzar:
            supa.actualizar(c["slug"], datos)
            print(f"  sin cambios   {c['slug']}")
            continue
        print(f"  generando voz {c['slug']} ({len(c['narracion'])} caracteres)…")
        audio = voz_elevenlabs(c["narracion"], os.environ["ELEVENLABS_API_KEY"], voz, modelo)
        url = supa.subir_audio(f"{c['slug']}-{huella}.mp3", audio)
        supa.guardar({
            **datos,
            "slug": c["slug"],
            "texto": c["texto"],
            "texto_hash": huella,
            "audio_url": url,
            "duracion_s": round(len(audio) * 8 / (KBPS * 1000)),
        })
        if anterior and anterior["audio_url"] != url:
            supa.borrar_audio(anterior["audio_url"])
        print(f"  publicado     {c['slug']}")

    # La carpeta cuentos/ manda: lo que ya no tiene fichero se retira de la app.
    for fila in publicados.values():
        supa.borrar(fila)
        print(f"  borrado       {fila['slug']}")


def demo(cuentos):
    """Genera audio con la voz del Mac en app/demo/ para probar la app sin gastar créditos."""
    (DEMO / "audio").mkdir(parents=True, exist_ok=True)
    voces = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    espanola = re.search(r"^(.+?)\s+es_ES", voces, re.M)
    voz = ["-v", espanola.group(1).strip()] if espanola else []
    catalogo = []
    for c in cuentos:
        destino = DEMO / "audio" / f"{c['slug']}.m4a"
        with tempfile.TemporaryDirectory() as tmp:
            texto, aiff = Path(tmp) / "t.txt", Path(tmp) / "t.aiff"
            texto.write_text(c["narracion"], encoding="utf-8")
            subprocess.run(["say", *voz, "-o", str(aiff), "-f", str(texto)], check=True)
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", str(aiff), str(destino)], check=True)
        info = subprocess.run(["afinfo", str(destino)], capture_output=True, text=True).stdout
        duracion = re.search(r"estimated duration: ([\d.]+)", info)
        catalogo.append({
            "slug": c["slug"],
            "titulo": c["titulo"],
            "descripcion": c["descripcion"],
            "audio_url": f"demo/audio/{destino.name}",
            "duracion_s": round(float(duracion.group(1))) if duracion else None,
        })
        print(f"  demo          {c['slug']}")
    (DEMO / "catalogo.json").write_text(json.dumps(catalogo, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--forzar", action="store_true", help="regenera el audio aunque el texto no haya cambiado")
    parser.add_argument("--demo", action="store_true", help="genera audio local con la voz del Mac")
    args = parser.parse_args()

    cuentos = sorted((leer_cuento(p) for p in CUENTOS.glob("*.md")), key=lambda c: (c["orden"], c["slug"]))
    if not cuentos:
        sys.exit("No hay cuentos en cuentos/*.md")
    print(f"{len(cuentos)} cuentos encontrados")
    demo(cuentos) if args.demo else publicar(cuentos, args.forzar)


if __name__ == "__main__":
    main()
