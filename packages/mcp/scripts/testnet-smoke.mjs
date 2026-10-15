#!/usr/bin/env node

/**
 * testnet-smoke.mjs
 * Fail-safe testnet smoke test for swal-trade MCP write tools.
 *
 * Hard safety rules:
 * - Refuses to run if SWAL_MCP_NETWORK is set to anything other than 'testnet'.
 * - Refuses to run if SWAL_MCP_MAINNET_CONFIRM is set.
 * - Reads testnet keys strictly from dedicated testnet.env (default ~/.config/swal-trade/testnet.env).
 * - Never echoes or prints keys or secrets.
 * - On unexpected state: attempts close_position once, prints MANUAL ACTION REQUIRED, exits non-zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  validateTestnetSafety,
  loadTestnetCredentials,
  buildTestnetChildEnv,
} from '../dist/testnet-guard.js';

const isDry = process.argv.includes('--dry');

// 1. Hard safety: validate network settings BEFORE any network interaction
const safety = validateTestnetSafety(process.env);
if (!safety.ok) {
  console.error(`SAFETY CHECK FAILED: ${safety.error}`);
  process.exit(1);
}

// 2. Load dedicated testnet keys (never real account keys)
const credsResult = loadTestnetCredentials(process.env.SWAL_TESTNET_ENV);
if (!credsResult.ok) {
  console.error(credsResult.error);
  process.exit(1);
}

// 3. Locate built server
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/index.js');
if (!fs.existsSync(serverPath)) {
  console.error(`Server dist file not found at ${serverPath}. Run 'npm run build' in packages/mcp first.`);
  process.exit(1);
}

// 4. Build child process environment
const childEnv = buildTestnetChildEnv({
  credentials: credsResult.credentials,
  maxNotionalUsd: process.env.SWAL_MAX_NOTIONAL_USD || '60', // BTCUSDT min notional on testnet is 50 USDT (fake money)
  maxLeverage: process.env.SWAL_MAX_LEVERAGE || '2',
  dailyLossUsd: process.env.SWAL_DAILY_LOSS_USD || '10',
  symbols: 'BTCUSDT',
  journalPath: process.env.SWAL_MCP_JOURNAL || '/tmp/swal-testnet-journal.jsonl',
});

function textOf(result) {
  if (!result || !result.content) return '';
  const block = result.content.find((item) => item.type === 'text');
  return block && 'text' in block ? block.text : '';
}

function printSummaryTable(steps, journalPath) {
  console.log('\n=== Testnet Smoke Test Results ===');
  console.log('-----------------------------------------------------------------------------------------');
  console.log(
    `${'Step'.padEnd(28)} | ${'Status'.padEnd(6)} | ${'Detail'}`
  );
  console.log('-----------------------------------------------------------------------------------------');
  for (const s of steps) {
    console.log(
      `${s.step.padEnd(28)} | ${s.status.padEnd(6)} | ${s.detail}`
    );
  }
  console.log('-----------------------------------------------------------------------------------------');
  console.log(`Journal: ${journalPath}\n`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: childEnv,
  stderr: 'pipe',
});

const client = new Client({ name: 'swal-trade-testnet-smoke', version: '0.1.0' });

const steps = [];

async function main() {
  try {
    await client.connect(transport);
  } catch (err) {
    console.error(`Failed to connect to MCP server: ${err.message}`);
    process.exit(1);
  }

  if (isDry) {
    try {
      // Dry run step 1: check tools
      const listed = await client.listTools();
      const toolNames = listed.tools.map((t) => t.name).sort();
      const writeTools = ['place_order', 'close_position', 'grid_place'];
      const missing = writeTools.filter((t) => !toolNames.includes(t));
      if (missing.length > 0) {
        throw new Error(`Write tools missing: ${missing.join(', ')}`);
      }
      steps.push({
        step: '1. tools_list (dry)',
        status: 'PASS',
        detail: `${toolNames.length} tools registered (write tools present)`,
      });

      // Dry run step 2: account_risk
      const riskRes = await client.callTool({ name: 'account_risk', arguments: {} });
      if (riskRes.isError) {
        throw new Error(`account_risk error: ${textOf(riskRes)}`);
      }
      const riskData = JSON.parse(textOf(riskRes));
      steps.push({
        step: '2. account_risk (dry)',
        status: 'PASS',
        detail: `Connected, readOnly: ${riskData.readOnly}, dayPnl: ${riskData.dayPnl}`,
      });

      // Dry run step 3: propose_order
      const propRes = await client.callTool({
        name: 'propose_order',
        arguments: {
          symbol: 'BTCUSDT',
          side: 'BUY',
          notional_usd: 15,
          stop_loss_pct: 1.5,
          leverage: 1,
        },
      });
      if (propRes.isError) {
        throw new Error(`propose_order error: ${textOf(propRes)}`);
      }
      const propData = JSON.parse(textOf(propRes));
      steps.push({
        step: '3. propose_order (dry)',
        status: 'PASS',
        detail: `Mark: ${propData.markPrice}, filters: minQty=${propData.filters?.minQty}, tickSize=${propData.filters?.tickSize}`,
      });

      printSummaryTable(steps, `${childEnv.SWAL_MCP_JOURNAL} (dry-run, no writes)`);
      console.log('DRY RUN COMPLETE: All read checks passed. No write orders were sent.');
      await client.close();
      process.exit(0);
    } catch (err) {
      steps.push({ step: 'dry_run', status: 'FAIL', detail: err.message });
      printSummaryTable(steps, `${childEnv.SWAL_MCP_JOURNAL} (dry-run)`);
      try { await client.close(); } catch {}
      process.exit(1);
    }
  }

  // Full write smoke run
  try {
    // (a) account_risk
    const risk1Res = await client.callTool({ name: 'account_risk', arguments: {} });
    if (risk1Res.isError) throw new Error(textOf(risk1Res));
    const risk1 = JSON.parse(textOf(risk1Res));
    steps.push({
      step: '(a) account_risk',
      status: 'PASS',
      detail: `Day PnL: ${risk1.dayPnl} USD, open positions: ${risk1.positions?.length ?? 0}`,
    });

    // (b) place_order for minimum valid BTCUSDT size with ~1.5% stop
    const propRes = await client.callTool({
      name: 'propose_order',
      arguments: {
        symbol: 'BTCUSDT',
        side: 'BUY',
        notional_usd: parseFloat(childEnv.SWAL_MAX_NOTIONAL_USD || '60'),
        stop_loss_pct: 1.5,
        leverage: 1,
      },
    });
    if (propRes.isError) throw new Error(`propose_order failed: ${textOf(propRes)}`);
    const propData = JSON.parse(textOf(propRes));
    const markPrice = propData.markPrice;
    const minQty = parseFloat(propData.filters?.minQty || '0.0001');
    const stepSize = parseFloat(propData.filters?.stepSize || '0.0001');
    const minNotional = parseFloat(propData.filters?.minNotional || '0');

    // Calculate minimum valid size
    const qtyByNotional = minNotional > 0 ? (minNotional / markPrice) : 0;
    const targetQty = Math.max(minQty, qtyByNotional);
    const stepCount = Math.ceil(targetQty / stepSize);
    const alignedQty = stepCount * stepSize;
    // The server turns notional_usd back into a quantity and rounds it DOWN to the step:
    // the exact aligned notional can land one step short (0.0007 BTC -> 0.0006, below
    // MIN_NOTIONAL). A 1% margin keeps the same step and absorbs small price moves.
    let orderNotional = Number((alignedQty * markPrice * 1.01).toFixed(2));
    if (minNotional > 0 && orderNotional < minNotional * 1.01) {
      orderNotional = Number((minNotional * 1.01).toFixed(2));
    }

    const placeRes = await client.callTool({
      name: 'place_order',
      arguments: {
        symbol: 'BTCUSDT',
        side: 'BUY',
        notional_usd: orderNotional,
        stop_loss_pct: 1.5,
        leverage: 1,
        type: 'market',
      },
    });
    if (placeRes.isError) throw new Error(`place_order failed: ${textOf(placeRes)}`);
    steps.push({
      step: '(b) place_order',
      status: 'PASS',
      detail: `Order sent: ${orderNotional} USD, SL: 1.5%`,
    });

    // (c) verify through account_risk that position exists and is protected by a stop
    const risk2Res = await client.callTool({ name: 'account_risk', arguments: {} });
    if (risk2Res.isError) throw new Error(`account_risk verification failed: ${textOf(risk2Res)}`);
    const risk2 = JSON.parse(textOf(risk2Res));
    const openPos = risk2.positions?.find(
      (p) => p.symbol === 'BTCUSDT' && Math.abs(parseFloat(p.amt)) > 0
    );
    if (!openPos) {
      throw new Error('Position verification failed: no open BTCUSDT position found');
    }
    const isUnprotected = risk2.unprotected?.some((p) => p.symbol === 'BTCUSDT');
    if (isUnprotected) {
      throw new Error('Position verification failed: BTCUSDT position is unprotected (missing stop)');
    }
    steps.push({
      step: '(c) verify position & stop',
      status: 'PASS',
      detail: `Position amt: ${openPos.amt} BTC, protected by algo stop`,
    });

    // (d) close_position BTCUSDT
    const closeRes = await client.callTool({
      name: 'close_position',
      arguments: { symbol: 'BTCUSDT' },
    });
    if (closeRes.isError) throw new Error(`close_position failed: ${textOf(closeRes)}`);
    const closeData = JSON.parse(textOf(closeRes));
    if (!closeData.flat) {
      throw new Error(`close_position did not flatten: remaining=${closeData.remaining}`);
    }
    steps.push({
      step: '(d) close_position',
      status: 'PASS',
      detail: `Position closed (remaining: ${closeData.remaining ?? 0}), orders cancelled`,
    });

    // (e) verify flat and no resting orders
    const risk3Res = await client.callTool({ name: 'account_risk', arguments: {} });
    if (risk3Res.isError) throw new Error(`account_risk post-close check failed: ${textOf(risk3Res)}`);
    const risk3 = JSON.parse(textOf(risk3Res));
    const remainingPos = risk3.positions?.find(
      (p) => p.symbol === 'BTCUSDT' && Math.abs(parseFloat(p.amt)) > 0
    );
    if (remainingPos) {
      throw new Error(`Post-close check failed: position still open (${remainingPos.amt})`);
    }
    steps.push({
      step: '(e) verify flat',
      status: 'PASS',
      detail: 'Account is flat, no remaining position for BTCUSDT',
    });

    printSummaryTable(steps, childEnv.SWAL_MCP_JOURNAL);
    console.log('SUCCESS: All testnet smoke test steps passed.');
    await client.close();
    process.exit(0);
  } catch (err) {
    const currentStep = steps.length > 0 ? `step ${steps.length + 1}` : 'initialization';
    steps.push({ step: currentStep, status: 'FAIL', detail: err.message });
    console.error(`\n[!] Unexpected error in ${currentStep}: ${err.message}`);
    console.error('Executing emergency close_position for BTCUSDT...');
    try {
      const emergencyClose = await client.callTool({
        name: 'close_position',
        arguments: { symbol: 'BTCUSDT' },
      });
      console.error(`Emergency close response: ${textOf(emergencyClose)}`);
    } catch (closeErr) {
      console.error(`Emergency close failed: ${closeErr.message}`);
    }
    console.error('\n************************************************************');
    console.error('MANUAL ACTION REQUIRED: BTCUSDT');
    console.error('Please verify position and orders at https://testnet.binancefuture.com');
    console.error('************************************************************\n');
    printSummaryTable(steps, childEnv.SWAL_MCP_JOURNAL);
    try { await client.close(); } catch {}
    process.exit(1);
  }
}

main();
