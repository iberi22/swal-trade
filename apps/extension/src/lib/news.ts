import { normalizeSymbol } from './market-context';

export const NEWS_HOST = 'https://trade.swal.network';
export const NEWS_PATH = '/api/news';
export const NEWS_LIMIT = 5;

export type NewsSentimentLabel = 'positivo' | 'negativo' | 'neutral';

export interface NewsSentiment {
  score: number;
  label: NewsSentimentLabel;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  snippet: string;
  sentiment: NewsSentiment;
}

/** El endpoint alojado solo cubre BTC y ETH. */
export function newsAsset(symbol: string): 'BTC' | 'ETH' | null {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return null;
  if (upper.startsWith('BTC')) return 'BTC';
  if (upper.startsWith('ETH')) return 'ETH';
  return null;
}

/** URL pública. Null si el símbolo no tiene titulares en el servicio. */
export function newsUrl(symbol: string, limit: number = NEWS_LIMIT): string | null {
  const asset = newsAsset(symbol);
  if (!asset) return null;
  const capped = Math.min(20, Math.max(1, Math.floor(limit)));
  return `${NEWS_HOST}${NEWS_PATH}?symbol=${asset}&limit=${capped}`;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function asLabel(value: unknown): NewsSentimentLabel | null {
  return value === 'positivo' || value === 'negativo' || value === 'neutral' ? value : null;
}

function isoOrEmpty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

/** Un titular del servicio. Se descarta lo que no traiga título y enlace https. */
export function parseNewsItem(row: unknown): NewsItem | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const title = text(record.title, 240);
  const url = text(record.url, 500);
  if (!title || !url.startsWith('https://')) return null;
  const sentimentRaw = record.sentiment && typeof record.sentiment === 'object'
    ? (record.sentiment as Record<string, unknown>)
    : {};
  const score = Number(sentimentRaw.score);
  const label = asLabel(sentimentRaw.label);
  return {
    id: text(record.id, 64) || url,
    title,
    url,
    source: text(record.source, 80),
    publishedAt: isoOrEmpty(record.publishedAt),
    snippet: text(record.snippet, 500),
    sentiment: {
      score: Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0,
      label: label ?? (score > 0 ? 'positivo' : score < 0 ? 'negativo' : 'neutral'),
    },
  };
}

/**
 * Parser puro de la respuesta `GET /api/news`. Acepta `{ items: [...] }` o una
 * lista pelada, y descarta filas inválidas en lugar de romper la tarjeta.
 */
export function parseNewsPayload(body: unknown, limit: number = NEWS_LIMIT): NewsItem[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
      ? ((body as { items: unknown[] }).items)
      : [];
  const out: NewsItem[] = [];
  for (const row of rows) {
    const item = parseNewsItem(row);
    if (!item) continue;
    out.push(item);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

const UNITS: ReadonlyArray<{ limit: number; div: number; name: string }> = [
  { limit: 60, div: 1, name: 'seg' },
  { limit: 3600, div: 60, name: 'min' },
  { limit: 86_400, div: 3600, name: 'h' },
  { limit: 2_592_000, div: 86_400, name: 'd' },
  { limit: 31_536_000, div: 2_592_000, name: 'mes' },
];

/** \"hace 5 min\", \"hace 3 d\". Texto, no una fecha que haya que interpretar. */
export function relativeTime(publishedAt: string, nowMs: number): string {
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return 'fecha no disponible';
  const seconds = Math.round((nowMs - time) / 1000);
  if (seconds <= 0) return 'ahora';
  for (const unit of UNITS) {
    if (seconds < unit.limit) {
      const value = Math.max(1, Math.floor(seconds / unit.div));
      return `hace ${value} ${unit.name}`;
    }
  }
  return 'hace tiempo';
}

export interface NewsFetchResult {
  items: NewsItem[];
  note: string | null;
}

/**
 * Titulares del símbolo. Devuelve `note` en lugar de lanzar: la tarjeta tiene
 * que pintar algo útil también sin red o con el servicio caído.
 */
export async function fetchNews(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<NewsFetchResult> {
  const url = newsUrl(symbol);
  if (!url) return { items: [], note: 'Sin titulares para este símbolo.' };
  let payload: unknown;
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { items: [], note: `Titulares no disponibles (${response.status}).` };
    payload = await response.json();
  } catch {
    return { items: [], note: 'Sin conexión con el servicio de titulares.' };
  }
  const items = parseNewsPayload(payload);
  if (items.length === 0) return { items: [], note: 'Sin titulares recientes.' };
  return { items, note: null, };
}

/** Los titulares se renuevan solos: el KVS del worker cachea 5 min. */
export const NEWS_REFRESH_MS = 5 * 60 * 1000;
export function freshnessOf(items: readonly NewsItem[], nowMs: number): boolean {
  return items.every((item) => item.publishedAt !== '' && nowMs - Date.parse(item.publishedAt) >= 0);
}
