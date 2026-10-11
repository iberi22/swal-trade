import { isMarketContext } from './market-context';
import { TV_GET_STATE, TV_STATE, type TvChartState } from './tv-paint';
import type { MarketContext } from './types';

export interface MarketContextMessage {
  type: 'market-context';
  context: MarketContext;
}

export interface GetContextMessage {
  type: 'get-context';
}

export interface ContextResultMessage {
  type: 'context-result';
  context: MarketContext | null;
}

/** El content script avisa de en qué pestaña está el gráfico de Binance. */
export interface TvChartDetail {
  symbol: string;
  tf: string;
}

export interface TvStateMessage {
  type: typeof TV_STATE;
  state: TvChartState;
  /** Solo con `mismatch`: qué símbolo y tf muestra el gráfico. */
  chart?: TvChartDetail;
}

/** El panel pregunta por el último estado conocido. */
export interface GetTvStateMessage {
  type: typeof TV_GET_STATE;
}

export interface TvStateResultMessage {
  type: 'tv-state-result';
  state: TvChartState | null;
  chart?: TvChartDetail;
}

export type RuntimeMessage =
  | MarketContextMessage
  | GetContextMessage
  | ContextResultMessage
  | TvStateMessage
  | GetTvStateMessage
  | TvStateResultMessage;

const TV_STATES: readonly TvChartState[] = [
  'ready',
  'tradingview',
  'original',
  'none',
  'mismatch',
  'unavailable',
];

function parseTvChartDetail(value: unknown): TvChartDetail | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { symbol?: unknown; tf?: unknown };
  if (typeof record.symbol !== 'string' || typeof record.tf !== 'string') return null;
  return { symbol: record.symbol, tf: record.tf };
}

export function parseTvChartState(value: unknown): TvChartState | null {
  return typeof value === 'string' && (TV_STATES as readonly string[]).includes(value)
    ? (value as TvChartState)
    : null;
}

export function parseRuntimeMessage(message: unknown): RuntimeMessage | null {
  if (!message || typeof message !== 'object') return null;
  const type = (message as { type?: unknown }).type;
  if (type === 'get-context') return { type: 'get-context' };
  if (type === TV_GET_STATE) return { type: TV_GET_STATE };
  if (type === TV_STATE) {
    const state = parseTvChartState((message as { state?: unknown }).state);
    if (!state) return null;
    const chart = parseTvChartDetail((message as { chart?: unknown }).chart);
    return chart ? { type: TV_STATE, state, chart } : { type: TV_STATE, state };
  }
  if (type === 'tv-state-result') {
    const state = (message as { state?: unknown }).state;
    const chart = parseTvChartDetail((message as { chart?: unknown }).chart);
    if (state == null) return { type: 'tv-state-result', state: null, chart: chart ?? undefined };
    const parsed = parseTvChartState(state);
    if (!parsed) return null;
    return { type: 'tv-state-result', state: parsed, chart: chart ?? undefined };
  }
  if (type === 'market-context') {
    const context = (message as { context?: unknown }).context;
    return isMarketContext(context) ? { type: 'market-context', context } : null;
  }
  if (type === 'context-result') {
    const context = (message as { context?: unknown }).context;
    if (context == null) return { type: 'context-result', context: null };
    return isMarketContext(context) ? { type: 'context-result', context } : null;
  }
  return null;
}
