const CFG = window.CONFIG || {};
const CACHE_AUDIO = 'audio-v1';
const FUNDIDO_S = 45; // el temporizador baja el volumen durante estos segundos antes de parar
const REPOSO_MS = 10000; // sin tocar la pantalla, el reproductor se apaga hasta quedar casi negro
const MODOS = ['fin', 15, 30, 45, 'seguido'];
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
const escuchados = new Set(leer('escuchados', []));

const mmss = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const minutos = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

const ICONO_PLAY = '<svg class="lleno" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICONO_PAUSA = '<svg class="lleno" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

// Portada abstracta generada a partir del slug: siempre la misma para cada cuento, sin ficheros.
const portadas = new Map();
function portada(slug) {
  if (portadas.has(slug)) return portadas.get(slug);
  let semilla = 2166136261;
  for (const ch of slug) semilla = Math.imul(semilla ^ ch.charCodeAt(0), 16777619);
  const azar = () => {
    semilla = (semilla + 0x6d2b79f5) | 0;
    let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const L = 512;
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = L;
  const g = lienzo.getContext('2d');
  const tono = (345 + azar() * 65) % 360; // de granate a ámbar: nunca azul

  const cielo = g.createLinearGradient(0, 0, 0, L);
  cielo.addColorStop(0, `hsl(${tono} 35% 9%)`);
  cielo.addColorStop(1, `hsl(${tono} 55% 32%)`);
  g.fillStyle = cielo;
  g.fillRect(0, 0, L, L);

  for (let i = 0; i < 26; i++) {
    g.fillStyle = `hsl(40 60% 85% / ${0.15 + azar() * 0.35})`;
    g.beginPath();
    g.arc(azar() * L, azar() * L * 0.5, 0.6 + azar() * 1.6, 0, Math.PI * 2);
    g.fill();
  }

  const luz = 20 + azar() * 25; // el astro, de cobre a crema
  const astro = { x: L * (0.25 + azar() * 0.5), y: L * (0.2 + azar() * 0.22), r: L * (0.08 + azar() * 0.09) };
  g.save();
  g.shadowColor = `hsl(${luz} 85% 65% / 0.7)`;
  g.shadowBlur = 70;
  g.fillStyle = `hsl(${luz} 75% 80%)`;
  g.beginPath();
  g.arc(astro.x, astro.y, astro.r, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Tres horizontes ondulados, más oscuros cuanto más cerca.
  for (let capa = 0; capa < 3; capa++) {
    const base = L * (0.56 + capa * 0.13);
    const amplitud = L * (0.02 + azar() * 0.05);
    const frecuencia = 1 + azar() * 2.5;
    const fase = azar() * Math.PI * 2;
    g.fillStyle = `hsl(${tono} ${45 - capa * 10}% ${22 - capa * 6}%)`;
    g.beginPath();
    g.moveTo(0, L);
    for (let x = 0; x <= L; x += 8) g.lineTo(x, base + Math.sin((x / L) * Math.PI * frecuencia + fase) * amplitud);
    g.lineTo(L, L);
    g.fill();
  }

  const url = lienzo.toDataURL('image/png');
  portadas.set(slug, url);
  return url;
}

// --- Fundido de volumen ---
// iOS no deja cambiar audio.volume desde la web, así que allí el volumen pasa por Web Audio.
// La rampa se programa por adelantado en el hilo de audio: sigue funcionando con la pantalla bloqueada.
const volumenEditable = (() => {
  try { audio.volume = 0.5; const ok = audio.volume === 0.5; audio.volume = 1; return ok; } catch { return false; }
})();
let grafo = null;

// Debe llamarse dentro de un toque del usuario para que el navegador permita crear el AudioContext.
function prepararGrafo() {
  const Contexto = window.AudioContext || window.webkitAudioContext;
  if (volumenEditable || grafo || !Contexto) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const ctx = new Contexto();
    const ganancia = ctx.createGain();
    ctx.createMediaElementSource(audio).connect(ganancia).connect(ctx.destination);
    grafo = { ctx, ganancia };
  } catch { /* sin fundido: el temporizador parará en seco */ }
}

function programarFundido() {
  const quedan = limite && !audio.paused ? (limite - Date.now()) / 1000 : null;
  if (volumenEditable) {
    audio.volume = quedan === null ? 1 : Math.min(1, Math.max(0, quedan / FUNDIDO_S));
    return;
  }
  if (!grafo) return;
  const { ctx, ganancia } = grafo;
  const ahora = ctx.currentTime;
  ganancia.gain.cancelScheduledValues(ahora);
  if (quedan === null) { ganancia.gain.setValueAtTime(1, ahora); return; }
  ganancia.gain.setValueAtTime(Math.min(1, Math.max(0, quedan / FUNDIDO_S)), ahora);
  if (quedan > FUNDIDO_S) ganancia.gain.setValueAtTime(1, ahora + quedan - FUNDIDO_S);
  ganancia.gain.linearRampToValueAtTime(0, ahora + Math.max(0, quedan));
}

// --- Catálogo ---
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

function crear(etiqueta, clase, texto) {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto) el.textContent = texto;
  return el;
}

function imagenPortada(c) {
  const img = crear('img', 'portada');
  img.src = portada(c.slug);
  img.alt = '';
  return img;
}

function barra(c) {
  const fondo = crear('div', 'barra');
  const relleno = crear('i');
  relleno.style.width = `${Math.min(100, (100 * (posiciones[c.slug] || 0)) / (c.duracion_s || 1))}%`;
  fondo.append(relleno);
  return fondo;
}

function pintarLista() {
  const ultimo = cuentos.find((c) => c.slug === leer('ultimo', null));
  const continuar = $('continuar');
  continuar.hidden = !(ultimo && posiciones[ultimo.slug] > 5);
  if (!continuar.hidden) {
    const boton = crear('button', 'seguir');
    const info = crear('span', 'info');
    const resta = (ultimo.duracion_s || 0) - posiciones[ultimo.slug];
    info.append(crear('strong', '', ultimo.titulo), crear('small', '', resta > 0 ? `Quedan ${minutos(resta)}` : 'Seguir'), barra(ultimo));
    boton.append(imagenPortada(ultimo), info);
    boton.addEventListener('click', () => elegir(ultimo));
    continuar.replaceChildren(crear('h3', '', 'Seguir escuchando'), boton);
  }

  $('lista').replaceChildren(...cuentos.map((c) => {
    const li = document.createElement('li');
    const boton = crear('button', 'cuento');
    boton.setAttribute('aria-current', String(actual?.slug === c.slug));
    const info = crear('span', 'info');
    const meta = crear('small');
    if (c.duracion_s) meta.textContent = minutos(c.duracion_s);
    if (escuchados.has(c.slug) && !(posiciones[c.slug] > 5)) {
      meta.append(c.duracion_s ? ' · ' : '', crear('span', 'hecho', '✓ Escuchado'));
    }
    info.append(crear('strong', '', c.titulo), crear('span', '', c.descripcion), meta);
    if (posiciones[c.slug] > 5) info.append(barra(c));
    boton.append(imagenPortada(c), info);
    boton.addEventListener('click', () => elegir(c));
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
    } catch { /* se reintentará en la próxima apertura */ }
  }
}

// --- Reproducción ---
function elegir(cuento) {
  prepararGrafo();
  abrir(cuento);
  mostrarReproductor();
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
  const imagen = portada(cuento.slug);
  $('titulo-actual').textContent = cuento.titulo;
  $('desc-actual').textContent = cuento.descripcion;
  $('portada').src = imagen;
  $('mini-titulo').textContent = cuento.titulo;
  $('mini-portada').src = imagen;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cuento.titulo,
      artist: 'Cuentos para dormir',
      artwork: [
        { src: imagen, sizes: '512x512', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  }
  pintarMini();
  pintarLista();
  pintarProgreso();
  if (reproducir) audio.play().catch(() => {});
}

function mostrarReproductor() {
  $('reproductor').hidden = false;
  document.body.classList.add('con-reproductor');
  pintarMini();
  despertar();
}

function cerrarReproductor() {
  $('reproductor').hidden = true;
  document.body.classList.remove('con-reproductor');
  clearTimeout(reposo);
  pintarMini();
}

function pintarMini() {
  const visible = Boolean(actual) && $('reproductor').hidden;
  $('mini').hidden = !visible;
  document.body.classList.toggle('con-mini', visible);
}

function siguiente() {
  const i = cuentos.findIndex((c) => c.slug === actual?.slug);
  return i >= 0 ? cuentos[i + 1] : null;
}

function saltar(segundos) {
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + segundos), audio.duration || 0);
}

function alternar() {
  prepararGrafo();
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function pintarProgreso() {
  const total = audio.duration || actual?.duracion_s || 0;
  const resta = total - audio.currentTime;
  $('progreso').max = Math.floor(total) || 100;
  $('progreso').value = Math.floor(audio.currentTime);
  $('transcurrido').textContent = mmss(audio.currentTime);
  $('restante').textContent = `-${mmss(resta)}`;
  $('mini-tiempo').textContent = `Quedan ${mmss(resta)}`;
  $('reposo').textContent = limite ? mmss((limite - Date.now()) / 1000) : mmss(resta);
}

function pintarPlay() {
  const icono = audio.paused ? ICONO_PLAY : ICONO_PAUSA;
  const etiqueta = audio.paused ? 'Reproducir' : 'Pausar';
  for (const id of ['play', 'mini-play']) {
    $(id).innerHTML = icono;
    $(id).setAttribute('aria-label', etiqueta);
  }
}

// --- Temporizador ---
function pintarModo() {
  $('modo-texto').textContent = modo === 'fin' ? 'Al terminar el cuento'
    : modo === 'seguido' ? 'Sin parar'
    : `${modo} min`;
  $('temporizador').setAttribute('aria-label', `Cuándo parar: ${$('modo-texto').textContent}. Toca para cambiar.`);
  const aviso = $('aviso-temporizador');
  if (typeof modo === 'number') {
    aviso.textContent = limite
      ? `Se apaga a las ${hora(limite)}, bajando poco a poco`
      : `Se apagará ${modo} min después de empezar`;
  } else if (modo === 'fin' && actual && !audio.paused && audio.duration) {
    aviso.textContent = `Se apaga a las ${hora(Date.now() + (audio.duration - audio.currentTime) * 1000)}`;
  } else if (modo === 'seguido') {
    aviso.textContent = 'Sigue con el siguiente cuento';
  } else {
    aviso.textContent = '';
  }
}

function cambiarModo() {
  modo = MODOS[(MODOS.indexOf(modo) + 1) % MODOS.length];
  guardar('modo', modo);
  limite = typeof modo === 'number' && !audio.paused ? Date.now() + modo * 60000 : null;
  programarFundido();
  pintarModo();
}

// Se comprueba también en timeupdate porque iOS congela los temporizadores con la pantalla bloqueada.
function comprobarLimite() {
  if (limite && Date.now() >= limite) {
    limite = null;
    audio.pause();
  }
  if (volumenEditable) programarFundido();
  pintarModo();
}

// --- Reposo: con la pantalla quieta, el reproductor se apaga hasta quedar casi negro ---
let reposo;
function despertar() {
  $('reproductor').classList.remove('en-reposo');
  clearTimeout(reposo);
  if (!audio.paused && !$('reproductor').hidden) {
    reposo = setTimeout(() => $('reproductor').classList.add('en-reposo'), REPOSO_MS);
  }
}

// --- Eventos ---
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
  if (grafo && grafo.ctx.state !== 'running') grafo.ctx.resume().catch(() => {});
  if (typeof modo === 'number' && !limite) limite = Date.now() + modo * 60000;
  programarFundido();
  pintarPlay();
  pintarModo();
  despertar();
});
audio.addEventListener('pause', () => {
  programarFundido();
  pintarPlay();
  pintarModo();
  // No se enciende la pantalla al parar: si el temporizador o el cuento acaban, se sigue durmiendo.
  clearTimeout(reposo);
});
audio.addEventListener('ended', () => {
  delete posiciones[actual.slug];
  guardar('posiciones', posiciones);
  escuchados.add(actual.slug);
  guardar('escuchados', [...escuchados]);
  const sig = siguiente();
  if (modo !== 'fin' && sig) abrir(sig);
  else pintarLista();
});
audio.addEventListener('error', () => {
  if (actual) $('estado').textContent = `No se ha podido reproducir «${actual.titulo}».`;
});

$('play').addEventListener('click', alternar);
$('mini-play').addEventListener('click', alternar);
$('mini-abrir').addEventListener('click', mostrarReproductor);
$('cerrar').addEventListener('click', cerrarReproductor);
$('atras').addEventListener('click', () => saltar(-15));
$('adelante').addEventListener('click', () => saltar(15));
$('progreso').addEventListener('input', (e) => { audio.currentTime = Number(e.target.value); });
$('temporizador').addEventListener('click', cambiarModo);
// En reposo los mandos no reciben toques: el primer toque solo enciende la pantalla.
$('reproductor').addEventListener('pointerdown', despertar);
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

pintarPlay();
pintarModo();
cargarCatalogo().then(() => {
  const ultimo = cuentos.find((c) => c.slug === leer('ultimo', null));
  if (ultimo && posiciones[ultimo.slug] > 5) abrir(ultimo, { reproducir: false });
});
