import { normalizeSymbol, parseIntervalLabel } from './market-context';
import { TIMEFRAMES, type Timeframe } from './types';

export interface ExtensionSettings {
  /** Temporalidad con la que arranca el panel cuando la página no dice nada. */
  defaultTimeframe: Timeframe;
  /** Pares o activos permitidos. Vacío = todos. */
  symbols: string[];
  /** Si el panel sigue la página abierta. */
  autoSync: boolean;
  /**
   * Pinta los niveles en el gráfico de Binance (pestaña Trading View).
   * Arranca apagado: es una anotación sobre la página, no un añadido del panel.
   */
  paintOnChart: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultTimeframe: '5m',
  symbols: [],
  autoSync: true,
  paintOnChart: false,
};

export const SETTINGS_KEY = 'settings';

export function normalizeSettingsTimeframe(value: unknown): Timeframe | null {
  const parsed = parseIntervalLabel(typeof value === 'string' ? value : null, { bare: true });
  return parsed && (TIMEFRAMES as readonly string[]).includes(parsed) ? parsed : null;
}

/** Token con pinta de símbolo: 2 a 12 letras o dígitos, y al menos una letra. */
function looksLikeSymbol(text: string): boolean {
  return /^[A-Z0-9]{2,12}$/.test(text) && /[A-Z]/.test(text);
}

/**
 * Parte el campo de texto en tokens. Primero por comas y saltos de línea; si un
 * trozo trae espacios, solo se parte cuando TODAS sus palabras parecen
 * símbolos. Así "BTCUSDT ETHUSDT" funciona y "MY API KEY" se descarta entero.
 */
function tokenize(value: string): string[] {
  const out: string[] = [];
  for (const chunk of value.split(/[,;\r\n]+/)) {
    const text = chunk.trim();
    if (!text) continue;
    if (!/\s/.test(text)) {
      out.push(text);
      continue;
    }
    const parts = text.split(/\s+/);
    if (parts.every(looksLikeSymbol)) out.push(...parts);
  }
  return out;
}

/**
 * Acepta "BTC, ETH", ["btcusdt"] o "BTCUSDT ETHUSDT".
 * Cada entrada puede ser el par completo o solo el activo.
 */
export function normalizeSymbolList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? tokenize(value) : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim().toUpperCase().replace(/^\$/, '');
    if (text.length > 20) continue;
    const symbol = normalizeSymbol(text) ?? (looksLikeSymbol(text) ? text : null);
    if (!symbol || out.includes(symbol)) continue;
    out.push(symbol);
    if (out.length >= 50) break;
  }
  return out;
}

/** Nunca confía en lo que haya en disco: valida campo a campo. */
export function normalizeSettings(raw: unknown): ExtensionSettings {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const timeframe = normalizeSettingsTimeframe(record.defaultTimeframe);
  return {
    defaultTimeframe: timeframe ?? DEFAULT_SETTINGS.defaultTimeframe,
    symbols: normalizeSymbolList(record.symbols),
    // Solo un `false` explícito apaga el seguimiento. Cualquier otra cosa es
    // basura y se queda con el valor por defecto.
    autoSync: record.autoSync === false ? false : DEFAULT_SETTINGS.autoSync,
    // Pintar en el gráfico necesita un `true` explícito: se sale del panel.
    paintOnChart: record.paintOnChart === true,
  };
}

/** `settings` tal como lo guarda `browser.storage.local`. */
export function settingsFromStorage(raw: unknown): ExtensionSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS, symbols: [] };
  const wrapped = (raw as Record<string, unknown>).settings;
  return normalizeSettings(wrapped ?? raw);
}

/**
 * Monedas con las que Binance cotiza un par. La lista blanca acepta el activo
 * ("BTC" cubre BTCUSDT y BTCUSDC) y el multiplicador de Binance ("PEPE" cubre
 * 1000PEPEUSDT). No vale empezar por: "SOL" no cubre SOLVUSDT.
 */
const QUOTES = '(?:USDT|USDC|BUSD|FDUSD|USD|PERP)';
const MULTIPLIER = '(?:[0-9]{1,5})?';

/** Lista vacía = todos los símbolos pasan. */
export function symbolAllowed(symbol: string, whitelist: readonly string[]): boolean {
  if (whitelist.length === 0) return true;
  const upper = symbol.toUpperCase();
  return whitelist.some((entry) => {
    const upperEntry = entry.trim().toUpperCase().replace(/^\$/, '');
    if (upper === upperEntry) return true;
    if (!looksLikeSymbol(upperEntry)) return false;
    return new RegExp(`^${MULTIPLIER}${upperEntry}${QUOTES}$`).test(upper);
  });
}

export function settingsToInputs(settings: ExtensionSettings): string {
  return settings.symbols.join(', ');
}
