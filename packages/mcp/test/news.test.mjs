import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { NEWS_NOTE } from "../dist/market-data.js";
import { HOSTED_NEWS_URL, loadHeadlines, newsAsset, scoreSentiment } from "../dist/news.js";
import { jsonResponse, textOf, withClient } from "./helpers.mjs";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const BRAVE_KEY = "test-brave-key";
const TAVILY_KEY = "test-tavily-key";
const FIRECRAWL_KEY = "test-firecrawl-key";

function hostOf(url) {
  return new URL(String(url)).hostname;
}

test("newsAsset solo acepta BTC y ETH", () => {
  assert.equal(newsAsset("btcusdt"), "BTC");
  assert.equal(newsAsset("ETHUSDC"), "ETH");
  assert.equal(newsAsset("SOLUSDT"), null);
});

test("el léxico copiado marca positivo, negativo y neutral", () => {
  assert.equal(scoreSentiment("Bitcoin rally and breakout").label, "positivo");
  assert.equal(scoreSentiment("ETH crash and hack").label, "negativo");
  assert.equal(scoreSentiment("El hackeo provoca una caída").label, "negativo");
  assert.deepEqual(scoreSentiment("Bitcoin price today"), { score: 0, label: "neutral" });
});

test("el orden de respaldo es Brave, Tavily, Firecrawl y después el sitio", async () => {
  const published = "2026-10-09T11:00:00.000Z";

  const braveOnly = [];
  const brave = await loadHeadlines({
    env: { BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY, FIRECRAWL_API_KEY: FIRECRAWL_KEY },
    symbol: "BTCUSDT",
    nowMs: NOW,
    fetchFn: async (url, init) => {
      braveOnly.push({ href: String(url), init });
      assert.equal(hostOf(url), "api.search.brave.com");
      assert.equal(init.headers["X-Subscription-Token"], BRAVE_KEY);
      assert.equal(new URL(String(url)).searchParams.get("freshness"), "pw");
      assert.equal(String(url).includes(BRAVE_KEY), false);
      return jsonResponse({
        results: [{ title: "Bitcoin rally", url: "https://news.example/btc", description: "breakout", page_age: published, profile: { name: "Wire" } }],
      });
    },
  });
  assert.equal(brave.note, null);
  assert.equal(brave.news.length, 1);
  assert.equal(brave.news[0].provider, "brave");
  assert.equal(brave.news[0].sentiment.label, "positivo");
  assert.equal(braveOnly.length, 1);
  assert.equal(JSON.stringify(brave).includes(BRAVE_KEY), false);

  const tavilyCalls = [];
  const tavily = await loadHeadlines({
    env: { BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY, FIRECRAWL_API_KEY: FIRECRAWL_KEY },
    symbol: "ETHUSDT",
    nowMs: NOW,
    fetchFn: async (url, init) => {
      tavilyCalls.push(String(url));
      if (hostOf(url) === "api.search.brave.com") return jsonResponse({ error: "down" }, 500);
      assert.equal(hostOf(url), "api.tavily.com");
      const body = JSON.parse(init.body);
      assert.equal(body.topic, "news");
      assert.equal(body.search_depth, "basic");
      assert.equal(init.body.includes(TAVILY_KEY), false);
      assert.equal(init.headers.Authorization, `Bearer ${TAVILY_KEY}`);
      return jsonResponse({
        results: [{ title: "Ethereum plunge", url: "https://news.example/eth", content: "crash", published_date: published }],
      });
    },
  });
  assert.deepEqual(tavilyCalls.map(hostOf), ["api.search.brave.com", "api.tavily.com"]);
  assert.equal(tavily.news[0].provider, "tavily");
  assert.equal(tavily.news[0].sentiment.label, "negativo");
  assert.equal(tavily.note, null);

  const fireCalls = [];
  const fire = await loadHeadlines({
    env: { BRAVE_API_KEY: BRAVE_KEY, TAVILY_API_KEY: TAVILY_KEY, FIRECRAWL_API_KEY: FIRECRAWL_KEY },
    symbol: "BTCUSDT",
    nowMs: NOW,
    fetchFn: async (url, init) => {
      fireCalls.push(hostOf(url));
      if (hostOf(url) !== "api.firecrawl.dev") return jsonResponse({ results: [] });
      assert.equal(String(url), "https://api.firecrawl.dev/v2/search");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.sources, ["news"]);
      assert.equal(body.scrapeOptions, undefined);
      return jsonResponse({
        success: true,
        data: { news: [{ title: "Bitcoin ban", url: "https://news.example/ban", snippet: "lawsuit", date: published }] },
      });
    },
  });
  assert.deepEqual(fireCalls, ["api.search.brave.com", "api.tavily.com", "api.firecrawl.dev"]);
  assert.equal(fire.news[0].provider, "firecrawl");

  const hostedCalls = [];
  const hosted = await loadHeadlines({
    env: {},
    symbol: "BTCUSDT",
    nowMs: NOW,
    fetchFn: async (url) => {
      hostedCalls.push(String(url));
      assert.equal(String(url), `${HOSTED_NEWS_URL}?symbol=BTC&limit=5`);
      return jsonResponse({
        symbol: "BTC",
        items: [{
          id: "abc",
          title: "Bitcoin rally hosted",
          url: "https://news.example/hosted",
          source: "Wire",
          publishedAt: published,
          snippet: "breakout",
          provider: "brave",
          symbols: ["BTC"],
          sentiment: { score: 1, label: "positivo" },
          secret: BRAVE_KEY,
        }],
      });
    },
  });
  assert.equal(hostedCalls.length, 1);
  assert.equal(hosted.news[0].title, "Bitcoin rally hosted");
  assert.equal(hosted.note, null);
  assert.equal(Object.hasOwn(hosted.news[0], "secret"), false);
  assert.equal(JSON.stringify(hosted).includes(BRAVE_KEY), false);

  const exhausted = [];
  const none = await loadHeadlines({
    env: { BRAVE_API_KEY: BRAVE_KEY },
    symbol: "BTCUSDT",
    nowMs: NOW,
    fetchFn: async (url) => {
      exhausted.push(hostOf(url));
      if (hostOf(url) === "api.search.brave.com") return jsonResponse({ results: [] });
      return jsonResponse({ error: "down" }, 503);
    },
  });
  assert.deepEqual(exhausted.map((host) => host), ["api.search.brave.com", "trade.swal.network"]);
  assert.equal(none.news, null);
  assert.equal(none.note, NEWS_NOTE);

  let fetches = 0;
  const other = await loadHeadlines({
    env: { BRAVE_API_KEY: BRAVE_KEY },
    symbol: "SOLUSDT",
    nowMs: NOW,
    fetchFn: async () => {
      fetches += 1;
      return jsonResponse({});
    },
  });
  assert.equal(fetches, 0);
  assert.equal(other.news, null);
  assert.equal(other.note, NEWS_NOTE);
});

test("market_context devuelve los titulares y conserva la nota si no hay fuente", async () => {
  const published = "2026-10-09T11:00:00.000Z";
  await withClient({
    env: { BRAVE_API_KEY: BRAVE_KEY, SWAL_ANALYSIS_CORE: fileURLToPath(new URL("./fixtures/does-not-exist.js", import.meta.url)) },
    now: () => NOW,
    fetchFn: async (url) => {
      const href = String(url);
      if (href.startsWith("https://api.alternative.me/")) {
        return jsonResponse({ data: [{ value: "45", value_classification: "Fear", timestamp: "1700000000" }] });
      }
      assert.equal(hostOf(url), "api.search.brave.com");
      return jsonResponse({
        results: [{ title: "Bitcoin rally", url: "https://news.example/btc", description: "breakout", page_age: published, profile: { name: "Wire" } }],
      });
    },
  }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "market_context", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.news.length, 1);
    assert.equal(body.news[0].title, "Bitcoin rally");
    assert.equal(body.note, null);
    assert.equal(body.fearGreed.value, 45);
    assert.equal(JSON.stringify(body).includes(BRAVE_KEY), false);
  });
});
