import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { MIXED_CURRENCY_REASON, parseBalance } from './parse-balance';
import { balanceForSymbol } from './page-balance';
import { findAccountBalanceRegion } from './region';
import { readPageAccount } from './content-reader';
import { n } from './fixtures';
import type { TextNode } from './tree';

const span = (text: string): TextNode => n('span', text);

/** Caja de cuenta en español tal como la pinta Binance (etiqueta y valor aparte). */
function balanceBoxEs(): TextNode {
  return n('div', undefined, [
    n('div', undefined, [span('USDC'), span('Cruzado')]),
    n('div', undefined, [span('Margen de mantenimiento'), span('0.9782 USDC')]),
    n('div', undefined, [span('Balance de margen'), span('71.9636 USDC')]),
    n('div', undefined, [span('Balance de Billetera'), span('72.4075 USDC')]),
    n('div', undefined, [span('PNL no realizado'), span('-0.4439 USDC')]),
    n('div', undefined, [span('Disp.'), span('70.83 USDC')]),
  ]);
}

/** Caja en inglés, con el activo y el modo pegados en el mismo nodo. */
function balanceBoxEn(): TextNode {
  return n('div', undefined, [
    n('div', undefined, [span('USDT Cross')]),
    n('div', undefined, [span('Margin Balance'), span('1,000.50 USDT')]),
    n('div', undefined, [span('Wallet Balance'), span('1,002.00 USDT')]),
    n('div', undefined, [span('Unrealized PNL'), span('+2.50 USDT')]),
    n('div', undefined, [span('Maintenance Margin'), span('1.50 USDT')]),
    n('div', undefined, [span('Avbl'), span('990.25 USDT')]),
  ]);
}

describe('parseBalance (Spanish account box)', () => {
  const balance = parseBalance(balanceBoxEs());

  it('reads every row with its asset', () => {
    expect(balance).toEqual({
      asset: 'USDC',
      marginBalance: 71.9636,
      walletBalance: 72.4075,
      available: 70.83,
      unrealizedPnl: -0.4439,
      maintenanceMargin: 0.9782,
      marginMode: 'cross',
      unusableReason: null,
    });
  });

  it('keeps the sign of the unrealized PNL', () => {
    expect(balance?.unrealizedPnl).toBeCloseTo(-0.4439, 10);
  });
});

describe('parseBalance (English account box)', () => {
  it('reads labels and mode glued in one node', () => {
    const balance = parseBalance(balanceBoxEn());
    expect(balance).toEqual({
      asset: 'USDT',
      marginBalance: 1000.5,
      walletBalance: 1002,
      available: 990.25,
      unrealizedPnl: 2.5,
      maintenanceMargin: 1.5,
      marginMode: 'cross',
      unusableReason: null,
    });
  });

  it('reads a label glued to its value', () => {
    const glued = n('div', undefined, [span('Balance de margen 71.9636 USDC')]);
    expect(parseBalance(glued)).toMatchObject({
      asset: 'USDC',
      marginBalance: 71.9636,
      marginMode: null,
    });
  });

  it('detects isolated margin', () => {
    const isolated = n('div', undefined, [
      span('USDC Aislado'),
      n('div', undefined, [span('Balance de margen'), span('10.5 USDC')]),
    ]);
    expect(parseBalance(isolated)).toMatchObject({ marginMode: 'isolated', marginBalance: 10.5 });
  });
});

describe('parseBalance (una sola moneda por recuadro)', () => {
  /**
   * Hallazgo P1: el encabezado decia USDT, el margen venia SIN sufijo y la
   * billetera en USDC. Antes, `asset` salia del primer sufijo que apareciera
   * (USDC) y el margen de 1.000 se ofrecia como 1.000 USDC para BTCUSDC.
   */
  it('rechaza el recuadro que mezcla encabezado y sufijos y dice por que', () => {
    const mixed = n('div', undefined, [
      n('div', undefined, [span('USDT Cross')]),
      n('div', undefined, [span('Margin Balance'), span('1000')]),
      n('div', undefined, [span('Wallet Balance'), span('2 USDC')]),
    ]);
    const balance = parseBalance(mixed);
    expect(balance).toMatchObject({
      asset: null,
      marginBalance: 1000,
      walletBalance: 2,
      unusableReason: 'monedas distintas en el recuadro',
    });
    // El motivo es el mismo constante que exporta el parser.
    expect(balance?.unusableReason).toBe(MIXED_CURRENCY_REASON);
    // Nunca capital: sin activo no hay saldo para el par.
    expect(balanceForSymbol(balance, 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance, 'BTCUSDT')).toBeNull();
  });

  it('rechaza lo mismo con el encabezado partido en dos nodos (USDT + Cruzado)', () => {
    const mixed = n('div', undefined, [
      n('div', undefined, [span('USDT'), span('Cruzado')]),
      n('div', undefined, [span('Balance de margen'), span('1000')]),
      n('div', undefined, [span('Balance de Billetera'), span('2 USDC')]),
    ]);
    expect(parseBalance(mixed)).toMatchObject({
      asset: null,
      marginMode: 'cross',
      marginBalance: 1000,
      unusableReason: MIXED_CURRENCY_REASON,
    });
  });

  it('rechaza que los sufijos se contradigan entre si aunque no haya encabezado', () => {
    const mixed = n('div', undefined, [
      n('div', undefined, [span('Balance de margen'), span('1000 USDC')]),
      n('div', undefined, [span('Balance de Billetera'), span('2 USDT')]),
    ]);
    expect(parseBalance(mixed)).toMatchObject({
      asset: null,
      marginBalance: 1000,
      walletBalance: 2,
      unusableReason: MIXED_CURRENCY_REASON,
    });
  });

  it('un numero sin sufijo hereda el activo cuando todo lo demas coincide', () => {
    const coherent = n('div', undefined, [
      n('div', undefined, [span('USDT Cross')]),
      n('div', undefined, [span('Margin Balance'), span('1000')]),
      n('div', undefined, [span('Wallet Balance'), span('2 USDT')]),
    ]);
    const balance = parseBalance(coherent);
    expect(balance).toMatchObject({
      asset: 'USDT',
      marginBalance: 1000,
      walletBalance: 2,
      unusableReason: null,
    });
    expect(balanceForSymbol(balance, 'BTCUSDT')).toEqual({ asset: 'USDT', value: 1000 });
  });

  it('el encabezado partido en ingles (USDT + Cross) no toma Cross por moneda', () => {
    const split = n('div', undefined, [
      n('div', undefined, [span('USDT'), span('Cross')]),
      n('div', undefined, [span('Margin Balance'), span('1000')]),
      n('div', undefined, [span('Wallet Balance'), span('2 USDT')]),
    ]);
    expect(parseBalance(split)).toMatchObject({
      asset: 'USDT',
      marginMode: 'cross',
      marginBalance: 1000,
      unusableReason: null,
    });
  });
});

describe('parseBalance (partial and garbage)', () => {
  it('keeps missing numbers as null instead of throwing', () => {
    const onlyAvailable = n('div', undefined, [n('div', undefined, [span('Disp.'), span('70.83 USDC')])]);
    expect(parseBalance(onlyAvailable)).toEqual({
      asset: 'USDC',
      marginBalance: null,
      walletBalance: null,
      available: 70.83,
      unrealizedPnl: null,
      maintenanceMargin: null,
      marginMode: null,
      unusableReason: null,
    });
  });

  it('returns null when the box is not there', () => {
    expect(parseBalance(null)).toBeNull();
    expect(parseBalance(undefined)).toBeNull();
    expect(parseBalance(n('div', undefined, [span('Hola')]))).toBeNull();
    expect(parseBalance(n('div', 'Balance'))).toBeNull();
  });

  it('does not take a positions row for an account box', () => {
    const row = n('div', undefined, [
      span('BTCUSDC Perp. 30x Cruzado Short'),
      span('82,644.1'),
    ]);
    expect(parseBalance(row)).toBeNull();
  });

  it('accepts numeric noise without inventing values', () => {
    const noise = n('div', undefined, [n('div', undefined, [span('Balance de margen'), span('--')])]);
    // Sin ningún número no hay saldo que ofrecer: se descarta la caja entera.
    expect(parseBalance(noise)).toBeNull();
  });
});

const PAGE = `<html><body>
  <div id="account">
    <div id="account-head"><span>USDC</span><span>Cruzado</span></div>
    <div><span>Margen de mantenimiento</span><span>0.9782 USDC</span></div>
    <div><span>Balance de margen</span><span>71.9636 USDC</span></div>
    <div><span>Balance de Billetera</span><span>72.4075 USDC</span></div>
    <div><span>PNL no realizado</span><span>-0.4439 USDC</span></div>
    <div><span>Disp.</span><span>70.83 USDC</span></div>
  </div>
  <div id="noise"><span>Depositar</span><span>Anuncios</span></div>
</body></html>`;

function page(html = PAGE) {
  return parseHTML(html).document as unknown as Parameters<typeof readPageAccount>[0];
}

describe('findAccountBalanceRegion', () => {
  it('finds the smallest container with the account labels', () => {
    const region = findAccountBalanceRegion(page());
    const id = (region as { getAttribute?: (name: string) => string | null }).getAttribute?.('id');
    expect(id).toBe('account');
  });

  it('does not invent a region without the labels', () => {
    expect(findAccountBalanceRegion(page('<html><body><div><span>Hola</span></div></body></html>'))).toBeNull();
  });

  it('reads the box through the content reader', () => {
    const result = readPageAccount(page());
    expect(result.balance).toMatchObject({
      asset: 'USDC',
      marginBalance: 71.9636,
      walletBalance: 72.4075,
      available: 70.83,
      marginMode: 'cross',
    });
    expect(result.positions).toEqual([]);
    expect(result.history).toEqual([]);
  });

  it('the fingerprint changes when only the balance changes', () => {
    const a = readPageAccount(page());
    const b = readPageAccount(page(PAGE.replace('71.9636 USDC', '70.0000 USDC')));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
