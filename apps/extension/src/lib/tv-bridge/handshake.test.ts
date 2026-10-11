// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SWAL_HELLO,
  buildHello,
  parseHello,
  withinShapeBudget,
  DrawRateLimit,
  establishLink
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
});
