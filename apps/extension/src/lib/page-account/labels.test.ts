import { describe, expect, it } from 'vitest';
import {
  HISTORY_VALUE_KEYS,
  isLabel,
  matchLabel,
  matchLabelPrefix,
  normalizeLabel,
  trailingAsset,
} from './labels';

describe('normalizeLabel', () => {
  it('lowercases, strips accents and collapses spaces', () => {
    expect(normalizeLabel('  Símbolo  ')).toBe('simbolo');
    expect(normalizeLabel('Duración')).toBe('duracion');
    expect(normalizeLabel('Interés   abierto máx.')).toBe('interes abierto max');
    expect(normalizeLabel('PnL (%ROI)')).toBe('pnl (%roi)');
  });

  it('never throws on non-strings', () => {
    expect(normalizeLabel(null)).toBe('');
    expect(normalizeLabel(undefined)).toBe('');
    expect(normalizeLabel(3)).toBe('');
  });
});

describe('matchLabel', () => {
  it('matches Spanish headers and labels', () => {
    expect(matchLabel('Símbolo')?.key).toBe('symbol');
    expect(matchLabel('Tamaño')?.key).toBe('size');
    expect(matchLabel('PnL (%ROI)')?.key).toBe('pnl');
    expect(matchLabel('Cerrar todo MKT')?.key).toBe('closeAllMkt');
    expect(matchLabel('Cerrar todo basado en PnL')?.key).toBe('closeAllPnl');
    expect(matchLabel('Precio de entrada')?.key).toBe('entry');
    expect(matchLabel('Precio de equilibrio')?.key).toBe('breakEven');
    expect(matchLabel('Precio de marca')?.key).toBe('mark');
    expect(matchLabel('Precio de Liq.')?.key).toBe('liq');
    expect(matchLabel('Cruzado')?.key).toBe('cross');
    expect(matchLabel('Aislado')?.key).toBe('isolated');
    expect(matchLabel('Cerrado')?.key).toBe('closed');
  });

  it('matches English headers and labels', () => {
    expect(matchLabel('Symbol')?.key).toBe('symbol');
    expect(matchLabel('PNL (ROI %)')?.key).toBe('pnl');
    expect(matchLabel('Entry Price')?.key).toBe('entry');
    expect(matchLabel('Break Even Price')?.key).toBe('breakEven');
    expect(matchLabel('Mark Price')?.key).toBe('mark');
    expect(matchLabel('Liq. Price')?.key).toBe('liq');
    expect(matchLabel('Realized PNL')?.key).toBe('realizedPnl');
    expect(matchLabel('Closing Vol.')?.key).toBe('closeVolume');
    expect(matchLabel('Avg. Close Price')?.key).toBe('avgClose');
    expect(matchLabel('Max Open Interest')?.key).toBe('maxOpenInterest');
    expect(matchLabel('Opened')?.key).toBe('opened');
    expect(matchLabel('Closed')?.key).toBe('closed');
    expect(matchLabel('Duration')?.key).toBe('duration');
    expect(matchLabel('Isolated')?.key).toBe('isolated');
  });

  it('captures the asset inside parentheses and ignores it for matching', () => {
    expect(matchLabel('PnL realizado (USDC)')).toEqual({
      key: 'realizedPnl',
      asset: 'USDC',
      normalized: 'pnl realizado (usdc)',
    });
    expect(matchLabel('Realized PNL (USDC)')).toMatchObject({ key: 'realizedPnl', asset: 'USDC' });
    expect(matchLabel('Vol. de cierre (BTC)')).toMatchObject({ key: 'closeVolume', asset: 'BTC' });
    expect(matchLabel('Vol. de cierre (1000PEPE)')).toMatchObject({
      key: 'closeVolume',
      asset: '1000PEPE',
    });
    expect(matchLabel('Interés abierto máx. (BTC)')).toMatchObject({
      key: 'maxOpenInterest',
      asset: 'BTC',
    });
    expect(matchLabel('Max Open Interest (ETH)')).toMatchObject({
      key: 'maxOpenInterest',
      asset: 'ETH',
    });
  });

  it('does not mistake "(ROI)" for an asset', () => {
    expect(trailingAsset('PnL (%ROI)')).toBeNull();
    expect(trailingAsset('PnL (ROI %)')).toBeNull();
    expect(matchLabel('PnL (%ROI)')?.asset).toBeNull();
  });

  it('returns null for unknown text', () => {
    expect(matchLabel('nonsense')).toBeNull();
    expect(matchLabel('')).toBeNull();
    expect(matchLabel(null)).toBeNull();
    expect(matchLabel(42)).toBeNull();
  });

  it('isLabel exposes the common case', () => {
    expect(isLabel('Cerrar todo MKT', 'closeAllMkt')).toBe(true);
    expect(isLabel('Cerrar todo MKT', 'entry')).toBe(false);
  });
});

describe('matchLabelPrefix', () => {
  it('accepts a value glued to the label', () => {
    expect(matchLabelPrefix('ROI+9.25%')?.key).toBe('roi');
    expect(matchLabelPrefix('PnL realizado (USDC)+1.01 USDC')).toMatchObject({
      key: 'realizedPnl',
      asset: 'USDC',
    });
    expect(matchLabelPrefix('Closing Vol. (BTC)0.004')?.key).toBe('closeVolume');
  });

  it('does not match labels glued to words', () => {
    expect(matchLabelPrefix('ROIplus')).toBeNull();
    expect(matchLabelPrefix('ClosedPosition')).toBeNull();
    expect(matchLabelPrefix('')).toBeNull();
  });
});

describe('HISTORY_VALUE_KEYS', () => {
  it('contains exactly the label/value pairs of a history card', () => {
    expect([...HISTORY_VALUE_KEYS]).toEqual([
      'realizedPnl',
      'roi',
      'closeVolume',
      'entry',
      'avgClose',
      'maxOpenInterest',
    ]);
  });
});
