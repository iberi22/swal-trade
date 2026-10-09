export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export interface MarketContext {
  symbol: string;
  timeframe: Timeframe;
  source: 'binance' | 'tradingview';
  /** True cuando la página no expone una temporalidad de la lista. */
  timeframeInferred: boolean;
}

/** Vela en segundos unix, el contrato de `analyze`. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Finding {
  id: string;
  kind: string;
  label: string;
  explanation: string;
  from: number;
  to: number;
  levels: number[];
  direction: string;
  strength: number;
  evidence: unknown;
}

export interface AnalysisInput {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}

export interface AnalysisResult {
  findings: Finding[];
  trend: string | null;
  levels: number[];
  generatedAt: string;
}
