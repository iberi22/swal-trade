import { describe, expect, it } from 'vitest';
import { analyze, volumeFlowOf } from './analysis';
import { findingsLegend, kindLabel, markersForFinding } from './findings-view';
import type { AnalysisResult, Candle, Finding, VolumeFlow } from './types';
import {
  CVD_LEGEND_TEXT,
  CVD_NO_DATA_TEXT,
  CVD_TONE,
  cvdHistogramData,
  cvdLineData,
  flowLegendText,
  volumeShockMarkers,
} from './volume-flow-view';

const T0 = 1_700_000_000;

function candle(i: number, share = 0.5, volume = 100): Candle {
  const close = 100 + i;
  const open = i ? close - 1 : close;
  return {
    time: T0 + i * 60,
    open,
    high: Math.max(open, close) + 0.3,
    low: Math.min(open, close) - 0.3,
    close,
    volume,
    takerBuyVolume: volume * share,
  };
}

const flow: VolumeFlow = {
  delta: [20, -20, 0],
  cvd: [20, 0, 0],
  buyShare: [0.6, 0.4, 0.5],
};

function shock(id: string, kind: string, from: number, direction: 'up' | 'down'): Finding {
  return {
    id,
    kind,
    label: 'choque',
    explanation: 'explicación',
    from,
    to: from,
    levels: [],
    direction,
    strength: 0.7,
    evidence: null,
  };
}

describe('series del panel de flujo', () => {
  it('la línea del CVD acumula el delta del núcleo', () => {
    const candles = [candle(0, 0.6), candle(1, 0.4), candle(2, 0.5)];
    expect(cvdLineData(candles, flow)).toEqual([
      { time: T0, value: 20 },
      { time: T0 + 60, value: 0 },
      { time: T0 + 120, value: 0 },
    ]);
  });

  it('sin flujo no hay puntos: no se inventa nada', () => {
    const candles = [candle(0), candle(1)];
    expect(cvdLineData(candles, null)).toEqual([]);
    expect(cvdHistogramData(candles, undefined)).toEqual([]);
    expect(flowLegendText(candles, null)).toBe(`${CVD_LEGEND_TEXT} ${CVD_NO_DATA_TEXT}`);
    expect(flowLegendText(candles, flow)).toBe(CVD_LEGEND_TEXT);
  });

  it('el histograma pinta pasos de un solo tono, sin rojo ni verde', () => {
    const candles = [candle(0, 0.75), candle(1, 0.25)];
    const bars = cvdHistogramData(candles, flow, CVD_TONE);
    expect(bars.map((bar) => bar.value)).toEqual([20, -20]);
    expect(bars[0]?.color).toBe(CVD_TONE.deltaUp);
    expect(bars[1]?.color).toBe(CVD_TONE.deltaDown);
    for (const bar of bars) {
      expect(bar.color).not.toMatch(/#|red|green/i);
      expect(bar.color).toMatch(/^hsl\(30 12% 12%/);
    }
  });

  it('descarta puntos cuyo tiempo no es utilizable', () => {
    const broken = [{ ...candle(0), time: 0 }];
    expect(cvdLineData(broken, flow)).toEqual([]);
    expect(cvdLineData([candle(0)], { ...flow, cvd: [] })).toEqual([]);
  });
});

describe('marcadores de choque con agresión', () => {
  it('marca ▲ la compra agresiva y ▼ la venta', () => {
    const markers = volumeShockMarkers([
      shock('a', 'volume_shock_sell', T0 + 300, 'down'),
      shock('b', 'double_bottom', T0 + 60, 'up'),
      shock('c', 'volume_shock_buy', T0 + 120, 'up'),
    ]);
    expect(markers).toEqual([
      { time: T0 + 120, position: 'belowBar', shape: 'arrowUp', text: '▲', findingId: 'c' },
      { time: T0 + 300, position: 'aboveBar', shape: 'arrowDown', text: '▼', findingId: 'a' },
    ]);
  });

  it('ancla el marcador a la vela más cercana y acepta milisegundos', () => {
    const times = [T0, T0 + 60, T0 + 120];
    const markers = volumeShockMarkers([shock('c', 'volume_shock_buy', (T0 + 61) * 1000, 'up')], times);
    expect(markers[0]?.time).toBe(T0 + 60);
  });

  it('el marcador del choque sale de markersForFinding, no se duplica', () => {
    const buy = shock('c', 'volume_shock_buy', T0 + 120, 'up');
    expect(markersForFinding(buy, [T0, T0 + 60, T0 + 120])).toEqual([
      { time: T0 + 120, position: 'belowBar', shape: 'arrowUp', text: '▲', findingId: 'c' },
    ]);
    // El resto de hallazgos sigue usando su etiqueta como texto.
    const other = markersForFinding(
      { ...shock('d', 'double_bottom', T0, 'up'), label: 'Doble suelo', to: T0 + 60 },
      [T0, T0 + 60],
    );
    expect(other.map((marker) => marker.text)).toEqual(['', 'Doble suelo']);
  });

  it('los choques de volumen tienen etiqueta en español', () => {
    expect(kindLabel('volume_shock_buy', '')).toBe('compra agresiva');
    expect(kindLabel('volume_shock_sell', '')).toBe('venta agresiva');
    expect(kindLabel('delta_divergence_bullish', '')).toBe('divergencia de delta alcista');
    expect(kindLabel('delta_divergence_bearish', '')).toBe('divergencia de delta bajista');
    expect(kindLabel('absorption', '')).toBe('absorción');
    expect(kindLabel('climax', '')).toBe('clímax de volumen');
  });
});

describe('integración con el núcleo', () => {
  /** 40 velas con un choque de compra agresiva al final. */
  const candles: Candle[] = [];
  for (let i = 0; i < 39; i += 1) candles.push(candle(i, 0.5));
  candles.push(candle(39, 0.85, 900));

  it('analyze expone el flujo y volumeFlowOf lo devuelve tal cual', () => {
    const result: AnalysisResult = analyze({ symbol: 'BTCUSDT', timeframe: '15m', candles });
    expect(result.volumeFlow).not.toBeNull();
    expect(result.volumeFlow?.cvd).toHaveLength(candles.length);
    expect(volumeFlowOf(candles)).toEqual(result.volumeFlow);
    expect(cvdLineData(candles, volumeFlowOf(candles))).toHaveLength(candles.length);
  });

  it('el choque de volumen del núcleo se pinta como ▲ en su vela', () => {
    const result = analyze({ symbol: 'BTCUSDT', timeframe: '15m', candles });
    const shockFinding = result.findings.find((item) => item.kind === 'volume_shock_buy');
    expect(shockFinding).toBeDefined();
    const markers = volumeShockMarkers(result.top, candles.map((c) => c.time));
    const shockTime = candles.find((c) => c.time === shockFinding?.from)?.time;
    expect(markers.some((m) => m.text === '▲' && m.time === shockTime)).toBe(true);
    // La leyenda conserva el hallazgo con su etiqueta.
    expect(findingsLegend(result.top).some((row) => row.kind === 'volume_shock_buy')).toBe(true);
  });

  it('sin takerBuyVolume el núcleo no da flujo y el panel no pinta', () => {
    const bare = candles.map(({ takerBuyVolume, ...rest }) => rest);
    expect(volumeFlowOf(bare)).toBeNull();
    expect(cvdLineData(bare, null)).toEqual([]);
    const result = analyze({ symbol: 'BTCUSDT', timeframe: '15m', candles: bare });
    expect(result.findings.some((item) => item.kind.startsWith('volume_shock_'))).toBe(false);
  });
});
