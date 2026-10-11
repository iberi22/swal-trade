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
export interface TvStateMessage {
  type: typeof TV_STATE;
  state: TvChartState;
}

/** El panel pregunta por el último estado conocido. */
export interface GetTvStateMessage {
  type: typeof TV_GET_STATE;
}

export interface TvStateResultMessage {
  type: 'tv-state-result';
  state: TvChartState | null;
}

export type RuntimeMessage =
  | MarketContextMessage
  | GetContextMessage
  | ContextResultMessage
  | TvStateMessage
  | GetTvStateMessage
  | TvStateResultMessage;

const TV_STATES: readonly TvChartState[] = ['ready', 'tradingview', 'original', 'none'];

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
    return state ? { type: TV_STATE, state } : null;
  }
  if (type === 'tv-state-result') {
    const state = (message as { state?: unknown }).state;
    if (state == null) return { type: 'tv-state-result', state: null };
    const parsed = parseTvChartState(state);
    return parsed ? { type: 'tv-state-result', state: parsed } : null;
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
