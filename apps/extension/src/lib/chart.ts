import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type HistogramData,
  type IPriceLine,
  type ITimeScaleApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, VolumeFlow } from './types';
import { CVD_TONE, cvdHistogramData, cvdLineData, type FlowBar, type FlowPoint } from './volume-flow-view';
import type { ChartAnnotation, ChartPriceLine, PriceLineKind } from './findings-view';

/**
 * Mismos escalones que workers/public-site/static/tokens.css.
 * Subida: cuerpo hueco. Bajada: cuerpo relleno. Un solo tono, sin rojo/verde.
 */
const BG = 'hsl(40 33% 96%)';
const FG = 'hsl(30 12% 12%)';
const MUTED = 'hsl(30 8% 40%)';
const GRID = 'hsl(40 18% 87%)';

/** El tono es único: lo que cambia es la opacidad, nunca el color. */
const DIM = 'hsl(30 12% 12% / 0.32)';
const SOFT = 'hsl(30 12% 12% / 0.55)';

export interface ChartHandle {
  setCandles(candles: Candle[]): void;
  updateCandle(candle: Candle): void;
  times(): number[];
  /** Anotaciones de todos los hallazgos; `selectedId` resalta uno. */
  setAnnotations(annotation: ChartAnnotation, selectedId?: string | null): void;
  /** Escala de tiempo: el panel de CVD la sigue para no desalinearse. */
  timeScale(): ITimeScaleApi<Time>;
  destroy(): void;
}

/**
 * Panel de flujo de volumen: línea de CVD y histograma del delta por vela.
 * `setFlow` repinta la serie completa; `updateFlow` solo mueve el último punto.
 */
export interface FlowPaneHandle {
  setFlow(candles: Candle[], flow: VolumeFlow | null): void;
  updateFlow(candles: Candle[], flow: VolumeFlow | null): void;
  destroy(): void;
}

interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

function toBar(candle: Candle): Bar {
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

const LINE_KIND: Record<PriceLineKind, { lineStyle: LineStyle }> = {
  level: { lineStyle: LineStyle.Solid },
  confirm: { lineStyle: LineStyle.Dashed },
  invalidate: { lineStyle: LineStyle.Dashed },
};

export function mountChart(container: HTMLElement): ChartHandle {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: BG },
      textColor: MUTED,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: GRID },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: {
      vertLine: { color: 'hsl(30 12% 12% / 0.35)', labelBackgroundColor: FG },
      horzLine: { color: 'hsl(30 12% 12% / 0.35)', labelBackgroundColor: FG },
    },
  });

  const series = chart.addSeries(CandlestickSeries, {
    upColor: 'transparent',
    downColor: FG,
    borderVisible: true,
    borderUpColor: FG,
    borderDownColor: FG,
    wickUpColor: FG,
    wickDownColor: FG,
  });
  const markers = createSeriesMarkers(series, []);
  const priceLines: Array<{ line: IPriceLine; findingId: string }> = [];
  let bars: Bar[] = [];

  return {
    setCandles(candles) {
      bars = candles.map(toBar);
      series.setData(bars);
      chart.timeScale().fitContent();
    },
    updateCandle(candle) {
      const bar = toBar(candle);
      const last = bars[bars.length - 1];
      if (last && bar.time < last.time) return;
      try {
        series.update(bar);
      } catch {
        return;
      }
      const index = bars.findIndex((item) => item.time === bar.time);
      if (index >= 0) bars[index] = bar;
      else bars.push(bar);
    },
    times() {
      return bars.map((bar) => bar.time as number);
    },
    timeScale() {
      return chart.timeScale();
    },
    setAnnotations(annotation, selectedId = null) {
      markers.setMarkers(
        annotation.markers.map((marker) => {
          const selected = selectedId !== null && marker.findingId === selectedId;
          return {
            time: marker.time as UTCTimestamp,
            position: marker.position,
            shape: marker.shape,
            color: selected ? FG : DIM,
            text: selected ? marker.text : '',
            size: selected ? 2 : 1,
          };
        }),
      );

      for (const entry of priceLines) series.removePriceLine(entry.line);
      priceLines.length = 0;

      for (const line of annotation.priceLines) {
        priceLines.push({
          line: series.createPriceLine(priceLineOptions(line, selectedId)),
          findingId: line.findingId,
        });
      }
    },
    destroy() {
      chart.remove();
    },
  };
}

/** Un hallazgo elegido manda: el resto se queda en el mismo tono, más flojo. */
function priceLineOptions(line: ChartPriceLine, selectedId: string | null) {
  const kind = LINE_KIND[line.kind] ?? LINE_KIND.level;
  const selected = selectedId !== null && line.findingId === selectedId;
  return {
    price: line.price,
    title: line.title,
    color: selected ? FG : SOFT,
    lineWidth: selected ? (2 as const) : (1 as const),
    lineStyle: kind.lineStyle,
    axisLabelVisible: selected,
  };
}

/**
 * Panel de flujo de volumen debajo del de precio: línea de CVD en el tono
 * principal, histograma del delta en pasos del mismo tono (sin rojo ni verde) y
 * escala de tiempo sincronizada con la del gráfico de velas. `price` es el
 * mango del gráfico de precio: manda su rango visible.
 */
export function mountFlowPane(container: HTMLElement, price: ChartHandle): FlowPaneHandle {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: BG },
      textColor: MUTED,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    },
    grid: { vertLines: { visible: false }, horzLines: { color: GRID } },
    rightPriceScale: { visible: false },
    timeScale: { visible: false, timeVisible: true, secondsVisible: false },
    crosshair: {
      vertLine: { color: 'hsl(30 12% 12% / 0.25)', labelBackgroundColor: FG },
      horzLine: { color: 'hsl(30 12% 12% / 0.25)', labelBackgroundColor: FG },
    },
  });

  const line = chart.addSeries(LineSeries, {
    color: CVD_TONE.line,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerRadius: 3,
  });
  // El delta va en su propia escala, oculta: comparte el lienzo sin inventar números.
  const bars = chart.addSeries(HistogramSeries, {
    priceScaleId: 'delta',
    color: CVD_TONE.deltaUp,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  chart.priceScale('delta').applyOptions({ visible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });

  // La escala de tiempo manda la del precio. El guard corta el rebote entre ambas.
  let syncing = false;
  const pull = () => {
    if (syncing) return;
    syncing = true;
    try {
      const range = price.timeScale().getVisibleLogicalRange();
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    } catch {
      /* rango aún no válido */
    } finally {
      syncing = false;
    }
  };
  const push = () => {
    if (syncing) return;
    syncing = true;
    try {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range) price.timeScale().setVisibleLogicalRange(range);
    } catch {
      /* rango aún no válido */
    } finally {
      syncing = false;
    }
  };
  price.timeScale().subscribeVisibleLogicalRangeChange(pull);
  chart.timeScale().subscribeVisibleLogicalRangeChange(push);

  const paint = (candles: Candle[], flow: VolumeFlow | null) => {
    const lineData = cvdLineData(candles, flow);
    const barsData = cvdHistogramData(candles, flow, CVD_TONE);
    if (!lineData.length) {
      line.setData([]);
      bars.setData([]);
      return;
    }
    line.setData(lineData.map(toLineData));
    bars.setData(barsData.map(toHistogramData));
  };

  return {
    setFlow(candles, flow) {
      paint(candles, flow);
      const range = price.timeScale().getVisibleLogicalRange();
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else chart.timeScale().fitContent();
    },
    updateFlow(candles, flow) {
      const lineData = cvdLineData(candles, flow);
      const barsData = cvdHistogramData(candles, flow, CVD_TONE);
      if (!lineData.length) {
        paint(candles, flow);
        return;
      }
      // Solo cambia la última vela: el CVD acumulado de las anteriores no se mueve.
      try {
        line.update(toLineData(lineData[lineData.length - 1]!));
        bars.update(toHistogramData(barsData[barsData.length - 1]!));
      } catch {
        paint(candles, flow);
      }
    },
    destroy() {
      chart.remove();
    },
  };
}

/** lightweight-charts quiere el tiempo como `Time`, no como número pelado. */
const toLineData = (point: FlowPoint): LineData<UTCTimestamp> => ({
  time: point.time as UTCTimestamp,
  value: point.value,
});

const toHistogramData = (bar: FlowBar): HistogramData<UTCTimestamp> => ({
  time: bar.time as UTCTimestamp,
  value: bar.value,
  color: bar.color,
});
