import { describe, expect, it, vi } from 'vitest';
import type { BridgePositionToolsMessage } from './schema';
import {
  MAX_SCANNED_SHAPES,
  PositionToolsPoller,
  drawingsFromPositionTools,
  isPositionToolName,
  readPositionTools,
  type TvPositionChartLike,
} from './position-tools';

interface FakeShape {
  id: string;
  name: string;
  points?: unknown;
  properties?: unknown;
  getPoints?: () => unknown;
  getProperties?: () => unknown;
}

function shape(over: Partial<FakeShape> & { id: string; name: string }): FakeShape {
  return {
    points: [{ price: 100 }],
    properties: { stopLevel: 1000, profitLevel: 2000 },
    getPoints() {
      return this.points;
    },
    getProperties() {
      return this.properties;
    },
    ...over,
  };
}

function chart(
  shapes: FakeShape[],
  options: { symbol?: string; ext?: unknown; withShapeReader?: boolean } = {},
): TvPositionChartLike & { calls: string[] } {
  const calls: string[] = [];
  const base: TvPositionChartLike = {
    symbol: () => options.symbol ?? 'BTCUSDT@PRICETYPE=LAST',
    symbolExt: () => options.ext ?? { minmov: 1, pricescale: 100 },
    getAllShapes: () => {
      calls.push('getAllShapes');
      return shapes.map((s) => ({ id: s.id, name: s.name }));
    },
    getShapeById: (id: string) => {
      calls.push(`getShapeById:${id}`);
      return shapes.find((s) => s.id === id) ?? null;
    },
  };
  return Object.assign(base, { calls });
}

describe('readPositionTools', () => {
  it('lee nombre, entrada y ticks de una herramienta de posición', () => {
    const message = readPositionTools(
      chart([shape({ id: 'tv-1', name: 'LineToolRiskRewardLong' })]),
    );
    expect(message).toEqual({
      type: 'swal:position-tools',
      version: 2,
      symbol: 'BTCUSDT',
      minmov: 1,
      pricescale: 100,
      tools: [{ id: 'tv-1', name: 'LineToolRiskRewardLong', entry: 100, stopLevel: 1000, profitLevel: 2000 }],
    });
  });

  it('solo mira formas cuyo nombre es de posición (position / riskreward)', () => {
    const message = readPositionTools(
      chart([
        shape({ id: 'a', name: 'horizontal_line' }),
        shape({ id: 'b', name: 'long_position' }),
        shape({ id: 'c', name: 'trend_line' }),
        shape({ id: 'd', name: 'LineToolRiskRewardShort' }),
      ]),
    );
    expect(message?.tools.map((t) => t.id)).toEqual(['b', 'd']);
  });

  it('reconoce los dos nombres vistos en vivo y rechaza el resto', () => {
    expect(isPositionToolName('long_position')).toBe(true);
    expect(isPositionToolName('short_position')).toBe(true);
    expect(isPositionToolName('LineToolRiskRewardLong')).toBe(true);
    expect(isPositionToolName('horizontal_line')).toBe(false);
    expect(isPositionToolName(undefined)).toBe(false);
    expect(isPositionToolName(42)).toBe(false);
  });

  it('devuelve el mensaje con la lista vacía si no hay ningún dibujo de posición', () => {
    const message = readPositionTools(chart([]));
    expect(message?.tools).toEqual([]);
    expect(message?.symbol).toBe('BTCUSDT');
    expect(message?.minmov).toBe(1);
    expect(message?.pricescale).toBe(100);
  });

  it('no inventa nada cuando falta la escala, el símbolo o el lector de formas', () => {
    expect(readPositionTools(null)).toBeNull();
    const noExt: TvPositionChartLike = {
      symbol: () => 'BTCUSDT',
      symbolExt: () => null,
      getAllShapes: () => [],
      getShapeById: () => null,
    };
    expect(readPositionTools(noExt)).toBeNull();
    expect(readPositionTools(chart([], { ext: { minmov: 0, pricescale: 100 } }))).toBeNull();
    expect(readPositionTools(chart([], { ext: { minmov: 1, pricescale: Number.NaN } }))).toBeNull();
    expect(readPositionTools(chart([], { symbol: 'not a symbol' }))).toBeNull();
    expect(readPositionTools(chart([], { symbol: '' }))).toBeNull();
    const noShapes: TvPositionChartLike = { symbol: () => 'BTCUSDT', symbolExt: () => ({ minmov: 1, pricescale: 100 }) };
    expect(readPositionTools(noShapes)).toBeNull();
  });

  it('descarta herramientas rotas (sin puntos, sin ticks, entrada 0)', () => {
    const message = readPositionTools(
      chart([
        shape({ id: 'no-points', name: 'long_position', points: [] }),
        shape({ id: 'no-stop', name: 'long_position', properties: { profitLevel: 2000 } }),
        shape({ id: 'zero', name: 'short_position', points: [{ price: 0 }] }),
        shape({ id: 'ok', name: 'short_position', points: [{ price: 250 }], properties: { stopLevel: 500, profitLevel: 900 } }),
      ]),
    );
    expect(message?.tools).toEqual([
      { id: 'ok', name: 'short_position', entry: 250, stopLevel: 500, profitLevel: 900 },
    ]);
  });

  it('acepta los niveles en snake_case que publica la API', () => {
    const message = readPositionTools(
      chart([
        shape({
          id: 'snake',
          name: 'long_position',
          properties: { stop_level: 1200, profit_level: 2400 },
        }),
      ]),
    );
    expect(message?.tools[0]).toMatchObject({ stopLevel: 1200, profitLevel: 2400 });
  });

  it('no toca el gráfico más allá de leer: ni crea ni borra entidades', () => {
    const fake = chart([shape({ id: 'tv-1', name: 'long_position' })]);
    const removeEntity = vi.fn();
    const createShape = vi.fn();
    readPositionTools(Object.assign(fake, { removeEntity, createShape }));
    expect(removeEntity).not.toHaveBeenCalled();
    expect(createShape).not.toHaveBeenCalled();
  });

  it('se para a las primeras formas escaneadas y a diez herramientas', () => {
    const many = Array.from({ length: MAX_SCANNED_SHAPES + 20 }, (_v, i) =>
      shape({ id: `s-${i}`, name: 'long_position' }),
    );
    const message = readPositionTools(chart(many));
    expect(message?.tools).toHaveLength(10);
  });

  it('nunca lanza: un chart que revienta devuelve null', () => {
    const broken: TvPositionChartLike = {
      symbol: () => {
        throw new Error('boom');
      },
      symbolExt: () => ({ minmov: 1, pricescale: 100 }),
      getAllShapes: () => [],
      getShapeById: () => null,
    };
    expect(readPositionTools(broken)).toBeNull();
  });
});

describe('drawingsFromPositionTools', () => {
  const message = (over: Partial<BridgePositionToolsMessage>): BridgePositionToolsMessage => ({
    type: 'swal:position-tools',
    version: 2,
    symbol: 'BTCUSDT',
    minmov: 1,
    pricescale: 100,
    tools: [],
    ...over,
  });

  it('mapea el ejemplo verificado de BTCUSDT (tick 0,01)', () => {
    const drawings = drawingsFromPositionTools(
      message({
        tools: [
          {
            id: 'tv-btc',
            name: 'LineToolRiskRewardLong',
            entry: 81917.9,
            stopLevel: 592530,
            profitLevel: 592530,
          },
        ],
      }),
    );
    expect(drawings).toEqual([
      { id: 'tv-btc', side: 'long', entry: 81917.9, stop: 75992.6, target: 87843.2, symbol: 'BTCUSDT' },
    ]);
  });

  it('mapea un corto', () => {
    const drawings = drawingsFromPositionTools(
      message({
        symbol: 'ETHUSDT',
        tools: [{ id: 'tv-short', name: 'short_position', entry: 100, stopLevel: 100, profitLevel: 200 }],
      }),
    );
    expect(drawings[0]).toMatchObject({ side: 'short', entry: 100, stop: 101, target: 98 });
  });

  it('mapea un par con tick 1e-7 (1000PEPE) sin perder precisión', () => {
    const drawings = drawingsFromPositionTools(
      message({
        symbol: '1000PEPEUSDC',
        pricescale: 10_000_000,
        tools: [{ id: 'tv-pepe', name: 'long_position', entry: 0.0061234, stopLevel: 2000, profitLevel: 6000 }],
      }),
    );
    expect(drawings).toHaveLength(1);
    expect(drawings[0]?.entry).toBeCloseTo(0.0061234, 9);
    expect(drawings[0]?.stop).toBeCloseTo(0.0059234, 9);
    expect(drawings[0]?.target).toBeCloseTo(0.0067234, 9);
  });

  it('descarta dibujos imposibles y mensajes ausentes', () => {
    expect(drawingsFromPositionTools(null)).toEqual([]);
    const drawings = drawingsFromPositionTools(
      message({
        tools: [
          // Stop a 60 ticks = 60 % de la entrada: `validateDrawing` lo rechaza.
          { id: 'bad', name: 'long_position', entry: 100, stopLevel: 6000, profitLevel: 200 },
          { id: 'good', name: 'long_position', entry: 100, stopLevel: 100, profitLevel: 200 },
        ],
      }),
    );
    expect(drawings.map((d) => d.id)).toEqual(['good']);
  });
});

describe('PositionToolsPoller', () => {
  const message = (entry: number): BridgePositionToolsMessage => ({
    type: 'swal:position-tools',
    version: 2,
    symbol: 'BTCUSDT',
    minmov: 1,
    pricescale: 100,
    tools: [{ id: 'tv-1', name: 'long_position', entry, stopLevel: 1000, profitLevel: 2000 }],
  });

  function harness(read: () => BridgePositionToolsMessage | null) {
    let timer: (() => void) | null = null;
    const sent: BridgePositionToolsMessage[] = [];
    const poller = new PositionToolsPoller(
      { read, send: (m) => sent.push(m) },
      1500,
      (cb) => {
        timer = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      () => {
        timer = null;
      },
    );
    const tick = () => timer?.();
    return { poller, sent, tick, hasTimer: () => timer !== null };
  }

  it('no sondea mientras el interruptor está apagado', () => {
    const read = vi.fn(() => message(100));
    const { poller, sent } = harness(read);
    expect(poller.tick()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(poller.isRunning).toBe(false);
  });

  it('envía en el primer tick y solo repite cuando el payload cambia', () => {
    let entry = 100;
    const { poller, sent, tick, hasTimer } = harness(() => message(entry));
    poller.setEnabled(true);
    expect(poller.isRunning).toBe(true);
    expect(hasTimer()).toBe(true);
    expect(sent).toHaveLength(1);

    tick();
    expect(sent).toHaveLength(1);

    entry = 101;
    tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.tools[0]?.entry).toBe(101);
  });

  it('se para al apagar el interruptor y vuelve a enviar al encender', () => {
    const { poller, sent, tick, hasTimer } = harness(() => message(100));
    poller.setEnabled(true);
    poller.setEnabled(false);
    expect(poller.isRunning).toBe(false);
    expect(hasTimer()).toBe(false);
    tick();
    expect(sent).toHaveLength(1);

    poller.setEnabled(true);
    expect(sent).toHaveLength(2);
    poller.stop();
    expect(poller.isRunning).toBe(false);
  });

  it('si el gráfico desaparece, reenvía el mismo payload cuando vuelve', () => {
    let present = true;
    const { poller, sent, tick } = harness(() => (present ? message(100) : null));
    poller.setEnabled(true);
    expect(sent).toHaveLength(1);
    present = false;
    tick();
    expect(sent).toHaveLength(1);
    present = true;
    tick();
    expect(sent).toHaveLength(2);
  });

  it('un enviar que lanza no rompe el sondeo', () => {
    let timer: (() => void) | null = null;
    const poller = new PositionToolsPoller(
      {
        read: () => message(100),
        send: () => {
          throw new Error('port closed');
        },
      },
      1500,
      (cb) => {
        timer = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      () => {
        timer = null;
      },
    );
    poller.setEnabled(true);
    expect(() => timer?.()).not.toThrow();
    expect(poller.isRunning).toBe(true);
  });
});
