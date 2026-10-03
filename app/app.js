const CFG = window.CONFIG || {};
const CACHE_AUDIO = 'audio-v1';
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const leer = (clave, defecto) => {
  try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; }
};
const guardar = (clave, valor) => {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
};

let cuentos = [];
let actual = null;
let modo = leer('modo', 'fin'); // 'fin' | 'seguido' | minutos
let limite = null; // instante (ms) en el que el temporizador detiene la reproducción
const posiciones = leer('posiciones', {});
const descargados = new Set();

const mmss = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function cargarCatalogo() {
  try {
    const r = CFG.supabaseUrl
      ? await fetch(
          `${CFG.supabaseUrl}/rest/v1/cuentos?select=slug,titulo,descripcion,audio_url,duracion_s&publicado=eq.true&order=orden,titulo`,
          { headers: { apikey: CFG.supabaseKey } },
        )
      : await fetch('demo/catalogo.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    cuentos = await r.json();
    guardar('catalogo', cuentos);
    $('estado').textContent = cuentos.length ? '' : 'Todavía no hay cuentos publicados.';
  } catch {
    cuentos = leer('catalogo', []);
    $('estado').textContent = cuentos.length
      ? 'Sin conexión: se muestran los cuentos ya guardados.'
      : 'No se han podido cargar los cuentos. Revisa la conexión.';
  }
  pintarLista();
  descargarAudios();
}

function pintarLista() {
  const lista = $('lista');
  lista.replaceChildren(...cuentos.map((c) => {
    const li = document.createElement('li');
    const boton = document.createElement('button');
    boton.className = 'cuento';
    boton.setAttribute('aria-current', String(actual?.slug === c.slug));
    const titulo = document.createElement('strong');
    titulo.textContent = c.titulo;
    const desc = document.createElement('span');
    desc.textContent = c.descripcion;
    const meta = document.createElement('small');
    const partes = [];
    if (c.duracion_s) partes.push(`${Math.max(1, Math.round(c.duracion_s / 60))} min`);
    if (posiciones[c.slug] > 5) partes.push(`seguir desde ${mmss(posiciones[c.slug])}`);
    if (descargados.has(c.audio_url)) partes.push('✓ sin conexión');
    meta.textContent = partes.join(' · ');
    boton.append(titulo, desc, meta);
    boton.addEventListener('click', () => abrir(c));
    li.append(boton);
    return li;
  }));
}

// Guarda los audios en el dispositivo para que funcionen sin conexión; el service worker los sirve.
async function descargarAudios() {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_AUDIO);
  const vigentes = new Set(cuentos.map((c) => new URL(c.audio_url, location.href).href));
  if (navigator.onLine) {
    for (const peticion of await cache.keys()) {
      if (!vigentes.has(peticion.url)) await cache.delete(peticion);
    }
  }
  for (const c of cuentos) {
    try {
      if (!(await cache.match(c.audio_url))) {
        const r = await fetch(c.audio_url, { mode: 'cors' });
        if (r.status !== 200) continue;
        await cache.put(c.audio_url, r);
      }
      descargados.add(c.audio_url);
      pintarLista();
    } catch { /* se reintentará en la próxima apertura */ }
  }
}

function abrir(cuento, { reproducir = true } = {}) {
  if (actual?.slug === cuento.slug) {
    if (reproducir && audio.paused) audio.play().catch(() => {});
    return;
  }
  actual = cuento;
  guardar('ultimo', cuento.slug);
  const pos = posiciones[cuento.slug] || 0;
  audio.src = cuento.audio_url;
  audio.addEventListener('loadedmetadata', () => {
    if (pos > 5 && pos < audio.duration - 10) audio.currentTime = pos;
  }, { once: true });
  $('titulo-actual').textContent = cuento.titulo;
  $('reproductor').hidden = false;
  document.body.classList.add('con-reproductor');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cuento.titulo,
      artist: 'Cuentos para dormir',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  pintarLista();
  pintarProgreso();
  if (reproducir) audio.play().catch(() => {});
}

function siguiente() {
  const i = cuentos.findIndex((c) => c.slug === actual?.slug);
  return i >= 0 ? cuentos[i + 1] : null;
}

function saltar(segundos) {
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + segundos), audio.duration || 0);
}

function pintarProgreso() {
  const total = audio.duration || actual?.duracion_s || 0;
  $('progreso').max = Math.floor(total) || 100;
  $('progreso').value = Math.floor(audio.currentTime);
  $('transcurrido').textContent = mmss(audio.currentTime);
  $('restante').textContent = `-${mmss(total - audio.currentTime)}`;
}

function pintarModo() {
  for (const b of document.querySelectorAll('#modos button')) {
    b.setAttribute('aria-checked', String(b.dataset.modo === String(modo)));
    b.setAttribute('role', 'radio');
  }
  const aviso = $('aviso-temporizador');
  if (typeof modo !== 'number') aviso.textContent = '';
  else if (limite) aviso.textContent = `Se apagará en ${Math.max(1, Math.ceil((limite - Date.now()) / 60000))} min`;
  else aviso.textContent = `Se apagará ${modo} min después de empezar`;
}

function fijarModo(valor) {
  modo = /^\d+$/.test(valor) ? Number(valor) : valor;
  guardar('modo', modo);
  limite = typeof modo === 'number' && !audio.paused ? Date.now() + modo * 60000 : null;
  pintarModo();
}

// Se comprueba también en timeupdate porque iOS congela los temporizadores con la pantalla bloqueada.
function comprobarLimite() {
  if (limite && Date.now() >= limite) {
    limite = null;
    audio.pause();
  }
  pintarModo();
}

let ultimoGuardado = 0;
audio.addEventListener('timeupdate', () => {
  pintarProgreso();
  comprobarLimite();
  if (actual && Math.abs(audio.currentTime - ultimoGuardado) >= 5) {
    ultimoGuardado = audio.currentTime;
    posiciones[actual.slug] = audio.currentTime;
    guardar('posiciones', posiciones);
  }
});
audio.addEventListener('play', () => {
  if (typeof modo === 'number' && !limite) limite = Date.now() + modo * 60000;
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', 'Pausar');
  pintarModo();
});
audio.addEventListener('pause', () => {
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Reproducir');
});
audio.addEventListener('ended', () => {
  delete posiciones[actual.slug];
  guardar('posiciones', posiciones);
  const sig = siguiente();
  if (modo !== 'fin' && sig) abrir(sig);
  else pintarLista();
});
audio.addEventListener('error', () => {
  if (actual) $('estado').textContent = `No se ha podido reproducir «${actual.titulo}».`;
});

$('play').addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
$('atras').addEventListener('click', () => saltar(-15));
$('adelante').addEventListener('click', () => saltar(15));
$('progreso').addEventListener('input', (e) => { audio.currentTime = Number(e.target.value); });
$('modos').addEventListener('click', (e) => {
  if (e.target.dataset.modo) fijarModo(e.target.dataset.modo);
});
setInterval(comprobarLimite, 1000);

if ('mediaSession' in navigator) {
  const acciones = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    seekbackward: () => saltar(-15),
    seekforward: () => saltar(15),
    nexttrack: () => { const s = siguiente(); if (s) abrir(s); },
  };
  for (const [accion, manejador] of Object.entries(acciones)) {
    try { navigator.mediaSession.setActionHandler(accion, manejador); } catch { /* acción no soportada */ }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

pintarModo();
cargarCatalogo().then(() => {
  const ultimo = cuentos.find((c) => c.slug === leer('ultimo', null));
  if (ultimo && posiciones[ultimo.slug] > 5) abrir(ultimo, { reproducir: false });
});
