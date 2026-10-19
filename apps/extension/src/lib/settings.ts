import { browser } from "wxt/browser";
import { normalizeSymbol, parseIntervalLabel } from './market-context';
import { isLocaleCode, type LocaleCode } from './i18n/locales';
import { TIMEFRAMES, type Timeframe } from './types';

export const HOTKEY_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'] as const;
export type HotkeyKey = (typeof HOTKEY_KEYS)[number];
export type HotkeyMap = Record<HotkeyKey, Timeframe | null>;
export const DEFAULT_HOTKEY_MAP: HotkeyMap = {
  F1: '1m', F2: '5m', F3: '15m', F4: '1h', F5: '4h',
  F6: null, F7: null, F8: null, F9: null, F10: null, F11: null, F12: null,
};

export const AI_PROVIDERS = ['opencode', 'openrouter', 'openai', 'anthropic', 'gemini', 'local'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type AiRedaction = 'relative' | 'absolute';
export type AcctKind = 'none' | 'ed25519' | 'hmac';

/** Límites de disciplina (reflejan los del guardian del dueño). */
export interface RulesSettings {
  maxRiskPct: number;
  maxLeverage: number;
  dailyLossUsd: number;
  revengeMinutes: number;
}

/** Ajustes de IA. NUNCA guardan claves: esas viven en otro sitio. */
export interface AiSettings {
  provider: AiProvider;
  model: string;
  redaction: AiRedaction;
  consentedProviders: AiProvider[];
}

/** Metadatos de la cuenta; nunca el secreto. */
export interface AcctMeta {
  configured: boolean;
  kind: AcctKind;
  last4: string;
}

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
  /**
   * Lee (solo lectura) las herramientas Long/Short Position que el usuario
   * dibuja en la pestaña Trading View. Arranca apagado: leer el gráfico ajeno
   * es una acción sobre la página y necesita un `true` explícito.
   */
  readDrawings: boolean;
  /**
   * Explicaciones con IA: manda el símbolo, la temporalidad y los patrones a
   * trade.swal.network. Arranca apagado y exige un `true` explícito.
   */
  explainWithAi: boolean;
  /** Atajos de teclado habilitados para cambiar la temporalidad (F1..F12). */
  hotkeysEnabled: boolean;
  /** Mapa de tecla de función a temporalidad (o null para ninguna). */
  hotkeyMap: HotkeyMap;
  /** Permite que un agente local (Claude Code) lea y pinte en el gráfico vía WebSocket. */
  claudeBridgeEnabled: boolean;
  claudeBridgePort: number;
  claudeBridgeToken: string;
  /** Consulta el servicio de radar local swal-radar. */
  radarEnabled: boolean;
  /** Puerto del servicio de radar local. */
  radarPort: number;
  rules: RulesSettings;
  ai: AiSettings;
  /** Lee posiciones del DOM de Binance. Necesita un `true` explícito. */
  domPositions: boolean;
  acctMeta: AcctMeta;
  /** Idioma del panel: 'auto' sigue al navegador. */
  locale: 'auto' | LocaleCode;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultTimeframe: '5m',
  symbols: [],
  autoSync: true,
  paintOnChart: false,
  readDrawings: false,
  explainWithAi: false,
  hotkeysEnabled: true,
  hotkeyMap: { ...DEFAULT_HOTKEY_MAP },
  claudeBridgeEnabled: false,
  claudeBridgePort: 47321,
  claudeBridgeToken: "",
  radarEnabled: true,
  radarPort: 47322,
  rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
  ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
  domPositions: false,
  acctMeta: { configured: false, kind: 'none', last4: '' },
  locale: 'auto',
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

export function normalizeHotkeyMap(raw: unknown): HotkeyMap {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: HotkeyMap = { ...DEFAULT_HOTKEY_MAP };
  for (const key of HOTKEY_KEYS) {
    if (key in record) {
      const val = record[key];
      out[key] = val === null || val === '' || val === 'none' ? null : normalizeSettingsTimeframe(val);
    }
  }
  return out;
}
function clampNumber(value: unknown, min: number, max: number, fallback: number, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const v = integer ? Math.round(value) : value;
  return Math.min(max, Math.max(min, v));
}

export function normalizeRules(raw: unknown): RulesSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS.rules;
  return {
    maxRiskPct: clampNumber(r.maxRiskPct, 0.1, 5, d.maxRiskPct, false),
    maxLeverage: clampNumber(r.maxLeverage, 1, 125, d.maxLeverage, true),
    // Debe ser > 0: lo que no lo sea vuelve al default.
    dailyLossUsd:
      typeof r.dailyLossUsd === 'number' && Number.isFinite(r.dailyLossUsd) && r.dailyLossUsd > 0
        ? Math.min(1e6, r.dailyLossUsd)
        : d.dailyLossUsd,
    revengeMinutes: clampNumber(r.revengeMinutes, 1, 240, d.revengeMinutes, true),
  };
}

function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeAi(raw: unknown): AiSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const consented: AiProvider[] = [];
  if (Array.isArray(r.consentedProviders)) {
    for (const p of r.consentedProviders) {
      if (isAiProvider(p) && !consented.includes(p)) consented.push(p);
    }
  }
  return {
    provider: isAiProvider(r.provider) ? r.provider : DEFAULT_SETTINGS.ai.provider,
    model:
      typeof r.model === 'string' && r.model.length <= 80 && /^[A-Za-z0-9._:/-]*$/.test(r.model)
        ? r.model
        : DEFAULT_SETTINGS.ai.model,
    redaction: r.redaction === 'absolute' ? 'absolute' : 'relative',
    consentedProviders: consented,
  };
}

export function normalizeAcctMeta(raw: unknown): AcctMeta {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind: AcctKind = r.kind === 'ed25519' || r.kind === 'hmac' ? r.kind : 'none';
  const last4 =
    typeof r.last4 === 'string' && /^[A-Za-z0-9]{0,4}$/.test(r.last4) ? r.last4 : '';
  return { configured: r.configured === true, kind, last4 };
}

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
    // Leer los dibujos del usuario también: solo con un `true` explícito.
    readDrawings: record.readDrawings === true,
    // Salir a la red necesita un `true` explícito: nunca por accidente.
    explainWithAi: record.explainWithAi === true,
    // Atajos de teclado activos por defecto; solo false explícito los desactiva.
    hotkeysEnabled: record.hotkeysEnabled === false ? false : DEFAULT_SETTINGS.hotkeysEnabled,
    hotkeyMap: normalizeHotkeyMap(record.hotkeyMap),
    claudeBridgeEnabled: record.claudeBridgeEnabled === true,
    claudeBridgePort:
      typeof record.claudeBridgePort === "number" &&
      Number.isInteger(record.claudeBridgePort) &&
      record.claudeBridgePort >= 1024 &&
      record.claudeBridgePort <= 65535
        ? record.claudeBridgePort
        : DEFAULT_SETTINGS.claudeBridgePort,
    claudeBridgeToken:
      typeof record.claudeBridgeToken === "string"
        ? record.claudeBridgeToken.trim().slice(0, 128)
        : DEFAULT_SETTINGS.claudeBridgeToken,
    radarEnabled: record.radarEnabled === false ? false : DEFAULT_SETTINGS.radarEnabled,
    radarPort:
      typeof record.radarPort === "number" &&
      Number.isInteger(record.radarPort) &&
      record.radarPort >= 1024 &&
      record.radarPort <= 65535
        ? record.radarPort
        : DEFAULT_SETTINGS.radarPort,
    rules: normalizeRules(record.rules),
    ai: normalizeAi(record.ai),
    domPositions: record.domPositions === true,
    acctMeta: normalizeAcctMeta(record.acctMeta),
    locale: isLocaleCode(record.locale) ? record.locale : 'auto',
  };
}

/** `settings` tal como lo guarda `browser.storage.local`. */
export function settingsFromStorage(raw: unknown): ExtensionSettings {
  if (!raw || typeof raw !== 'object') return normalizeSettings(undefined);
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


export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const data = await browser.storage.local?.get(SETTINGS_KEY);
    return settingsFromStorage(data);
  } catch {
    return { ...DEFAULT_SETTINGS, symbols: [] };
  }
}
