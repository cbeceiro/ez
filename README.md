# Cuentos para dormir

PWA que reproduce cuentos narrados con una voz clonada. Los cuentos se escriben y se publican desde el ordenador; la app solo los lee y los reproduce.

```
cuentos/*.md  →  herramientas/publicar.py  →  Supabase (tabla cuentos + bucket cuentos-audio)  →  app/
```

## Añadir o cambiar un cuento

1. Crea `cuentos/mi-cuento.md`:

   ```markdown
   ---
   titulo: Mi cuento
   descripcion: Una línea que se ve en la lista.
   orden: 4
   ---

   Texto del cuento…
   ```

2. Publica:

   ```bash
   python3 herramientas/publicar.py
   ```

Solo se genera audio para los cuentos nuevos o cuyo texto ha cambiado. La app los muestra la próxima vez que se abra.

## Configuración (una vez)

- Copia `.env.example` a `.env` y rellena las claves de ElevenLabs y Supabase.
- Aplica `supabase/esquema.sql` en el proyecto de Supabase.
- Pon la URL y la clave pública del proyecto en `app/config.js`.
- Sube la carpeta `app/` a un hosting estático con HTTPS.

## Probar en local sin claves

```bash
python3 herramientas/publicar.py --demo
python3 -m http.server 5173 --directory app
```

Genera los audios con la voz del Mac en `app/demo/` (se usa mientras `app/config.js` esté vacío).
