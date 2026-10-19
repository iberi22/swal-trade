import { describe, expect, it } from 'vitest';
import { n } from './fixtures';
import { matchLabel } from './labels';
import { isSymbolToken } from './parse-history';
import {
  anonymizeTree,
  MAX_COMPACT_CHARS,
  treeToCompactText,
} from './snapshot';
import { collectTexts, findTextNodes, type TextNode } from './tree';

function containsDigitOutsideLabelsOrSymbols(texts: string[]): boolean {
  return texts.some((text) => {
    if (matchLabel(text) !== null) return false;
    if (isSymbolToken(text)) return false;
    const withoutSymbols = text.replace(/[0-9A-Z]{2,20}(?:USDT|USDC|BUSD)/g, '');
    // El anonimizador sustituye cada digito por '9': no debe quedar otro digito.
    return /[0-8]/.test(withoutSymbols);
  });
}

const tree = n(
  'div',
  undefined,
  [
    n('div', undefined, [n('span', '1000PEPEUSDC'), n('span', 'Perp.'), n('span', '40x')]),
    n('div', undefined, [n('span', 'PnL realizado (USDC)'), n('span', '-0.91 USDC')]),
    n('div', undefined, [n('span', '10/19/2026 00:13:18 Abierto')]),
    n('input', undefined, undefined, {
      type: 'text',
      value: '0.004104',
      role: 'textbox',
      ariaLabel: 'Precio 62,148',
    }),
  ],
  { role: 'row' },
);

describe('anonymizeTree', () => {
  const safe = anonymizeTree(tree);

  it('keeps tags, roles and known labels', () => {
    expect(safe.tag).toBe('div');
    expect(safe.attrs?.role).toBe('row');
    expect(safe.children?.[0]?.children?.[1]?.text).toBe('Perp.');
    expect(safe.children?.[1]?.children?.[0]?.text).toBe('PnL realizado (USDC)');
  });

  it('keeps symbols but masks every other digit', () => {
    expect(safe.children?.[0]?.children?.[0]?.text).toBe('1000PEPEUSDC');
    expect(safe.children?.[0]?.children?.[2]?.text).toBe('99x');
    expect(safe.children?.[1]?.children?.[1]?.text).toBe('-9.99 USDC');
    expect(safe.children?.[2]?.children?.[0]?.text).toBe('99/99/9999 99:99:99 Abierto');
    expect(containsDigitOutsideLabelsOrSymbols(collectTexts(safe))).toBe(false);
  });

  it('drops input values and types but keeps roles and masks aria-labels', () => {
    const inputs = findTextNodes(safe, (node) => node.tag === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.attrs).toEqual({ role: 'textbox', ariaLabel: 'Precio 99,999' });
    expect(inputs[0]?.attrs?.value).toBeUndefined();
  });

  it('caps the number of nodes and never throws', () => {
    expect(anonymizeTree(tree, { maxNodes: 2 }).children?.length ?? 0).toBeLessThan(3);
    expect(anonymizeTree(null).tag).toBe('unknown');
    expect(anonymizeTree(undefined).tag).toBe('unknown');
    expect(anonymizeTree({} as TextNode).tag).toBe('unknown');
  });
});

describe('treeToCompactText', () => {
  it('renders an indented outline with tags, roles and text', () => {
    const compact = treeToCompactText(tree);
    expect(compact).toContain('div role=row');
    expect(compact).toContain('"PnL realizado (USDC)"');
    expect(compact.split('\n')[1]).toMatch(/^ {2}div/);
  });

  it('stays under 60 KB on a huge tree', () => {
    const huge = n(
      'div',
      undefined,
      Array.from({ length: 2000 }, (_, index) => n('span', `texto ${index} ${'x'.repeat(100)}`)),
    );
    const compact = treeToCompactText(huge);
    expect(compact.length).toBeLessThanOrEqual(MAX_COMPACT_CHARS);
    expect(compact.length).toBeLessThanOrEqual(60_000);
    expect(compact).toContain('truncated');
  });

  it('handles empty input', () => {
    expect(treeToCompactText(null)).toBe('');
    expect(treeToCompactText({ tag: 'div' })).toBe('div');
  });
});
