export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export interface MarketContext {
  symbol: string;
  timeframe: Timeframe;
  source: 'binance' | 'tradingview';
  /** True cuando la página no expone una temporalidad de la lista. */
  timeframeInferred: boolean;
}

/**
 * Nivel de decisión de un hallazgo. El núcleo rellena `confirm` e
 * `invalidate` en cada nivel con los precios de decisión del patrón.
 * `levels: []` en los hallazgos antiguos: se acepta también el número pelado.
 */
export interface FindingLevel {
  /** Papel del nivel dentro del patrón: cuello, soporte, val, trough… */
  role?: string;
  price: number;
  /** Precio que confirma el patrón si el cierre lo atraviesa. */
  confirm?: number;
  /** Precio que invalida el patrón si el cierre lo atraviesa. */
  invalidate?: number;
  /** Otros campos numéricos del núcleo (low, high, touches…). */
  [key: string]: unknown;
}

/**
 * Vela en segundos unix, el contrato de `analyze`.
 * `takerBuyVolume` y `trades` son opcionales: sin ellos el núcleo omite el
 * flujo de volumen (delta/CVD) y sus hallazgos, pero el resto funciona igual.
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Número de trades de la vela (índice 8 de la fila de klines). */
  trades?: number;
  /** Volumen de compra agresiva / taker buy base (índice 9 de la fila de klines). */
  takerBuyVolume?: number;
}

export interface Finding {
  id: string;
  kind: string;
  label: string;
  explanation: string;
  from: number;
  to: number;
  levels: Array<FindingLevel | number>;
  direction: string;
  strength: number;
  /** `confirmed` cuando el patrón ya cerró; `forming` mientras se forma. */
  status?: string;
  evidence: unknown;
}

export interface AnalysisInput {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}

export interface AnalysisResult {
  findings: Finding[];
  /** Subconjunto diverso de `findings`: lo que se dibuja en el gráfico. */
  top: Finding[];
  trend: string | null;
  levels: number[];
  generatedAt: string;
}
