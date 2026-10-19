// Etiquetas visibles de la pagina de Binance Futures (UI en espanol o ingles).
//
// Nunca se usan clases CSS: Binance las ofusca y las renombra. Solo texto.

export type LabelLang = 'es' | 'en';

export type LabelKey =
  | 'symbol'
  | 'size'
  | 'pnl'
  | 'closeAllMkt'
  | 'closeAllPnl'
  | 'entry'
  | 'breakEven'
  | 'mark'
  | 'liq'
  | 'realizedPnl'
  | 'roi'
  | 'closeVolume'
  | 'avgClose'
  | 'maxOpenInterest'
  | 'opened'
  | 'closed'
  | 'cross'
  | 'isolated'
  | 'long'
  | 'short'
  | 'duration'
  | 'perp';

/** Etiquetas por idioma, en la forma en que aparecen en pantalla. */
export const LABELS: Record<LabelLang, Record<LabelKey, string[]>> = {
  es: {
    symbol: ['Símbolo'],
    size: ['Tamaño'],
    pnl: ['PnL (%ROI)'],
    closeAllMkt: ['Cerrar todo MKT'],
    closeAllPnl: ['Cerrar todo basado en PnL'],
    entry: ['Precio de entrada'],
    breakEven: ['Precio de equilibrio'],
    mark: ['Precio de marca'],
    liq: ['Precio de Liq.', 'Precio de liq.'],
    realizedPnl: ['PnL realizado', 'PnL realizada', 'PnL realizado (USDC)'],
    roi: ['ROI'],
    closeVolume: ['Vol. de cierre', 'Volumen de cierre'],
    avgClose: ['Precio de cierre prom.', 'Precio de cierre promedio'],
    maxOpenInterest: ['Interés abierto máx.', 'Interés abierto max.'],
    opened: ['Abierto'],
    closed: ['Cerrado'],
    cross: ['Cruzado'],
    isolated: ['Aislado'],
    long: ['Long', 'Largo'],
    short: ['Short', 'Corto'],
    duration: ['Duración'],
    perp: ['Perp.', 'Perp'],
  },
  en: {
    symbol: ['Symbol'],
    size: ['Size'],
    pnl: ['PNL (ROI %)', 'PnL (ROI %)'],
    closeAllMkt: ['Close All MKT', 'Close All Market'],
    closeAllPnl: ['Close All by PNL', 'Close All Based on PNL'],
    entry: ['Entry Price'],
    breakEven: ['Break Even Price', 'Breakeven Price'],
    mark: ['Mark Price'],
    liq: ['Liq. Price', 'Liquidation Price'],
    realizedPnl: ['Realized PnL', 'Realized PNL'],
    roi: ['ROI'],
    closeVolume: ['Closing Vol.', 'Closing Volume', 'Close Vol.'],
    avgClose: ['Avg. Close Price', 'Average Close Price'],
    maxOpenInterest: ['Max Open Interest', 'Max. Open Interest'],
    opened: ['Opened'],
    closed: ['Closed'],
    cross: ['Cross'],
    isolated: ['Isolated'],
    long: ['Long'],
    short: ['Short'],
    duration: ['Duration'],
    perp: ['Perp.', 'Perp'],
  },
};

/** Cabeceras de la tabla de posiciones abiertas. */
export const OPEN_POSITION_HEADER_KEYS: readonly LabelKey[] = [
  'symbol',
  'size',
  'pnl',
  'closeAllMkt',
  'closeAllPnl',
  'entry',
  'breakEven',
  'mark',
  'liq',
];

/** Etiquetas cuyos pares etiqueta/valor se leen en el historial. */
export const HISTORY_VALUE_KEYS: readonly LabelKey[] = [
  'realizedPnl',
  'roi',
  'closeVolume',
  'entry',
  'avgClose',
  'maxOpenInterest',
];

export interface MatchedLabel {
  key: LabelKey;
  /** Activo entre parentesis, p. ej. `USDC` en `PnL realizado (USDC)`. */
  asset: string | null;
  /** Texto normalizado (minusculas, sin acentos, espacios colapsados). */
  normalized: string;
}

/** Minusculas, sin acentos, sin espacios de mas ni puntuacion final. */
export function normalizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, '')
    .trim();
}

/** `USDC` de `PnL realizado (USDC)`; null si el parentesis no es un activo. */
export function trailingAsset(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let asset: string | null = null;
  for (const match of raw.matchAll(/\(\s*([A-Za-z0-9]{2,20})\s*\)/g)) {
    const candidate = match[1] ?? '';
    if (/[A-Z]/.test(candidate)) asset = candidate.toUpperCase();
  }
  return asset;
}

const ALIASES = new Map<string, LabelKey>();

for (const lang of ['es', 'en'] as const) {
  const table = LABELS[lang];
  for (const key of Object.keys(table) as LabelKey[]) {
    for (const raw of table[key]) {
      const normalized = normalizeLabel(raw);
      if (normalized && !ALIASES.has(normalized)) ALIASES.set(normalized, key);
    }
  }
}

const PREFIX_ENTRIES: ReadonlyArray<readonly [string, LabelKey]> = [...ALIASES.entries()].sort(
  (a, b) => b[0].length - a[0].length,
);

function stripTrailingParens(raw: string): string {
  return raw.replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Busca una etiqueta exacta. Ignora un sufijo de activo entre parentesis
 * (`(USDC)`, `(BTC)`) y lo devuelve en `asset`.
 */
export function matchLabel(raw: unknown): MatchedLabel | null {
  if (typeof raw !== 'string') return null;
  const normalized = normalizeLabel(raw);
  if (!normalized) return null;
  const direct = ALIASES.get(normalized);
  if (direct) return { key: direct, asset: trailingAsset(raw), normalized };
  const core = normalizeLabel(stripTrailingParens(raw));
  const key = ALIASES.get(core);
  if (key) return { key, asset: trailingAsset(raw), normalized };
  return null;
}

/**
 * Igual que `matchLabel`, pero acepta que el texto continue con el valor
 * (`ROI+9.25%`, `PnL realizado (USDC)+1.01 USDC`). Exige que el caracter
 * siguiente a la etiqueta no sea letra ni digito.
 */
export function matchLabelPrefix(raw: unknown): MatchedLabel | null {
  if (typeof raw !== 'string') return null;
  const normalized = normalizeLabel(raw);
  if (!normalized) return null;
  for (const [alias, key] of PREFIX_ENTRIES) {
    if (!normalized.startsWith(alias)) continue;
    const next = normalized.slice(alias.length, alias.length + 1);
    if (next && /[a-z0-9]/.test(next)) continue;
    return { key, asset: trailingAsset(raw), normalized };
  }
  return null;
}

/** Atajo booleano: ¿el texto es exactamente esta etiqueta (con o sin activo)? */
export function isLabel(raw: unknown, key: LabelKey): boolean {
  return matchLabel(raw)?.key === key;
}
