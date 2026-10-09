/**
 * Noticias para `market_context`. Copia de workers/public-site/src/news.js
 * (adaptadores, léxico y normalización). El worker no se importa aquí porque
 * este paquete se publica solo.
 *
 * Orden de respaldo: Brave, Tavily, Firecrawl (solo si su clave está en el
 * entorno) y, si ninguno devuelve titulares, GET
 * https://trade.swal.network/api/news. Si tampoco hay nada, `news` es null y
 * la nota es NEWS_NOTE.
 *
 * Sentimiento: léxico determinista ES/EN. Heurística, no es asesoría.
 * Positivos: rally, bullish, surge, soar, soars, adoption, approval, approved,
 * breakout, inflows, upgrade, partnership, rebound, outperforms, alcista, alza,
 * subida, repunte, aprobado, aprobacion, adopcion.
 * Negativos: crash, plunge, hack, hacked, ban, banned, lawsuit, bearish, dump,
 * liquidation, liquidations, exploit, stolen, bankruptcy, collapse, outage,
 * fraud, scam, selloff, sell off, bajista, caida, hackeo, colapso, quiebra,
 * estafa, prohibicion, liquidacion.
 * score = (positivos - negativos) / (positivos + negativos), o 0.
 */

import { NEWS_NOTE } from "./market-data.js";
import { isRecord } from "./types.js";
import type { FetchLike } from "./types.js";

export { NEWS_NOTE };

export const HOSTED_NEWS_URL = "https://trade.swal.network/api/news";
export const NEWS_TOOL_LIMIT = 5;
export const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const BRAVE_NEWS_URL = "https://api.search.brave.com/res/v1/news/search";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

const PROVIDERS = ["brave", "tavily", "firecrawl"] as const;
type Provider = (typeof PROVIDERS)[number];

const PROVIDER_ENV: Record<Provider, string> = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
};

const POSITIVE = [
  "rally", "bullish", "surge", "soar", "soars", "adoption", "approval", "approved",
  "breakout", "inflows", "upgrade", "partnership", "rebound", "outperforms",
  "alcista", "alza", "subida", "repunte", "aprobado", "aprobacion", "adopcion",
];

const NEGATIVE = [
  "crash", "plunge", "hack", "hacked", "ban", "banned", "lawsuit", "bearish", "dump",
  "liquidation", "liquidations", "exploit", "stolen", "bankruptcy", "collapse",
  "outage", "fraud", "scam", "selloff", "sell off",
  "bajista", "caida", "hackeo", "colapso", "quiebra", "estafa", "prohibicion", "liquidacion",
];

export type SentimentLabel = "positivo" | "negativo" | "neutral";
export type NewsSymbol = "BTC" | "ETH";

export interface Headline {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  snippet: string;
  provider: Provider;
  symbols: NewsSymbol[];
  sentiment: { score: number; label: SentimentLabel };
}

interface RawHit {
  title: unknown;
  url: unknown;
  snippet: string;
  source: string;
  publishedAt: unknown;
  provider: Provider;
}

interface StoredHit extends Headline {
  titleKey: string;
}

export interface NewsLoad {
  news: Headline[] | null;
  note: string | null;
}

export interface LoadHeadlinesInput {
  env: NodeJS.ProcessEnv;
  symbol: string;
  fetchFn: FetchLike;
  nowMs?: number;
}

export function newsAsset(symbol: string): NewsSymbol | null {
  const upper = symbol.toUpperCase();
  if (upper.startsWith("BTC")) return "BTC";
  if (upper.startsWith("ETH")) return "ETH";
  return null;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[-_/]+/g, " ");
}

function hasTerm(foldedText: string, term: string): boolean {
  const needle = fold(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (!needle) return false;
  return new RegExp(`(?:^|[^a-z0-9])${needle}(?=$|[^a-z0-9])`).test(foldedText);
}

export function scoreSentiment(text: string): { score: number; label: SentimentLabel } {
  const folded = fold(text);
  let pos = 0;
  let neg = 0;
  for (const term of POSITIVE) if (hasTerm(folded, term)) pos += 1;
  for (const term of NEGATIVE) if (hasTerm(folded, term)) neg += 1;
  if (pos + neg === 0) return { score: 0, label: "neutral" };
  const score = Math.max(-1, Math.min(1, Math.round(((pos - neg) / (pos + neg)) * 1000) / 1000));
  const label: SentimentLabel = score > 0 ? "positivo" : score < 0 ? "negativo" : "neutral";
  return { score, label };
}

function titleKey(title: string): string {
  return fold(title).replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key === "fbclid" || key === "gclid") url.searchParams.delete(key);
  }
  const entries = [...url.searchParams.entries()].sort(
    (a, b) => (a[0] ?? "").localeCompare(b[0] ?? "") || (a[1] ?? "").localeCompare(b[1] ?? ""),
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.protocol = "https:";
  return url.toString();
}

async function hashId(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tagSymbols(text: string, fallback: NewsSymbol): NewsSymbol[] {
  const folded = fold(text);
  const found: NewsSymbol[] = [];
  if (hasTerm(folded, "bitcoin") || hasTerm(folded, "btc")) found.push("BTC");
  if (hasTerm(folded, "ethereum") || hasTerm(folded, "ether") || hasTerm(folded, "eth")) found.push("ETH");
  if (!found.length) found.push(fallback);
  return found;
}

function parseTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function hostnameOf(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanSource(source: string, url: string): string {
  const text = source.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 80);
  return hostnameOf(url);
}

function withinAge(publishedAt: string, nowMs: number): boolean {
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return false;
  if (time > nowMs + 10 * 60 * 1000) return false;
  return nowMs - time <= NEWS_MAX_AGE_MS;
}

function toPublic(item: StoredHit): Headline {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    snippet: item.snippet,
    provider: item.provider,
    symbols: item.symbols.slice(),
    sentiment: { score: item.sentiment.score, label: item.sentiment.label },
  };
}

async function normalizeRaw(raw: RawHit, fallback: NewsSymbol, nowMs: number): Promise<StoredHit | null> {
  if (typeof raw.title !== "string" || typeof raw.url !== "string") return null;
  const title = raw.title.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!title) return null;
  let url: string;
  try {
    url = canonicalUrl(raw.url);
  } catch {
    return null;
  }
  const snippet = raw.snippet.replace(/\s+/g, " ").trim().slice(0, 500);
  const publishedAt = parseTime(raw.publishedAt) || new Date(nowMs).toISOString();
  return {
    id: await hashId(url),
    title,
    url,
    source: cleanSource(raw.source, url),
    publishedAt,
    snippet,
    provider: raw.provider,
    symbols: tagSymbols(`${title} ${snippet}`, fallback),
    sentiment: scoreSentiment(`${title} ${snippet}`),
    titleKey: titleKey(title),
  };
}

async function readJson(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error(`${label} respuesta grande`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} json invalido`);
  }
}

async function providerFetch(fetchFn: FetchLike, url: string | URL, init: RequestInit, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, redirect: "error" });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 180) : "red";
    throw new Error(`${label} red ${message}`);
  }
  if (!response.ok) throw new Error(`${label} http ${response.status}`);
  return readJson(response, label);
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 10);
}

function parseBrave(body: unknown): RawHit[] {
  const results = isRecord(body) ? asRows(body.results) : [];
  return results.map((row) => {
    const profile = isRecord(row.profile) ? row.profile : null;
    const meta = isRecord(row.meta_url) ? row.meta_url : null;
    const source = typeof profile?.name === "string" ? profile.name : typeof meta?.hostname === "string" ? meta.hostname : "";
    return {
      title: row.title,
      url: row.url,
      snippet: typeof row.description === "string" ? row.description : "",
      source,
      publishedAt: typeof row.page_age === "string" ? row.page_age : row.page_fetched,
      provider: "brave",
    };
  });
}

function parseTavily(body: unknown): RawHit[] {
  const results = isRecord(body) ? asRows(body.results) : [];
  return results.map((row) => ({
    title: row.title,
    url: row.url,
    snippet: typeof row.content === "string" ? row.content : "",
    source: hostnameOf(row.url),
    publishedAt: row.published_date,
    provider: "tavily",
  }));
}

function parseFirecrawl(body: unknown): RawHit[] {
  if (isRecord(body) && body.success === false) return [];
  const data = isRecord(body) ? body.data : undefined;
  const rows = Array.isArray(data) ? asRows(data) : isRecord(data) ? asRows(data.news) : [];
  return rows.map((row) => ({
    title: row.title,
    url: row.url,
    snippet: typeof row.snippet === "string" ? row.snippet : typeof row.description === "string" ? row.description : "",
    source: hostnameOf(row.url),
    publishedAt: row.date,
    provider: "firecrawl",
  }));
}

function readKey(env: NodeJS.ProcessEnv, provider: Provider): string | null {
  const value = env[PROVIDER_ENV[provider]];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function queryFor(symbol: NewsSymbol): string {
  return symbol === "BTC" ? "Bitcoin BTC cryptocurrency" : "Ethereum ETH cryptocurrency";
}

async function fetchRaw(provider: Provider, apiKey: string, query: string, fetchFn: FetchLike): Promise<RawHit[]> {
  if (provider === "brave") {
    const url = new URL(BRAVE_NEWS_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    url.searchParams.set("freshness", "pw");
    url.searchParams.set("country", "ALL");
    url.searchParams.set("search_lang", "en");
    const body = await providerFetch(fetchFn, url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    }, "brave");
    return parseBrave(body);
  }
  if (provider === "tavily") {
    const body = await providerFetch(fetchFn, TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        topic: "news",
        search_depth: "basic",
        max_results: 10,
        time_range: "week",
        include_answer: false,
        include_raw_content: false,
        chunks_per_source: 1,
      }),
    }, "tavily");
    return parseTavily(body);
  }
  const body = await providerFetch(fetchFn, FIRECRAWL_SEARCH_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, limit: 10, sources: ["news"] }),
  }, "firecrawl");
  return parseFirecrawl(body);
}

async function fetchFresh(provider: Provider, env: NodeJS.ProcessEnv, asset: NewsSymbol, fetchFn: FetchLike, nowMs: number): Promise<Headline[]> {
  const apiKey = readKey(env, provider);
  if (!apiKey) return [];
  const raws = await fetchRaw(provider, apiKey, queryFor(asset), fetchFn);
  const fresh: Headline[] = [];
  for (const raw of raws) {
    const item = await normalizeRaw(raw, asset, nowMs);
    if (!item || !withinAge(item.publishedAt, nowMs)) continue;
    fresh.push(toPublic(item));
  }
  return fresh;
}

function asLabel(value: unknown): SentimentLabel | null {
  if (value === "positivo" || value === "negativo" || value === "neutral") return value;
  return null;
}

function asProvider(value: unknown): Provider | null {
  if (value === "brave" || value === "tavily" || value === "firecrawl") return value;
  return null;
}

function hostedItem(row: unknown): Headline | null {
  if (!isRecord(row) || typeof row.title !== "string" || typeof row.url !== "string" || typeof row.id !== "string") return null;
  if (!row.url.startsWith("https://")) return null;
  const provider = asProvider(row.provider);
  const sentiment = isRecord(row.sentiment) ? row.sentiment : null;
  const label = sentiment ? asLabel(sentiment.label) : null;
  const score = sentiment ? Number(sentiment.score) : Number.NaN;
  if (!provider || !label || !Number.isFinite(score)) return null;
  const symbols = Array.isArray(row.symbols)
    ? row.symbols.filter((symbol): symbol is NewsSymbol => symbol === "BTC" || symbol === "ETH")
    : [];
  if (!symbols.length) return null;
  return {
    id: row.id.slice(0, 64),
    title: row.title.slice(0, 240),
    url: row.url,
    source: typeof row.source === "string" ? row.source.slice(0, 80) : "",
    publishedAt: parseTime(row.publishedAt) || "",
    snippet: typeof row.snippet === "string" ? row.snippet.slice(0, 500) : "",
    provider,
    symbols,
    sentiment: { score: Math.max(-1, Math.min(1, score)), label },
  };
}

async function fetchHosted(asset: NewsSymbol, fetchFn: FetchLike, nowMs: number): Promise<Headline[]> {
  const url = new URL(HOSTED_NEWS_URL);
  url.searchParams.set("symbol", asset);
  url.searchParams.set("limit", String(NEWS_TOOL_LIMIT));
  const body = await providerFetch(fetchFn, url, { method: "GET", headers: { Accept: "application/json" } }, "hosted");
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  const fresh: Headline[] = [];
  for (const row of body.items) {
    const item = hostedItem(row);
    if (!item || !item.publishedAt || !withinAge(item.publishedAt, nowMs)) continue;
    fresh.push(item);
  }
  return fresh;
}

/**
 * Titulares del símbolo (BTC* / ETH*). Null y NEWS_NOTE si no hay fuente.
 */
export async function loadHeadlines(input: LoadHeadlinesInput): Promise<NewsLoad> {
  const asset = newsAsset(input.symbol);
  if (!asset) return { news: null, note: NEWS_NOTE };
  const nowMs = input.nowMs ?? Date.now();
  for (const provider of PROVIDERS) {
    if (!readKey(input.env, provider)) continue;
    try {
      const fresh = await fetchFresh(provider, input.env, asset, input.fetchFn, nowMs);
      if (fresh.length > 0) return { news: fresh.slice(0, NEWS_TOOL_LIMIT), note: null };
    } catch {
      // El siguiente proveedor, y al final el sitio alojado.
    }
  }
  try {
    const hosted = await fetchHosted(asset, input.fetchFn, nowMs);
    if (hosted.length > 0) return { news: hosted.slice(0, NEWS_TOOL_LIMIT), note: null };
  } catch {
    // Sin red o sin titulares.
  }
  return { news: null, note: NEWS_NOTE };
}
