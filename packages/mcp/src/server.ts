import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAccountRiskView } from "./account.js";
import { createReadOnlyClient } from "./binance.js";
import { futuresBase, parseAccountRiskConfig, parseProposalLimits, readCredentials } from "./config.js";
import { ANALYSIS_CORE_MISSING, loadAnalysisCore, withSortedFindings } from "./core.js";
import { fetchSymbolFilters } from "./exchange.js";
import { createGridPlanStore, gridPlace, gridPlan } from "./grid.js";
import {
  ANALYZE_TIMEFRAMES,
  createFearGreedCache,
  DEFAULT_KLINE_LIMIT,
  fetchCandles,
  fetchMarkPrice,
  MARKET_KLINE_LIMIT,
  MARKET_TIMEFRAMES,
  MAX_KLINE_LIMIT,
  NEWS_NOTE,
} from "./market-data.js";
import { loadHeadlines } from "./news.js";
import { closePosition, placeOrder } from "./place.js";
import { PLACEMENT_NOTE, proposeFromMark } from "./propose.js";
import { normalizeSymbol } from "./symbol.js";
import { parseTradingConfig, readBase, tradingEnabled, TESTNET_BASE } from "./trading-config.js";
import { errorMessage, redactSecrets } from "./types.js";
import type { FetchLike } from "./types.js";
import type { WriteDeps } from "./write.js";

const STRENGTH_NOTE = "Strength is pattern quality, not probability.";

/** The three notes every write tool carries in its description. */
const WRITE_FLAG_NOTE =
  "Write tool: it sends real orders to Binance USD-M futures. It is only registered when SWAL_MCP_TRADING=enabled, and it trades on testnet (https://testnet.binancefuture.com) unless SWAL_MCP_NETWORK=mainnet and SWAL_MCP_MAINNET_CONFIRM=yes are both set.";
const WRITE_GUARD_NOTE =
  "Every order passes the order guard first: the symbol must be in SWAL_MCP_SYMBOLS, the notional is capped by SWAL_MAX_NOTIONAL_USD, leverage by SWAL_MAX_LEVERAGE (default 1), a stop is always required, the daily-loss lock (SWAL_DAILY_LOSS_USD) refuses new orders when today's PnL reaches it, and open positions are capped by SWAL_MCP_MAX_POSITIONS (default 1).";
const EXPLAIN_NOTE =
  "Explain what you are about to send to the user in plain language before calling this tool (for an order: symbol, side, notional, leverage, stop, take profit and why). The user decides; nothing is sent until this tool is called.";
const NO_STRATEGY_NOTE =
  "This server provides no strategy, no signal and no recommendation: it only executes the explicit instruction it is given.";

/**
 * The instructions the client is shown, built from the configuration that is
 * actually in force.
 *
 * They are derived from parseTradingConfig rather than from a hardcoded string,
 * because instructions that describe a different configuration than the one the
 * server will enforce are worse than no instructions at all.
 */
export function serverInstructions(env: NodeJS.ProcessEnv, base: string): string {
  const parts = [
    "swal-trade MCP serves chart analysis, market context, account risk and order proposals.",
    `Reads use ${base}.`,
  ];
  const cfg = parseTradingConfig(env);
  if (!cfg.ok) {
    parts.push(
      tradingEnabled(env)
        ? `Write tools (place_order, close_position, grid_place) are registered, but the current configuration refuses every order: ${cfg.error} Fix the configuration before sending anything.`
        : "Write tools (place_order, close_position, grid_place) are disabled unless SWAL_MCP_TRADING=enabled; grid_plan is read-only and always available.",
    );
  } else {
    const value = cfg.value;
    parts.push(
      `Write tools are registered because SWAL_MCP_TRADING=enabled. They trade on ${value.base} (${value.network}): explain every order to the user before sending it, and never assume a strategy or a signal from this server.`,
      `The order guard enforces: symbols ${value.symbols.join(", ")}; notional at most ${value.maxNotionalUsd} USD per position; leverage at most ${value.maxLeverage}x; at most ${value.maxOpenPositions} open position(s); a stop on every order; and no new order once today's PnL reaches -${value.dailyLossUsd} USD (${value.tz >= 0 ? "+" : ""}${value.tz}h day boundary).`,
    );
  }
  parts.push(STRENGTH_NOTE, "There are no withdrawal tools. API keys must not have withdrawal permission.", "The daily-loss lock cannot be bypassed from this server.");
  return parts.join(" ");
}

export interface ServerDeps {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  now?: () => number;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: ToolText[];
  isError?: boolean;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const fetchFn: FetchLike = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const fearGreedCache = createFearGreedCache();
  const plans = createGridPlanStore(now);
  const writeDeps: WriteDeps = { env, fetchFn, now, plans };
  // One base for every tool: what an order is explained with is what it is sent
  // against, and the write tools decide their own network from SWAL_MCP_NETWORK.
  const publicBase = futuresBase(env);
  const base = readBase(env, publicBase.ok ? publicBase.value : "https://fapi.binance.com");
  const secrets = [env.BINANCE_API_KEY, env.BINANCE_API_SECRET].flatMap((value) => (value ? [value, value.trim()] : []));
  const canTrade = tradingEnabled(env);

  const fail = (text: string): ToolResult => ({
    content: [{ type: "text", text: redactSecrets(text, secrets) }],
    isError: true,
  });
  const ok = (value: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

  const server = new McpServer({ name: "swal-trade", version: "0.1.0" }, { instructions: serverInstructions(env, base) });

  server.registerTool(
    "analyze_chart",
    {
      title: "Analyze chart",
      description: `Fetch public USD-M futures klines and return analysis-core findings for one symbol and timeframe. Findings are sorted by strength descending. ${STRENGTH_NOTE} This tool is read-only and does not place orders.`,
      inputSchema: {
        symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT."),
        timeframe: z.enum(ANALYZE_TIMEFRAMES).describe("Candle interval."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_KLINE_LIMIT)
          .optional()
          .describe(`Number of klines, from 1 to ${MAX_KLINE_LIMIT}. Default ${DEFAULT_KLINE_LIMIT}.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const symbol = normalizeSymbol(args.symbol);
      if (!symbol) return fail("symbol must be 2 to 30 letters or digits.");
      if (!publicBase.ok) return fail(publicBase.error);
      const loaded = await loadAnalysisCore(env);
      if (!loaded.ok) return fail(ANALYSIS_CORE_MISSING);
      try {
        const candles = await fetchCandles({
          base,
          symbol,
          timeframe: args.timeframe,
          limit: args.limit ?? DEFAULT_KLINE_LIMIT,
          fetchFn,
        });
        const result: unknown = await loaded.analyze({ symbol, timeframe: args.timeframe, candles });
        const sorted = withSortedFindings(result);
        if (!sorted.ok) return fail(sorted.error);
        return ok(sorted.value);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "market_context",
    {
      title: "Market context",
      description: `Read-only multi-timeframe trend (1m, 5m, 1h, 4h) from the analysis core when it is available, plus the fear and greed index cached for 1 hour. News is fetched from a local provider key when one is set (Brave, then Tavily, then Firecrawl) and otherwise from the hosted feed. If none of that returns headlines, news is null: it ${NEWS_NOTE}. ${STRENGTH_NOTE}`,
      inputSchema: {
        symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const symbol = normalizeSymbol(args.symbol);
      if (!symbol) return fail("symbol must be 2 to 30 letters or digits.");
      if (!publicBase.ok) return fail(publicBase.error);
      try {
        const [fearGreed, core, headlines] = await Promise.all([
          fearGreedCache.get(fetchFn, now),
          loadAnalysisCore(env),
          loadHeadlines({ env, symbol, fetchFn, nowMs: now() }),
        ]);
        if (!core.ok) {
          return ok({
            symbol,
            asOf: new Date(now()).toISOString(),
            trends: null,
            analysisError: ANALYSIS_CORE_MISSING,
            fearGreed,
            news: headlines.news,
            note: headlines.note,
          });
        }
        const trends: Record<string, unknown> = {};
        await Promise.all(
          MARKET_TIMEFRAMES.map(async (timeframe) => {
            try {
              const candles = await fetchCandles({
                base,
                symbol,
                timeframe,
                limit: MARKET_KLINE_LIMIT,
                fetchFn,
              });
              const result: unknown = await core.analyze({ symbol, timeframe, candles });
              const sorted = withSortedFindings(result);
              trends[timeframe] = sorted.ok ? sorted.value.trend : { error: sorted.error };
            } catch (err) {
              trends[timeframe] = { error: errorMessage(err) };
            }
          }),
        );
        return ok({
          symbol,
          asOf: new Date(now()).toISOString(),
          trends,
          analysisError: null,
          fearGreed,
          news: headlines.news,
          note: headlines.note,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "account_risk",
    {
      title: "Account risk",
      description:
        "Read-only account risk check. Requires BINANCE_API_KEY and BINANCE_API_SECRET and uses signed GET requests only (account, position risk, income, open algo orders). Compares daily PnL with SWAL_DAILY_LOSS_USD, leverage with SWAL_MAX_LEVERAGE, and notional with SWAL_MAX_NOTIONAL_USD, and lists positions that have no STOP_MARKET algo order. Does not place, cancel, or withdraw.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const credentials = readCredentials(env);
      if (!credentials.ok) return fail(credentials.error);
      const cfg = parseAccountRiskConfig(env);
      if (!cfg.ok) return fail(cfg.error);
      try {
        const client = createReadOnlyClient({
          apiKey: credentials.value.apiKey,
          apiSecret: credentials.value.apiSecret,
          fetchFn,
          now,
          base,
        });
        const snapshot = await loadAccountRiskView({ client, cfg: cfg.value, now });
        return ok({
          ...snapshot.view,
          limits: {
            dailyLossUsd: cfg.value.limit,
            warnFraction: cfg.value.warn ?? 0.7,
            maxNotionalUsd: cfg.value.maxNotional,
            maxLeverage: cfg.value.maxLev,
            tzOffsetHours: cfg.value.tz,
          },
          readOnly: true,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "propose_order",
    {
      title: "Propose order",
      description: `Build a proposed futures order from the public mark price: quantity rounded down to the exchange stepSize and checked against minQty and MIN_NOTIONAL, stop price, a liquidation-distance check, and violations of SWAL_MAX_LEVERAGE and SWAL_MAX_NOTIONAL_USD. stop_loss_pct is a percent (1.5 means 1.5%). The stop is always included. ${PLACEMENT_NOTE} ${EXPLAIN_NOTE} ${NO_STRATEGY_NOTE}`,
      inputSchema: {
        symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT."),
        side: z.enum(["BUY", "SELL", "LONG", "SHORT"]).describe("BUY/LONG opens a long. SELL/SHORT opens a short."),
        notional_usd: z.number().finite().positive().describe("Order notional in USD."),
        stop_loss_pct: z.number().finite().gt(0).lt(100).describe("Stop distance in percent of mark price. 1.5 means 1.5%."),
        leverage: z.number().finite().min(1).max(125).optional().describe("Leverage. Default 1. Never sent to the exchange."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const limits = parseProposalLimits(env);
      if (!limits.ok) return fail(limits.error);
      const symbol = normalizeSymbol(args.symbol);
      if (!symbol) return fail("symbol must be 2 to 30 letters or digits.");
      try {
        const [markPrice, filters] = await Promise.all([
          fetchMarkPrice(base, symbol, fetchFn),
          fetchSymbolFilters(base, symbol, fetchFn),
        ]);
        const built = proposeFromMark({
          symbol,
          side: args.side,
          notionalUsd: args.notional_usd,
          stopLossPct: args.stop_loss_pct,
          leverage: args.leverage ?? 1,
          markPrice,
          limits: limits.value,
          filters: filters.ok
            ? {
                stepSize: filters.value.stepSize,
                minQty: filters.value.minQty,
                tickSize: filters.value.tickSize,
                minNotional: filters.value.minNotional,
              }
            : null,
        });
        if (!built.ok) return fail(built.error);
        return ok({
          ...built.proposal,
          filtersError: filters.ok ? null : filters.error,
          filtersSource: filters.ok ? "/fapi/v1/exchangeInfo" : null,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // grid_plan: read-only, always available.
  // -------------------------------------------------------------------------

  server.registerTool(
    "grid_plan",
    {
      title: "Grid plan",
      description: `Read-only plan for a limit grid on one symbol: the price of every level rounded to the exchange tickSize, the quantity per level rounded to stepSize, the total notional, the average entry, the worst-case loss if price runs to stop_loss_price, and the levels that would not rest as post-only orders. It reads exchangeInfo, the mark price and the book ticker, and it never places, cancels or modifies an order, so it does not need API keys and it is always available. Placing the grid needs grid_place, which is only registered with SWAL_MCP_TRADING=enabled and trades on testnet unless SWAL_MCP_NETWORK=mainnet and SWAL_MCP_MAINNET_CONFIRM=yes are both set. ${NO_STRATEGY_NOTE}`,
      inputSchema: {
        symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT."),
        lower: z.number().finite().positive().describe("Lower bound of the grid."),
        upper: z.number().finite().positive().describe("Upper bound of the grid. Must be greater than lower."),
        levels: z
          .number()
          .int()
          .min(2)
          .max(20)
          .describe("Number of price levels, from 2 to 20."),
        total_notional_usd: z.number().finite().positive().describe("Total notional spread across the levels, in USD."),
        stop_loss_price: z
          .number()
          .finite()
          .positive()
          .describe("Protective stop price. Below the range for a long grid, above it for a short grid."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const outcome = await gridPlan(writeDeps, args);
      return outcome.ok ? ok(outcome.value) : fail(outcome.error);
    },
  );

  // -------------------------------------------------------------------------
  // Write tools: registered only when the user opted in.
  // -------------------------------------------------------------------------

  if (canTrade) {
    server.registerTool(
      "place_order",
      {
        title: "Place order",
        description: `WRITE tool. Places one entry order and a mandatory protective STOP_MARKET through the Algo Service (POST /fapi/v1/algoOrder, closePosition, workingType MARK_PRICE). Sets leverage and ISOLATED margin on the exchange before the entry, rounds the quantity to stepSize and checks minQty and MIN_NOTIONAL. type market sends a MARKET order; type post_only sends a LIMIT GTX at the best bid or ask and reprices away from the book on -5022 or EXPIRED. If the protective stop fails twice the position is closed with a MARKET reduceOnly order and the tool returns an error. Every write is appended to the local journal (SWAL_MCP_JOURNAL). ${WRITE_FLAG_NOTE} ${WRITE_GUARD_NOTE} ${EXPLAIN_NOTE} ${NO_STRATEGY_NOTE}`,
        inputSchema: {
          symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT. Must be in SWAL_MCP_SYMBOLS."),
          side: z.enum(["BUY", "SELL", "LONG", "SHORT"]).describe("BUY/LONG opens a long. SELL/SHORT opens a short."),
          notional_usd: z.number().finite().positive().describe("Order notional in USD. Capped by SWAL_MAX_NOTIONAL_USD."),
          stop_loss_pct: z.number().finite().gt(0).lt(100).describe("Stop distance in percent of the entry price. Mandatory."),
          take_profit_pct: z.number().finite().gt(0).optional().describe("Optional take profit distance in percent of the entry price."),
          leverage: z.number().finite().min(1).max(125).optional().describe("Leverage. Default 1. Capped by SWAL_MAX_LEVERAGE."),
          type: z.enum(["market", "post_only"]).optional().describe("market (default) or post_only (LIMIT GTX)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        const outcome = await placeOrder(writeDeps, args);
        return outcome.ok ? ok(outcome.value) : fail(outcome.error);
      },
    );

    server.registerTool(
      "close_position",
      {
        title: "Close position",
        description: `WRITE tool. Closes one symbol's position with a MARKET reduceOnly order and cancels that symbol's open orders and open algo orders. The daily-loss lock and the position cap do not apply: closing is protective and must never be blocked. It does not withdraw and does not touch any other symbol. ${WRITE_FLAG_NOTE} ${EXPLAIN_NOTE} ${NO_STRATEGY_NOTE}`,
        inputSchema: {
          symbol: z.string().min(1).describe("Futures symbol, for example BTCUSDT."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        const outcome = await closePosition(writeDeps, args);
        return outcome.ok ? ok(outcome.value) : fail(outcome.error);
      },
    );

    server.registerTool(
      "grid_place",
      {
        title: "Grid place",
        description: `WRITE tool. Places a limit grid as post-only orders (LIMIT GTX, 2 to 20 levels) plus one protective STOP_MARKET below a long range or above a short range, with the same flag, order guard and journal as place_order. The direction comes from the stop (below the range = long, above = short), leverage is SWAL_MAX_LEVERAGE, and margin is ISOLATED. Accepts a plan_id returned by grid_plan, or the same parameters. If any level cannot be rested or the protective stop fails twice, the grid is cancelled, any open position is closed with MARKET reduceOnly, and the tool returns an error. ${WRITE_FLAG_NOTE} ${WRITE_GUARD_NOTE} ${EXPLAIN_NOTE} ${NO_STRATEGY_NOTE}`,
        inputSchema: {
          plan_id: z.string().min(1).optional().describe("plan_id returned by grid_plan. Alternative to passing the parameters."),
          symbol: z.string().min(1).optional().describe("Futures symbol, for example BTCUSDT. Required without plan_id."),
          lower: z.number().finite().positive().optional().describe("Lower bound of the grid."),
          upper: z.number().finite().positive().optional().describe("Upper bound of the grid."),
          levels: z.number().int().min(2).max(20).optional().describe("Number of price levels, from 2 to 20."),
          total_notional_usd: z.number().finite().positive().optional().describe("Total notional spread across the levels, in USD."),
          stop_loss_price: z.number().finite().positive().optional().describe("Protective stop price, below a long range or above a short range."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        const outcome = await gridPlace(writeDeps, args);
        return outcome.ok ? ok(outcome.value) : fail(outcome.error);
      },
    );
  }

  return server;
}
