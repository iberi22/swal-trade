import { describe, expect, it } from 'vitest';
import { MIXED_CURRENCY_REASON, type PageBalance } from './page-account/parse-balance';
import {
  CAPITAL_SOURCE_STORAGE_KEY,
  DEFAULT_CAPITAL_SOURCE,
  formatCapitalHeadline,
  normalizeCapitalSource,
  pageCapitalAvailable,
  resolveCapital,
  resolveCapitalOnLoad,
  type CapitalInput,
} from './sizing-capital';
import {
  displayRiskPct,
  exactSizingFromLoad,
  parseSizingLoad,
  type SizingLoad,
} from './trade-cards/sizing-bridge';

const balance = (over: Partial<PageBalance> = {}): PageBalance => ({
  asset: 'USDC',
  marginBalance: 71.9636,
  walletBalance: 72.4075,
  available: 70.83,
  unrealizedPnl: -0.4439,
  maintenanceMargin: 0.9782,
  marginMode: 'cross',
  unusableReason: null,
  ...over,
});

const NOW = 1_700_000_060_000;
const CAPTURED = 1_700_000_000_000;

const input = (over: Partial<CapitalInput> = {}): CapitalInput => ({
  source: 'manual',
  manualCapital: 1000,
  symbol: 'BTCUSDC',
  balance: balance(),
  capturedAtMs: CAPTURED,
  nowMs: NOW,
  readPageAccount: true,
  ...over,
});

describe('normalizeCapitalSource', () => {
  it('defaults to manual', () => {
    expect(DEFAULT_CAPITAL_SOURCE).toBe('manual');
    expect(normalizeCapitalSource(undefined)).toBe('manual');
    expect(normalizeCapitalSource('manual')).toBe('manual');
    expect(normalizeCapitalSource('page')).toBe('page');
    expect(normalizeCapitalSource('otra-cosa')).toBe('manual');
  });

  it('has its own storage key, apart from the numeric preferences', () => {
    expect(CAPITAL_SOURCE_STORAGE_KEY).toBe('sizing_capital_source');
  });
});

describe('pageCapitalAvailable', () => {
  it('needs the opt-in and a balance for the pair quote', () => {
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance(), symbol: 'BTCUSDC' })).toBe(true);
    expect(pageCapitalAvailable({ readPageAccount: false, balance: balance(), symbol: 'BTCUSDC' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance(), symbol: 'BTCUSDT' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: null, symbol: 'BTCUSDC' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance({ marginBalance: null }), symbol: 'BTCUSDC' })).toBe(false);
  });
});

describe('resolveCapital', () => {
  it('manual by default, in USDT', () => {
    expect(resolveCapital(input())).toEqual({
      source: 'manual',
      capital: 1000,
      asset: 'USDT',
      assetMismatch: false,
      stale: false,
      pageLine: null,
      fallbackNote: null,
    });
  });

  it('uses the page margin balance with the pair asset', () => {
    const resolved = resolveCapital(input({ source: 'page' }));
    expect(resolved).toMatchObject({ source: 'page', capital: 71.9636, asset: 'USDC', stale: false });
    expect(resolved.pageLine).toBe('saldo de la página: 71,96 USDC (hace 60 s)');
    expect(resolved.fallbackNote).toBeNull();
  });

  it('matches the quote of a USDT pair', () => {
    const usdt = balance({ asset: 'USDT', marginBalance: 250.5 });
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT', balance: usdt }));
    expect(resolved).toMatchObject({ source: 'page', capital: 250.5, asset: 'USDT' });
  });

  it('falls back to the manual value on an asset mismatch and says why', () => {
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT' }));
    expect(resolved).toMatchObject({ source: 'manual', capital: 1000, asset: 'USDT', assetMismatch: true });
    expect(resolved.fallbackNote).toContain('USDC');
    expect(resolved.fallbackNote).toContain('USDT');
    expect(resolved.pageLine).toBeNull();
  });

  it('al cambiar a un par con otra moneda deja la nota de respaldo (la fuente elegida no se toca)', () => {
    // Hallazgo P2: BTCUSDC con saldo en USDC -> BTCUSDT. El panel NO debe pasar
    // la fuente a 'manual' por su cuenta: sigue pidiendo la página y el
    // resolutor usa el manual CON la nota visible. Si el panel cambiara la
    // fuente, `fallbackNote` seria null y el aviso desaparecia.
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT' }));
    expect(resolved.source).toBe('manual');
    expect(resolved.capital).toBe(1000);
    expect(resolved.assetMismatch).toBe(true);
    expect(resolved.fallbackNote).toBe(
      'el saldo de la página está en USDC y el par se cotiza en USDT: se usa el capital manual',
    );
  });

  it('no ofrece un recuadro con monedas mezcladas y explica el motivo', () => {
    // Hallazgo P1: el parser deja `asset: null` cuando el encabezado y los
    // sufijos no coinciden. Ese recuadro no puede ser capital de ningun par.
    const mixed = balance({ asset: null, unusableReason: MIXED_CURRENCY_REASON });
    expect(pageCapitalAvailable({ readPageAccount: true, balance: mixed, symbol: 'BTCUSDC' })).toBe(false);
    const resolved = resolveCapital(input({ source: 'page', balance: mixed }));
    expect(resolved).toMatchObject({ source: 'manual', capital: 1000, assetMismatch: false });
    expect(resolved.fallbackNote).toBe('monedas distintas en el recuadro: se usa el capital manual');
  });

  it('falls back when there is no page balance yet', () => {
    const resolved = resolveCapital(input({ source: 'page', balance: null }));
    expect(resolved.source).toBe('manual');
    expect(resolved.capital).toBe(1000);
    expect(resolved.fallbackNote).toContain('todavía no muestra el saldo');
  });

  it('falls back when reading the page is off', () => {
    const resolved = resolveCapital(input({ source: 'page', readPageAccount: false }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('apagada');
  });

  it('falls back when the page has no margin balance', () => {
    const resolved = resolveCapital(input({ source: 'page', balance: balance({ marginBalance: null }) }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('saldo de margen');
  });

  it('falls back when the pair has no known quote', () => {
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTC' }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('activo de cotización');
  });

  it('marks the page balance stale after 60 s', () => {
    const fresh = resolveCapital(input({ source: 'page', nowMs: CAPTURED + 59_000 }));
    expect(fresh.stale).toBe(false);
    const stale = resolveCapital(input({ source: 'page', nowMs: CAPTURED + 61_000 }));
    expect(stale.stale).toBe(true);
    expect(stale.pageLine).toContain('dato viejo');
    expect(stale.source).toBe('page');
    expect(stale.capital).toBe(71.9636);
  });
});

describe('resolveCapitalOnLoad', () => {
  /** Ticket de 100 con cantidad 0,1 y pérdida 1,0095 (el caso del hallazgo). */
  const ticketLoad = (): SizingLoad => {
    const load = parseSizingLoad({
      direction: 'long',
      entry: 100,
      stop: 99.9,
      riskPct: 1.0095,
      riskUsd: 1.0095,
      quantity: 0.1,
      capital: 100,
      note: 'desde tarjeta: pérdida con comisiones incluidas',
      entryFeeRate: 0.0005,
      exitFeeRate: 0.0005,
    });
    if (!load) throw new Error('payload inválido');
    return load;
  };

  it('con «saldo de la página» pasa a manual con el capital del ticket y avisa', () => {
    // Hallazgo P1: con la página en 1.000 y una carga de 100, la fuente seguía
    // en 'page', `exactSizingFromLoad` devolvía null y se veían 1 y 10,09 en
    // vez de la cantidad y la pérdida exactas del ticket (0,1 y 1,0095).
    const load = ticketLoad();
    const decision = resolveCapitalOnLoad('page', load);
    expect(decision).toEqual({
      source: 'manual',
      capital: 100,
      note: 'Cargado desde la tarjeta/tu dibujo con su capital (100,00). Vuelve a «saldo de la página» para recalcular con tu saldo.',
    });
    expect(decision.note).toContain('«saldo de la página»');
  });

  it('con el capital de la carga la cifra exacta del ticket se mantiene', () => {
    const load = ticketLoad();
    const decision = resolveCapitalOnLoad('page', load);
    const state = {
      entryStr: String(load.entry),
      stopStr: String(load.stop),
      direction: load.direction,
      capital: decision.capital,
      riskPct: displayRiskPct(load),
    };
    expect(exactSizingFromLoad(load, state)).toEqual({ quantity: 0.1, lossUsd: 1.0095 });
    // Con el saldo de la página (1.000) la carga exacta se descartaba: ese era el fallo.
    expect(exactSizingFromLoad(load, { ...state, capital: 1000 })).toBeNull();
  });

  it('si la fuente ya era manual no hay nota que dar', () => {
    const load = ticketLoad();
    expect(resolveCapitalOnLoad('manual', load)).toEqual({ source: 'manual', capital: 100, note: null });
  });
});

describe('formatCapitalHeadline', () => {
  it('manual sin respaldo: solo el capital en USDT', () => {
    expect(formatCapitalHeadline(resolveCapital(input()))).toBe('capital 1.000,00 USDT');
  });

  it('página fresca: añade la misma línea que el dimensionador', () => {
    expect(formatCapitalHeadline(resolveCapital(input({ source: 'page' })))).toBe(
      'capital 71,96 USDC · saldo de la página: 71,96 USDC (hace 60 s)',
    );
  });

  it('página vieja: el encabezado lleva la marca de dato viejo (hallazgo P2)', () => {
    const stale = resolveCapital(input({ source: 'page', nowMs: CAPTURED + 61_000 }));
    expect(stale.stale).toBe(true);
    const line = formatCapitalHeadline(stale);
    expect(line).toContain('saldo de la página');
    expect(line).toContain('hace 61 s');
    expect(line).toContain('dato viejo');
  });

  it('respaldo: enseña el motivo y no un «manual» mudo', () => {
    const fallback = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT' }));
    expect(formatCapitalHeadline(fallback)).toBe(
      'capital 1.000,00 USDT · el saldo de la página está en USDC y el par se cotiza en USDT: se usa el capital manual',
    );
  });
});
