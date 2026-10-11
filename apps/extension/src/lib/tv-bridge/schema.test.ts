import { describe, expect, it } from 'vitest';
import {
  MAX_SHAPE_ID,
  MAX_SHAPE_TEXT,
  SHAPE_POINT_RANGE,
  SWAL_CLEAR,
  SWAL_DRAW,
  SWAL_MAX_SHAPES,
  SWAL_MESSAGE_VERSION,
  SWAL_READY,
  buildClearMessage,
  buildDrawMessage,
  buildReadyMessage,
  coerceShape,
  coerceShapes,
  parseBridgeMessage,
  type BridgeShape,
} from './schema';

const NONCE = 'a'.repeat(32);

function shape(overrides: Partial<BridgeShape> = {}): BridgeShape {
  return {
    id: 'shock:1700000000|level:100',
    kind: 'level',
    style: 'solid',
    text: 'cuello 100',
    points: [{ time: 1_700_000_000, price: 100 }],
    ...overrides,
  };
}

describe('coerceShape', () => {
  it('acepta una forma bien formada', () => {
    expect(coerceShape(shape())).toEqual(shape());
  });

  it('exige un id y un tipo conocidos', () => {
    expect(coerceShape(shape({ id: '' }))).toBeNull();
    expect(coerceShape(shape({ kind: 'fibonacci' as never }))).toBeNull();
    expect(coerceShape(shape({ style: 'dotted' as never }))).toBeNull();
  });

  it('rechaza NaN, infinitos y precios no positivos', () => {
    expect(coerceShape(shape({ points: [{ time: Number.NaN, price: 100 }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: 1_700_000_000, price: Number.POSITIVE_INFINITY }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: 1_700_000_000, price: 0 }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: 1_700_000_000, price: -1 } as never] }))).toBeNull();
  });

  it('rechaza tiempos que no son segundos enteros', () => {
    expect(coerceShape(shape({ points: [{ time: 1_700_000_000.5, price: 100 }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: 1_700_000_000_000, price: 100 }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: '1700000000' as never, price: 100 }] }))).toBeNull();
    expect(coerceShape(shape({ points: [{ time: -5, price: 100 }] }))).toBeNull();
  });

  it('cuenta los puntos por tipo', () => {
    expect(SHAPE_POINT_RANGE.trend).toEqual({ min: 2, max: 2 });
    expect(SHAPE_POINT_RANGE.zone).toEqual({ min: 2, max: 2 });
    // Una línea de tendencia con un punto no vale: la API exige dos.
    expect(coerceShape(shape({ kind: 'trend' }))).toBeNull();
    // Un nivel con dos puntos tampoco.
    expect(
      coerceShape(
        shape({ kind: 'level', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }),
      ),
    ).toBeNull();
  });

  it('la flecha necesita dirección', () => {
    expect(coerceShape(shape({ kind: 'arrow' }))).toBeNull();
    expect(coerceShape(shape({ kind: 'arrow', direction: 'sideways' as never }))).toBeNull();
    expect(coerceShape(shape({ kind: 'arrow', direction: 'down' }))?.direction).toBe('down');
  });

  it('recorta id y texto en lugar de tirar la forma', () => {
    const long = coerceShape(shape({ id: 'x'.repeat(200), text: 'y'.repeat(200) }));
    expect(long?.id).toHaveLength(MAX_SHAPE_ID);
    expect(long?.text).toHaveLength(MAX_SHAPE_TEXT);
  });
});

describe('coerceShapes', () => {
  it('descarta las formas inválidas y corta en el tope', () => {
    const many = Array.from({ length: SWAL_MAX_SHAPES + 20 }, (_, index) =>
      shape({ id: `f${index}`, points: [{ time: 1_700_000_000 + index, price: 100 }] }),
    );
    many[3] = { ...many[3]!, points: [{ time: Number.NaN, price: 1 }] };
    const out = coerceShapes([...many, 'basura', null, 42]);
    expect(out).toHaveLength(SWAL_MAX_SHAPES);
    expect(out.some((item) => Number.isNaN(item.points[0]!.time))).toBe(false);
  });

  it('sin array no hay formas', () => {
    expect(coerceShapes(undefined)).toEqual([]);
    expect(coerceShapes({})).toEqual([]);
  });
});

describe('parseBridgeMessage', () => {
  it('acepta el dibujo con el nonce correcto', () => {
    const message = buildDrawMessage([shape()], NONCE, 'BTCUSDT@1h');
    expect(parseBridgeMessage(message, NONCE)).toEqual(message);
  });

  it('acepta el limpiado y el saludo', () => {
    expect(parseBridgeMessage(buildClearMessage(NONCE), NONCE)?.type).toBe(SWAL_CLEAR);
    const ready = buildReadyMessage(NONCE, 'ready');
    expect(parseBridgeMessage(ready, NONCE)).toEqual(ready);
  });

  it('descarta los tipos que no son nuestros', () => {
    expect(parseBridgeMessage({ type: 'swal:paint' }, NONCE)).toBeNull();
    expect(parseBridgeMessage({ type: 'draw' }, NONCE)).toBeNull();
    expect(parseBridgeMessage(undefined, NONCE)).toBeNull();
    expect(parseBridgeMessage('swal:draw', NONCE)).toBeNull();
    expect(parseBridgeMessage([], NONCE)).toBeNull();
  });

  it('descarta otra versión del contrato', () => {
    const stale = { ...buildDrawMessage([shape()], NONCE), version: SWAL_MESSAGE_VERSION + 1 };
    expect(parseBridgeMessage(stale, NONCE)).toBeNull();
    expect(parseBridgeMessage({ ...buildClearMessage(NONCE), version: '1' }, NONCE)).toBeNull();
  });

  it('descarta un nonce que no es el de esta página', () => {
    expect(parseBridgeMessage(buildDrawMessage([shape()], 'b'.repeat(32)), NONCE)).toBeNull();
    // Sin nonce publicado todavía, no se acepta nada.
    expect(parseBridgeMessage(buildDrawMessage([shape()], NONCE), null)).toBeNull();
    expect(parseBridgeMessage(buildDrawMessage([shape()], NONCE), '')).toBeNull();
    expect(parseBridgeMessage(buildDrawMessage([shape()], NONCE), undefined)).toBeNull();
    // Un mensaje sin nonce tampoco.
    const noNonce = { ...buildDrawMessage([shape()], NONCE), nonce: undefined };
    expect(parseBridgeMessage(noNonce, NONCE)).toBeNull();
  });

  it('un dibujo viaja con las formas ya filtradas', () => {
    const empty = buildDrawMessage([], NONCE);
    const parsed = parseBridgeMessage(empty, NONCE);
    expect(parsed?.type).toBe(SWAL_DRAW);
    if (parsed?.type === SWAL_DRAW) expect(parsed.shapes).toEqual([]);
    const dirty = parseBridgeMessage({ ...empty, shapes: [{ id: 'x' }, null, 3] }, NONCE);
    expect(dirty?.type).toBe(SWAL_DRAW);
    if (dirty?.type === SWAL_DRAW) expect(dirty.shapes).toEqual([]);
  });

  it('corta en el tope de formas', () => {
    const huge = buildDrawMessage(
      Array.from({ length: 500 }, (_, index) => shape({ id: `f${index}` })),
      NONCE,
    );
    const parsed = parseBridgeMessage(huge, NONCE);
    expect(parsed?.type).toBe(SWAL_DRAW);
    if (parsed?.type === SWAL_DRAW) expect(parsed.shapes).toHaveLength(SWAL_MAX_SHAPES);
  });

  it('el saludo lleva el motivo y, en desajuste, qué muestra el gráfico', () => {
    const mismatch = buildReadyMessage(NONCE, 'mismatch', { symbol: 'ETHUSDT', tf: '4h' });
    const parsed = parseBridgeMessage(mismatch, NONCE);
    expect(parsed).toMatchObject({ type: SWAL_READY, ready: false, reason: 'mismatch', chart: { symbol: 'ETHUSDT', tf: '4h' } });
    // Sin reason conocido, se degrada a absent (nunca listo).
    const bogus = { ...buildReadyMessage(NONCE, 'ready'), reason: 'quien-sabe' };
    expect(parseBridgeMessage(bogus, NONCE)).toMatchObject({ reason: 'absent', ready: false });
  });

  it('ignora el saludo como orden', () => {
    const ready = buildReadyMessage(NONCE, 'ready') as unknown as Record<string, unknown>;
    expect(parseBridgeMessage(ready, NONCE)).toMatchObject({ type: SWAL_READY, ready: true });
  });
});
