import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createReadOnlyClient } from "./binance.js";
import { futuresBase, parseAccountRiskConfig, parseProposalLimits, readCredentials } from "./config.js";
import { ANALYSIS_CORE_MISSING, loadAnalysisCore, withSortedFindings } from "./core.js";
import {
  explainFallback,
  explainRequestBody,
  explainTimeoutMs,
  explainToolResult,
  explainUrl,
  fetchHostedExplanation,
  EXPLAIN_FALLBACK_NOTE,
} from "./explain.js";
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
import { PLACEMENT_NOTE, proposeFromMark } from "./propose.js";
import { dayStartMs, evaluateAccount } from "./risk.js";
import type { AlgoOrder, IncomeRow, PositionRiskRow, RawPosition } from "./risk.js";
import { normalizeSymbol } from "./symbol.js";
import { errorMessage, isRecord, redactSecrets } from "./types.js";
import type { FetchLike } from "./types.js";

const STRENGTH_NOTE = "Strength is pattern quality, not probability.";

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

function asNumberString(value: unknown, field: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`missing ${field}`);
}

function parseAccountPositions(account: unknown): RawPosition[] {
  if (!isRecord(account)) throw new Error("account response is not an object");
  const rows = account.positions ?? [];
  if (!Array.isArray(rows)) throw new Error("account positions is not an array");
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") throw new Error("account position is invalid");
    const position: RawPosition = {
      symbol: row.symbol,
      positionAmt: asNumberString(row.positionAmt, "positionAmt"),
      notional: asNumberString(row.notional, "notional"),
      unrealizedProfit: asNumberString(row.unrealizedProfit, "unrealizedProfit"),
    };
    if (typeof row.positionSide === "string") position.positionSide = row.positionSide;
    return position;
  });
}

function parsePositionRisk(value: unknown): PositionRiskRow[] {
  if (!Array.isArray(value)) throw new Error("positionRisk response is not an array");
  return value.map((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") throw new Error("positionRisk row is invalid");
    if (typeof row.leverage !== "string" && typeof row.leverage !== "number") throw new Error("positionRisk row missing leverage");
    return {
      symbol: row.symbol,
      positionAmt: asNumberString(row.positionAmt, "positionAmt"),
      leverage: row.leverage,
    };
  });
}

function parseIncome(value: unknown): IncomeRow[] {
  if (!Array.isArray(value)) throw new Error("income response is not an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("income row is not an object");
    const income: IncomeRow = {};
    if (typeof row.incomeType === "string") income.incomeType = row.incomeType;
    if (typeof row.asset === "string") income.asset = row.asset;
    if (typeof row.income === "string" || typeof row.income === "number") income.income = row.income;
    if (typeof row.time === "number") income.time = row.time;
    return income;
  });
}

function parseAlgo(value: unknown): AlgoOrder[] {
  if (!Array.isArray(value)) throw new Error("openAlgoOrders response is not an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("algo order is not an object");
    const order: AlgoOrder = {};
    if (typeof row.symbol === "string") order.symbol = row.symbol;
    if (typeof row.side === "string") order.side = row.side;
    if (typeof row.orderType === "string") order.orderType = row.orderType;
    if (typeof row.type === "string") order.type = row.type;
    if ("closePosition" in row) order.closePosition = row.closePosition;
    if ("reduceOnly" in row) order.reduceOnly = row.reduceOnly;
    if (typeof row.positionSide === "string") order.positionSide = row.positionSide;
    return order;
  });
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const fetchFn: FetchLike = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const fearGreedCache = createFearGreedCache();
  const secrets = [env.BINANCE_API_KEY, env.BINANCE_API_SECRET].flatMap((value) =>
    value ? [value, value.trim()] : [],
  );

  const fail = (text: string): ToolResult => ({
    content: [{ type: "text", text: redactSecrets(text, secrets) }],
    isError: true,
  });
  const ok = (value: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

  const server = new McpServer(
    { name: "swal-trade", version: "0.1.0" },
    {
      instructions: [
        "swal-trade MCP is read-only in this build.",
        "Order placement tools are disabled in this build.",
        STRENGTH_NOTE,
        "There are no withdrawal tools. API keys must not have withdrawal permission.",
        "The daily-loss lock cannot be bypassed from this server.",
      ].join(" "),
    },
  );

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
      const base = futuresBase(env);
      if (!base.ok) return fail(base.error);
      const loaded = await loadAnalysisCore(env);
      if (!loaded.ok) return fail(ANALYSIS_CORE_MISSING);
      try {
        const candles = await fetchCandles({
          base: base.value,
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
    "explain_analysis",
    {
      title: "Explain analysis",
      description: `Run the same deterministic analysis as analyze_chart and ask the hosted explain endpoint (POST /api/explain) for a plain-Spanish explanation of the top patterns: what they mean, what would confirm or invalidate them, and which risk to manage (stop placement, position size, 1x leverage). The model never gives orders and never promises results. Without SWAL_EXPLAIN_URL, or when the hosted endpoint fails, the tool returns the deterministic fallback built from the same findings. ${STRENGTH_NOTE} This tool is read-only, does not place orders and is not financial advice.`,
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
      const base = futuresBase(env);
      if (!base.ok) return fail(base.error);
      const loaded = await loadAnalysisCore(env);
      if (!loaded.ok) return fail(ANALYSIS_CORE_MISSING);
      let body;
      try {
        const candles = await fetchCandles({
          base: base.value,
          symbol,
          timeframe: args.timeframe,
          limit: args.limit ?? DEFAULT_KLINE_LIMIT,
          fetchFn,
        });
        const result: unknown = await loaded.analyze({ symbol, timeframe: args.timeframe, candles });
        const sorted = withSortedFindings(result);
        if (!sorted.ok) return fail(sorted.error);
        body = explainRequestBody(sorted.value, symbol, args.timeframe);
      } catch (err) {
        return fail(errorMessage(err));
      }

      const url = explainUrl(env);
      if (!url) {
        return ok(
          explainToolResult({
            symbol,
            timeframe: args.timeframe,
            payload: explainFallback(body.analysis, symbol, args.timeframe, "sin endpoint alojado"),
            model: null,
            hosted: false,
            note: `SWAL_EXPLAIN_URL vacío: ${EXPLAIN_FALLBACK_NOTE}`,
          }),
        );
      }

      const hosted = await fetchHostedExplanation(url, body, fetchFn, explainTimeoutMs(env));
      const analysis = hosted.ok && hosted.payload ? hosted.payload : explainFallback(body.analysis, symbol, args.timeframe, hosted.error ?? "sin explicación alojada");
      return ok(
        explainToolResult({
          symbol,
          timeframe: args.timeframe,
          payload: analysis,
          model: hosted.model,
          hosted: hosted.ok,
          note: hosted.ok ? null : `El endpoint alojado no respondió (${hosted.error ?? "error"}). ${EXPLAIN_FALLBACK_NOTE}`,
        }),
      );
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
      const base = futuresBase(env);
      if (!base.ok) return fail(base.error);
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
                base: base.value,
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
      const base = futuresBase(env);
      if (!base.ok) return fail(base.error);
      try {
        const client = createReadOnlyClient({
          apiKey: credentials.value.apiKey,
          apiSecret: credentials.value.apiSecret,
          fetchFn,
          now,
          base: base.value,
        });
        await client.syncTime();
        const start = dayStartMs(now(), cfg.value.tz);
        const [account, positionRisk, algoOrders, income] = await Promise.all([
          client.account(),
          client.positionRisk(),
          client.openAlgoOrders(),
          client.incomeSince(start),
        ]);
        const snapshot = evaluateAccount({
          account: { positions: parseAccountPositions(account) },
          positionRisk: parsePositionRisk(positionRisk),
          income: parseIncome(income),
          algoOrders: parseAlgo(algoOrders),
          cfg: cfg.value,
        });
        return ok({
          ...snapshot,
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
      description: `Build a proposed futures order from the public mark price: quantity, stop price, a liquidation-distance check, and violations of SWAL_MAX_LEVERAGE and SWAL_MAX_NOTIONAL_USD. stop_loss_pct is a percent (1.5 means 1.5%). The stop is always included. Order placement tools are disabled in this build. This tool never sends an order. ${PLACEMENT_NOTE}`,
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
      const base = futuresBase(env);
      if (!base.ok) return fail(base.error);
      const symbol = normalizeSymbol(args.symbol);
      if (!symbol) return fail("symbol must be 2 to 30 letters or digits.");
      try {
        const markPrice = await fetchMarkPrice(base.value, symbol, fetchFn);
        const built = proposeFromMark({
          symbol,
          side: args.side,
          notionalUsd: args.notional_usd,
          stopLossPct: args.stop_loss_pct,
          leverage: args.leverage ?? 1,
          markPrice,
          limits: limits.value,
        });
        if (!built.ok) return fail(built.error);
        return ok(built.proposal);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  return server;
}
