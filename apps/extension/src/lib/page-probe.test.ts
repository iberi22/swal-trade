import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_SELECTOR,
  STORAGE_KEYS,
  bestIntervalGroup,
  collectIntervalControls,
  intervalFromControls,
  labelFromText,
  parseStoredInterval,
  probeDomInterval,
  probeStorageInterval,
  resolvePageInterval,
  toolbarInterval,
  type ProbeDocument,
  type PageSource,
} from './page-probe';

/** Carga un fixture HTML y lo devuelve como `Document` de navegador. */
function fixture(name: string): ProbeDocument {
  const html = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
  return parseHTML(html).document as unknown as ProbeDocument;
}

function controls(name: string, source: PageSource) {
  return collectIntervalControls(fixture(name), source);
}

describe('fixtures HTML', () => {
  it('los fixtures existen y linkedom los parsea', () => {
    expect(controls('binance-toolbar-15m.html', 'binance')).toHaveLength(6);
    expect(controls('tradingview-toolbar-1d.html', 'tradingview')).toHaveLength(6);
    expect(controls('no-interval-page.html', 'binance')).toEqual([]);
  });
});

describe('labelFromText', () => {
  it('en Binance solo acepta temporalidades con sufijo', () => {
    expect(labelFromText('15m', 'binance')).toBe('15m');
    expect(labelFromText('1H', 'binance')).toBe('1h');
    expect(labelFromText('1D', 'binance')).toBe('1d');
  });

  it('en Binance un número pelado no es una temporalidad', () => {
    // "5" en Binance puede ser apalancamiento o cantidad.
    expect(labelFromText('5', 'binance')).toBeNull();
    expect(labelFromText('20x', 'binance')).toBeNull();
    expect(labelFromText('1,234.50 USDT', 'binance')).toBeNull();
    expect(labelFromText('30m', 'binance')).toBeNull();
    expect(labelFromText(null, 'binance')).toBeNull();
    expect(labelFromText(undefined, 'binance')).toBeNull();
    expect(labelFromText('', 'binance')).toBeNull();
  });

  it('en TradingView el código pelado sí es la temporalidad', () => {
    expect(labelFromText('5', 'tradingview')).toBe('5m');
    expect(labelFromText('15', 'tradingview')).toBe('15m');
    expect(labelFromText('60', 'tradingview')).toBe('1h');
    expect(labelFromText('240', 'tradingview')).toBe('4h');
    expect(labelFromText('1440', 'tradingview')).toBe('1d');
    expect(labelFromText('D', 'tradingview')).toBe('1d');
    expect(labelFromText('1D', 'tradingview')).toBe('1d');
  });

  it('los intervalos que el panel no soporta no se disfrazan', () => {
    // 3m o 30m existen en TradingView, pero el panel solo dibuja seis. Mejor
    // decir que la temporalidad es inferida que cargar velas de otra.
    expect(labelFromText('3', 'tradingview')).toBeNull();
    expect(labelFromText('30', 'tradingview')).toBeNull();
    expect(labelFromText('45m', 'binance')).toBeNull();
    expect(labelFromText('2h', 'tradingview')).toBeNull();
  });
});

describe('binance toolbar in the DOM', () => {
  it('lee 15m del grupo con el botón activo', () => {
    expect(probeDomInterval(fixture('binance-toolbar-15m.html'), 'binance')).toBe('15m');
  });

  it('sigue al usuario cuando pulsa 4h', () => {
    expect(probeDomInterval(fixture('binance-toolbar-4h.html'), 'binance')).toBe('4h');
  });

  it('acepta aria-checked y data-state sin clase activa', () => {
    expect(probeDomInterval(fixture('binance-toolbar-aria-checked.html'), 'binance')).toBe('1h');
  });

  it('resuelve la barra plegada que solo muestra el elegido', () => {
    expect(probeDomInterval(fixture('binance-toolbar-collapsed.html'), 'binance')).toBe('1d');
  });

  it('no elige nada si la barra no marca ninguno', () => {
    expect(probeDomInterval(fixture('binance-toolbar-no-active.html'), 'binance')).toBeNull();
  });

  it('no inventa una temporalidad en la página de órdenes', () => {
    expect(probeDomInterval(fixture('no-interval-page.html'), 'binance')).toBeNull();
  });

  it('marca activo solo el botón que la página marca', () => {
    const [first, second, third] = controls('binance-toolbar-15m.html', 'binance');
    expect([first?.active, second?.active, third?.active]).toEqual([false, false, true]);
    expect(third?.text).toBe('15m');
  });
});

describe('tradingview toolbar in the DOM', () => {
  it('mapea el código pelado 1440 a 1d', () => {
    expect(probeDomInterval(fixture('tradingview-toolbar-1d.html'), 'tradingview')).toBe('1d');
  });

  it('lee 4h del texto con aria-pressed', () => {
    expect(probeDomInterval(fixture('tradingview-toolbar-4h.html'), 'tradingview')).toBe('4h');
  });

  it('no trata el formulario de orden como barra de intervalos', () => {
    expect(probeDomInterval(fixture('no-interval-page.html'), 'tradingview')).toBeNull();
  });
});

describe('bestIntervalGroup / intervalFromControls', () => {
  const group = [
    { text: '1m' as const, active: false, group: 0 },
    { text: '5m' as const, active: false, group: 0 },
    { text: '4h' as const, active: true, group: 0 },
    { text: '5m' as const, active: false, group: 1 },
    { text: '1h' as const, active: true, group: 1 },
  ];

  it('se queda con el grupo que tiene más temporalidades distintas', () => {
    const best = bestIntervalGroup(group);
    expect(best.map((control) => control.text)).toEqual(['1m', '5m', '4h']);
  });

  it('dentro de ese grupo gana el activo', () => {
    expect(intervalFromControls(group)).toBe('4h');
  });

  it('con un único botón activo en toda la página lo usa', () => {
    expect(
      intervalFromControls([{ text: '1h', active: true, group: 3 }]),
    ).toBe('1h');
  });

  it('sin ningún activo devuelve null', () => {
    expect(intervalFromControls([{ text: '1m', active: false, group: 0 }])).toBeNull();
    expect(intervalFromControls([])).toBeNull();
  });
});

describe('toolbarInterval', () => {
  it('ignora contenedores que no son de intervalo', () => {
    expect(toolbarInterval(fixture('no-interval-page.html'), 'binance')).toBeNull();
  });

  it('devuelve null si la barra compacta no marca ninguna', () => {
    expect(toolbarInterval(fixture('binance-toolbar-no-active.html'), 'binance')).toBeNull();
  });
});

describe('parseStoredInterval', () => {
  it('acepta el texto pelado', () => {
    expect(parseStoredInterval('15m', 'binance')).toBe('15m');
    expect(parseStoredInterval('  4H  ', 'binance')).toBe('4h');
  });

  it('acepta el valor envuelto en JSON', () => {
    expect(parseStoredInterval('{"interval":"1h"}', 'binance')).toBe('1h');
    expect(parseStoredInterval('{"kline":{"interval":"1d"}}', 'binance')).toBe('1d');
    expect(parseStoredInterval('{"chart":{"timeframe":"15m"}}', 'binance')).toBe('15m');
    expect(parseStoredInterval('{"lastKlineInterval":"4h"}', 'tradingview')).toBe('4h');
  });

  it('no inventa ni se deja engañar por otros valores', () => {
    expect(parseStoredInterval(null, 'binance')).toBeNull();
    expect(parseStoredInterval('', 'binance')).toBeNull();
    expect(parseStoredInterval('{"leverage":"20x"}', 'binance')).toBeNull();
    expect(parseStoredInterval('{"interval":"45m"}', 'binance')).toBeNull();
    expect(parseStoredInterval('x'.repeat(500), 'binance')).toBeNull();
    // Un número pelado en Binance sigue siendo ambiguo.
    expect(parseStoredInterval('5', 'binance')).toBeNull();
    expect(parseStoredInterval('240', 'tradingview')).toBe('4h');
  });
});

describe('probeStorageInterval', () => {
  const store = new Map<string, string>([
    ['binance_kline_interval', '{"interval":"1h"}'],
    ['chart_interval', '5m'],
  ]);

  it('lee la primera clave permitida que tenga una temporalidad', () => {
    expect(probeStorageInterval((key) => store.get(key) ?? null, 'binance')).toBe('1h');
  });

  it('no lee claves fuera de la lista permitida', () => {
    const read = vi.fn((key: string) => store.get(key) ?? null);
    expect(probeStorageInterval(read, 'binance')).toBe('1h');
    // Se detiene en la primera clave con intervalo: no recorre las demás.
    const asked = read.mock.calls.map(([key]) => key);
    expect(asked).toEqual(STORAGE_KEYS.slice(0, 3));
    expect(asked.every((key) => STORAGE_KEYS.includes(key))).toBe(true);
  });

  it('si el storage lanza, no rompe el content script', () => {
    expect(
      probeStorageInterval(() => {
        throw new Error('storage blocked');
      }, 'binance'),
    ).toBeNull();
  });

  it('devuelve null cuando no hay ninguna clave con intervalo', () => {
    expect(probeStorageInterval(() => null, 'binance')).toBeNull();
  });
});

describe('resolvePageInterval', () => {
  it('el DOM manda sobre el storage', () => {
    expect(
      resolvePageInterval({ source: 'binance', dom: '4h', storage: '{"interval":"1d"}' }),
    ).toBe('4h');
  });

  it('usa el storage cuando la página no pinta la barra', () => {
    expect(
      resolvePageInterval({ source: 'binance', dom: null, storage: '{"interval":"1d"}' }),
    ).toBe('1d');
  });

  it('no adivina si ninguno de los dos dice nada', () => {
    expect(resolvePageInterval({ source: 'binance', dom: null, storage: null })).toBeNull();
    expect(resolvePageInterval({ source: 'binance', dom: '20x', storage: 'x' })).toBeNull();
  });
});

describe('live DOM (lo que ve el MutationObserver)', () => {
  it('releyendo el mismo documento tras pulsar otro intervalo cambia el resultado', () => {
    // El content script no cachea: en cada mutación vuelve a preguntar al DOM.
    const doc = parseHTML(readFileSync(new URL('./__fixtures__/binance-toolbar-15m.html', import.meta.url), 'utf8'))
      .document as unknown as ProbeDocument;
    expect(probeDomInterval(doc, 'binance')).toBe('15m');

    // Lo que hace la SPA al pulsar "4h": mueve aria-pressed y la clase.
    const previous = doc.querySelector('button.is-active');
    previous?.removeAttribute('aria-pressed');
    previous?.classList.remove('is-active');
    const next = doc.querySelector('button[data-value="4h"]');
    next?.setAttribute('aria-pressed', 'true');
    next?.classList.add('is-active');

    expect(probeDomInterval(doc, 'binance')).toBe('4h');
  });

  it('una barra que la SPA reemplaza entera se lee igual', () => {
    const doc = parseHTML('<div id="root"></div>').document as unknown as ProbeDocument;
    expect(probeDomInterval(doc, 'binance')).toBeNull();
    const root = doc.querySelector('#root');
    root?.insertAdjacentHTML(
      'beforeend',
      '<div class="chart-interval-toolbar"><button data-value="5m">5m</button>' +
        '<button class="is-active" data-value="15m">15m</button></div>',
    );
    expect(probeDomInterval(doc, 'binance')).toBe('15m');
  });
});

describe('selectores publicados', () => {
  it('el selector de controles es estrecho: nada de div suelto', () => {
    expect(CONTROL_SELECTOR).not.toMatch(/(^|,\s*)div\b/);
    expect(CONTROL_SELECTOR).not.toMatch(/(^|,\s*)(span|li)\b/);
    expect(CONTROL_SELECTOR).toContain('button');
  });
});
