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
    expect(coerceShape(shape({ kind: 'trend' }))).toBeNull();
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
  it('acepta el dibujo (la confianza la da el puerto, no el contenido)', () => {
    const message = buildDrawMessage([shape()], 'BTCUSDT@1h');
    expect(parseBridgeMessage(message)).toEqual(message);
  });

  it('acepta el limpiado y el saludo', () => {
    expect(parseBridgeMessage(buildClearMessage())?.type).toBe(SWAL_CLEAR);
    const ready = buildReadyMessage('ready');
    expect(parseBridgeMessage(ready)).toEqual(ready);
  });

  it('descarta los tipos que no son nuestros', () => {
    expect(parseBridgeMessage({ type: 'swal:paint' })).toBeNull();
    expect(parseBridgeMessage({ type: 'draw' })).toBeNull();
    expect(parseBridgeMessage(undefined)).toBeNull();
    expect(parseBridgeMessage('swal:draw')).toBeNull();
    expect(parseBridgeMessage([])).toBeNull();
  });

  it('descarta otra versión del contrato', () => {
    const stale = { ...buildDrawMessage([shape()]), version: SWAL_MESSAGE_VERSION + 1 };
    expect(parseBridgeMessage(stale)).toBeNull();
    expect(parseBridgeMessage({ ...buildClearMessage(), version: '1' })).toBeNull();
  });

  it('un dibujo viaja con las formas ya filtradas', () => {
    const empty = buildDrawMessage([]);
    const parsed = parseBridgeMessage(empty);
    expect(parsed?.type).toBe(SWAL_DRAW);
    if (parsed?.type === SWAL_DRAW) expect(parsed.shapes).toEqual([]);
    const dirty = parseBridgeMessage({ ...empty, shapes: [{ id: 'x' }, null, 3] });
    expect(dirty?.type).toBe(SWAL_DRAW);
    if (dirty?.type === SWAL_DRAW) expect(dirty.shapes).toEqual([]);
  });

  it('corta en el tope de formas', () => {
    const huge = buildDrawMessage(
      Array.from({ length: 500 }, (_, index) => shape({ id: `f${index}` })),
    );
    const parsed = parseBridgeMessage(huge);
    expect(parsed?.type).toBe(SWAL_DRAW);
    if (parsed?.type === SWAL_DRAW) expect(parsed.shapes).toHaveLength(SWAL_MAX_SHAPES);
  });

  it('el saludo lleva el motivo y, en desajuste, qué muestra el gráfico', () => {
    const mismatch = buildReadyMessage('mismatch', { symbol: 'ETHUSDT', tf: '4h' });
    const parsed = parseBridgeMessage(mismatch);
    expect(parsed).toMatchObject({
      type: SWAL_READY,
      ready: false,
      reason: 'mismatch',
      chart: { symbol: 'ETHUSDT', tf: '4h' },
    });
    // Sin reason conocido, se degrada a absent (nunca listo).
    const bogus = { ...buildReadyMessage('ready'), reason: 'quien-sabe' };
    expect(parseBridgeMessage(bogus)).toMatchObject({ reason: 'absent', ready: false });
  });

  it('ignora el saludo como orden', () => {
    const ready = buildReadyMessage('ready') as unknown as Record<string, unknown>;
    expect(parseBridgeMessage(ready)).toMatchObject({ type: SWAL_READY, ready: true });
  });
});
