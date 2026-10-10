import { isMarketContext } from './market-context';
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

export type RuntimeMessage = MarketContextMessage | GetContextMessage | ContextResultMessage;

export function parseRuntimeMessage(message: unknown): RuntimeMessage | null {
  if (!message || typeof message !== 'object') return null;
  const type = (message as { type?: unknown }).type;
  if (type === 'get-context') return { type: 'get-context' };
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
