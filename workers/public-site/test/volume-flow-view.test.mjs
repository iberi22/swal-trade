// Tests de los helpers puros del panel de flujo de volumen (sin DOM ni red).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CVD_LEGEND,
  CVD_NO_DATA,
  TONE,
  cvdHistogramData,
  cvdLineData,
  flowLegend,
  nearestTime,
  volumeShockMarkers,
} from '../static/analisis/volume-flow-view.js';
import { analyzeSync } from '../static/analisis/analysis-core.js';

const T0 = 1_700_000_000;
/** Vela mínima con volumen taker repartido según `share`. */
function candle(i, { close = 100 + i, volume = 100, share = 0.5, wick = 0.3 } = {}) {
  const open = i ? close - 1 : close;
  return {
    time: T0 + i * 60,
    open,
    high: Math.max(open, close) + wick,
    low: Math.min(open, close) - wick,
    close,
    volume,
    takerBuyVolume: volume * share,
  };
}

test('la línea de CVD acumula el delta de cada vela', () => {
  const candles = [
    candle(0, { share: 0.6, volume: 100 }), // delta +20
    candle(1, { share: 0.4, volume: 100 }), // delta −20
    candle(2, { share: 0.5, volume: 100 }), // delta 0
  ];
  assert.deepEqual(cvdLineData(candles), [
    { time: T0, value: 20 },
    { time: T0 + 60, value: 0 },
    { time: T0 + 120, value: 0 },
  ]);
});

test('sin takerBuyVolume no hay línea ni histograma: no se inventa flujo', () => {
  const bare = [candle(0), candle(1)].map(({ takerBuyVolume, ...rest }) => rest);
  assert.deepEqual(cvdLineData(bare), []);
  assert.deepEqual(cvdHistogramData(bare), []);
  assert.deepEqual(cvdLineData([]), []);
  assert.equal(flowLegend(bare), `${CVD_LEGEND} ${CVD_NO_DATA}`);
  assert.equal(flowLegend([candle(0)]), CVD_LEGEND);
});

test('el histograma del delta usa pasos de un solo tono, sin rojo ni verde', () => {
  const bars = cvdHistogramData([
    candle(0, { share: 0.75 }), // +50
    candle(1, { share: 0.25 }), // −50
  ]);
  assert.deepEqual(bars.map((b) => b.value), [50, -50]);
  assert.equal(bars[0].color, TONE.deltaUp);
  assert.equal(bars[1].color, TONE.deltaDown);
  for (const bar of bars) {
    assert.doesNotMatch(bar.color, /red|green|#[0-9a-f]{3}/i);
    assert.match(bar.color, /^rgba\(34, 31, 27, /); // pasos de --foreground
  }
});

test('las velas sin dato taker aportan delta 0 y el CVD se mantiene', () => {
  const candles = [candle(0, { share: 0.6, volume: 100 })];
  const bare = candle(1, { volume: 100 });
  delete bare.takerBuyVolume;
  candles.push(bare);
  assert.deepEqual(cvdHistogramData(candles).map((b) => b.value), [20, 0]);
  assert.deepEqual(cvdLineData(candles).map((b) => b.value), [20, 20]);
});

test('los marcadores de choque marcan ▲ la compra agresiva y ▼ la venta', () => {
  const markers = volumeShockMarkers([
    { kind: 'volume_shock_sell', from: T0 + 300 },
    { kind: 'double_bottom', from: T0 + 60 },
    { kind: 'volume_shock_buy', from: T0 + 120 },
  ]);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map((m) => m.time), [T0 + 120, T0 + 300]);
  assert.deepEqual(markers[0], {
    time: T0 + 120,
    position: 'belowBar',
    shape: 'arrowUp',
    color: TONE.line,
    text: '▲',
  });
  assert.equal(markers[1].position, 'aboveBar');
  assert.equal(markers[1].text, '▼');
});

test('los marcadores se anclan a una vela y aceptan tiempos en milisegundos', () => {
  const times = [T0, T0 + 60, T0 + 120];
  const markers = volumeShockMarkers([{ kind: 'volume_shock_buy', from: (T0 + 61) * 1000 }], { candleTimes: times });
  assert.equal(markers[0].time, T0 + 60);
  assert.equal(volumeShockMarkers([{ kind: 'volume_shock_buy' }]).length, 0);
  assert.equal(volumeShockMarkers(null).length, 0);
  assert.equal(nearestTime(times, T0 + 119), T0 + 120);
  assert.equal(nearestTime([], T0), T0);
  assert.equal(nearestTime(times, 'x'), null);
});

// ---------- integración con el núcleo ----------

/** 71 velas con un choque de compra agresiva al final (volumen 8× y 80% taker). */
function shockedCandles() {
  const candles = [];
  for (let i = 0; i < 70; i += 1) candles.push(candle(i, { close: 100 + i * 0.4 }));
  candles.push(candle(70, { close: 128, volume: 900, share: 0.8 }));
  return candles;
}

test('un choque de volumen del núcleo se pinta como marcador en su vela', () => {
  const candles = shockedCandles();
  const res = analyzeSync({ symbol: 'BTCUSDT', timeframe: '15m', candles });
  const shock = res.findings.find((f) => f.kind === 'volume_shock_buy');
  assert.ok(shock, 'el núcleo debe detectar la compra agresiva');
  assert.ok(res.volumeFlow, 'y exponer el flujo de volumen');
  assert.equal(res.volumeFlow.cvd.length, candles.length);
  assert.equal(res.volumeFlow.buyShare.at(-1), 0.8);

  const markers = volumeShockMarkers(res.findings, { candleTimes: candles.map((c) => c.time) });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].time, shock.from);
  assert.equal(markers[0].text, '▲');
  // El panel tiene datos que pintar: la línea y el histograma llegan al final.
  assert.equal(cvdLineData(candles).length, candles.length);
  assert.ok(cvdHistogramData(candles).at(-1).value > 0);
});

test('sin datos taker el núcleo no publica flujo ni choques', () => {
  const candles = shockedCandles().map(({ takerBuyVolume, ...rest }) => rest);
  const res = analyzeSync({ symbol: 'BTCUSDT', timeframe: '15m', candles });
  assert.equal(res.volumeFlow, null);
  assert.equal(res.findings.some((f) => f.kind.startsWith('volume_shock_')), false);
  assert.deepEqual(cvdLineData(candles), []);
});
