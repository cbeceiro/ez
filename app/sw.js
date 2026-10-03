const SHELL = 'shell-v1';
const AUDIO = 'audio-v1';
const FICHEROS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FICHEROS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method === 'GET') e.respondWith(responder(e.request));
});

async function responder(req) {
  const guardado = await (await caches.open(AUDIO)).match(req.url);
  if (guardado) return conRango(req, guardado);

  const propio = new URL(req.url).origin === location.origin;
  if (!propio || req.destination === 'audio') return fetch(req);

  // La app se sirve primero de la red para que las actualizaciones lleguen al abrirla;
  // la copia guardada solo se usa sin conexión.
  try {
    // 'no-cache' obliga a revalidar con el servidor en lugar de usar la caché HTTP del navegador.
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.status === 200) (await caches.open(SHELL)).put(req, r.clone());
    return r;
  } catch (err) {
    const copia = await caches.match(req, { ignoreSearch: true });
    if (copia) return copia;
    throw err;
  }
}

// Safari pide el audio por rangos y rechaza una respuesta completa, así que se recorta a mano.
async function conRango(req, resp) {
  const rango = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  if (!rango) return resp;
  const blob = await resp.blob();
  const ini = Number(rango[1]);
  const fin = rango[2] ? Math.min(Number(rango[2]), blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(ini, fin + 1), {
    status: 206,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${ini}-${fin}/${blob.size}`,
      'Content-Length': String(fin - ini + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
