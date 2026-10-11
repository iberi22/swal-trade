import { describe, expect, it } from 'vitest';
import { ChartSession, type BridgeReport } from './tv-session';
import { buildDrawMessage, type BridgeShape } from './schema';

/** Chart de mentira que apunta lo que se crea, se borra y sus suscripciones. */
function makeChart(symbol: string, resolution: string) {
  let sym = symbol;
  let res = resolution;
  let range = { from: 1_700_000_000, to: 1_700_100_000 };
  const created: Array<{ name: string; points: Array<{ time: number; price: number }> }> = [];
  const removed: string[] = [];
  const cbs: Record<string, () => void> = {};
  let counter = 0;
  const chart = {
    getVisibleRange: () => range,
    symbol: () => sym,
    resolution: () => res,
    createShape(point: { time: number; price: number }, options: { shape: string }) {
      created.push({ name: options.shape, points: [point] });
      return Promise.resolve(`ent-${++counter}`);
    },
    createMultipointShape(points: Array<{ time: number; price: number }>, options: { shape: string }) {
      created.push({ name: options.shape, points });
      return Promise.resolve(`ent-${++counter}`);
    },
    removeEntity(id: string) {
      removed.push(id);
    },
    onSymbolChanged(cb: () => void) {
      cbs.symbol = cb;
    },
    onIntervalChanged(cb: () => void) {
      cbs.interval = cb;
    },
    onVisibleRangeChanged(cb: () => void) {
      cbs.range = cb;
    },
    // Estado observable para las aserciones.
    created,
    removed,
    // Controles del test.
    setSymbol(s: string) {
      sym = s;
    },
    setResolution(r: string) {
      res = r;
    },
    setRange(from: number, to: number) {
      range = { from, to };
    },
    fire(kind: 'symbol' | 'interval' | 'range') {
      cbs[kind]?.();
    },
  };
  return chart;
}

/** Reloj controlado: sleep solo avanza cuando el test hace tick(). */
function makeClock() {
  let pending: (() => void) | null = null;
  const sleep = () =>
    new Promise<void>((resolve) => {
      pending = resolve;
    });
  const tick = async () => {
    const resolve = pending;
    pending = null;
    resolve?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { sleep, tick };
}

/** Documento con un iframe (o ninguno) que publica la API del chart. */
function makeDoc(chart: ReturnType<typeof makeChart> | null) {
  const win = chart ? { tradingViewApi: { activeChart: () => chart } } : null;
  return {
    querySelectorAll: (selector: string) =>
      selector === 'iframe' ? (win ? [{ contentWindow: win }] : []) : [],
  };
}

function levelShape(id: string, price = 100): BridgeShape {
  return { id, kind: 'level', style: 'solid', text: id, points: [{ time: 1_700_050_000, price }] };
}

describe('ChartSession (F4, F2, F3, F14)', () => {
  it('encuentra el chart y queda listo sin pintar nada hasta que le pidan', async () => {
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    expect(session.isReady).toBe(true);
    expect(chart.created).toHaveLength(0);
    session.stop();
  });

  it('un mensaje recibido antes de tener chart se aplica cuando aparece (F4)', async () => {
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    // Sin chart todavía.
    const session = new ChartSession({
      document: makeDoc(null) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    // Llega un draw sin gráfico: se encola, no pinta.
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1d'));
    expect(session.isReady).toBe(false);
    // Aparece el chart que casa con el análisis.
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    (session as unknown as { deps: { document: Document } }).deps.document = makeDoc(
      chart,
    ) as unknown as Document;
    await clock.tick(); // el bucle re-encuentra el chart y listo aplica lo encolado
    expect(session.isReady).toBe(true);
    expect(chart.created.length).toBeGreaterThan(0);
    session.stop();
  });

  it('pinta cuando el chart casa con el análisis (F2)', async () => {
    const chart = makeChart('ETHUSDT@PRICETYPE=LAST', '1h');
    const clock = makeClock();
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: () => {},
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'ETHUSDT@1h'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created.length).toBeGreaterThan(0);
    session.stop();
  });

  it('rehúsa pintar si el símbolo no coincide y avisa del desajuste (F2)', async () => {
    const chart = makeChart('ETHUSDT@PRICETYPE=LAST', '1h');
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1h'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created).toHaveLength(0);
    const last = reports[reports.length - 1]!;
    expect(last.status).toBe('mismatch');
    expect(last.chart).toEqual({ symbol: 'ETHUSDT', tf: '1h' });
    session.stop();
  });

  it('rehúsa pintar si la temporalidad no coincide y avisa (F2)', async () => {
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '240'); // 4h
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1h'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created).toHaveLength(0);
    expect(reports[reports.length - 1]?.status).toBe('mismatch');
    session.stop();
  });

  it('cambiar el símbolo en el chart descuelga y avisa; volver redibuja (F2)', async () => {
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1d'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created.length).toBe(1);
    // El usuario cambia el par a ETH en la página.
    chart.setSymbol('ETHUSDT@PRICETYPE=LAST');
    chart.fire('symbol');
    await new Promise((r) => setTimeout(r, 0));
    expect(reports[reports.length - 1]?.status).toBe('mismatch');
    expect(chart.removed).toContain('ent-1');
    // Vuelve a BTC: redibuja lo último pedido.
    chart.setSymbol('BTCUSDT@PRICETYPE=LAST');
    chart.fire('symbol');
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created.length).toBe(2);
    session.stop();
  });

  it('conserva las formas al perder el chart y las redibuja al volver (F3)', async () => {
    const chartA = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    const clock = makeClock();
    const reports: BridgeReport[] = [];
    const session = new ChartSession({
      document: makeDoc(chartA) as unknown as Document,
      sleep: clock.sleep,
      onStatus: (r) => reports.push(r),
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1d'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chartA.created.length).toBe(1);
    // El iframe se recarga (Trading View ↔ Original): el chart desaparece.
    (session as unknown as { deps: { document: Document } }).deps.document = makeDoc(
      null,
    ) as unknown as Document;
    await clock.tick();
    await clock.tick();
    expect(session.isReady).toBe(false);
    // Vuelve el gráfico (objeto nuevo), aún en BTC/USDT 1D.
    const chartB = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    (session as unknown as { deps: { document: Document } }).deps.document = makeDoc(
      chartB,
    ) as unknown as Document;
    await clock.tick();
    await clock.tick();
    expect(chartB.created.length).toBe(1);
    expect(session.isReady).toBe(true);
    session.stop();
  });

  it('clear borra lo nuestro y deja de pintar', async () => {
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    const clock = makeClock();
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: () => {},
    });
    session.start();
    await clock.tick();
    session.apply(buildDrawMessage([levelShape('a')], 'BTCUSDT@1d'));
    await new Promise((r) => setTimeout(r, 0));
    session.apply({ type: 'swal:clear', version: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.removed).toContain('ent-1');
    session.stop();
  });

  it('refresca el rango con onVisibleRangeChanged y ancla a él (F14)', async () => {
    const chart = makeChart('BTCUSDT@PRICETYPE=LAST', '1D');
    const clock = makeClock();
    const session = new ChartSession({
      document: makeDoc(chart) as unknown as Document,
      sleep: clock.sleep,
      onStatus: () => {},
    });
    session.start();
    await clock.tick();
    // El usuario navega a un tramo muy lejano del gráfico.
    chart.setRange(1_500_000_000, 1_500_100_000);
    chart.fire('range');
    // Un punto fuera del rango se ancla dentro de los márgenes nuevos.
    session.apply(buildDrawMessage([levelShape('a', 100)], 'BTCUSDT@1d'));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.created).toHaveLength(1);
    const point = chart.created[0]!.points[0]!;
    const span = 1_500_100_000 - 1_500_000_000;
    expect(point.time).toBeGreaterThanOrEqual(1_500_000_000 - span);
    expect(point.time).toBeLessThanOrEqual(1_500_100_000 + span);
    session.stop();
  });
});
