// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  SWAL_HELLO,
  buildHello,
  parseHello,
  withinShapeBudget,
  DrawRateLimit,
  establishLink,
  LINK_ACK_WAIT_MS,
  LINK_TAG,
  LINK_RENDEZVOUS_EVENT,
  LINK_PROTOCOL_VERSION,
  type BridgeChannel,
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
  const open: BridgeChannel[] = [];

  beforeEach(() => {
    document.documentElement.innerHTML = '';
    vi.useFakeTimers();
    open.length = 0;
  });

  afterEach(() => {
    while (open.length > 0) open.pop()?.disconnect();
    vi.useRealTimers();
  });

  async function linked(): Promise<[BridgeChannel, BridgeChannel]> {
    const bridgePromise = establishLink('bridge');
    const contentPromise = establishLink('content');
    const [bridge, content] = await Promise.all([bridgePromise, contentPromise]);
    open.push(bridge, content);
    return [bridge, content];
  }

  it('links with the bridge waiting passively and leaves no node in the DOM', async () => {
    const bridgePromise = establishLink('bridge');

    // Mientras espera no hay punto de encuentro expuesto.
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    const [bridge, content] = await Promise.all([bridgePromise, establishLink('content')]);
    open.push(bridge, content);

    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    let received: unknown = null;
    content.onMessage((msg) => { received = msg; });
    bridge.send({ type: 'test' });
    expect(received).toEqual({ type: 'test' });
  });

  it('el puente aguanta la llegada tardía del aislado (50 s) y enlaza igual', async () => {
    const bridgePromise = establishLink('bridge');
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    // Cincuenta segundos de hueco (document_idle tardío): no hay plazo ni nodo.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    const [bridge, content] = await Promise.all([bridgePromise, establishLink('content')]);
    open.push(bridge, content);

    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    let received: unknown = null;
    content.onMessage((msg) => { received = msg; });
    bridge.send(buildHello('sesion-tardia', true));
    expect(parseHello(received)).toEqual(buildHello('sesion-tardia', true));
  });

  it('el nodo solo vive durante el intercambio, no mientras el puente espera', async () => {
    const bridgePromise = establishLink('bridge');
    // Nada colgado durante la espera pasiva.
    expect(document.documentElement.querySelectorAll(LINK_TAG)).toHaveLength(0);

    const contentPromise = establishLink('content');
    // La campana y la captura ocurren en el mismo turno: al volver de
    // `establishLink` el nodo ya no está.
    expect(document.documentElement.querySelectorAll(LINK_TAG)).toHaveLength(0);

    const [bridge, content] = await Promise.all([bridgePromise, contentPromise]);
    open.push(bridge, content);
  });

  it('un atacante con una referencia al nodo no puede inyectar (sin nonce)', async () => {
    // Un script de la página registrado ANTES del puente alcanza a capturar el
    // nodo en el turno del encuentro. Esa referencia es justo lo que P1
    // reproducía: antes valía un `swal:clear` y ahora no.
    let captured: Element | null = null;
    const eavesdrop = () => {
      captured = document.documentElement.querySelector(LINK_TAG);
    };
    window.addEventListener(LINK_RENDEZVOUS_EVENT, eavesdrop);

    const [bridge, content] = await linked();
    window.removeEventListener(LINK_RENDEZVOUS_EVENT, eavesdrop);

    expect(captured).not.toBeNull();

    const received: unknown[] = [];
    bridge.onMessage((msg) => { received.push(msg); });

    // 1) Mensaje sin sobre ni nonce: descartado.
    (captured as unknown as Element).dispatchEvent(
      new CustomEvent('swal:to-bridge', { detail: JSON.stringify({ type: 'swal:clear' }) }),
    );
    // 2) Sobre con nonce inventado: descartado.
    (captured as unknown as Element).dispatchEvent(
      new CustomEvent('swal:to-bridge', {
        detail: JSON.stringify({ v: LINK_PROTOCOL_VERSION, n: '00'.repeat(16), m: { type: 'swal:clear' } }),
      }),
    );

    expect(received).toEqual([]);

    // El canal legítimo sigue funcionando.
    let legit: unknown = null;
    content.onMessage((msg) => { legit = msg; });
    bridge.send({ type: 'swal:hello', session: 's', enabled: true });
    expect(legit).toEqual({ type: 'swal:hello', session: 's', enabled: true });
  });

  it('es one-shot: una segunda campana no crea otro canal', async () => {
    const [bridge, content] = await linked();

    const second = establishLink('content');
    const secondResult = second.then(
      () => 'linked',
      (err: Error) => err.message,
    );

    await vi.advanceTimersByTimeAsync(LINK_ACK_WAIT_MS + 10);
    expect(await secondResult).toBe('Link timeout');
    // El nodo del intento tardío se retiró; no queda ningún canal huérfano.
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    let received: unknown = null;
    content.onMessage((msg) => { received = msg; });
    bridge.send({ ping: true });
    expect(received).toEqual({ ping: true });
  });

  it('un evento de enlace tardío tras el cleanup no crea canal', async () => {
    const pending = establishLink('content');
    const outcome = pending.then(
      () => 'linked',
      (err: Error) => err.message,
    );

    // Nadie contesta: el aislado se rinde, retira el nodo y limpia listeners.
    await vi.advanceTimersByTimeAsync(LINK_ACK_WAIT_MS + 10);
    expect(await outcome).toBe('Link timeout');
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();

    // Un `swal:link`/campana a destiempo no resucita nada.
    window.dispatchEvent(
      new CustomEvent(LINK_RENDEZVOUS_EVENT, { detail: JSON.stringify({ nonce: 'ab'.repeat(16) }) }),
    );
    const late = document.createElement(LINK_TAG);
    document.documentElement.appendChild(late);
    late.dispatchEvent(new CustomEvent('swal:link', { detail: JSON.stringify({ nonce: 'ab'.repeat(16) }) }));

    expect(document.documentElement.querySelector(LINK_TAG)).toBe(late); // nadie lo tocó
    late.remove();
  });

  it('pagehide cancela un enlace pendiente del aislado', async () => {
    const pending = establishLink('content');
    const outcome = pending.then(
      () => 'linked',
      (err: Error) => err.message,
    );

    expect(document.documentElement.querySelector(LINK_TAG)).not.toBeNull();

    window.dispatchEvent(new Event('pagehide'));

    expect(await outcome).toBe('Link cancelled');
    expect(document.documentElement.querySelector(LINK_TAG)).toBeNull();
  });

  it('pagehide cancela la espera pasiva del puente', async () => {
    const pending = establishLink('bridge');
    const outcome = pending.then(
      () => 'linked',
      (err: Error) => err.message,
    );

    window.dispatchEvent(new Event('pagehide'));

    expect(await outcome).toBe('Link cancelled');
  });

  it('la espera del aislado está acotada (nodo fuera del DOM pronto)', () => {
    // El nodo es lo único capturable: si alguien la sube a decenas de segundos,
    // vuelve la ventana de exposición de P1.
    expect(LINK_ACK_WAIT_MS).toBeGreaterThan(0);
    expect(LINK_ACK_WAIT_MS).toBeLessThanOrEqual(2_000);
  });

  it('los entrypoints llaman sin tope numérico', () => {
    const entrypoints = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../entrypoints');
    const bridge = readFileSync(path.join(entrypoints, 'binance-tv-bridge.content.ts'), 'utf8');
    const content = readFileSync(path.join(entrypoints, 'content.ts'), 'utf8');
    expect(bridge).toContain("establishLink('bridge')");
    expect(content).toContain("establishLink('content')");
    expect(bridge).not.toMatch(/establishLink\('bridge',\s*\d/);
    expect(content).not.toMatch(/establishLink\('content',\s*\d/);
  });

  it('page script cannot eavesdrop on the detached channel or forge on window', async () => {
    const [bridge, content] = await linked();

    let eavesdropped: Event | null = null;
    window.addEventListener('swal:to-content', (e) => { eavesdropped = e; });
    document.addEventListener('swal:to-content', (e) => { eavesdropped = e; });

    let receivedByIsolated: unknown = null;
    content.onMessage((msg) => { receivedByIsolated = msg; });

    bridge.send({ secret: true });

    expect(receivedByIsolated).toEqual({ secret: true });
    expect(eavesdropped).toBeNull();

    document.dispatchEvent(new CustomEvent('swal:to-bridge', { detail: JSON.stringify({ forged: true }) }));

    expect(receivedByIsolated).toEqual({ secret: true });
  });

  it('a side never receives its own send', async () => {
    const [bridge] = await linked();

    let bridgeReceived: unknown = null;
    bridge.onMessage((msg) => { bridgeReceived = msg; });

    bridge.send({ echo: true });

    expect(bridgeReceived).toBeNull();
  });
});
