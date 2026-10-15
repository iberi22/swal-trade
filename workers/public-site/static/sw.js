/* Service worker de SWAL Trade (sitio publico).
 *
 * Reglas de oro (auditable a simple vista):
 *  - Solo intercepta GET del mismo origen.
 *  - Nunca toca /api/*, /backup/*, /checkout/*, /ingest ni /public/*: esos datos son
 *    sensibles o cambian en cada peticion y jamas deben salir de la cache.
 *  - No guarda respuestas que no sean 200 ni las que traen `Cache-Control: no-store`.
 *  - Sin `skipWaiting` automatico: la pagina avisa "Nueva version disponible" y el
 *    usuario decide (mensaje SKIP_WAITING).
 */
const VERSION = 'swal-trade-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const OFFLINE_URL = '/offline/';
const NAVIGATION_TIMEOUT_MS = 4000;

/* Cascara minima para poder decir "hace falta conexion" sin red. */
const SHELL = [
  OFFLINE_URL,
  '/offline/index.html',
  '/tokens.css',
  '/site.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

/* Rutas que nunca pasan por la cache (mismo prefijo que el worker). */
const NEVER_CACHE = [/^\/api\//, /^\/backup\//, /^\/checkout\//, /^\/ingest$/, /^\/public\//];

function isNeverCached(pathname) {
  return NEVER_CACHE.some((re) => re.test(pathname));
}

/* Estaticos con stale-while-revalidate: css, js, iconos y el favicon. */
function isCacheableAsset(pathname) {
  return (
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname.startsWith('/icons/') ||
    pathname === '/favicon.svg'
  );
}

function isStorable(response) {
  if (!response || response.status !== 200) return false;
  if (response.type === 'opaqueredirect') return false;
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/no-store/i.test(cacheControl);
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const response = await fetch(new Request(url, { cache: 'reload' }));
            if (isStorable(response)) await cache.put(url, response);
          } catch (_) {
            /* Un fallo de precarga no debe tumbar la instalacion. */
          }
        })
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirstNavigation(event) {
  const request = event.request;
  const runtime = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
    if (isStorable(response)) await runtime.put(request, response.clone());
    return response;
  } catch (_) {
    const cached =
      (await runtime.match(request)) ||
      (await runtime.match(request, { ignoreSearch: true })) ||
      (await caches.match(OFFLINE_URL)) ||
      (await caches.match('/offline/index.html'));
    if (cached) return cached;
    return new Response('Sin conexion. Abre el sitio con internet para ver los datos.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function staleWhileRevalidate(event) {
  const request = event.request;
  const revalidate = caches.open(RUNTIME_CACHE).then(async (cache) => {
    const response = await fetch(request);
    if (isStorable(response)) await cache.put(request, response.clone());
    return response;
  });
  event.waitUntil(revalidate.catch(() => {}));
  return caches.match(request).then((cached) => cached || revalidate);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  if (isCacheableAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
