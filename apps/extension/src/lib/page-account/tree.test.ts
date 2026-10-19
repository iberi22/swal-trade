import { describe, expect, it } from 'vitest';
import {
  collectTexts,
  countTextNodes,
  findTextNodes,
  flattenText,
  nodeTextOf,
  toTextTree,
  walkTextTree,
  type DomNodeLike,
  type TextNode,
} from './tree';
import { n } from './fixtures';

function domText(value: string): DomNodeLike {
  return { nodeType: 3, nodeValue: value };
}

function domEl(
  tagName: string,
  childNodes: DomNodeLike[],
  attrs: Record<string, string> = {},
  value?: string,
): DomNodeLike {
  return {
    nodeType: 1,
    tagName,
    value,
    childNodes,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

describe('toTextTree', () => {
  it('keeps direct text, children, input values and ARIA attributes', () => {
    const dom = domEl(
      'DIV',
      [
        domText('Hola   mundo'),
        domEl('SPAN', [domText('hijo')]),
        domEl('INPUT', [], { type: 'text', 'aria-label': 'Entrada' }, '0.004104'),
      ],
      { role: 'row' },
    );

    const tree = toTextTree(dom);
    expect(tree.tag).toBe('div');
    expect(tree.text).toBe('Hola mundo');
    expect(tree.attrs).toEqual({ role: 'row' });
    expect(tree.children?.[0]).toEqual({ tag: 'span', text: 'hijo' });
    expect(tree.children?.[1]).toEqual({
      tag: 'input',
      attrs: { ariaLabel: 'Entrada', type: 'text', value: '0.004104' },
    });
  });

  it('skips script, style and svg subtrees', () => {
    const dom = domEl('DIV', [
      domEl('SCRIPT', [domText('window.x = 1')]),
      domEl('STYLE', [domText('div{color:red}')]),
      domEl('SVG', [domEl('PATH', [])]),
      domEl('SPAN', [domText('visible')]),
    ]);

    const tree = toTextTree(dom);
    expect(tree.children).toHaveLength(1);
    expect(tree.children?.[0]?.text).toBe('visible');
    expect(flattenText(tree)).toBe('visible');
  });

  it('caps depth and node count', () => {
    let dom: DomNodeLike = domEl('SPAN', [domText('fondo')]);
    for (let i = 0; i < 10; i += 1) dom = domEl('DIV', [dom]);
    expect(flattenText(toTextTree(dom))).toBe('fondo');

    const shallow = toTextTree(dom, { maxDepth: 2 });
    expect(flattenText(shallow)).toBe('');

    const wide = domEl(
      'DIV',
      Array.from({ length: 20 }, (_, index) => domEl('SPAN', [domText(`t${index}`)])),
    );
    const capped = toTextTree(wide, { maxNodes: 5 });
    expect(countTextNodes(capped)).toBe(5);
  });

  it('never throws on garbage input', () => {
    expect(toTextTree(null).tag).toBe('unknown');
    expect(toTextTree(undefined).tag).toBe('unknown');
    expect(toTextTree({} as DomNodeLike).tag).toBe('unknown');
    expect(toTextTree('nope' as unknown as DomNodeLike).tag).toBe('unknown');
  });
});

describe('text helpers', () => {
  const tree = n('div', 'raiz', [
    n('span', 'uno'),
    n('input', undefined, undefined, { value: '0.004104' }),
    n('div', undefined, [n('span', 'dos')]),
  ]);

  it('collects texts in document order, excluding input values by default', () => {
    expect(collectTexts(tree)).toEqual(['raiz', 'uno', 'dos']);
    expect(collectTexts(tree, { includeInputValues: true })).toEqual([
      'raiz',
      'uno',
      '0.004104',
      'dos',
    ]);
  });

  it('flattens to a single line', () => {
    expect(flattenText(tree)).toBe('raiz uno dos');
    expect(flattenText(tree, { includeInputValues: true })).toBe('raiz uno 0.004104 dos');
  });

  it('walks, prunes and finds nodes', () => {
    const visited: string[] = [];
    walkTextTree(tree, (node) => {
      visited.push(node.tag);
    });
    expect(visited).toEqual(['div', 'span', 'input', 'div', 'span']);

    const pruned: string[] = [];
    walkTextTree(tree, (node) => {
      pruned.push(node.tag);
      return node.tag === 'input' ? false : undefined;
    });
    expect(pruned).toContain('input');

    const spans = findTextNodes(tree, (node) => node.tag === 'span');
    expect(spans.map(nodeTextOf)).toEqual(['uno', 'dos']);
  });

  it('handles null nodes', () => {
    expect(collectTexts(null)).toEqual([]);
    expect(flattenText(undefined)).toBe('');
    expect(nodeTextOf(null)).toBe('');
    expect(countTextNodes(null)).toBe(0);
    walkTextTree(null, () => {
      throw new Error('no deberia visitarse');
    });
  });

  it('accepts a hand-built tree with no children property', () => {
    const leaf: TextNode = { tag: 'span', text: '  solo  ' };
    expect(flattenText(leaf)).toBe('solo');
  });
});
