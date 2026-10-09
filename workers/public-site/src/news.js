/**
 * Noticias de BTC y ETH para el sitio público.
 *
 * El mismo comportamiento está copiado en packages/mcp/src/news.ts (el paquete
 * se publica solo; no puede importar este archivo). Si cambias el léxico o la
 * forma de una petición, cambia los dos.
 *
 * Presupuesto — como máximo ~1000 peticiones/mes por proveedor:
 * El cron del worker es cada 5 minutos (dead-man): 12 ticks/hora.
 * Las noticias no corren en cada tick. La puerta es de 30 minutos
 * (NEWS_GATE_MS): 2 ciclos/hora.
 * Cada ciclo hace 2 búsquedas (BTC y ETH) contra un solo proveedor, en rotación
 * brave → tavily → firecrawl.
 * Mes de 31 días: 31 × 24 × 2 = 1488 ciclos × 2 símbolos / 3 proveedores = 992
 * peticiones por proveedor. Mes de 30 días: 960. steadyStateRequestsPerProvider().
 * Un fallo o una lista vacía prueba el siguiente proveedor y también cuenta.
 * NEWS_MONTHLY_CAP = 1000 corta esas peticiones de más. El contador está en
 * news_meta (D1) o, si no hay D1, en el KV SNAPSHOTS. La puerta avanza al
 * empezar el ciclo, así un fallo no se reintenta cada 5 minutos.
 *
 * Sentimiento: léxico determinista español/inglés. Es una heurística de
 * palabras, no un modelo y no es asesoría financiera.
 *
 * Contratos (comprobados en la documentación oficial, octubre 2026):
 * - Brave News Search: GET https://api.search.brave.com/res/v1/news/search
 *   Header X-Subscription-Token. Resultados en results[]: title, url,
 *   description, page_age | page_fetched, profile.name, meta_url.hostname.
 *   freshness=pw (7 días); aquí nos quedamos con 48 h.
 * - Tavily: POST https://api.tavily.com/search
 *   Authorization: Bearer. Body JSON con topic "news", search_depth "basic"
 *   (1 crédito). La clave va en el header, no en el body.
 *   results[]: title, url, content, published_date.
 * - Firecrawl v2: POST https://api.firecrawl.dev/v2/search
 *   Authorization: Bearer. sources: ["news"] (también acepta {type:"news"}).
 *   data.news[]: title, url, snippet, date. Sin scrapeOptions (no baja la página).
 *   Si data es un array (forma v1), se leen title, url, description.
 */

export const NEWS_SYMBOLS = ['BTC', 'ETH'];
export const NEWS_PROVIDERS = ['brave', 'tavily', 'firecrawl'];
export const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const NEWS_GATE_MS = 30 * 60 * 1000;
export const NEWS_MONTHLY_CAP = 1000;
export const NEWS_DEFAULT_LIMIT = 20;
export const NEWS_MAX_LIMIT = 20;
export const NEWS_PUBLIC_CACHE = 'public, max-age=300';
export const BRAVE_NEWS_URL = 'https://api.search.brave.com/res/v1/news/search';
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
export const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

const PROVIDER_ENV = {
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
};

/**
 * Términos de palabra completa sobre texto ya plegado (minúsculas, sin tildes,
 * guiones como espacios). Un acierto suma 1. No hay pesos.
 * score = (positivos - negativos) / (positivos + negativos), o 0 si no hay aciertos.
 * label positivo si score > 0, negativo si score < 0, neutral si score === 0.
 */
export const SENTIMENT_TERMS = {
  positive: [
    'rally', 'bullish', 'surge', 'soar', 'soars', 'adoption', 'approval', 'approved',
    'breakout', 'inflows', 'upgrade', 'partnership', 'rebound', 'outperforms',
    'alcista', 'alza', 'subida', 'repunte', 'aprobado', 'aprobacion', 'adopcion',
  ],
  negative: [
    'crash', 'plunge', 'hack', 'hacked', 'ban', 'banned', 'lawsuit', 'bearish', 'dump',
    'liquidation', 'liquidations', 'exploit', 'stolen', 'bankruptcy', 'collapse',
    'outage', 'fraud', 'scam', 'selloff', 'sell off',
    'bajista', 'caida', 'hackeo', 'colapso', 'quiebra', 'estafa', 'prohibicion', 'liquidacion',
  ],
};

const META_GET = 'SELECT value FROM news_meta WHERE key = ?1';
const META_PUT =
  'INSERT INTO news_meta (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
const TITLE_HIT = 'SELECT id FROM news WHERE title_key = ?1 AND id != ?2 LIMIT 1';
const SYMBOLS_OF = 'SELECT symbols FROM news WHERE id = ?1';
const UPSERT =
  'INSERT INTO news (id, url, title, title_key, source, published_at, snippet, provider, symbols, sentiment_score, sentiment_label, fetched_at) ' +
  'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ' +
  'ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, title_key = excluded.title_key, ' +
  'source = excluded.source, published_at = excluded.published_at, snippet = excluded.snippet, ' +
  'provider = excluded.provider, symbols = excluded.symbols, sentiment_score = excluded.sentiment_score, ' +
  'sentiment_label = excluded.sentiment_label, fetched_at = excluded.fetched_at';
const PURGE = 'DELETE FROM news WHERE published_at < ?1';
const LIST =
  'SELECT id, url, title, source, published_at, snippet, provider, symbols, sentiment_score, sentiment_label ' +
  'FROM news WHERE published_at >= ?1 AND instr(symbols, ?2) > 0 ORDER BY published_at DESC LIMIT ?3';

const KV_ITEMS = 'news:items';

/**
 * Peticiones de régimen estable por proveedor, sin fallos.
 * @param {number} days
 * @returns {number}
 */
export function steadyStateRequestsPerProvider(days = 31) {
  const cycles = days * 24 * (60 / (NEWS_GATE_MS / 60000));
  return (cycles * NEWS_SYMBOLS.length) / NEWS_PROVIDERS.length;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[-_/]+/g, ' ');
}

/**
 * @param {string} foldedText - ya plegado
 * @param {string} term
 * @returns {boolean}
 */
export function hasTerm(foldedText, term) {
  const needle = fold(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (!needle) return false;
  return new RegExp(`(?:^|[^a-z0-9])${needle}(?=$|[^a-z0-9])`).test(foldedText);
}

/**
 * @param {string} text
 * @returns {{score: number, label: 'positivo'|'negativo'|'neutral'}}
 */
export function scoreSentiment(text) {
  const folded = fold(text);
  let pos = 0;
  let neg = 0;
  for (const term of SENTIMENT_TERMS.positive) if (hasTerm(folded, term)) pos += 1;
  for (const term of SENTIMENT_TERMS.negative) if (hasTerm(folded, term)) neg += 1;
  if (pos + neg === 0) return { score: 0, label: 'neutral' };
  const score = Math.max(-1, Math.min(1, Math.round(((pos - neg) / (pos + neg)) * 1000) / 1000));
  const label = score > 0 ? 'positivo' : score < 0 ? 'negativo' : 'neutral';
  return { score, label };
}

/**
 * @param {string} title
 * @returns {string}
 */
export function titleKey(title) {
  return fold(title).replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function canonicalUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key === 'fbclid' || key === 'gclid') url.searchParams.delete(key);
  }
  const entries = [...url.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = '';
  for (const [key, value] of entries) url.searchParams.append(key, value);
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.protocol = 'https:';
  return url.toString();
}

/**
 * @param {string} url - ya canónica
 * @returns {Promise<string>} 32 hex chars (SHA-256 truncado)
 */
export async function hashId(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} symbol
 * @returns {string|null}
 */
export function queryFor(symbol) {
  if (symbol === 'BTC') return 'Bitcoin BTC cryptocurrency';
  if (symbol === 'ETH') return 'Ethereum ETH cryptocurrency';
  return null;
}

/**
 * @param {string} text
 * @param {string} fallbackSymbol
 * @returns {Array<'BTC'|'ETH'>}
 */
export function tagSymbols(text, fallbackSymbol) {
  const folded = fold(text);
  const found = [];
  if (hasTerm(folded, 'bitcoin') || hasTerm(folded, 'btc')) found.push('BTC');
  if (hasTerm(folded, 'ethereum') || hasTerm(folded, 'ether') || hasTerm(folded, 'eth')) found.push('ETH');
  if (!found.length && (fallbackSymbol === 'BTC' || fallbackSymbol === 'ETH')) found.push(fallbackSymbol);
  return found;
}

/**
 * @param {string[] } left
 * @param {string[]} right
 * @returns {Array<'BTC'|'ETH'>}
 */
export function mergeSymbols(left, right) {
  const set = new Set([...(left || []), ...(right || [])]);
  return NEWS_SYMBOLS.filter((symbol) => set.has(symbol));
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function parseTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

/**
 * @param {unknown} source
 * @param {string} url
 * @returns {string}
 */
function cleanSource(source, url) {
  const text = typeof source === 'string' ? source.replace(/\s+/g, ' ').trim() : '';
  if (text) return text.slice(0, 80);
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {object} raw
 * @param {string} fallbackSymbol
 * @param {number} nowMs
 * @returns {Promise<object|null>}
 */
export async function normalizeRaw(raw, fallbackSymbol, nowMs) {
  if (!raw || typeof raw.title !== 'string' || typeof raw.url !== 'string') return null;
  if (!NEWS_PROVIDERS.includes(raw.provider)) return null;
  const title = raw.title.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!title) return null;
  let url;
  try {
    url = canonicalUrl(raw.url);
  } catch {
    return null;
  }
  const snippet = String(raw.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const symbols = tagSymbols(`${title} ${snippet}`, fallbackSymbol);
  if (!symbols.length) return null;
  return {
    id: await hashId(url),
    title,
    url,
    source: cleanSource(raw.source, url),
    publishedAt: parseTime(raw.publishedAt) || new Date(nowMs).toISOString(),
    snippet,
    provider: raw.provider,
    symbols,
    sentiment: scoreSentiment(`${title} ${snippet}`),
    titleKey: titleKey(title),
  };
}

/**
 * Une duplicados del mismo ciclo. La misma url o el mismo título se queda en
 * una ficha y suma los símbolos.
 * @param {object[]} items
 * @returns {object[]}
 */
export function dedupeItems(items) {
  const byUrl = new Map();
  const byTitle = new Map();
  const out = [];
  for (const item of items) {
    if (!item || !item.url || !item.titleKey) continue;
    const hit = byUrl.get(item.url) || byTitle.get(item.titleKey);
    if (hit) {
      hit.symbols = mergeSymbols(hit.symbols, item.symbols);
      if (String(item.publishedAt) > String(hit.publishedAt)) {
        hit.publishedAt = item.publishedAt;
        if (item.snippet) hit.snippet = item.snippet;
      }
      byUrl.set(item.url, hit);
      byTitle.set(item.titleKey, hit);
      continue;
    }
    const copy = { ...item, symbols: item.symbols.slice() };
    byUrl.set(item.url, copy);
    byTitle.set(item.titleKey, copy);
    out.push(copy);
  }
  return out;
}

/**
 * @param {object} item
 * @param {number} nowMs
 * @returns {boolean}
 */
export function withinAge(item, nowMs, maxAgeMs = NEWS_MAX_AGE_MS) {
  const time = Date.parse(item && item.publishedAt);
  if (!Number.isFinite(time)) return false;
  if (time > nowMs + 10 * 60 * 1000) return false;
  return nowMs - time <= maxAgeMs;
}

/**
 * @param {number|null|undefined} lastRunMs
 * @param {number} nowMs
 * @param {number} [gateMs]
 * @returns {boolean}
 */
export function shouldFetchNews(lastRunMs, nowMs, gateMs = NEWS_GATE_MS) {
  if (lastRunMs === null || lastRunMs === undefined) return true;
  const last = Number(lastRunMs);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= gateMs;
}

/**
 * @param {number} nowMs
 * @returns {string} YYYY-MM en UTC
 */
export function budgetMonth(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/**
 * @param {object} env
 * @returns {Array<'brave'|'tavily'|'firecrawl'>}
 */
export function configuredProviders(env) {
  return NEWS_PROVIDERS.filter((name) => {
    const value = env && env[PROVIDER_ENV[name]];
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * @param {string} name
 * @returns {string}
 */
export function providerEnvName(name) {
  return PROVIDER_ENV[name] || '';
}

async function readJson(res, label) {
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (text.length > 1_000_000) throw new Error(`${label} respuesta grande`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} json invalido`);
    }
  }
  return res.json();
}

function hostnameOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * @param {unknown} body
 * @returns {object[]}
 */
export function parseBraveBody(body) {
  const results = body && Array.isArray(body.results) ? body.results : [];
  return results.slice(0, 10).map((row) => ({
    title: row && row.title,
    url: row && row.url,
    snippet: (row && (row.description || '')) || '',
    source: (row && row.profile && row.profile.name) || (row && row.meta_url && row.meta_url.hostname) || '',
    publishedAt: (row && (row.page_age || row.page_fetched)) || null,
    provider: 'brave',
  }));
}

/**
 * @param {unknown} body
 * @returns {object[]}
 */
export function parseTavilyBody(body) {
  const results = body && Array.isArray(body.results) ? body.results : [];
  return results.slice(0, 10).map((row) => ({
    title: row && row.title,
    url: row && row.url,
    snippet: (row && (row.content || '')) || '',
    source: hostnameOf(row && row.url),
    publishedAt: (row && row.published_date) || null,
    provider: 'tavily',
  }));
}

/**
 * @param {unknown} body
 * @returns {object[]}
 */
export function parseFirecrawlBody(body) {
  if (body && body.success === false) return [];
  const data = body && body.data;
  const rows = Array.isArray(data) ? data : data && Array.isArray(data.news) ? data.news : [];
  return rows.slice(0, 10).map((row) => ({
    title: row && row.title,
    url: row && row.url,
    snippet: (row && (row.snippet || row.description || '')) || '',
    source: hostnameOf(row && row.url),
    publishedAt: (row && row.date) || null,
    provider: 'firecrawl',
  }));
}

async function providerFetch(fetchImpl, url, init, label) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (err) {
    const message = err && err.message ? String(err.message).slice(0, 180) : 'red';
    throw new Error(`${label} red ${message}`);
  }
  if (!res || !res.ok) throw new Error(`${label} http ${res && res.status}`);
  return readJson(res, label);
}

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {typeof fetch} fetchImpl
 */
export async function fetchBraveNews(apiKey, query, fetchImpl) {
  const url = new URL(BRAVE_NEWS_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '10');
  url.searchParams.set('freshness', 'pw');
  url.searchParams.set('country', 'ALL');
  url.searchParams.set('search_lang', 'en');
  const body = await providerFetch(fetchImpl, url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  }, 'brave');
  return parseBraveBody(body);
}

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {typeof fetch} fetchImpl
 */
export async function fetchTavilyNews(apiKey, query, fetchImpl) {
  const body = await providerFetch(fetchImpl, TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      topic: 'news',
      search_depth: 'basic',
      max_results: 10,
      time_range: 'week',
      include_answer: false,
      include_raw_content: false,
      chunks_per_source: 1,
    }),
  }, 'tavily');
  return parseTavilyBody(body);
}

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {typeof fetch} fetchImpl
 */
export async function fetchFirecrawlNews(apiKey, query, fetchImpl) {
  const body = await providerFetch(fetchImpl, FIRECRAWL_SEARCH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, limit: 10, sources: ['news'] }),
  }, 'firecrawl');
  return parseFirecrawlBody(body);
}

/**
 * @param {'brave'|'tavily'|'firecrawl'} provider
 * @param {object} env
 * @param {string} query
 * @param {typeof fetch} fetchImpl
 */
export async function fetchProvider(provider, env, query, fetchImpl) {
  const apiKey = env[PROVIDER_ENV[provider]];
  if (provider === 'brave') return fetchBraveNews(apiKey, query, fetchImpl);
  if (provider === 'tavily') return fetchTavilyNews(apiKey, query, fetchImpl);
  if (provider === 'firecrawl') return fetchFirecrawlNews(apiKey, query, fetchImpl);
  return [];
}

function parseSymbols(value) {
  if (Array.isArray(value)) return mergeSymbols(value, []);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? mergeSymbols(parsed, []) : [];
  } catch {
    return [];
  }
}

function rowToPublic(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    publishedAt: row.published_at,
    snippet: row.snippet,
    provider: row.provider,
    symbols: parseSymbols(row.symbols),
    sentiment: { score: Number(row.sentiment_score), label: row.sentiment_label },
  };
}

/**
 * Quita titleKey y fetchedAt. La respuesta pública no lleva secretos.
 * @param {object} item
 */
export function toPublicItem(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    snippet: item.snippet,
    provider: item.provider,
    symbols: parseSymbols(item.symbols),
    sentiment: {
      score: Number(item.sentiment && item.sentiment.score !== undefined ? item.sentiment.score : item.sentiment_score),
      label: (item.sentiment && item.sentiment.label) || item.sentiment_label,
    },
  };
}

function createD1NewsStore(db) {
  return {
    async getMeta(key) {
      const row = await db.prepare(META_GET).bind(key).first();
      return row && typeof row.value === 'string' ? row.value : null;
    },
    async setMeta(key, value) {
      await db.prepare(META_PUT).bind(key, value, Math.floor(Date.now() / 1000)).run();
    },
    async upsert(item, nowMs) {
      const owner = await db.prepare(TITLE_HIT).bind(item.titleKey, item.id).first();
      if (owner) return false;
      const current = await db.prepare(SYMBOLS_OF).bind(item.id).first();
      const symbols = current ? mergeSymbols(parseSymbols(current.symbols), item.symbols) : item.symbols;
      await db.prepare(UPSERT).bind(
        item.id,
        item.url,
        item.title,
        item.titleKey,
        item.source,
        item.publishedAt,
        item.snippet,
        item.provider,
        JSON.stringify(symbols),
        item.sentiment.score,
        item.sentiment.label,
        Math.floor(nowMs / 1000),
      ).run();
      return true;
    },
    async purge(nowMs) {
      const cutoff = new Date(nowMs - NEWS_MAX_AGE_MS).toISOString();
      await db.prepare(PURGE).bind(cutoff).run();
    },
    async list(symbol, limit, nowMs) {
      const cutoff = new Date(nowMs - NEWS_MAX_AGE_MS).toISOString();
      const res = await db.prepare(LIST).bind(cutoff, `"${symbol}"`, limit).all();
      const rows = res && Array.isArray(res.results) ? res.results : [];
      return rows.map(rowToPublic);
    },
  };
}

function createKvNewsStore(kv) {
  const metaKey = (key) => `news:meta:${key}`;
  const readItems = async () => {
    const raw = await kv.get(KV_ITEMS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    async getMeta(key) {
      const value = await kv.get(metaKey(key));
      return typeof value === 'string' ? value : null;
    },
    async setMeta(key, value) {
      await kv.put(metaKey(key), value);
    },
    async upsert(item, nowMs) {
      const items = await readItems();
      const titleOwner = items.find((row) => row.titleKey === item.titleKey && row.id !== item.id);
      if (titleOwner) return false;
      const index = items.findIndex((row) => row.id === item.id);
      const symbols = index >= 0 ? mergeSymbols(items[index].symbols, item.symbols) : item.symbols;
      const stored = { ...toPublicItem({ ...item, symbols }), titleKey: item.titleKey, fetchedAt: nowMs, symbols };
      if (index >= 0) items[index] = stored;
      else items.push(stored);
      await kv.put(KV_ITEMS, JSON.stringify(items));
      return true;
    },
    async purge(nowMs) {
      const items = (await readItems()).filter((item) => withinAge(item, nowMs));
      await kv.put(KV_ITEMS, JSON.stringify(items));
    },
    async list(symbol, limit, nowMs) {
      return (await readItems())
        .filter((item) => withinAge(item, nowMs) && parseSymbols(item.symbols).includes(symbol))
        .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
        .slice(0, limit)
        .map(toPublicItem);
    },
  };
}

/**
 * D1 si existe el binding `DB`. Si no, el KV `SNAPSHOTS`. Igual que el snapshot.
 * @param {object} env
 * @returns {object|null}
 */
export function newsStore(env) {
  if (env && env.DB && typeof env.DB.prepare === 'function') return createD1NewsStore(env.DB);
  if (env && env.SNAPSHOTS && typeof env.SNAPSHOTS.get === 'function') return createKvNewsStore(env.SNAPSHOTS);
  return null;
}

function parseBudget(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Un ciclo de recolección. No lanza: el cron no debe tumbar al dead-man.
 * @param {object} env
 * @param {number} [nowMs]
 * @param {typeof fetch} [fetchImpl]
 */
export async function ingestNews(env, nowMs = Date.now(), fetchImpl = fetch) {
  const store = newsStore(env);
  if (!store) return { ok: false, skipped: true, reason: 'no_store', stored: 0 };
  const last = await store.getMeta('last_run');
  if (!shouldFetchNews(last === null ? null : Number(last), nowMs)) {
    return { ok: true, skipped: true, reason: 'gate', stored: 0 };
  }
  const configured = configuredProviders(env);
  if (!configured.length) return { ok: true, skipped: true, reason: 'no_keys', stored: 0 };

  const month = budgetMonth(nowMs);
  const budgetKey = `budget:${month}`;
  const budget = parseBudget(await store.getMeta(budgetKey));
  const room = configured.some((name) => Number(budget[name] || 0) < NEWS_MONTHLY_CAP);
  await store.setMeta('last_run', String(nowMs));
  if (!room) return { ok: true, skipped: true, reason: 'budget', stored: 0 };

  const rotation = Number(await store.getMeta('rotation'));
  const start = Number.isFinite(rotation) ? Math.abs(rotation) % configured.length : 0;
  const order = configured.map((_, index) => configured[(start + index) % configured.length]);
  await store.setMeta('rotation', String((start + 1) % configured.length));

  const collected = [];
  for (const symbol of NEWS_SYMBOLS) {
    const query = queryFor(symbol);
    for (const provider of order) {
      if (Number(budget[provider] || 0) >= NEWS_MONTHLY_CAP) continue;
      budget[provider] = Number(budget[provider] || 0) + 1;
      await store.setMeta(budgetKey, JSON.stringify(budget));
      try {
        const raws = await fetchProvider(provider, env, query, fetchImpl);
        const fresh = [];
        for (const raw of raws) {
          const item = await normalizeRaw(raw, symbol, nowMs);
          if (item && withinAge(item, nowMs)) fresh.push(item);
        }
        if (fresh.length) {
          collected.push(...fresh);
          break;
        }
      } catch (err) {
        console.warn(`news: ${provider} fallo`, err && err.message);
      }
    }
  }

  let stored = 0;
  for (const item of dedupeItems(collected)) {
    if (await store.upsert(item, nowMs)) stored += 1;
  }
  await store.purge(nowMs);
  return { ok: true, skipped: false, reason: 'fetched', stored, order };
}

function newsJson(payload, status, extra) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? NEWS_PUBLIC_CACHE : 'no-store' };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers[key] = value;
  }
  return { payload, status, headers };
}

/**
 * GET /api/news?symbol=BTC|ETH&limit=20
 * Misma origen: sin Access-Control-Allow-Origin. Cache 5 min.
 * @param {Request} request
 * @param {object} env
 * @param {number} [nowMs]
 */
export async function handleNewsRequest(request, env, nowMs = Date.now()) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const built = newsJson({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
    return new Response(JSON.stringify(built.payload), { status: 405, headers: built.headers });
  }
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (symbol !== 'BTC' && symbol !== 'ETH') {
    const built = newsJson({ error: 'symbol_invalid' }, 400);
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(built.payload), { status: 400, headers: built.headers });
  }
  const limit = parseLimit(url.searchParams.get('limit'));
  let items = [];
  const store = newsStore(env);
  if (store) {
    try {
      items = await store.list(symbol, limit, nowMs);
    } catch (err) {
      console.warn('news: lectura fallo', err && err.message);
      items = [];
    }
  }
  const payload = { symbol, items, asOf: new Date(nowMs).toISOString() };
  const built = newsJson(payload, 200);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status: 200, headers: built.headers });
}

/**
 * @param {string|null} raw
 * @returns {number}
 */
function parseLimit(raw) {
  if (raw === null || raw === '') return NEWS_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return NEWS_DEFAULT_LIMIT;
  const value = Number(raw);
  if (value < 1) return NEWS_DEFAULT_LIMIT;
  return Math.min(value, NEWS_MAX_LIMIT);
}
