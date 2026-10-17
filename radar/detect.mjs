#!/usr/bin/env node
// radar/detect.mjs — Thin Node CLI helper calling the deterministic analysis core.
// Reads JSON on stdin ({symbol, timeframe, candles}), prints findings JSON on stdout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_CORE_PATH = path.resolve(
  repoRoot,
  'workers/public-site/static/analisis/analysis-core.js'
);
const corePath = process.env.RADAR_CORE_PATH || DEFAULT_CORE_PATH;

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c) continue;
    if (Array.isArray(c)) {
      let t = Number(c[0]);
      if (t > 1e11) t = Math.floor(t / 1000);
      out.push({
        time: t,
        open: +c[1],
        high: +c[2],
        low: +c[3],
        close: +c[4],
        volume: +c[5],
        trades: c[8] != null ? +c[8] : undefined,
        takerBuyVolume: c[9] != null ? +c[9] : undefined,
      });
    } else if (typeof c === 'object') {
      let t = Number(c.time ?? c.t ?? 0);
      if (t > 1e11) t = Math.floor(t / 1000);
      out.push({
        time: t,
        open: +c.open,
        high: +c.high,
        low: +c.low,
        close: +c.close,
        volume: +(c.volume ?? c.v ?? 0),
        trades: c.trades != null ? +c.trades : undefined,
        takerBuyVolume: c.takerBuyVolume != null ? +c.takerBuyVolume : undefined,
      });
    }
  }
  return out;
}

async function main() {
  const input = fs.readFileSync(0, 'utf8');
  if (!input.trim()) {
    console.log(JSON.stringify([]));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    console.error('Invalid JSON input:', err.message);
    process.exit(1);
  }

  const rawCandles = Array.isArray(payload) ? payload : (payload.candles || []);
  const symbol = payload.symbol || process.env.RADAR_SYMBOL || 'BTCUSDC';
  const timeframe = payload.timeframe || process.env.RADAR_TIMEFRAME || '15m';

  const candles = normalizeCandles(rawCandles);
  const coreUrl = corePath.startsWith('/') ? pathToFileURL(corePath).href : corePath;
  const core = await import(coreUrl);

  const res = core.analyzeSync({ symbol, timeframe, candles });
  const findings = res?.findings || [];
  console.log(JSON.stringify(findings));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
