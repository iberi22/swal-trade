import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from './types';
import type { ChartAnnotation } from './findings-view';

/**
 * Mismos escalones que workers/public-site/static/tokens.css.
 * Subida: cuerpo hueco. Bajada: cuerpo relleno. Un solo tono, sin rojo/verde.
 */
const BG = 'hsl(40 33% 96%)';
const FG = 'hsl(30 12% 12%)';
const MUTED = 'hsl(30 8% 40%)';
const GRID = 'hsl(40 18% 87%)';

export interface ChartHandle {
  setCandles(candles: Candle[]): void;
  updateCandle(candle: Candle): void;
  times(): number[];
  setAnnotations(annotation: ChartAnnotation): void;
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
  const priceLines: IPriceLine[] = [];
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
    setAnnotations(annotation) {
      for (const line of priceLines) series.removePriceLine(line);
      priceLines.length = 0;
      markers.setMarkers(
        annotation.markers.map((marker) => ({
          time: marker.time as UTCTimestamp,
          position: marker.position,
          shape: marker.shape,
          color: FG,
          text: marker.text,
        })),
      );
      for (const line of annotation.priceLines) {
        priceLines.push(
          series.createPriceLine({
            price: line.price,
            title: line.title,
            color: FG,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
          }),
        );
      }
    },
    destroy() {
      chart.remove();
    },
  };
}
