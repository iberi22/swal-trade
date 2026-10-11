import { describe, expect, it } from 'vitest';
import {
  SWAL_HELLO,
  SWAL_PORT,
  buildHello,
  buildPort,
  isPortFor,
  parseHello,
  withinShapeBudget,
  DrawRateLimit,
} from './handshake';

describe('Handshake logic', () => {
  it('buildHello / parseHello', () => {
    const hello = buildHello('sess-1', true);
    expect(hello).toEqual({ type: SWAL_HELLO, session: 'sess-1', enabled: true });

    expect(parseHello(hello)).toEqual(hello);
    expect(parseHello(null)).toBeNull();
    expect(parseHello({ type: 'swal:hello' })).toBeNull();
    expect(parseHello({ type: 'swal:hello', session: 123 })).toBeNull();
  });

  it('buildPort / isPortFor', () => {
    const port = buildPort('sess-1');
    expect(port).toEqual({ type: SWAL_PORT, session: 'sess-1' });

    const ports = [{} as MessagePort];
    expect(isPortFor(port, 'sess-1', ports)).toBe(true);
    expect(isPortFor(port, 'sess-2', ports)).toBe(false);
    expect(isPortFor(port, 'sess-1', [])).toBe(false);
    expect(isPortFor(port, 'sess-1', null)).toBe(false);
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