// Parser de las tarjetas de "Historial de posiciones" de Binance Futures.
//
// Se apoya solo en etiquetas visibles y en la forma `SIMBOLO ... Abierto ...
// Cerrado`. Las tarjetas pueden venir en cualquier orden, con campos que falten
// y dentro de cualquier contenedor.

import {
  HISTORY_VALUE_KEYS,
  matchLabel,
  matchLabelPrefix,
  normalizeLabel,
  type LabelKey,
} from './labels';
import { parseDate, parseDuration, parsePercent, parsePrice, parseSignedAmount } from './numbers';
import { collectTexts, type TextNode } from './tree';
import type { MarginType, PositionSide } from '../account/types';

/** Token de simbolo de futuros: `BTCUSDC`, `1000PEPEUSDC`, `ETHUSDT`. */
const SYMBOL_TOKEN = /^[0-9A-Z]{2,20}(?:USDT|USDC|BUSD)$/;

/** Igual, pero suelto dentro de un texto mayor. */
const SYMBOL_IN_TEXT = /[0-9A-Z]{2,20}(?:USDT|USDC|BUSD)/;

export function isSymbolToken(raw: unknown): boolean {
  return typeof raw === 'string' && SYMBOL_TOKEN.test(raw.trim());
}

/** Primer simbolo que aparece en un texto, en mayusculas. Null si no hay. */
export function findSymbolToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = SYMBOL_IN_TEXT.exec(raw.toUpperCase());
  return match ? match[0] : null;
}

export type HistoryStatus = 'open' | 'closed' | null;

export interface ClosedPosition {
  symbol: string;
  leverage: number | null;
  marginMode: MarginType | null;
  side: PositionSide | null;
  status: HistoryStatus;
  openedAtMs: number | null;
  closedAtMs: number | null;
  durationMs: number | null;
  realizedPnl: number | null;
  pnlAsset: string | null;
  roiPct: number | null;
  closeVolume: number | null;
  closeVolumeAsset: string | null;
  entry: number | null;
  avgClose: number | null;
  maxOpenInterest: number | null;
  /** Clave estable para deduplicar: `symbol|openedAtMs|closedAtMs`. */
  key: string;
}

export interface HistoryParseOptions {
  /** Offset de la pagina en minutos (UTC-5 = -300). Por defecto 0. */
  tzOffsetMinutes?: number;
}

interface DateHit {
  ms: number;
  marker: 'open' | 'close' | null;
}

interface CardSlice {
  symbol: string;
  texts: string[];
}

const VALUE_KEYS = new Set<LabelKey>(HISTORY_VALUE_KEYS);

function cardKey(symbol: string, openedAtMs: number | null, closedAtMs: number | null): string {
  return `${symbol}|${openedAtMs}|${closedAtMs}`;
}

function hasOpenMarker(text: string): boolean {
  return /\b(?:abierto|abierta|opened|open)\b/.test(normalizeLabel(text));
}

function hasCloseMarker(text: string): boolean {
  return /\b(?:cerrado|cerrada|closed|close)\b/.test(normalizeLabel(text));
}

/** Etiqueta de un trozo de texto: `Cerrado` gana a `Abierto` si aparecen los dos. */
function markerOf(text: string): DateHit['marker'] {
  if (hasCloseMarker(text)) return 'close';
  if (hasOpenMarker(text)) return 'open';
  return null;
}

/**
 * Fechas con su etiqueta. Cuando apertura y cierre viven en el MISMO texto
 * («10/18/2026 23:45:54 Abierto | 10/19/2026 10:21:28 Cerrado») no basta con
 * mirar el texto entero: cada fecha se asocia a la etiqueta que la SIGUE (y, si
 * no hay, a la que la precede). Asi la primera es apertura y la segunda cierre;
 * antes las dos salian como cierre y la tarjeta se descartaba.
 */
function datesIn(text: string, tzOffsetMinutes: number): DateHit[] {
  const hits: DateHit[] = [];
  const re = /\d{1,2}\/\d{1,2}\/\d{4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g;
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i] as RegExpMatchArray;
    const ms = parseDate(match[0], tzOffsetMinutes);
    if (ms === null) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? ((matches[i + 1] as RegExpMatchArray).index ?? text.length) : text.length;
    // La etiqueta mas cercana por delante de la fecha.
    let marker = markerOf(text.slice(start, end));
    if (marker === null) {
      const previous = matches[i - 1] as RegExpMatchArray | undefined;
      const from = previous ? (previous.index ?? 0) + previous[0].length : 0;
      marker = markerOf(text.slice(from, match.index ?? 0));
    }
    hits.push({ ms, marker });
  }
  return hits;
}

function cardCandidates(texts: string[], tzOffsetMinutes: number): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? '';
    if (!findSymbolToken(text)) continue;
    let opened = false;
    let closed = false;
    const end = Math.min(texts.length, i + 60);
    for (let j = i; j < end; j++) {
      for (const hit of datesIn(texts[j] ?? '', tzOffsetMinutes)) {
        if (hit.marker === 'open') opened = true;
        if (hit.marker === 'close') closed = true;
        if (!hit.marker) {
          // Sin etiqueta: primera fecha = apertura, segunda = cierre.
          if (!opened) opened = true;
          else closed = true;
        }
      }
      if (opened && closed) break;
    }
    if (opened && closed) candidates.push(i);
  }
  return candidates;
}

function slices(texts: string[], starts: number[]): CardSlice[] {
  const out: CardSlice[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? texts.length;
    const symbol = findSymbolToken(texts[start]);
    if (!symbol) continue;
    out.push({ symbol, texts: texts.slice(start, Math.max(start + 1, end)) });
  }
  return out;
}

function leverageOf(texts: string[]): number | null {
  for (const text of texts) {
    const match = /(?:^|[^\d])(\d{1,3})\s*x(?:\b|[^\w])/i.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && value <= 125) return value;
  }
  return null;
}

function marginModeOf(texts: string[]): MarginType | null {
  for (const text of texts) {
    const normalized = normalizeLabel(text);
    if (/\b(?:cruzado|cross)\b/.test(normalized)) return 'cross';
  }
  for (const text of texts) {
    const normalized = normalizeLabel(text);
    if (/\b(?:aislado|isolated)\b/.test(normalized)) return 'isolated';
  }
  return null;
}

function sideOf(texts: string[]): PositionSide | null {
  for (const text of texts) {
    const normalized = normalizeLabel(text);
    if (/\b(?:short|corto|corta)\b/.test(normalized)) return 'short';
    if (/\b(?:long|largo|larga)\b/.test(normalized)) return 'long';
  }
  return null;
}

interface ValueRead {
  value: number | null;
  asset: string | null;
  /** true si el texto solo era la etiqueta: hay que mirar el siguiente nodo. */
  needsNext: boolean;
}

function readValue(key: LabelKey, text: string, labelAsset: string | null): ValueRead {
  if (key === 'realizedPnl') {
    const amount = parseSignedAmount(text);
    return { value: amount?.value ?? null, asset: amount?.asset ?? labelAsset, needsNext: amount === null };
  }
  if (key === 'roi') {
    const value = parsePercent(text);
    return { value, asset: null, needsNext: value === null };
  }
  const value = parsePrice(text);
  return { value, asset: labelAsset, needsNext: value === null };
}

function parseCard(slice: CardSlice, tzOffsetMinutes: number): ClosedPosition {
  const texts = slice.texts;
  const dateHits: DateHit[] = [];
  for (const text of texts) dateHits.push(...datesIn(text, tzOffsetMinutes));

  let openedAtMs: number | null = null;
  let closedAtMs: number | null = null;
  for (const hit of dateHits) {
    if (hit.marker === 'open' && openedAtMs === null) openedAtMs = hit.ms;
    if (hit.marker === 'close' && closedAtMs === null) closedAtMs = hit.ms;
  }
  for (const hit of dateHits) {
    if (hit.marker !== null) continue;
    if (openedAtMs === null) openedAtMs = hit.ms;
    else if (closedAtMs === null) closedAtMs = hit.ms;
  }
  // Si solo se etiqueto el cierre, la fecha anterior es la apertura.
  if (openedAtMs === null && closedAtMs !== null) {
    const before = dateHits.find((h) => h.ms < (closedAtMs as number));
    if (before) openedAtMs = before.ms;
  }

  let durationMs: number | null = null;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? '';
    const normalized = normalizeLabel(text);
    if (!/\b(?:duracion|duration)\b/.test(normalized)) continue;
    durationMs = parseDuration(text);
    if (durationMs === null) durationMs = parseDuration(texts[i + 1] ?? '');
    if (durationMs !== null) break;
  }
  if (durationMs === null && openedAtMs !== null && closedAtMs !== null) {
    const diff = closedAtMs - openedAtMs;
    if (diff >= 0) durationMs = diff;
  }

  let realizedPnl: number | null = null;
  let pnlAsset: string | null = null;
  let roiPct: number | null = null;
  let closeVolume: number | null = null;
  let closeVolumeAsset: string | null = null;
  let entry: number | null = null;
  let avgClose: number | null = null;
  let maxOpenInterest: number | null = null;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? '';
    const exact = matchLabel(text);
    const matched = exact ?? matchLabelPrefix(text);
    if (!matched || !VALUE_KEYS.has(matched.key)) continue;
    const labelAsset = matched.asset;
    // Etiqueta y valor en nodos distintos (lo habitual): el valor es el siguiente.
    let read: ValueRead = exact
      ? { value: null, asset: labelAsset, needsNext: true }
      : readValue(matched.key, stripLabelAsset(text, labelAsset), labelAsset);
    if (read.needsNext) {
      const next = texts[i + 1] ?? '';
      // Solo se consume el siguiente nodo si es un valor, no otra etiqueta.
      if (next && matchLabel(next) === null && matchLabelPrefix(next) === null) {
        read = readValue(matched.key, next, labelAsset);
        if (read.value !== null) i += 1;
      }
    }
    if (read.value === null) continue;
    switch (matched.key) {
      case 'realizedPnl':
        realizedPnl = read.value;
        pnlAsset = read.asset;
        break;
      case 'roi':
        roiPct = read.value;
        break;
      case 'closeVolume':
        closeVolume = read.value;
        closeVolumeAsset = read.asset;
        break;
      case 'entry':
        entry = read.value;
        break;
      case 'avgClose':
        avgClose = read.value;
        break;
      case 'maxOpenInterest':
        maxOpenInterest = read.value;
        break;
      default:
        break;
    }
  }

  return {
    symbol: slice.symbol,
    leverage: leverageOf(texts),
    marginMode: marginModeOf(texts),
    side: sideOf(texts),
    status: closedAtMs !== null ? 'closed' : openedAtMs !== null ? 'open' : null,
    openedAtMs,
    closedAtMs,
    durationMs,
    realizedPnl,
    pnlAsset,
    roiPct,
    closeVolume,
    closeVolumeAsset,
    entry,
    avgClose,
    maxOpenInterest,
    key: cardKey(slice.symbol, openedAtMs, closedAtMs),
  };
}

/** Quita `(1000PEPE)`/`(USDC)` para no leer digitos del propio activo. */
function stripLabelAsset(text: string, asset: string | null): string {
  if (!asset) return text;
  return text.replace(new RegExp(`\\(\\s*${asset}\\s*\\)`, 'i'), ' ');
}

/**
 * Extrae las posiciones cerradas de una pagina (o de cualquier subarbol que
 * contenga las tarjetas). Nunca lanza.
 */
export function parsePositionHistory(
  root: TextNode | null | undefined,
  opts: HistoryParseOptions = {},
): ClosedPosition[] {
  try {
    const tz = Number.isFinite(opts.tzOffsetMinutes) ? (opts.tzOffsetMinutes as number) : 0;
    const texts = collectTexts(root);
    const starts = cardCandidates(texts, tz);
    const seen = new Set<string>();
    const out: ClosedPosition[] = [];
    for (const slice of slices(texts, starts)) {
      const position = parseCard(slice, tz);
      if (seen.has(position.key)) continue;
      seen.add(position.key);
      out.push(position);
    }
    return out;
  } catch {
    return [];
  }
}
