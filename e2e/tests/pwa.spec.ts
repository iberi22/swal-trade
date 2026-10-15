import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, assertClean } from './site-test';

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'workers/public-site/static');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/** Servidor estatico minimo para poder apagar el origen de verdad (Playwright no corta la red del service worker). */
function startStaticServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(STATIC_DIR, pathname);
    if (!file.startsWith(STATIC_DIR + path.sep)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('fuera del sitio');
      return;
    }
    readFile(file)
      .then((data) => {
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        response.end(data);
      })
      .catch(() => {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('no existe');
      });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Espera a que el service worker este activo y controlando (o no) la pestana. */
async function waitForServiceWorker(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

async function controlledByServiceWorker(page: import('@playwright/test').Page) {
  return page.evaluate(() => Boolean(navigator.serviceWorker.controller));
}

test('el service worker se registra en /sw.js con alcance raiz y controla la pagina tras recargar', async ({
  page,
  problems,
}) => {
  await page.goto('/analisis/', { waitUntil: 'load' });
  await waitForServiceWorker(page);

  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      scopePath: reg ? new URL(reg.scope).pathname : null,
      scriptPath: reg?.active ? new URL(reg.active.scriptURL).pathname : null,
      state: reg?.active?.state ?? null,
    };
  });
  expect(registration.scriptPath).toBe('/sw.js');
  expect(registration.scopePath).toBe('/');
  expect(registration.state).toBe('activated');

  await page.reload({ waitUntil: 'load' });
  await expect.poll(() => controlledByServiceWorker(page)).toBe(true);

  // La pagina sigue siendo la misma: el registro no cambia el comportamiento.
  await expect(page.locator('h1')).toContainText('Análisis de patrones');
  await assertClean(page, problems);
});

test('el manifiesto se sirve como application/manifest+json y /sw.js sin cache', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toMatch(/application\/manifest\+json/);
  const body = await manifest.json();
  expect(body.name).toBe('SWAL Trade');
  expect(body.start_url).toBe('/analisis/?source=pwa');
  expect(body.scope).toBe('/');

  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toBe('no-cache');
  expect(sw.headers()['service-worker-allowed']).toBe('/');

  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/favicon.svg']) {
    const response = await request.get(icon);
    expect(response.status(), icon).toBe(200);
  }

  const offline = await request.get('/offline/');
  expect(offline.status()).toBe(200);
});

test('/api/news se sirve del origen y nunca entra en la cache del service worker', async ({ page, problems }) => {
  await page.route('**/api/news*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );

  await page.goto('/analisis/', { waitUntil: 'load' });
  await waitForServiceWorker(page);
  await page.reload({ waitUntil: 'load' });
  await expect.poll(() => controlledByServiceWorker(page)).toBe(true);

  const result = await page.evaluate(async () => {
    const response = await fetch('/api/news?symbol=BTC&limit=5');
    const payload = await response.json();
    const entries: string[] = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
    }
    return { status: response.status, hasItems: Array.isArray(payload.items), entries };
  });

  expect(result.status).toBe(200);
  expect(result.hasItems).toBe(true);
  expect(result.entries.some((path) => path.startsWith('/api/'))).toBe(false);
  await assertClean(page, problems);
});

test('sin conexion: lo visitado sale de la cache y una ruta nueva cae en el aviso offline', async ({
  page,
  problems,
}) => {
  test.setTimeout(180_000);

  // Origen propio: al cerrarlo, el fetch del service worker falla de verdad (context.setOffline
  // no afecta a las peticiones que hace el service worker en Chromium).
  const { server, origin } = await startStaticServer();
  // /api/news lo pide la propia pagina de analisis; se responde en el navegador para que
  // la prueba mida la cache del service worker y no un 404 del servidor de apoyo.
  await page.route('**/api/news*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  try {
    await page.goto(`${origin}/analisis/`, { waitUntil: 'load' });
    await waitForServiceWorker(page);
    await page.reload({ waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    await expect.poll(() => controlledByServiceWorker(page)).toBe(true);

    const cachedEntries = await page.evaluate(async () => {
      const entries: string[] = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
      }
      return entries;
    });
    expect(cachedEntries).toContain('/analisis/');
    expect(cachedEntries).toContain('/offline/');

    await stopServer(server);

    const cached = await page.goto(`${origin}/analisis/`, { waitUntil: 'load' });
    expect(cached?.status()).toBe(200);
    await expect(page.locator('h1')).toContainText('Análisis de patrones');

    await page.goto(`${origin}/ruta-sin-visitar/`, { waitUntil: 'load' });
    await expect(page.locator('h1')).toContainText('Sin conexión');
    await expect(page.getByText('Esta página necesita internet')).toBeVisible();
    await assertClean(page, problems);
  } finally {
    if (server.listening) await stopServer(server);
  }
});

test('la pagina avisa de una version nueva y pide SKIP_WAITING al actualizar', async ({ page, problems }) => {
  await page.goto('/', { waitUntil: 'load' });
  await waitForServiceWorker(page);
  await page.reload({ waitUntil: 'load' });
  await expect.poll(() => controlledByServiceWorker(page)).toBe(true);

  // Se simula una version recien instalada en `registration.installing`: el mismo evento
  // `updatefound` y el mismo `statechange` que dispara una actualizacion real.
  await page.evaluate(async () => {
    const sent: string[] = [];
    (window as unknown as { __swMessages: string[] }).__swMessages = sent;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('sin registro de service worker');
    const installing = {
      state: 'installed',
      postMessage: (data: { type: string }) => sent.push(data.type),
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'statechange') listener();
      },
    };
    Object.defineProperty(registration, 'installing', { value: installing, configurable: true });
    registration.dispatchEvent(new Event('updatefound'));
  });

  const bar = page.locator('#pwa-update-bar');
  await expect(bar).toContainText('Nueva versión disponible');
  await bar.getByRole('button', { name: 'Actualizar' }).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __swMessages?: string[] }).__swMessages ?? []))
    .toEqual(['SKIP_WAITING']);
  await expect(bar.getByRole('button')).toHaveText('Actualizando…');
  await assertClean(page, problems);
});

test('Chrome no reporta errores de instalabilidad para la PWA', async ({ page, context }) => {
  await page.goto('/analisis/', { waitUntil: 'load' });
  await waitForServiceWorker(page);
  await page.reload({ waitUntil: 'load' });
  await expect.poll(() => controlledByServiceWorker(page)).toBe(true);

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string; errorArguments?: unknown[] }[];
  };
  expect(installabilityErrors, JSON.stringify(installabilityErrors)).toEqual([]);
  await cdp.detach();
});
