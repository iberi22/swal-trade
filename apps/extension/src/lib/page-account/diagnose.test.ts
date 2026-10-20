import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  composeDiagnoseText,
  DIAGNOSE_REGION_MAX_CHARS,
  describeRegions,
  regionSummary,
  type DiagnoseRegions,
} from './diagnose';
import type { RegionSource } from './region';
import { anonymizeTree, treeToCompactText } from './snapshot';

const PAGE = `
<html><body>
  <div id="app">
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
        <div><span>Precio de entrada</span></div>
        <div><span>Precio de marca</span></div>
      </div>
      <div id="row-btc">
        <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span></div>
        <div><span>254.56 USDC</span></div>
        <div><span>+2.10 USDC</span><span>+19.00%</span></div>
        <div><span>Merc...</span><input value="82644.1" /></div>
        <div><span>82,100.0</span></div>
      </div>
    </div>
    <div id="history">
      <div id="card-btc">
        <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span><span>Cruzado Short</span><span>Cerrado</span></div>
        <div><span>10/18/2026 23:45:54 Abierto</span><span>|</span><span>10/19/2026 10:21:28 Cerrado</span></div>
        <div><span>PnL realizado (USDC)</span><span>+1.01 USDC</span></div>
        <div><span>ROI</span><span>+9.25%</span></div>
        <div><span>Precio de entrada</span><span>82,644.1</span></div>
      </div>
    </div>
  </div>
</body></html>`;

/** Página sin la caja de cuenta: el caso que el volcado único ocultaba. */
const NO_ACCOUNT = `
<html><body><div id="app">
  <div id="history">
    <div id="card-btc">
      <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span><span>Cruzado Short</span><span>Cerrado</span></div>
      <div><span>10/18/2026 23:45:54 Abierto</span><span>|</span><span>10/19/2026 10:21:28 Cerrado</span></div>
      <div><span>PnL realizado (USDC)</span><span>+1.01 USDC</span></div>
      <div><span>ROI</span><span>+9.25%</span></div>
      <div><span>Precio de entrada</span><span>82,644.1</span></div>
    </div>
  </div>
</div></body></html>`;

const EMPTY = '<html><body><div><span>Hola</span></div></body></html>';

function page(html = PAGE): RegionSource {
  return parseHTML(html).document as unknown as RegionSource;
}

function regionsOf(html: string): DiagnoseRegions {
  return describeRegions(page(html));
}

describe('describeRegions', () => {
  it('informa de las tres regiones cuando la página las tiene', () => {
    const regions = regionsOf(PAGE);
    expect(regions.balance.found).toBe(true);
    expect(regions.positions.found).toBe(true);
    expect(regions.history.found).toBe(true);
    expect(regions.balance.nodes).toBeGreaterThan(0);
    expect(regions.history.nodes).toBeGreaterThan(0);
    expect(regions.balance.outline).toContain('Balance de margen');
    expect(regions.history.outline).toContain('PnL realizado');
  });

  it('dice que la caja de cuenta falta aunque el historial llene el volcado', () => {
    const regions = regionsOf(NO_ACCOUNT);
    expect(regions.balance).toEqual({ found: false, nodes: 0, outline: '' });
    expect(regions.positions.found).toBe(false);
    expect(regions.history.found).toBe(true);
  });

  it('sin nada reconocible deja las tres en falso', () => {
    const regions = regionsOf(EMPTY);
    expect(regions).toEqual({
      balance: { found: false, nodes: 0, outline: '' },
      positions: { found: false, nodes: 0, outline: '' },
      history: { found: false, nodes: 0, outline: '' },
    });
  });

  it('no filtra cifras ni valores de inputs', () => {
    const regions = regionsOf(PAGE);
    const text = Object.values(regions)
      .map((report) => report.outline)
      .join('\n');
    for (const raw of ['71.9636', '72.4075', '0.9782', '82644', '82,644.1']) {
      expect(text).not.toContain(raw);
    }
    // La etiqueta y el símbolo sí se conservan: son la pista del parser.
    expect(text).toContain('Balance de margen');
    expect(text).toContain('BTCUSDC');
  });

  it('acota el esquema de cada región', () => {
    const noise = `<div>${Array.from({ length: 900 }, (_, i) => `<span>n${i}</span>`).join('')}</div>`;
    const html = `<html><body><div id="history">${noise}</div></body></html>`;
    for (const report of Object.values(regionsOf(html))) {
      expect(report.outline.length).toBeLessThanOrEqual(DIAGNOSE_REGION_MAX_CHARS);
    }
  });
});

describe('regionSummary', () => {
  it('marca con ✓ y ✗ cada región y cuenta los nodos', () => {
    const regions = regionsOf(NO_ACCOUNT);
    expect(regionSummary(regions)).toMatch(
      /^caja de cuenta ✗ · posiciones ✗ · historial ✓ \d+ nodos$/,
    );
  });
});

describe('composeDiagnoseText', () => {
  it('incluye el resumen y solo las regiones encontradas', () => {
    const regions = regionsOf(NO_ACCOUNT);
    const text = composeDiagnoseText(regions);
    expect(text.startsWith('Regiones: caja de cuenta ✗')).toBe(true);
    expect(text).toContain('== historial ==');
    expect(text).not.toContain('== caja de cuenta ==');
  });

  it('sin regiones cae al volcado de respaldo', () => {
    const regions = regionsOf(EMPTY);
    expect(composeDiagnoseText(regions, 'div "hola"')).toContain('div "hola"');
    expect(composeDiagnoseText(regions, '')).toBe(
      'Regiones: caja de cuenta ✗ · posiciones ✗ · historial ✗',
    );
  });
});

describe('diagnóstico: campos editables nunca se serializan', () => {
  /** Historial con un textarea, un campo y un contenteditable con secretos. */
  const WITH_FIELDS = `
<html><body><div id="app">
  <div id="history">
    <div id="card-btc">
      <div><span>BTCUSDC</span><span>Perp.</span><span>30x</span><span>Cruzado Short</span><span>Cerrado</span></div>
      <div><span>10/18/2026 23:45:54 Abierto</span><span>|</span><span>10/19/2026 10:21:28 Cerrado</span></div>
      <div><span>PnL realizado (USDC)</span><span>+1.01 USDC</span></div>
      <div><span>ROI</span><span>+9.25%</span></div>
      <div><span>Precio de entrada</span><span>82,644.1</span></div>
      <textarea>SECRET_ALPHA</textarea>
      <input value="SECRET_CHARLIE" />
      <div contenteditable="true"><span>SECRET_BRAVO</span></div>
    </div>
  </div>
</div></body></html>`;

  it('el texto de textarea, input y contenteditable no llega al informe', () => {
    const regions = regionsOf(WITH_FIELDS);
    const text = Object.values(regions)
      .map((report) => report.outline)
      .join('\n');
    for (const secret of ['SECRET_ALPHA', 'SECRET_BRAVO', 'SECRET_CHARLIE']) {
      expect(text, secret).not.toContain(secret);
    }
    // La estructura y las etiquetas sí se conservan: el informe sigue sirviendo.
    expect(text).toContain('textarea');
    expect(text).toContain('PnL realizado');
    expect(text).toContain('BTCUSDC');
    expect(regions.history.found).toBe(true);
  });

  it('anonymizeTree tapa el subárbol de un contenteditable entero', () => {
    const tree = {
      tag: 'div',
      children: [
        { tag: 'span', text: 'BTCUSDC' },
        { tag: 'div', attrs: { editable: true as const }, children: [{ tag: 'span', text: 'SECRET_DELTA' }] },
        { tag: 'textarea', text: 'SECRET_ECHO' },
        { tag: 'p', text: 'PnL realizado' },
      ],
    };
    const outline = treeToCompactText(anonymizeTree(tree));
    expect(outline).toContain('BTCUSDC');
    expect(outline).toContain('PnL realizado');
    expect(outline).not.toContain('SECRET_DELTA');
    expect(outline).not.toContain('SECRET_ECHO');
  });

  it('respeta el tope de nodos que se le pide (RegionOptions.maxNodes)', () => {
    const regions = describeRegions(page(PAGE), { maxNodes: 5 });
    for (const report of Object.values(regions)) {
      if (!report.found) continue;
      expect(report.nodes).toBeLessThanOrEqual(5);
    }
    // Sin tope explícito sigue usando el del lector.
    const full = describeRegions(page(PAGE));
    expect(full.history.nodes).toBeGreaterThan(5);
  });
});
