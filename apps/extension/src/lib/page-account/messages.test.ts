import { describe, expect, it } from 'vitest';
import {
  PAGE_ACCOUNT_DIAGNOSE_RESULT,
  PAGE_ACCOUNT_GET,
  PAGE_ACCOUNT_UPDATE,
  PAGE_DIAGNOSE_MAX_CHARS,
  PAGE_HISTORY_MAX,
  PAGE_POSITIONS_MAX,
  parseClosedPosition,
  parsePageAccountDiagnoseResult,
  parsePageAccountMessage,
  parsePageAccountResult,
  parsePageAccountUpdate,
  parsePagePosition,
  parseStoredPagePositions,
} from './messages';
import type { ClosedPosition } from './parse-history';
import type { PagePosition } from './parse-positions';

const position = (over: Partial<PagePosition> = {}): PagePosition => ({
  symbol: 'BTCUSDC',
  contract: 'perp',
  leverage: 30,
  marginMode: 'cross',
  side: 'short',
  sizeQuote: { value: -0.004, asset: 'BTC' },
  sizeBase: -0.004,
  uPnl: 2.1,
  roiPct: 19,
  entry: 82644.1,
  breakEven: 82300,
  mark: 82100,
  liq: 95000,
  ...over,
});

const row = (over: Partial<ClosedPosition> = {}): ClosedPosition => ({
  symbol: 'BTCUSDC',
  leverage: 30,
  marginMode: 'cross',
  side: 'short',
  status: 'closed',
  openedAtMs: 1_700_000_000_000,
  closedAtMs: 1_700_010_000_000,
  durationMs: 10_000_000,
  realizedPnl: 1.01,
  pnlAsset: 'USDC',
  roiPct: 9.25,
  closeVolume: 0.004,
  closeVolumeAsset: 'BTC',
  entry: 82644.1,
  avgClose: 82330,
  maxOpenInterest: 0.004,
  key: 'BTCUSDC|1700000000000|1700010000000',
  ...over,
});

describe('parsePagePosition', () => {
  it('acepta una fila completa', () => {
    expect(parsePagePosition(position())).toEqual(position());
  });

  it('convierte la basura en null y no lanza', () => {
    expect(parsePagePosition(null)).toBeNull();
    expect(parsePagePosition('x')).toBeNull();
    expect(parsePagePosition({})).toBeNull();
    expect(parsePagePosition({ symbol: 'btc' })).toBeNull();
    expect(parsePagePosition({ symbol: 'BTCUSDC', leverage: 500 })).not.toBeNull();
    expect(parsePagePosition({ symbol: 'BTCUSDC', leverage: 500 })?.leverage).toBeNull();
    expect(parsePagePosition({ symbol: 'BTCUSDC', entry: Number.NaN })?.entry).toBeNull();
    expect(parsePagePosition({ symbol: 'BTCUSDC', sizeQuote: { value: 1, asset: 'x' } })?.sizeQuote).toBeNull();
  });

  it('rechaza lados, modos y contratos inventados', () => {
    const p = parsePagePosition(position({ side: 'both' as never, marginMode: 'weird' as never, contract: 'spot' as never }));
    expect(p?.side).toBeNull();
    expect(p?.marginMode).toBeNull();
    expect(p?.contract).toBeNull();
  });
});

describe('parseClosedPosition', () => {
  it('acepta una fila completa', () => {
    expect(parseClosedPosition(row())).toEqual(row());
  });

  it('exige símbolo y clave estable', () => {
    expect(parseClosedPosition({ ...row(), key: '' })).toBeNull();
    expect(parseClosedPosition({ ...row(), key: '<script>' })).toBeNull();
    expect(parseClosedPosition({ ...row(), symbol: 'btc/usdc' })).toBeNull();
  });

  it('los números no finitos se vuelven null', () => {
    const parsed = parseClosedPosition({ ...row(), realizedPnl: Infinity, roiPct: Number.NaN });
    expect(parsed?.realizedPnl).toBeNull();
    expect(parsed?.roiPct).toBeNull();
  });
});

describe('parsePageAccountUpdate', () => {
  const update = (over: Record<string, unknown> = {}) => ({
    type: PAGE_ACCOUNT_UPDATE,
    positions: [position()],
    history: [row()],
    tzOffsetMinutes: -300,
    capturedAt: Date.now(),
    ...over,
  });

  it('acepta un aviso correcto', () => {
    const parsed = parsePageAccountUpdate(update());
    expect(parsed?.positions).toHaveLength(1);
    expect(parsed?.history).toHaveLength(1);
    expect(parsed?.tzOffsetMinutes).toBe(-300);
  });

  it('rechaza sobres raros', () => {
    expect(parsePageAccountUpdate(null)).toBeNull();
    expect(parsePageAccountUpdate({})).toBeNull();
    expect(parsePageAccountUpdate(update({ type: 'otra-cosa' }))).toBeNull();
    expect(parsePageAccountUpdate(update({ positions: 'nada' }))).toBeNull();
    expect(parsePageAccountUpdate(update({ capturedAt: Number.NaN }))).toBeNull();
    expect(parsePageAccountUpdate(update({ capturedAt: 0 }))).toBeNull();
    expect(parsePageAccountUpdate(update({ tzOffsetMinutes: 900 }))).toBeNull();
    expect(parsePageAccountUpdate(update({ tzOffsetMinutes: 1.5 }))).toBeNull();
    // Un sello del futuro no se cree.
    expect(parsePageAccountUpdate(update({ capturedAt: Date.now() + 10 * 60_000 }))).toBeNull();
  });

  it('capa posiciones e historial y descarta filas inválidas', () => {
    const manyPositions = Array.from({ length: 200 }, (_v, i) =>
      position({ symbol: `SYM${i}USDC`, sizeBase: i }),
    );
    const manyHistory = Array.from({ length: 800 }, (_v, i) =>
      row({ key: `BTCUSDC|${i}|${i + 1}`, openedAtMs: i, closedAtMs: i + 1 }),
    );
    const parsed = parsePageAccountUpdate(
      update({ positions: [...manyPositions, { symbol: '' }], history: [...manyHistory, null] }),
    );
    expect(parsed?.positions).toHaveLength(PAGE_POSITIONS_MAX);
    expect(parsed?.history).toHaveLength(PAGE_HISTORY_MAX);
  });

  it('deduplica por símbolo/lado/tamaño y por clave', () => {
    const parsed = parsePageAccountUpdate(
      update({ positions: [position(), position()], history: [row(), row()] }),
    );
    expect(parsed?.positions).toHaveLength(1);
    expect(parsed?.history).toHaveLength(1);
  });

  it('sin offset asume 0', () => {
    const { tzOffsetMinutes: _ignored, ...raw } = update();
    expect(parsePageAccountUpdate(raw)?.tzOffsetMinutes).toBe(0);
  });
});

describe('parseStoredPagePositions', () => {
  it('lee lo que dejó el background', () => {
    const stored = parseStoredPagePositions({
      positions: [position()],
      capturedAt: 1_700_000_000_000,
      tzOffsetMinutes: -300,
    });
    expect(stored?.positions).toHaveLength(1);
    expect(stored?.capturedAt).toBe(1_700_000_000_000);
  });

  it('ante basura devuelve null', () => {
    expect(parseStoredPagePositions(null)).toBeNull();
    expect(parseStoredPagePositions({ positions: [] })).toBeNull();
    expect(parseStoredPagePositions({ positions: [], capturedAt: 0 })).toBeNull();
  });
});

describe('parsePageAccountResult', () => {
  it('valida filas y recalcula las métricas', () => {
    const parsed = parsePageAccountResult({
      type: 'page-account:result',
      positions: [position()],
      capturedAt: 1_700_000_000_000,
      history: [row(), row({ key: 'a|1|2', realizedPnl: -3 })],
    });
    expect(parsed?.history).toHaveLength(2);
    expect(parsed?.metrics.n).toBe(2);
    expect(parsed?.metrics.wins).toBe(1);
    expect(parsed?.metrics.losses).toBe(1);
  });

  it('rechaza respuestas incompletas', () => {
    expect(parsePageAccountResult(null)).toBeNull();
    expect(parsePageAccountResult({ type: 'page-account:result' })).toBeNull();
  });
});

describe('parsePageAccountMessage', () => {
  it('clasifica los mensajes del panel y del content script', () => {
    expect(parsePageAccountMessage({ type: PAGE_ACCOUNT_GET })).toEqual({ type: PAGE_ACCOUNT_GET });
    expect(parsePageAccountMessage({ type: 'page-account:clear' })).toEqual({ type: 'page-account:clear' });
    expect(parsePageAccountMessage({ type: 'page-account:diagnose' })).toEqual({
      type: 'page-account:diagnose',
    });
    const update = parsePageAccountMessage({
      type: PAGE_ACCOUNT_UPDATE,
      positions: [],
      history: [],
      tzOffsetMinutes: 0,
      capturedAt: Date.now(),
    });
    expect(update?.type).toBe(PAGE_ACCOUNT_UPDATE);
  });

  it('un aviso inválido no se convierte en mensaje', () => {
    expect(parsePageAccountMessage({ type: PAGE_ACCOUNT_UPDATE, positions: [] })).toBeNull();
    expect(parsePageAccountMessage({ type: 'otra-cosa' })).toBeNull();
    expect(parsePageAccountMessage('nada')).toBeNull();
  });
});

describe('parsePageAccountDiagnoseResult', () => {
  it('devuelve el esquema y lo acota', () => {
    expect(
      parsePageAccountDiagnoseResult({ type: PAGE_ACCOUNT_DIAGNOSE_RESULT, outline: 'div "hola"' }),
    ).toBe('div "hola"');
    expect(
      parsePageAccountDiagnoseResult({
        type: PAGE_ACCOUNT_DIAGNOSE_RESULT,
        outline: 'x'.repeat(PAGE_DIAGNOSE_MAX_CHARS + 10),
      }),
    ).toHaveLength(PAGE_DIAGNOSE_MAX_CHARS);
  });

  it('rechaza lo que no es un diagnóstico', () => {
    expect(parsePageAccountDiagnoseResult({ type: PAGE_ACCOUNT_DIAGNOSE_RESULT })).toBeNull();
    expect(parsePageAccountDiagnoseResult({ outline: 'x' })).toBeNull();
  });
});
