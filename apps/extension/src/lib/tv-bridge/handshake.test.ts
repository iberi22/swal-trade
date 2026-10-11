import { describe, expect, it } from 'vitest';
import {
  DrawRateLimit,
  SHAPE_BUDGET_FACTOR,
  buildHello,
  createSession,
  isPortFor,
  parseHello,
  withinShapeBudget,
} from './handshake';
import { SWAL_MAX_SHAPES, SWAL_MESSAGE_VERSION } from './schema';

describe('saludo aislado ↔ puente (F1)', () => {
  it('crea un session aleatorio por carga', () => {
    expect(createSession()).toMatch(/^[0-9a-f]+$/);
    expect(createSession()).not.toBe(createSession());
  });

  it('parseHello acepta el saludo bien formado y lee enabled', () => {
    const hello = buildHello('deadbeef', true);
    expect(parseHello(hello)).toEqual({ session: 'deadbeef', enabled: true });
    expect(parseHello(buildHello('deadbeef', false)).enabled).toBe(false);
  });

  it('parseHello rechaza basura', () => {
    expect(parseHello({})).toBeNull();
    expect(parseHello({ type: 'otro', version: SWAL_MESSAGE_VERSION, session: 'x' })).toBeNull();
    expect(parseHello({ type: 'swal-tv:hello', version: 99, session: 'x' })).toBeNull();
    expect(parseHello({ type: 'swal-tv:hello', version: SWAL_MESSAGE_VERSION })).toBeNull();
  });

  it('isPortFor solo acepta el puerto de NUESTRO session y con un puerto real', () => {
    // Sin puerto transferido no hay canal.
    expect(isPortFor({ type: SWAL_PORT, version: SWAL_MESSAGE_VERSION, session: 's' }, 's', [])).toBe(false);
    // Puerto de otro session: se descarta.
    const { port1 } = new MessageChannel();
    expect(
      isPortFor({ type: SWAL_PORT, version: SWAL_MESSAGE_VERSION, session: 'otro' }, 's', [port1]),
    ).toBe(false);
    // Session correcto y puerto real (event.ports[0]).
    expect(isPortFor({ type: SWAL_PORT, version: SWAL_MESSAGE_VERSION, session: 's' }, 's', [port1])).toBe(true);
  });

  it('buildHello exige enabled booleano', () => {
    expect(buildHello('s', false).enabled).toBe(false);
  });
});

describe('límite de dibujos por segundo (DrawRateLimit, F1)', () => {
  it('deja pasar hasta cuatro por ventana y corta al quinto', () => {
    const limit = new DrawRateLimit(4, 1000);
    const t0 = 100_000;
    expect([0, 1, 2, 3].every((i) => limit.allow(t0 + i))).toBe(true);
    expect(limit.allow(t0 + 4)).toBe(false);
  });

  it('la ventana deslizante vuelve a dar paso pasado el segundo', () => {
    const limit = new DrawRateLimit(4, 1000);
    for (let i = 0; i < 4; i++) limit.allow(1_000);
    expect(limit.allow(1_500)).toBe(false); // mismo segundo
    expect(limit.allow(2_500)).toBe(true); // ya fuera de la ventana
  });
});

describe('rechazo temprano por tamaño (withinShapeBudget, F1)', () => {
  it('acepta hasta 4× el tope y rechaza por encima', () => {
    expect(withinShapeBudget(SWAL_MAX_SHAPES * SHAPE_BUDGET_FACTOR)).toBe(true);
    expect(withinShapeBudget(SWAL_MAX_SHAPES * SHAPE_BUDGET_FACTOR + 1)).toBe(false);
    expect(withinShapeBudget(SWAL_MAX_SHAPES)).toBe(true);
  });
});

