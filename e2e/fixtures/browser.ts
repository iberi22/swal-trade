import type { Page, Route } from '@playwright/test';
import { accountSecret, invoiceBody, licenseBody, PLANS } from './billing.mjs';
import {
  accountPayload,
  algoPayload,
  apiRestrictionsPayload,
  incomePayload,
  positionRiskPayload,
} from './binance-account.mjs';
import { toBinanceKlines } from './candles.mjs';

export const FNG = {
  data: [{ value: '12', value_classification: 'Extreme Fear', timestamp: '1700000000' }],
};

export const SNAPSHOT = {
  schema: 'synapse.public.snapshot/v1',
  generated_at: '2026-10-09T12:00:00.000Z',
  mode: 'paper',
  engine: {
    status: 'ok',
    feed_ok: true,
    last_price_update_at: '2026-10-09T12:00:00.000Z',
    uptime_s: 10,
    strategies_registered: 0,
  },
  account: {
    initial_capital: 1000,
    equity_pct: 0,
    daily_pnl_pct: 0,
    max_drawdown_pct: 0,
    open_positions: 0,
    total_trades: 0,
    win_rate: null,
  },
  points_formula: '1 punto = 1 pb de rendimiento neto',
  bots: [],
  open_positions: [],
  recent_trades: [],
  equity_curve: [],
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'content-type': 'application/json',
};

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  await route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
}

export interface Problems {
  consoleErrors: string[];
  pageErrors: string[];
  csp: () => Promise<string[]>;
}

export function collectProblems(page: Page): Problems {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  return {
    consoleErrors,
    pageErrors,
    csp: () => page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []),
  };
}

export async function installCspProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations?: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

/** Mocks genéricos para que ninguna página hable con Binance, alternative.me ni el cobrador real. */
export async function installSiteMocks(page: Page) {
  await page.routeWebSocket(/fstream\.binance\.com/, () => {
    // Conexión abierta y muda: la página pasa a "en vivo" y no reintenta contra la red.
  });

  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => fulfillJson(route, toBinanceKlines()));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/depth/, (route) =>
    fulfillJson(route, {
      lastUpdateId: 1,
      bids: [
        ['68000.00', '5.0'],
        ['67900.00', '10.0'],
        ['67500.00', '80.0'],
      ],
      asks: [
        ['68100.00', '5.0'],
        ['68200.00', '10.0'],
        ['68600.00', '80.0'],
      ],
    }),
  );
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/time/, (route) => fulfillJson(route, { serverTime: Date.now() }));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v3\/account/, (route) => fulfillJson(route, accountPayload()));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v2\/positionRisk/, (route) => fulfillJson(route, positionRiskPayload()));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/income/, (route) => fulfillJson(route, incomePayload()));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/openAlgoOrders/, (route) => fulfillJson(route, algoPayload()));
  await page.route(/https:\/\/api\.binance\.com\/sapi\/v1\/account\/apiRestrictions/, (route) =>
    fulfillJson(route, apiRestrictionsPayload()),
  );
  await page.route(/https:\/\/api\.alternative\.me\//, (route) => fulfillJson(route, FNG));
  // La ruta registrada al final gana. El comodín va primero para no tapar /v1/plans.
  await page.route(/https:\/\/pay\.swal\.network\/.*/, (route) =>
    fulfillJson(route, { error: 'not_mocked', message: 'ruta de pago no prevista en el mock generico' }, 404),
  );
  await page.route(/https:\/\/pay\.swal\.network\/v1\/plans/, (route) => fulfillJson(route, PLANS));
  await page.route('**/public/v1/snapshot', (route) => fulfillJson(route, SNAPSHOT));
}

export interface CheckoutMock {
  secret: string;
  invoiceGets: () => number;
}

/** Flujo completo de pay.swal.network. El primer GET de la factura está pending; el segundo, paid. */
export async function installCheckoutMock(page: Page): Promise<CheckoutMock> {
  const secret = accountSecret();
  const invoice = invoiceBody();
  const license = licenseBody();
  let gets = 0;

  await page.route(/https:\/\/pay\.swal\.network\/.*/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/\/+$/, '');
    const method = route.request().method();
    if (method === 'OPTIONS') {
      await fulfillJson(route, {});
      return;
    }
    if (path === '/v1/plans' && method === 'GET') {
      await fulfillJson(route, PLANS);
      return;
    }
    if (path === '/v1/accounts' && method === 'POST') {
      await fulfillJson(route, { account_id: 'acc_e2e', account_secret: secret }, 201);
      return;
    }
    if (path === '/v1/invoices' && method === 'POST') {
      const auth = route.request().headers().authorization ?? '';
      if (auth !== `Bearer ${secret}`) {
        await fulfillJson(route, { error: 'unauthorized', message: 'credencial invalida' }, 401);
        return;
      }
      await fulfillJson(route, invoice, 201);
      return;
    }
    if (path === `/v1/invoices/${invoice.invoice_id}` && method === 'GET') {
      gets += 1;
      const status = gets >= 2 ? 'paid' : 'pending';
      await fulfillJson(route, {
        ...invoice,
        status,
        created_at: new Date().toISOString(),
        tx_hash: status === 'paid' ? '0xabc' : null,
        payer_address: null,
        paid_at: status === 'paid' ? new Date().toISOString() : null,
      });
      return;
    }
    if (path === '/v1/license' && method === 'GET') {
      await fulfillJson(route, license);
      return;
    }
    if (path === '/v1/pubkey' && method === 'GET') {
      await fulfillJson(route, { algorithm: 'Ed25519', spki_base64: 'unused', issuer: 'swal-trade-billing' });
      return;
    }
    await fulfillJson(route, { error: 'not_found', message: path }, 404);
  });

  return { secret, invoiceGets: () => gets };
}
