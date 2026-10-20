// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SWAL_HELLO,
  buildHello,
  parseHello,
  withinShapeBudget,
  DrawRateLimit,
  establishLink,
  BRIDGE_LINK_WAIT_MS,
  CONTENT_LINK_WAIT_MS,
} from './handshake';

describe('Handshake logic', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
    vi.useFakeTimers();
  });

  it('buildHello / parseHello', () => {
    const hello = buildHello('sess-1', true);
    expect(hello).toEqual({ type: SWAL_HELLO, session: 'sess-1', enabled: true });

    expect(parseHello(hello)).toEqual(hello);
    expect(parseHello(null)).toBeNull();
    expect(parseHello({ type: 'swal:hello' })).toBeNull();
    expect(parseHello({ type: 'swal:hello', session: 123 })).toBeNull();
  });

  it('withinShapeBudget', () => {
    expect(withinShapeBudget(0)).toBe(true);
    expect(withinShapeBudget(240)).toBe(true);
    expect(withinShapeBudget(241)).toBe(false);
  });

  it('DrawRateLimit', () => {
    const rate = new DrawRateLimit(4);
    const now = 1000;

    expect(rate.allow(now)).toBe(true);
    expect(rate.allow(now)).toBe(true);
    expect(rate.allow(now)).toBe(true);
    expect(rate.allow(now)).toBe(true);
    expect(rate.allow(now)).toBe(false);

    expect(rate.allow(now + 999)).toBe(false);
    expect(rate.allow(now + 1000)).toBe(true);
  });
});

describe('establishLink', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
    vi.useFakeTimers();
  });

  it('links when MAIN is first and ISOLATED is second', async () => {
    const mainPromise = establishLink('bridge');

    // MAIN creates the element
    const linkEl = document.documentElement.querySelector('swal-link');
    expect(linkEl).not.toBeNull();

    const isolatedPromise = establishLink('content');

    // ISOLATED should detach the element
    expect(document.documentElement.querySelector('swal-link')).toBeNull();

    const [mainChannel, isolatedChannel] = await Promise.all([mainPromise, isolatedPromise]);
    expect(mainChannel).toBeDefined();
    expect(isolatedChannel).toBeDefined();

    // Verify communication
    let received: any = null;
    isolatedChannel.onMessage((msg) => { received = msg; });
    mainChannel.send({ type: 'test' });

    expect(received).toEqual({ type: 'test' });
  });

  it('links when ISOLATED is first and MAIN is second', async () => {
    const isolatedPromise = establishLink('content');

    // ISOLATED creates the element
    const linkEl = document.documentElement.querySelector('swal-link');
    expect(linkEl).not.toBeNull();

    const mainPromise = establishLink('bridge');

    // MAIN should detach the element
    expect(document.documentElement.querySelector('swal-link')).toBeNull();

    const [isolatedChannel, mainChannel] = await Promise.all([isolatedPromise, mainPromise]);
    expect(mainChannel).toBeDefined();
    expect(isolatedChannel).toBeDefined();

    // Verify communication
    let received: any = null;
    mainChannel.onMessage((msg) => { received = msg; });
    isolatedChannel.send({ type: 'test' });

    expect(received).toEqual({ type: 'test' });
  });

  it('rejects on timeout if second script never runs', async () => {
    const promise = establishLink('bridge', 100);

    expect(document.documentElement.querySelector('swal-link')).not.toBeNull();

    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow('Link timeout');
    // Element should be cleaned up
    expect(document.documentElement.querySelector('swal-link')).toBeNull();
  });

  it('page script cannot eavesdrop or forge messages', async () => {
    const mainPromise = establishLink('bridge');
    const isolatedPromise = establishLink('content');

    const [mainChannel, isolatedChannel] = await Promise.all([mainPromise, isolatedPromise]);

    let eavesdropped: any = null;
    window.addEventListener('swal:to-content', (e) => { eavesdropped = e; });
    document.addEventListener('swal:to-content', (e) => { eavesdropped = e; });

    let receivedByIsolated: any = null;
    isolatedChannel.onMessage((msg) => { receivedByIsolated = msg; });

    mainChannel.send({ secret: true });

    expect(receivedByIsolated).toEqual({ secret: true });
    // Page script should not see the event since it's on a detached node
    expect(eavesdropped).toBeNull();

    // Page script forging a message
    document.dispatchEvent(new CustomEvent('swal:to-bridge', { detail: JSON.stringify({ forged: true }) }));

    expect(receivedByIsolated).toEqual({ secret: true }); // Still just the secret, forged didn't arrive
  });

  it('a side never receives its own send', async () => {
    const mainPromise = establishLink('bridge');
    const isolatedPromise = establishLink('content');

    const [bridgeChannel, contentChannel] = await Promise.all([mainPromise, isolatedPromise]);

    let bridgeReceived: any = null;
    bridgeChannel.onMessage((msg) => { bridgeReceived = msg; });

    bridgeChannel.send({ echo: true });

    expect(bridgeReceived).toBeNull(); // Shouldn't receive its own message
  });

  // Regresión (pintado en Binance): el puente vive en `document_start` y el
  // content script aislado en `document_idle`. El hueco entre ambos es el
  // tiempo que tarda la página en estar lista, no milisegundos: medido en vivo
  // con red móvil lenta, de 9 s a 30 s. Con el tope de 3 s el puente se rendía,
  // borraba el `<swal-link>` y el aislado llegaba a un punto de encuentro vacío:
  // sin canal, `paint()` no mandaba nada y el panel no pintaba (y no lo decía).
  it('el puente aguanta la llegada tardía del aislado (document_idle) y enlaza', async () => {
    const mainPromise = establishLink('bridge', BRIDGE_LINK_WAIT_MS);
    expect(document.documentElement.querySelector('swal-link')).not.toBeNull();

    // Treinta segundos de hueco: mucho más que el viejo tope de 3 s.
    await vi.advanceTimersByTimeAsync(30_000);
    // Sigue esperando: el punto de encuentro sigue en el DOM.
    expect(document.documentElement.querySelector('swal-link')).not.toBeNull();

    const isolatedPromise = establishLink('content', CONTENT_LINK_WAIT_MS);
    const [mainChannel, isolatedChannel] = await Promise.all([mainPromise, isolatedPromise]);

    expect(document.documentElement.querySelector('swal-link')).toBeNull();

    let received: any = null;
    isolatedChannel.onMessage((msg) => { received = msg; });
    mainChannel.send(buildHello('sesion-tardia', true));
    expect(parseHello(received)).toEqual(buildHello('sesion-tardia', true));
  });

  it('la espera del puente cubre el hueco medido y la del aislado es corta', () => {
    // Si alguien vuelve a bajarlas, el enlace se pierde otra vez en una página
    // lenta. El hueco real medido llegó a 30 s.
    expect(BRIDGE_LINK_WAIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CONTENT_LINK_WAIT_MS).toBeGreaterThanOrEqual(3_000);
    expect(CONTENT_LINK_WAIT_MS).toBeLessThan(BRIDGE_LINK_WAIT_MS);
  });

  it('los dos entrypoints esperan con esas constantes, no con un tope corto', () => {
    const entrypoints = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../entrypoints');
    const bridge = readFileSync(path.join(entrypoints, 'binance-tv-bridge.content.ts'), 'utf8');
    const content = readFileSync(path.join(entrypoints, 'content.ts'), 'utf8');
    expect(bridge).toContain("establishLink('bridge', BRIDGE_LINK_WAIT_MS)");
    expect(content).toContain("establishLink('content', CONTENT_LINK_WAIT_MS)");
    expect(bridge).not.toMatch(/establishLink\('bridge',\s*\d/);
    expect(content).not.toMatch(/establishLink\('content',\s*\d/);
  });

  it('si de verdad no aparece nadie, se rinde y libera el punto de encuentro', async () => {
    const promise = establishLink('bridge', 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow('Link timeout');
    expect(document.documentElement.querySelector('swal-link')).toBeNull();
  });
});
