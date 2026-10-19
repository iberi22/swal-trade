// Fixtures de pagina construidos a mano (nada de DOM) a partir de las capturas
// reales del usuario. Se comparten entre los tests de `page-account`.

import type { TextNode, TextNodeAttrs } from './tree';

/** Constructor corto de `TextNode`. */
export function n(
  tag: string,
  text?: string,
  children?: TextNode[],
  attrs?: TextNodeAttrs,
): TextNode {
  const node: TextNode = { tag };
  if (text !== undefined) node.text = text;
  if (children && children.length > 0) node.children = children;
  if (attrs && Object.keys(attrs).length > 0) node.attrs = attrs;
  return node;
}

const span = (text: string): TextNode => n('span', text);

function headerRow(labels: string[]): TextNode {
  return n(
    'div',
    undefined,
    labels.map((label) => n('div', undefined, [span(label)])),
    { role: 'row' },
  );
}

function inputCell(texts: string[], value: string): TextNode {
  return n('div', undefined, [
    ...texts.map(span),
    n('input', undefined, undefined, { type: 'text', value, role: 'textbox' }),
  ]);
}

/**
 * Tabla de posiciones abiertas en espanol: PEPE solo con tamano en USDC y BTC
 * short con tamano en unidades base. Las columnas "Cerrar" llevan inputs que
 * el parser debe ignorar.
 */
export function openPositionsEs(): TextNode {
  const header = headerRow([
    'Símbolo',
    'Tamaño',
    'PnL (%ROI)',
    'Cerrar todo MKT',
    'Cerrar todo basado en PnL',
    'Precio de entrada',
    'Precio de equilibrio',
    'Precio de marca',
    'Precio de Liq.',
  ]);

  const pepe = n('div', undefined, [
    n('div', undefined, [span('1000PEPEUSDC'), span('Perp.'), span('40x')]),
    n('div', undefined, [span('254.56 USDC')]),
    n('div', undefined, [span('-0.91 USDC'), span('-14.40%')]),
    inputCell(['Merc...'], '0.004104'),
    inputCell(['Límite'], '62,148'),
    n('div', undefined, [span('0.0041106')]),
    n('div', undefined, [span('0.0041123')]),
    n('div', undefined, [span('0.0040981')]),
    n('div', undefined, [span('0.0030178')]),
  ]);

  const btc = n('div', undefined, [
    n('div', undefined, [span('BTCUSDC'), span('Perp.'), span('30x')]),
    n('div', undefined, [span('-0.004 BTC')]),
    n('div', undefined, [span('+2.10 USDC'), span('+19.00%')]),
    inputCell(['Merc...'], '82,600'),
    inputCell(['Límite'], '82,700'),
    n('div', undefined, [span('82,644.1')]),
    n('div', undefined, [span('82,300.0')]),
    n('div', undefined, [span('82,100.0')]),
    n('div', undefined, [span('95,000.0')]),
  ]);

  return n('div', undefined, [header, n('div', undefined, [pepe, btc])]);
}

/** Cabecera en ingles y una fila con tamano solo en USDC (lado por liq). */
export function openPositionsEnQuoteShort(): TextNode {
  const header = headerRow([
    'Symbol',
    'Size',
    'PNL (ROI %)',
    'Entry Price',
    'Break Even Price',
    'Mark Price',
    'Liq. Price',
  ]);

  const row = n('div', undefined, [
    n('div', undefined, [span('ETHUSDC'), span('Perp.'), span('10x')]),
    n('div', undefined, [span('1,500.00 USDC')]),
    n('div', undefined, [span('-12.00 USDC'), span('-8.00%')]),
    n('div', undefined, [span('3,000.0')]),
    n('div', undefined, [span('3,010.0')]),
    n('div', undefined, [span('3,050.0')]),
    n('div', undefined, [span('3,300.0')]),
  ]);

  return n('div', undefined, [header, n('div', undefined, [row])]);
}

export interface CardSpec {
  symbol: string;
  leverage: string;
  marginSide: string;
  opened: string;
  closed: string;
  duration?: string;
  pnlLabel: string;
  pnlValue?: string;
  roiLabel?: string;
  roiValue?: string;
  closeVolLabel?: string;
  closeVolValue?: string;
  entryLabel?: string;
  entryValue?: string;
  avgCloseLabel?: string;
  avgCloseValue?: string;
  maxOiLabel?: string;
  maxOiValue?: string;
}

function pair(label: string, value?: string): TextNode[] {
  if (value === undefined) return [];
  return [n('div', undefined, [span(label), span(value)])];
}

/** Tarjeta de "Historial de posiciones" con etiquetas/valores en nodos distintos. */
export function historyCard(spec: CardSpec): TextNode {
  const times = [span(spec.opened), span('|'), span(spec.closed)];
  if (spec.duration) times.push(span(`(Duración ${spec.duration})`));
  return n('div', undefined, [
    n('div', undefined, [
      span(spec.symbol),
      span('Perp.'),
      span(spec.leverage),
      span(spec.marginSide),
      span('Cerrado'),
    ]),
    n('div', undefined, times),
    ...pair(spec.pnlLabel, spec.pnlValue),
    ...pair(spec.roiLabel ?? 'ROI', spec.roiValue),
    ...pair(spec.closeVolLabel ?? '', spec.closeVolValue),
    ...pair(spec.entryLabel ?? 'Precio de entrada', spec.entryValue),
    ...pair(spec.avgCloseLabel ?? 'Precio de cierre prom.', spec.avgCloseValue),
    ...pair(spec.maxOiLabel ?? '', spec.maxOiValue),
  ]);
}

/** Las tres tarjetas de las capturas, en orden. */
export function historyCards(): TextNode[] {
  const btc = historyCard({
    symbol: 'BTCUSDC',
    leverage: '30x',
    marginSide: 'Cruzado Short',
    opened: '10/18/2026 23:45:54 Abierto',
    closed: '10/19/2026 10:21:28 Cerrado',
    duration: '10h 35m',
    pnlLabel: 'PnL realizado (USDC)',
    pnlValue: '+1.01 USDC',
    roiValue: '+9.25%',
    closeVolLabel: 'Vol. de cierre (BTC)',
    closeVolValue: '0.004',
    entryValue: '82,644.1',
    avgCloseValue: '82,330.0',
    maxOiLabel: 'Interés abierto máx. (BTC)',
    maxOiValue: '0.004',
  });

  const pepe = historyCard({
    symbol: '1000PEPEUSDC',
    leverage: '40x',
    marginSide: 'Cruzado Long',
    opened: '10/19/2026 00:13:18 Abierto',
    closed: '10/19/2026 08:53:36 Cerrado',
    duration: '8h 40m',
    pnlLabel: 'PnL realizado (USDC)',
    pnlValue: '+2.16 USDC',
    roiValue: '+40.24%',
    closeVolLabel: 'Vol. de cierre (1000PEPE)',
    closeVolValue: '53,033',
    entryValue: '0.0040522',
    avgCloseValue: '0.0040967',
    maxOiLabel: 'Interés abierto máx. (1000PEPE)',
    maxOiValue: '53,033',
  });

  const hbar = historyCard({
    symbol: 'HBARUSDC',
    leverage: '25x',
    marginSide: 'Cruzado Short',
    opened: '10/18/2026 15:26:58 Abierto',
    closed: '10/19/2026 02:04:33 Cerrado',
    duration: '10h 37m',
    pnlLabel: 'PnL realizado (USDC)',
    pnlValue: '-10.57 USDC',
    roiValue: '-62.05%',
    closeVolLabel: 'Vol. de cierre (HBAR)',
    closeVolValue: '5,184',
    entryValue: '0.0821800',
    avgCloseValue: '0.0842113',
    // Sin "Interés abierto máx.": la tarjeta de HBAR no lo muestra.
  });

  return [btc, pepe, hbar];
}

/** Las tres tarjetas de las capturas, con ruido de tabs y contenedores. */
export function historyFixture(cards: TextNode[] = historyCards()): TextNode {
  return n('div', undefined, [
    n('div', undefined, [span('Posiciones'), span('Historial de posiciones')], { role: 'tablist' }),
    n('div', undefined, [
      n('div', undefined, [span('Filtros'), span('Todo')]),
      n('div', undefined, cards),
      n('div', undefined, [span('Mostrando 3 registros')]),
    ]),
  ]);
}

/** Tarjeta con etiquetas en ingles y sin ROI. */
export function englishHistoryFixture(): TextNode {
  const english = n('div', undefined, [
    n('div', undefined, [span('ETHUSDC'), span('Perp.'), span('20x'), span('Cross Long')]),
    n('div', undefined, [
      span('10/19/2026 01:02:03 Opened'),
      span('|'),
      span('10/19/2026 03:04:05 Closed'),
      span('(Duration 2h 2m)'),
    ]),
    n('div', undefined, [span('Realized PNL (USDC)'), span('+5.00 USDC')]),
    n('div', undefined, [span('Closing Vol. (ETH)'), span('0.5')]),
    n('div', undefined, [span('Entry Price'), span('2,000.0')]),
    n('div', undefined, [span('Avg. Close Price'), span('2,050.0')]),
    n('div', undefined, [span('Max Open Interest (ETH)'), span('0.5')]),
  ]);
  return n('div', undefined, [span('Position History'), english]);
}
