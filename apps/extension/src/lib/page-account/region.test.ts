import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { findAccountBalanceRegion, findHistoryRegion, findOpenPositionsRegion } from './region';
import { fingerprintOf, readPageAccount } from './content-reader';
import { anonymizeTree, treeToCompactText } from './snapshot';

const PAGE = `
<html><body>
  <div id="app">
    <div id="tabs"><div role="tab">Posiciones</div><div role="tab">Historial de posiciones</div></div>
    <div id="account">
      <div><span>USDC Cruzado</span></div>
      <div><span>Margen de mantenimiento</span><span>0.9782 USDC</span></div>
      <div><span>Balance de margen</span><span>71.9636 USDC</span></div>
      <div><span>Balance de Billetera</span><span>72.4075 USDC</span></div>
      <div><span>PNL no realizado</span><span>-0.4439 USDC</span></div>
      <div><span>Disp.</span><span>70.83 USDC</span></div>
    </div>
    <div id="positions-table">
      <div id="header" role="row">
        <div><span>Símbolo</span></div>
        <div><span>Tamaño</span></div>
        <div><span>PnL (%ROI)</span></div>
        <div><span>Cerrar todo MKT</span></div>
        <div><span>Precio de entrada</span></div>
        <div><span>Precio de equilibrio</span></div>
        <div><span>Precio de marca</span></div>
        <div><span>Precio de Liq.</span></div>
      </div>
      <div id="row-pepe">
        <div><span>1000PEPEUSDC</span><span>Perp.</span><span>40x</span></div>
        <div><span>254.56 USDC</span></div>
        <div><span>-0.91 USDC</span><span>-14.40%</span></div>
        <div><span>Merc...</span><input value="0.004104" /></div>
        <div><span>0.0041106</span></div>
        <div><span>0.0041123</span></div>
        <div><span>0.0040981</span></div>
        <div><span>0.0030178</span></div>
      </div>
      <div id="row-btc">
        <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span></div>
        <div><span>-0.004 BTC</span></div>
        <div><span>+2.10 USDC</span><span>+19.00%</span></div>
        <div><span>Merc...</span><input value="82600" /></div>
        <div><span>82,644.1</span></div>
        <div><span>82,300.0</span></div>
        <div><span>82,100.0</span></div>
        <div><span>95,000.0</span></div>
      </div>
    </div>
    <div id="history">
      <div id="card-btc">
        <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span><span>Cruzado Short</span><span>Cerrado</span></div>
        <div><span>10/18/2026 23:45:54 Abierto</span><span>|</span><span>10/19/2026 10:21:28 Cerrado</span><span>(Duración 10h 35m)</span></div>
        <div><span>PnL realizado (USDC)</span><span>+1.01 USDC</span></div>
        <div><span>ROI</span><span>+9.25%</span></div>
        <div><span>Vol. de cierre (BTC)</span><span>0.004</span></div>
        <div><span>Precio de entrada</span><span>82,644.1</span></div>
        <div><span>Precio de cierre prom.</span><span>82,330.0</span></div>
      </div>
      <div id="card-hbar">
        <div><span>HBARUSDC</span><span>Perp.</span><span>25x</span><span>Cruzado Short</span><span>Cerrado</span></div>
        <div><span>10/18/2026 15:26:58 Abierto</span><span>|</span><span>10/19/2026 02:04:33 Cerrado</span><span>(Duración 10h 37m)</span></div>
        <div><span>PnL realizado (USDC)</span><span>-10.57 USDC</span></div>
        <div><span>ROI</span><span>-62.05%</span></div>
        <div><span>Vol. de cierre (HBAR)</span><span>5,184</span></div>
        <div><span>Precio de entrada</span><span>0.0821800</span></div>
        <div><span>Precio de cierre prom.</span><span>0.0842113</span></div>
      </div>
    </div>
    <div id="noise"><span>Anuncios</span><span>Depositar</span></div>
  </div>
</body></html>`;

function page(html = PAGE) {
  return parseHTML(html).document as unknown as Parameters<typeof readPageAccount>[0];
}

describe('findOpenPositionsRegion', () => {
  it('localiza la tabla de posiciones por sus etiquetas', () => {
    const region = findOpenPositionsRegion(page());
    expect(region).not.toBeNull();
    const id = (region as { getAttribute?: (n: string) => string | null }).getAttribute?.('id');
    expect(id).toBe('positions-table');
  });

  it('sin tabla de posiciones no inventa una región', () => {
    expect(findOpenPositionsRegion(page('<html><body><div><span>Hola</span></div></body></html>'))).toBeNull();
  });
});

describe('findHistoryRegion', () => {
  it('coge el contenedor con todas las tarjetas, no la primera', () => {
    const region = findHistoryRegion(page());
    const id = (region as { getAttribute?: (n: string) => string | null }).getAttribute?.('id');
    expect(id).toBe('history');
  });

  it('sin la pestaña de historial devuelve null', () => {
    const html = '<html><body><div><span>Posiciones</span><span>Sin historial</span></div></body></html>';
    expect(findHistoryRegion(page(html))).toBeNull();
  });
});

describe('findAccountBalanceRegion', () => {
  it('localiza la caja de cuenta por sus etiquetas', () => {
    const region = findAccountBalanceRegion(page());
    const id = (region as { getAttribute?: (n: string) => string | null }).getAttribute?.('id');
    expect(id).toBe('account');
  });

  it('sin etiquetas de saldo no inventa una región', () => {
    expect(findAccountBalanceRegion(page('<html><body><div><span>Hola</span></div></body></html>'))).toBeNull();
  });
});

describe('readPageAccount', () => {
  it('lee posiciones e historial de la página', () => {
    const result = readPageAccount(page(), { tzOffsetMinutes: 0 });
    expect(result.positions.map((p) => p.symbol)).toEqual(['1000PEPEUSDC', 'BTCUSDC']);
    expect(result.history.map((r) => r.symbol)).toEqual(['BTCUSDC', 'HBARUSDC']);
    expect(result.fingerprint).toMatch(/^[0-9a-f]+:\d+$/);
    expect(result.tree).not.toBeNull();
  });

  it('lee la caja de cuenta de la página', () => {
    const result = readPageAccount(page(), { tzOffsetMinutes: 0 });
    expect(result.balance).toEqual({
      asset: 'USDC',
      marginBalance: 71.9636,
      walletBalance: 72.4075,
      available: 70.83,
      unrealizedPnl: -0.4439,
      maintenanceMargin: 0.9782,
      marginMode: 'cross',
    });
  });

  it('la huella cambia si solo cambia el saldo', () => {
    const a = readPageAccount(page(), { tzOffsetMinutes: 0 });
    const b = readPageAccount(page(PAGE.replace('71.9636 USDC', '12.5 USDC')), { tzOffsetMinutes: 0 });
    expect(b.balance?.marginBalance).toBe(12.5);
    expect(a.positions).toEqual(b.positions);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('una página sin caja de cuenta devuelve saldo null', () => {
    const html = PAGE.replace(/<div id="account">[\s\S]*?<\/div>\s*<div id="positions-table">/, '<div id="positions-table">');
    expect(readPageAccount(page(html), { tzOffsetMinutes: 0 }).balance).toBeNull();
  });

  it('la huella no cambia si los datos no cambian', () => {
    const a = readPageAccount(page(), { tzOffsetMinutes: 0 });
    const b = readPageAccount(page(), { tzOffsetMinutes: 0 });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('la huella cambia cuando cambia un número de la página', () => {
    const a = readPageAccount(page(), { tzOffsetMinutes: 0 });
    const b = readPageAccount(page(PAGE.replace('+2.10 USDC', '+9.99 USDC')), { tzOffsetMinutes: 0 });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('una página sin nada no rompe: devuelve listas vacías', () => {
    const result = readPageAccount(page('<html><body></body></html>'));
    expect(result.positions).toEqual([]);
    expect(result.history).toEqual([]);
    expect(result.tree).toBeNull();
  });

  it('el diagnóstico anonimizado tapa los dígitos y conserva las etiquetas', () => {
    const result = readPageAccount(page());
    const outline = treeToCompactText(anonymizeTree(result.tree));
    expect(outline).toContain('BTCUSDC');
    expect(outline).not.toContain('82644');
    expect(outline).not.toContain('82,644');
    expect(outline).not.toContain('0.0041106');
    expect(outline.length).toBeLessThanOrEqual(60_000);
  });
});

describe('fingerprintOf', () => {
  it('es estable y distinta para textos distintos', () => {
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'));
    expect(fingerprintOf('abc')).not.toBe(fingerprintOf('abd'));
    expect(fingerprintOf('')).toBe('1505:0');
  });
});
