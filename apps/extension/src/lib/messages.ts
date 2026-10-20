import { isMarketContext } from './market-context';
import { parsePositionToolsMessage, type BridgePositionToolsMessage } from './tv-bridge/schema';
import { TV_GET_STATE, TV_POSITION_TOOLS, TV_STATE, type TvChartState } from './tv-paint';
import type { HotkeyAction } from './hotkeys';
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

export interface HotkeySetTimeframeMessage {
  type: 'swal:hotkey-set-timeframe';
  timeframe: string;
}

/**
 * Hotkey actions the page forwards to the panel (symbol, paint and drawing).
 * Timeframes keep their own message: the background needs them to drive the
 * chart bridge.
 */
export type PageHotkeyAction =
  | { type: 'symbol'; direction: 1 | -1 }
  | { type: 'paint' }
  | { type: 'drawing' };

export interface HotkeyActionMessage {
  type: 'swal:hotkey-action';
  action: PageHotkeyAction;
}

/** El content script releva las herramientas de posición leídas del gráfico. */
export interface TvPositionToolsMessage {
  type: typeof TV_POSITION_TOOLS;
  tools: BridgePositionToolsMessage;
}

export type RuntimeMessage =
  | MarketContextMessage
  | GetContextMessage
  | ContextResultMessage
  | TvStateMessage
  | GetTvStateMessage
  | TvStateResultMessage
  | HotkeySetTimeframeMessage
  | HotkeyActionMessage
  | TvPositionToolsMessage;

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

/**
 * Message the page uses to forward a hotkey. Timeframes travel on their own
 * type (the background uses them to drive the chart); the other four actions
 * go to the panel. Null when the action is not forwarded.
 */
export function pageHotkeyMessage(
  action: HotkeyAction | null | undefined,
): HotkeySetTimeframeMessage | HotkeyActionMessage | null {
  if (!action) return null;
  if (action.type === 'timeframe') {
    return { type: 'swal:hotkey-set-timeframe', timeframe: action.timeframe };
  }
  return { type: 'swal:hotkey-action', action };
}

/** Closed shape of a forwarded hotkey action. */
export function parsePageHotkeyAction(value: unknown): PageHotkeyAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as { type?: unknown; direction?: unknown };
  if (action.type === 'paint') return { type: 'paint' };
  if (action.type === 'drawing') return { type: 'drawing' };
  if (action.type === 'symbol') {
    if (action.direction === 1) return { type: 'symbol', direction: 1 };
    if (action.direction === -1) return { type: 'symbol', direction: -1 };
  }
  return null;
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
  if (type === 'swal:hotkey-set-timeframe') {
    const timeframe = (message as { timeframe?: unknown }).timeframe;
    if (typeof timeframe === 'string') {
      return { type: 'swal:hotkey-set-timeframe', timeframe };
    }
    return null;
  }
  if (type === 'swal:hotkey-action') {
    const action = parsePageHotkeyAction((message as { action?: unknown }).action);
    return action ? { type: 'swal:hotkey-action', action } : null;
  }
  if (type === TV_POSITION_TOOLS) {
    const tools = parsePositionToolsMessage((message as { tools?: unknown }).tools);
    return tools ? { type: TV_POSITION_TOOLS, tools } : null;
  }
  if (type === 'context-result') {
    const context = (message as { context?: unknown }).context;
    if (context == null) return { type: 'context-result', context: null };
    return isMarketContext(context) ? { type: 'context-result', context } : null;
  }
  return null;
}

/**
 * Mensajes privilegiados (cuenta e IA). Solo los atiende el background cuando
 * vienen del panel de la propia extension; ver `lib/background/router.ts`.
 */
export type AcctGetParams = Record<string, string | number | undefined>;

export type PrivilegedMessage =
  | { type: 'acct:snapshot'; symbol: string }
  | { type: 'acct:get'; path: string; params: AcctGetParams }
  | { type: 'acct:gen-ed25519' }
  | { type: 'acct:set-key'; apiKey: string; kind: 'ed25519' | 'hmac'; hmacSecret?: string }
  | { type: 'acct:test' }
  | { type: 'acct:clear' }
  | { type: 'acct:meta' }
  | { type: 'ai:set-key'; provider: string; key: string; persist: 'session' | 'vault' }
  | { type: 'ai:clear'; provider?: string }
  | { type: 'ai:models'; provider: string }
  | { type: 'ai:analyze'; provider: string; model: string; payload: Record<string, unknown> };

/** Tipos que exigen la guarda de remitente. */
export function isPrivilegedType(type: unknown): boolean {
  return typeof type === 'string' && (type.startsWith('acct:') || type.startsWith('ai:'));
}

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const API_KEY_RE = /^[A-Za-z0-9]{16,128}$/;
const PRINTABLE_RE = /^[\x21-\x7e]+$/;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parsePrivilegedMessage(message: unknown): PrivilegedMessage | null {
  if (!isPlain(message)) return null;
  const m = message;
  switch (m.type) {
    case 'acct:snapshot':
      return typeof m.symbol === 'string' && SYMBOL_RE.test(m.symbol)
        ? { type: 'acct:snapshot', symbol: m.symbol }
        : null;
    case 'acct:get': {
      if (typeof m.path !== 'string' || m.path.length > 80) return null;
      const params: AcctGetParams = {};
      if (m.params !== undefined) {
        if (!isPlain(m.params)) return null;
        for (const [k, v] of Object.entries(m.params)) {
          if (v === undefined) continue;
          if (typeof v !== 'string' && typeof v !== 'number') return null;
          params[k] = v;
        }
      }
      return { type: 'acct:get', path: m.path, params };
    }
    case 'acct:gen-ed25519':
    case 'acct:test':
    case 'acct:clear':
    case 'acct:meta':
      return { type: m.type };
    case 'acct:set-key': {
      if (typeof m.apiKey !== 'string' || !API_KEY_RE.test(m.apiKey)) return null;
      if (m.kind === 'ed25519') return { type: 'acct:set-key', apiKey: m.apiKey, kind: 'ed25519' };
      if (m.kind === 'hmac') {
        const s = m.hmacSecret;
        if (typeof s !== 'string' || s.length > 256 || !PRINTABLE_RE.test(s)) return null;
        return { type: 'acct:set-key', apiKey: m.apiKey, kind: 'hmac', hmacSecret: s };
      }
      return null;
    }
    case 'ai:set-key': {
      if (typeof m.provider !== 'string' || typeof m.key !== 'string') return null;
      if (m.key.length < 8 || m.key.length > 512 || !PRINTABLE_RE.test(m.key)) return null;
      if (m.persist !== 'session' && m.persist !== 'vault') return null;
      return { type: 'ai:set-key', provider: m.provider, key: m.key, persist: m.persist };
    }
    case 'ai:clear':
      if (m.provider === undefined) return { type: 'ai:clear' };
      return typeof m.provider === 'string' ? { type: 'ai:clear', provider: m.provider } : null;
    case 'ai:models':
      return typeof m.provider === 'string' ? { type: 'ai:models', provider: m.provider } : null;
    case 'ai:analyze':
      if (typeof m.provider !== 'string' || typeof m.model !== 'string' || !isPlain(m.payload)) return null;
      return { type: 'ai:analyze', provider: m.provider, model: m.model, payload: m.payload };
    default:
      return null;
  }
}
