import { randomBytes } from 'node:crypto';

export const PLANS = {
  plans: [
    { id: 'pro_month', price_display: '10', days: 30 },
    { id: 'pro_quarter', price_display: '27', days: 90 },
    { id: 'pro_year', price_display: '96', days: 365 },
  ],
  methods: [
    { network: 'bsc', token: 'USDT', decimals: 18 },
    { network: 'bsc', token: 'USDC', decimals: 18 },
    { network: 'tron', token: 'USDT', decimals: 6 },
  ],
};

export function accountSecret() {
  return randomBytes(32).toString('base64url');
}

export function invoiceBody(plan = 'pro_month') {
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return {
    invoice_id: 'inv_e2e',
    account_id: 'acc_e2e',
    pay_address: '0x1111111111111111111111111111111111111111',
    amount_display: '10.0037',
    amount_units: '10003700000000000000',
    token: 'USDT',
    network: 'bsc',
    plan,
    days: 30,
    expires_at: expires,
  };
}

export function licenseBody(token = 'e2e-header.e2e-sig') {
  const valid = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  return {
    token,
    plan: 'pro_month',
    account_id: 'acc_e2e',
    expires_at: valid,
    valid_until: valid,
    grace_days: 3,
  };
}
