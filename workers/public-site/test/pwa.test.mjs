import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { cspFor } from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = join(ROOT, 'static');
const SITE = 'https://trade.swal.network';

const MANIFEST = join(STATIC, 'manifest.webmanifest');
const SW_PATH = join(STATIC, 'sw.js');

// Misma regla que test/site-pages.test.mjs: el manifiesto tampoco promete rentabilidad.
const FORBIDDEN = /ganancia[s]? garantizad|rentabilidad|win\s?rate|ingreso[s]? pasivo|retorno[s]? garantizad|\bROI\b|\+\d+(\.\d+)?\s?%/i;

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const rel = (p) => '/' + p.slice(STATIC.length + 1);

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'no es un PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Bloque de _headers: linea sin sangria = patron; lineas con sangria = cabeceras. */
function headerBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      current = line.trim();
      blocks.set(current, []);
    } else if (current) {
      blocks.get(current).push(line.trim());
    }
  }
  return blocks;
}

const valueOf = (block = [], name) => {
  const hit = block.find((h) => h.startsWith(`${name}:`));
  return hit ? hit.slice(name.length + 1).trim() : null;
};

// --- service worker en un contexto de VM: se prueba el comportamiento, no el texto ---

function loadServiceWorker(options = {}) {
  const listeners = new Map();
  const puts = [];
  const fetched = [];
  const deleted = [];
  const cached = options.cached ?? new Map();
  const keyOf = (key) => (typeof key === 'string' ? key : key.url);

  const store = {
    async put(key, value) {
      puts.push(keyOf(key));
      cached.set(keyOf(key), value);
    },
    async match(key) {
      return cached.get(keyOf(key));
    },
  };

  // En un service worker real las URL relativas se resuelven contra su propio ambito;
  // Request de Node exige una URL absoluta, asi que aqui se reproduce esa regla.
  class ScopedRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' && input.startsWith('/') ? SITE + input : input, init);
    }
  }

  const sandbox = {
    self: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      location: { origin: SITE },
      clients: { claim: async () => {} },
      skipWaiting: () => {
        sandbox.skipped = true;
      },
    },
    caches: {
      open: async () => store,
      match: async (key) => cached.get(keyOf(key)),
      keys: async () => options.cacheKeys ?? [],
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
    },
    fetch: async (request, init) => {
      fetched.push(keyOf(request));
      if (options.fetch) return options.fetch(request, init);
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/css' } });
    },
    Request: ScopedRequest,
    Response,
    Headers,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(readFileSync(SW_PATH, 'utf8'), { filename: 'sw.js' }).runInContext(sandbox);

  const dispatch = (request) => {
    const event = {
      request,
      respondWith: (promise) => {
        event.response = promise;
      },
      waitUntil: (promise) => {
        event.waited = promise;
      },
    };
    listeners.get('fetch')(event);
    return event;
  };

  return { listeners, puts, fetched, deleted, dispatch, sandbox };
}

test('sw.js: no intercepta POST, otro origen, /api/*, /backup/*, /checkout/*, /ingest ni /public/*', () => {
  const sw = loadServiceWorker();
  const untouched = [
    new Request(`${SITE}/analisis/`, { method: 'POST' }),
    new Request('https://fapi.binance.com/fapi/v1/klines'),
    new Request(`${SITE}/api/news?symbol=BTC`),
    new Request(`${SITE}/api/explain`),
    new Request(`${SITE}/api/backup`),
    new Request(`${SITE}/backup/backup-core.js`),
    new Request(`${SITE}/checkout/checkout-lib.js`),
    new Request(`${SITE}/ingest`),
    new Request(`${SITE}/public/v1/snapshot`),
  ];
  for (const request of untouched) {
    const event = sw.dispatch(request);
    assert.equal(event.response, undefined, `no debe interceptar ${request.method} ${request.url}`);
  }
  assert.deepEqual(sw.fetched, []);
});

test('sw.js: con red los estaticos salen de la red, nunca de una copia vieja', async () => {
  // Las URLs de JS/CSS no llevan version: una copia vieja tras un despliegue mezclaria
  // HTML nuevo con JS viejo.
  const oldCss = new Response('body{color:red}', { status: 200, headers: { 'Content-Type': 'text/css' } });
  const sw = loadServiceWorker({
    cached: new Map([[`${SITE}/tokens.css`, oldCss]]),
    fetch: async () => new Response('body{color:blue}', { status: 200, headers: { 'Content-Type': 'text/css' } }),
  });
  const event = sw.dispatch(new Request(`${SITE}/tokens.css`));
  const response = await event.response;
  assert.equal(await response.text(), 'body{color:blue}', 'gana la version de la red');
  assert.deepEqual(sw.fetched, [`${SITE}/tokens.css`]);
  assert.ok(sw.puts.includes(`${SITE}/tokens.css`), 'y se guarda para usarla sin conexion');
});

test('sw.js: sin red los estaticos salen de la copia guardada', async () => {
  const savedCss = new Response('body{color:red}', { status: 200, headers: { 'Content-Type': 'text/css' } });
  const sw = loadServiceWorker({
    cached: new Map([[`${SITE}/tokens.css`, savedCss]]),
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const event = sw.dispatch(new Request(`${SITE}/tokens.css`));
  const response = await event.response;
  assert.equal(await response.text(), 'body{color:red}', 'sin conexion se usa la copia guardada');
});

test('sw.js: solo guarda respuestas 200 sin Cache-Control: no-store', async () => {
  const cases = [
    { name: '404', response: new Response('nope', { status: 404 }), stored: false },
    {
      name: '200 no-store',
      response: new Response('secreto', { status: 200, headers: { 'Cache-Control': 'no-store' } }),
      stored: false,
    },
    { name: '200', response: new Response('ok', { status: 200 }), stored: true },
  ];
  for (const item of cases) {
    const sw = loadServiceWorker({ fetch: async () => item.response.clone() });
    const event = sw.dispatch(new Request(`${SITE}/site.css`));
    await event.response;
    await event.waited;
    assert.equal(sw.puts.includes(`${SITE}/site.css`), item.stored, `respuesta ${item.name}`);
  }
});

test('sw.js: sin red, la navegacion visitada sale de la cache y el resto cae en la pagina offline', async () => {
  const offline = new Response('<h1>Sin conexión</h1>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const visitada = new Response('<h1>Analisis cacheado</h1>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const cacheado = new Map([
    ['/offline/', offline],
    [`${SITE}/analisis/`, visitada],
  ]);
  const sw = loadServiceWorker({
    cached: cacheado,
    fetch: async () => {
      throw new Error('sin red');
    },
  });

  const visitadaEvent = sw.dispatch({ method: 'GET', url: `${SITE}/analisis/`, mode: 'navigate' });
  assert.match(await (await visitadaEvent.response).text(), /Analisis cacheado/);

  const nuevaEvent = sw.dispatch({ method: 'GET', url: `${SITE}/pricing/`, mode: 'navigate' });
  assert.match(await (await nuevaEvent.response).text(), /Sin conexión/);
});

test('sw.js: precachea la cascara, sube de version y limpia caches viejas', async () => {
  const sw = loadServiceWorker({ cacheKeys: ['swal-trade-v0-shell', 'swal-trade-v1-shell', 'otra'] });
  const install = { waitUntil: (promise) => (install.waited = promise) };
  sw.listeners.get('install')(install);
  await install.waited;
  for (const url of ['/offline/', '/pwa-register.js', '/tokens.css', '/site.css', '/favicon.svg', '/manifest.webmanifest']) {
    assert.ok(sw.puts.includes(url), `la cascara deberia precachear ${url}`);
  }

  const activate = { waitUntil: (promise) => (activate.waited = promise) };
  sw.listeners.get('activate')(activate);
  await activate.waited;
  assert.deepEqual(sw.deleted, ['swal-trade-v0-shell', 'otra'], 'solo borra lo que no es de la version actual');
});

test('sw.js: una cascara con respuestas no guardables no rompe la instalacion', async () => {
  const sw = loadServiceWorker({ fetch: async () => new Response('boom', { status: 500 }) });
  const install = { waitUntil: (promise) => (install.waited = promise) };
  sw.listeners.get('install')(install);
  await install.waited;
  assert.deepEqual(sw.puts, []);
});

test('sw.js: la actualizacion solo avanza con el mensaje SKIP_WAITING', () => {
  const sw = loadServiceWorker();
  sw.listeners.get('message')({ data: { type: 'OTRA_COSA' } });
  assert.notEqual(sw.sandbox.skipped, true);
  sw.listeners.get('message')({ data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.sandbox.skipped, true);
});

// --- manifiesto, cabeceras y cabeceras de las paginas ---

test('manifest: campos obligatorios, español y sin promesas de rentabilidad', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  assert.equal(manifest.name, 'SWAL Trade');
  assert.equal(manifest.short_name, 'SWAL Trade');
  assert.ok(manifest.description.length > 40, 'descripcion demasiado corta');
  assert.doesNotMatch(manifest.description, FORBIDDEN);
  assert.equal(manifest.lang, 'es');
  assert.equal(manifest.dir, 'ltr');
  assert.equal(manifest.start_url, '/analisis/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);

  const tokens = readFileSync(join(STATIC, 'tokens.css'), 'utf8');
  const bg = /--background:\s*(\d+)\s+(\d+)%\s+(\d+)%/.exec(tokens);
  assert.ok(bg, 'tokens.css debe declarar --background');
  const boneWhite = hslToHex(Number(bg[1]), Number(bg[2]) / 100, Number(bg[3]) / 100);
  assert.equal(manifest.theme_color, boneWhite, 'theme_color debe venir de tokens.css');
  assert.equal(manifest.background_color, boneWhite, 'background_color debe venir de tokens.css');

  const urls = manifest.shortcuts.map((s) => s.url);
  assert.deepEqual(urls.sort(), ['/analisis/', '/guardian/']);
  for (const shortcut of manifest.shortcuts) assert.ok(shortcut.name.length > 0);
});

test('manifest: los iconos existen y tienen el tamaño que declaran', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const purpose = manifest.icons.map((i) => i.purpose ?? 'any');
  assert.ok(purpose.includes('maskable'), 'falta un icono maskable');

  const pngSizes = [];
  for (const icon of manifest.icons) {
    const file = join(STATIC, icon.src.replace(/^\//, ''));
    assert.ok(existsSync(file), `falta el icono ${icon.src}`);
    if (!icon.src.endsWith('.png')) continue;
    const [width, height] = icon.sizes.split('x').map(Number);
    const actual = pngSize(readFileSync(file));
    assert.equal(actual.width, width, `${icon.src} ancho`);
    assert.equal(actual.height, height, `${icon.src} alto`);
    pngSizes.push(`${actual.width}x${actual.height}`);
  }
  assert.ok(pngSizes.includes('192x192'), 'falta el 192x192 (minimo de instalacion)');
  assert.ok(pngSizes.includes('512x512'), 'falta el 512x512 (minimo de instalacion)');
  assert.ok(manifest.icons.some((i) => i.type === 'image/svg+xml'), 'debe conservar el SVG');
});

test('cada página enlaza el manifiesto, el color de tema y el registro del service worker', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const files = htmlFiles(STATIC);
  assert.ok(files.length >= 13, 'deberian existir todas las paginas del sitio');

  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, `${rel(file)} sin manifiesto`);
    assert.match(
      html,
      new RegExp(`<meta name="theme-color" content="${manifest.theme_color}">`),
      `${rel(file)} con theme-color distinto al manifiesto`
    );
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/icon-192\.png">/, `${rel(file)} sin apple-touch-icon`);
    assert.match(html, /<script src="\/pwa-register\.js" defer><\/script>/, `${rel(file)} sin pwa-register.js`);
    assert.doesNotMatch(html, /navigator\.serviceWorker\.register\(/, `${rel(file)} no debe registrar el SW en linea`);
  }
  assert.ok(existsSync(join(STATIC, 'offline', 'index.html')), 'falta la pagina offline');
});

test('pwa-register.js registra /sw.js con alcance raiz y avisa de la nueva version', () => {
  const code = readFileSync(join(STATIC, 'pwa-register.js'), 'utf8');
  assert.match(code, /register\('\/sw\.js',\s*\{\s*scope:\s*'\/'\s*\}\)/);
  assert.match(code, /Nueva versión disponible/);
  assert.match(code, /type:\s*'SKIP_WAITING'/);
  assert.match(code, /controllerchange/);
  assert.doesNotMatch(code, /<\/script/i, 'debe ser un archivo externo, no HTML');
});

test('_headers y worker.js sirven el service worker y el manifiesto como es debido', () => {
  const blocks = headerBlocks(readFileSync(join(STATIC, '_headers'), 'utf8'));

  const swBlock = blocks.get('/sw.js');
  assert.ok(swBlock, 'falta el bloque /sw.js en _headers');
  assert.equal(valueOf(swBlock, 'Cache-Control'), 'no-cache');
  assert.equal(valueOf(swBlock, 'Service-Worker-Allowed'), '/');

  const manifestBlock = blocks.get('/manifest.webmanifest');
  assert.ok(manifestBlock, 'falta el bloque /manifest.webmanifest en _headers');
  assert.equal(valueOf(manifestBlock, 'Content-Type'), 'application/manifest+json');
  assert.match(valueOf(manifestBlock, 'Cache-Control') ?? '', /^public, max-age=\d+$/);

  const worker = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');
  assert.match(worker, /pathname === '\/sw\.js'/);
  assert.match(worker, /Service-Worker-Allowed/);
  assert.match(worker, /application\/manifest\+json/);
});

test('la CSP de todas las rutas permite registrar el service worker y pedir el manifiesto', () => {
  // worker-src y manifest-src caen a default-src: basta con que sea 'self' y que nadie
  // los restrinja a otro valor.
  const rutas = ['/', '/analisis/', '/guardian/', '/checkout/', '/backup/', '/offline/', '/pricing/'];
  const policies = [cspFor('/'), ...rutas.map((r) => cspFor(r))];
  for (const csp of policies) {
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /worker-src|manifest-src/);
  }

  const headers = readFileSync(join(STATIC, '_headers'), 'utf8');
  for (const csp of [...headers.matchAll(/Content-Security-Policy:\s*(.+)/g)].map((m) => m[1])) {
    assert.match(csp, /default-src 'self'/, csp);
    assert.doesNotMatch(csp, /worker-src|manifest-src/, csp);
  }
});

test('robots.txt deja claro que el service worker y el manifiesto no son contenido indexable', () => {
  // No se prohibe /offline/ (esta en el sitemap), pero ninguna regla debe bloquear /sw.js.
  const robots = readFileSync(join(STATIC, 'robots.txt'), 'utf8');
  assert.doesNotMatch(robots, /Disallow:\s*\/sw\.js/);
  assert.doesNotMatch(robots, /Disallow:\s*\/manifest\.webmanifest/);
});
