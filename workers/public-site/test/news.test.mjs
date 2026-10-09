import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import {
  NEWS_MONTHLY_CAP,
  budgetMonth,
  canonicalUrl,
  configuredProviders,
  dedupeItems,
  fetchBraveNews,
  fetchFirecrawlNews,
  fetchTavilyNews,
  handleNewsRequest,
  hashId,
  ingestNews,
  newsStore,
  normalizeRaw,
  parseFirecrawlBody,
  scoreSentiment,
  shouldFetchNews,
  steadyStateRequestsPerProvider,
  withinAge,
} from '../src/news.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const BRAVE_KEY = 'test-brave-key';
const TAVILY_KEY = 'test-tavily-key';
const FIRECRAWL_KEY = 'test-firecrawl-key';

function memoryNewsDb() {
  const news = new Map();
  const meta = new Map();
  return {
    news,
    meta,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          return {
            async first() {
              if (text.startsWith('SELECT value FROM news_meta')) {
                const value = meta.get(args[0]);
                return value === undefined ? null : { value };
              }
              if (text.startsWith('SELECT id FROM news WHERE title_key')) {
                const [titleKey, id] = args;
                for (const row of news.values()) {
                  if (row.title_key === titleKey && row.id !== id) return { id: row.id };
                }
                return null;
              }
              if (text.startsWith('SELECT symbols FROM news WHERE id')) {
                const row = news.get(args[0]);
                return row ? { symbols: row.symbols } : null;
              }
              throw new Error(`first sin manejar: ${text.slice(0, 90)}`);
            },
            async all() {
              if (!text.startsWith('SELECT id, url, title')) throw new Error(`all sin manejar: ${text.slice(0, 70)}`);
              const [cutoff, needle, limit] = args;
              const results = [...news.values()]
                .filter((row) => row.published_at >= cutoff && String(row.symbols).includes(needle))
                .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
                .slice(0, limit);
              return { results };
            },
            async run() {
              if (text.startsWith('INSERT INTO news_meta')) {
                meta.set(args[0], args[1]);
                return;
              }
              if (text.startsWith('INSERT INTO news ')) {
                const [id, url, title, title_key, source, published_at, snippet, provider, symbols, sentiment_score, sentiment_label, fetched_at] = args;
                news.set(id, { id, url, title, title_key, source, published_at, snippet, provider, symbols, sentiment_score, sentiment_label, fetched_at });
                return;
              }
              if (text.startsWith('DELETE FROM news')) {
                const cutoff = args[0];
                for (const [id, row] of news) if (row.published_at < cutoff) news.delete(id);
                return;
              }
              throw new Error(`run sin manejar: ${text.slice(0, 90)}`);
            },
          };
        },
      };
    },
  };
}

function memoryKv() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

function jsonRes(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => text,
  };
}

function braveRow(symbol, n, extra = {}) {
  const name = symbol === 'BTC' ? 'Bitcoin' : 'Ethereum';
  return {
    title: extra.title || `${name} rally number ${n}`,
    url: extra.url || `https://www.example.com/${symbol.toLowerCase()}/${n}?utm_source=news`,
    description: extra.description || `${name} breakout`,
    page_age: extra.page_age || '2026-10-09T11:00:00.000Z',
    profile: { name: 'Example Wire', url: 'https://example.com' },
    meta_url: { hostname: 'example.com' },
  };
}

function router(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    const host = new URL(href).hostname;
    const handler = handlers[host];
    if (!handler) throw new Error(`unexpected ${host}`);
    return handler(href, init);
  };
  return { calls, fetchImpl };
}

test('el régimen estable de 31 días queda por debajo del tope de 1000', () => {
  assert.equal(steadyStateRequestsPerProvider(31), 992);
  assert.equal(steadyStateRequestsPerProvider(30), 960);
  assert.ok(steadyStateRequestsPerProvider(31) <= NEWS_MONTHLY_CAP);
  assert.equal(NEWS_MONTHLY_CAP, 1000);
});

test('léxico de sentimiento: español, inglés, empate y texto sin términos', () => {
  assert.equal(scoreSentiment('Bitcoin rally and breakout').label, 'positivo');
  assert.equal(scoreSentiment('Bitcoin rally and breakout').score, 1);
  assert.equal(scoreSentiment('ETH crash and hack').label, 'negativo');
  assert.equal(scoreSentiment('ETH crash and hack').score, -1);
  assert.deepEqual(scoreSentiment('Bitcoin price today'), { score: 0, label: 'neutral' });
  assert.deepEqual(scoreSentiment('rally but crash'), { score: 0, label: 'neutral' });
  assert.equal(scoreSentiment('La aprobación del ETF es una subida').label, 'positivo');
  assert.equal(scoreSentiment('El hackeo provoca una caída').label, 'negativo');
  const mixed = scoreSentiment('rally, breakout, but a crash');
  assert.equal(mixed.score, 0.333);
  assert.equal(mixed.label, 'positivo');
  assert.ok(mixed.score >= -1 && mixed.score <= 1);
});

test('la url canónica ignora utm, www y el esquema, y el id es el hash', async () => {
  const left = canonicalUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1');
  const right = canonicalUrl('http://example.com/a?a=1&b=2');
  assert.equal(left, right);
  assert.equal(await hashId(left), await hashId(right));
  const item = await normalizeRaw({
    title: '  Bitcoin   rally  ',
    url: 'https://www.Example.com/a/?utm_source=x',
    snippet: 'breakout',
    source: 'Example Wire',
    publishedAt: '2026-10-09T11:00:00.000Z',
    provider: 'brave',
  }, 'ETH', NOW);
  assert.equal(item.url, 'https://example.com/a');
  assert.equal(item.id, await hashId(item.url));
  assert.deepEqual(item.symbols, ['BTC']);
  assert.equal(item.provider, 'brave');
  assert.equal(item.title, 'Bitcoin rally');
  assert.equal(withinAge({ publishedAt: '2026-10-07T11:00:00.000Z' }, NOW), false);
  assert.equal(withinAge({ publishedAt: '2026-10-09T11:00:00.000Z' }, NOW), true);
});

test('dedupe une la misma url o el mismo título y suma símbolos', async () => {
  const first = await normalizeRaw({
    title: 'Bitcoin rally number 1',
    url: 'https://example.com/story?utm_campaign=a',
    snippet: 'breakout',
    source: 'Wire',
    publishedAt: '2026-10-09T10:00:00.000Z',
    provider: 'brave',
  }, 'BTC', NOW);
  const sameUrl = await normalizeRaw({
    title: 'Ethereum looks at the same story',
    url: 'https://www.example.com/story/',
    snippet: 'Ethereum rebound',
    source: 'Wire',
    publishedAt: '2026-10-09T11:00:00.000Z',
    provider: 'tavily',
  }, 'ETH', NOW);
  const sameTitle = await normalizeRaw({
    title: 'Bitcoin rally number 1',
    url: 'https://other.example/btc',
    snippet: 'Ethereum too',
    source: 'Other',
    publishedAt: '2026-10-09T09:00:00.000Z',
    provider: 'brave',
  }, 'ETH', NOW);
  const merged = dedupeItems([first, sameUrl, sameTitle]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://example.com/story');
  assert.deepEqual(merged[0].symbols, ['BTC', 'ETH']);
  assert.equal(merged[0].publishedAt, '2026-10-09T11:00:00.000Z');
});

test('adaptadores: Brave, Tavily y Firecrawl piden la forma documentada y no filtran la clave', async () => {
  const brave = await fetchBraveNews(BRAVE_KEY, 'Bitcoin BTC cryptocurrency', async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin + parsed.pathname, 'https://api.search.brave.com/res/v1/news/search');
    assert.equal(parsed.searchParams.get('q'), 'Bitcoin BTC cryptocurrency');
    assert.equal(parsed.searchParams.get('freshness'), 'pw');
    assert.equal(parsed.searchParams.get('count'), '10');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['X-Subscription-Token'], BRAVE_KEY);
    assert.equal(String(url).includes(BRAVE_KEY), false);
    return jsonRes({
      type: 'news',
      results: [{
        title: 'Bitcoin rally',
        url: 'https://news.example/btc',
        description: 'A breakout',
        page_age: '2026-10-09T11:00:00.000Z',
        profile: { name: 'Wire', url: 'https://news.example' },
        meta_url: { hostname: 'news.example' },
      }],
    });
  });
  assert.equal(brave[0].provider, 'brave');
  assert.equal(brave[0].source, 'Wire');
  assert.equal(brave[0].snippet, 'A breakout');
  assert.equal(JSON.stringify(brave).includes(BRAVE_KEY), false);

  const tavily = await fetchTavilyNews(TAVILY_KEY, 'Ethereum ETH cryptocurrency', async (url, init) => {
    assert.equal(String(url), 'https://api.tavily.com/search');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${TAVILY_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.topic, 'news');
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.api_key, undefined);
    assert.equal(init.body.includes(TAVILY_KEY), false);
    return jsonRes({
      results: [{
        title: 'Ethereum plunge',
        url: 'https://news.example/eth',
        content: 'A crash',
        published_date: 'Thu, 09 Oct 2026 11:00:00 GMT',
      }],
    });
  });
  assert.equal(tavily[0].provider, 'tavily');
  assert.equal(tavily[0].snippet, 'A crash');
  assert.equal(tavily[0].source, 'news.example');
  assert.equal(JSON.stringify(tavily).includes(TAVILY_KEY), false);

  const firecrawl = await fetchFirecrawlNews(FIRECRAWL_KEY, 'Bitcoin BTC cryptocurrency', async (url, init) => {
    assert.equal(String(url), 'https://api.firecrawl.dev/v2/search');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${FIRECRAWL_KEY}`);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.sources, ['news']);
    assert.equal(body.scrapeOptions, undefined);
    assert.equal(init.body.includes(FIRECRAWL_KEY), false);
    return jsonRes({
      success: true,
      data: { news: [{ title: 'Bitcoin ban', url: 'https://news.example/ban', snippet: 'lawsuit', date: '2026-10-09T11:00:00.000Z' }] },
    });
  });
  assert.equal(firecrawl[0].provider, 'firecrawl');
  assert.equal(firecrawl[0].snippet, 'lawsuit');
  assert.equal(JSON.stringify(firecrawl).includes(FIRECRAWL_KEY), false);

  const legacy = parseFirecrawlBody({
    success: true,
    data: [{ title: 'Ethereum alza', url: 'https://old.example/eth', description: 'repunte' }],
  });
  assert.equal(legacy[0].provider, 'firecrawl');
  assert.equal(legacy[0].snippet, 'repunte');
  assert.deepEqual(parseFirecrawlBody({ success: false, data: { news: [{ title: 'x', url: 'https://x' }] } }), []);
});

test('la puerta de 30 min no vuelve a pedir proveedores', async () => {
  assert.equal(shouldFetchNews(null, NOW), true);
  assert.equal(shouldFetchNews(NOW, NOW + 30 * 60 * 1000 - 1), false);
  assert.equal(shouldFetchNews(NOW, NOW + 30 * 60 * 1000), true);

  const DB = memoryNewsDb();
  const { calls, fetchImpl } = router({
    'api.search.brave.com': () => jsonRes({ results: [braveRow('BTC', 1), braveRow('ETH', 1)] }),
  });
  const env = { DB, BRAVE_API_KEY: BRAVE_KEY };
  const first = await ingestNews(env, NOW, fetchImpl);
  assert.equal(first.skipped, false);
  assert.equal(calls.length, 2);
  const second = await ingestNews(env, NOW + 5 * 60 * 1000, fetchImpl);
  assert.equal(second.reason, 'gate');
  assert.equal(calls.length, 2);
  await ingestNews(env, NOW + 30 * 60 * 1000, fetchImpl);
  assert.equal(calls.length, 4);
});

test('rota proveedores, cae al siguiente si el primero falla y respeta el cupo', async () => {
  const DB = memoryNewsDb();
  const { calls, fetchImpl } = router({
    'api.search.brave.com': () => jsonRes({ results: [braveRow('BTC', 1)] }),
    'api.tavily.com': async (_url, init) => {
      const query = JSON.parse(init.body).query;
      const symbol = query.startsWith('Bitcoin') ? 'BTC' : 'ETH';
      return jsonRes({
        results: [{ title: `${symbol} rally via tavily`, url: `https://tavily.example/${symbol}`, content: 'breakout', published_date: '2026-10-09T11:00:00.000Z' }],
      });
    },
  });
  const env = { DB, BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY };
  await ingestNews(env, NOW, fetchImpl);
  assert.deepEqual(calls.map((call) => new URL(call.href).hostname), ['api.search.brave.com', 'api.search.brave.com']);
  calls.length = 0;
  await ingestNews(env, NOW + 30 * 60 * 1000, fetchImpl);
  assert.deepEqual(calls.map((call) => new URL(call.href).hostname), ['api.tavily.com', 'api.tavily.com']);

  const failed = memoryNewsDb();
  const fallback = router({
    'api.search.brave.com': () => jsonRes({ error: 'no' }, 500),
    'api.tavily.com': () => jsonRes({
      results: [{ title: 'Bitcoin rally fallback', url: 'https://tavily.example/only', content: 'breakout', published_date: '2026-10-09T11:00:00.000Z' }],
    }),
  });
  const saved = await ingestNews({ DB: failed, BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY }, NOW, fallback.fetchImpl);
  assert.ok(saved.stored >= 1);
  const listed = await newsStore({ DB: failed }).list('BTC', 20, NOW);
  assert.equal(listed[0].provider, 'tavily');
  assert.equal(JSON.stringify(listed).includes(TAVILY_KEY), false);

  const capped = memoryNewsDb();
  await newsStore({ DB: capped }).setMeta(`budget:${budgetMonth(NOW)}`, JSON.stringify({ brave: NEWS_MONTHLY_CAP }));
  const quiet = router({ 'api.search.brave.com': () => jsonRes({ results: [braveRow('BTC', 1)] }) });
  const stopped = await ingestNews({ DB: capped, BRAVE_API_KEY: BRAVE_KEY }, NOW, quiet.fetchImpl);
  assert.equal(stopped.reason, 'budget');
  assert.equal(quiet.calls.length, 0);
  assert.deepEqual(configuredProviders({}), []);
});

test('GET /api/news: vacío, con datos, tope de limit, sin CORS abierto ni secretos', async () => {
  const DB = memoryNewsDb();
  const env = { DB, BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY, FIRECRAWL_API_KEY: FIRECRAWL_KEY };
  const empty = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=BTC'), env);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).items, []);
  assert.equal(empty.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(empty.headers.get('access-control-allow-origin'), null);

  const store = newsStore(env);
  for (let i = 0; i < 25; i += 1) {
    const item = await normalizeRaw({
      title: `Bitcoin rally ${i}`,
      url: `https://example.com/btc/${i}`,
      snippet: 'breakout',
      source: 'Wire',
      publishedAt: new Date(NOW - i * 60 * 1000).toISOString(),
      provider: 'brave',
    }, 'BTC', NOW);
    await store.upsert(item, NOW);
  }
  const old = await normalizeRaw({
    title: 'Bitcoin crash archive',
    url: 'https://example.com/btc/old',
    snippet: 'collapse',
    source: 'Wire',
    publishedAt: '2026-10-01T12:00:00.000Z',
    provider: 'brave',
  }, 'BTC', NOW);
  await store.upsert(old, NOW);
  const eth = await normalizeRaw({
    title: 'Ethereum plunge today',
    url: 'https://example.com/eth/1',
    snippet: 'crash',
    source: 'Wire',
    publishedAt: '2026-10-09T11:00:00.000Z',
    provider: 'tavily',
  }, 'ETH', NOW);
  await store.upsert(eth, NOW);

  const capped = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=btc&limit=100'), env);
  const cappedBody = await capped.json();
  assert.equal(capped.status, 200);
  assert.equal(cappedBody.symbol, 'BTC');
  assert.equal(cappedBody.items.length, 20);
  assert.equal(cappedBody.items[0].title, 'Bitcoin rally 0');
  assert.equal(cappedBody.items.some((item) => item.title.includes('archive')), false);
  assert.equal(JSON.stringify(cappedBody).includes(BRAVE_KEY), false);
  assert.equal(Object.hasOwn(cappedBody.items[0], 'titleKey'), false);
  assert.deepEqual(cappedBody.items[0].sentiment.label === 'positivo' || cappedBody.items[0].sentiment.label === 'neutral', true);

  const five = await handleNewsRequest(new Request('https://trade.swal.network/api/news?symbol=BTC&limit=5'), env, NOW);
  assert.equal((await five.json()).items.length, 5);

  const onlyEth = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=ETH'), env);
  const ethBody = await onlyEth.json();
  assert.equal(ethBody.items.length, 1);
  assert.equal(ethBody.items[0].title, 'Ethereum plunge today');
  assert.equal(ethBody.items[0].sentiment.label, 'negativo');

  const bad = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=SOL'), env);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'symbol_invalid');
  const post = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=BTC', { method: 'POST' }), env);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  const head = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=BTC', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('sin D1 el KV guarda y lee; si hay D1 no se escribe KV', async () => {
  const kv = memoryKv();
  const { fetchImpl } = router({
    'api.search.brave.com': (href) => {
      const symbol = new URL(href).searchParams.get('q').startsWith('Bitcoin') ? 'BTC' : 'ETH';
      return jsonRes({ results: [braveRow(symbol, 7)] });
    },
  });
  const saved = await ingestNews({ SNAPSHOTS: kv, BRAVE_API_KEY: BRAVE_KEY }, NOW, fetchImpl);
  assert.equal(saved.skipped, false);
  assert.ok(kv.map.has('news:items'));
  const res = await worker.fetch(new Request('https://trade.swal.network/api/news?symbol=ETH&limit=5'), { SNAPSHOTS: kv });
  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].source, 'Example Wire');
  assert.equal(JSON.stringify(body).includes(BRAVE_KEY), false);

  const DB = memoryNewsDb();
  const kv2 = memoryKv();
  await ingestNews({ DB, SNAPSHOTS: kv2, BRAVE_API_KEY: BRAVE_KEY }, NOW, fetchImpl);
  assert.equal(kv2.map.has('news:items'), false);
  assert.ok(DB.news.size > 0);
});

test('el cron sigue enganchado a waitUntil y no llama a la red sin claves', async () => {
  let seen = 0;
  let pending = Promise.resolve();
  await worker.scheduled({}, {}, {
    waitUntil(promise) {
      seen += 1;
      pending = promise;
      return promise;
    },
  });
  await pending;
  assert.equal(seen, 1);
});

test('la página de análisis pide /api/news y no pinta el tono con color', () => {
  const html = readFileSync(new URL('../static/analisis/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../static/analisis/analisis.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../static/analisis/analisis.css', import.meta.url), 'utf8');
  assert.match(html, /id="news"/);
  assert.doesNotMatch(html, /Próximamente/);
  assert.match(js, /\/api\/news\?symbol=/);
  assert.match(js, /noopener noreferrer/);
  assert.match(js, /limit=5/);
  assert.doesNotMatch(css, /\.positivo|\.negativo|sentiment/);
});
