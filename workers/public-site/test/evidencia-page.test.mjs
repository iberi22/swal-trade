import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Testing without linkedom per project rules since it's not a dependency
import { renderRows } from '../static/evidencia/app.js';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const EVIDENCIA_DIR = join(STATIC, 'evidencia');
const HTML_PATH = join(EVIDENCIA_DIR, 'index.html');
const JS_PATH = join(EVIDENCIA_DIR, 'app.js');
const SITEMAP_PATH = join(STATIC, 'sitemap.xml');

test('evidencia page exists', () => {
  assert.ok(existsSync(HTML_PATH), 'index.html should exist in evidencia');
  assert.ok(existsSync(JS_PATH), 'app.js should exist in evidencia');
});

test('page has one h1', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const h1Count = (html.match(/<h1[^>]*>/g) || []).length;
  assert.strictEqual(h1Count, 1, 'Page should have exactly one H1');
});

test('links app.js with type=module or defer and no inline script', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const scripts = html.match(/<script[^>]*>/g) || [];

  // We allow pwa-register.js and app.js
  const inlineScripts = scripts.filter(s => !s.includes('src='));
  assert.strictEqual(inlineScripts.length, 0, 'No inline scripts allowed');

  const appScript = scripts.find(s => s.includes('app.js'));
  assert.ok(appScript, 'Should include app.js');
  assert.ok(appScript.includes('type="module"'), 'app.js should be type="module"');
});

test('contains specific required strings', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  assert.ok(html.includes('0 de 92'), 'Should contain "0 de 92"');
  assert.ok(html.includes('no es una probabilidad'), 'Should contain "no es una probabilidad"');
});

test('contains specific required empty state string in HTML or JS', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const js = readFileSync(JS_PATH, 'utf8');
  assert.ok(js.includes('Aún no hay datos publicados.'), 'Should contain empty state string');
});

test('contains no forbidden claim words without negation', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const forbidden = /garantiz|guarantee|risk-free|sin riesgo/i;

  if (forbidden.test(html)) {
    // If found, must be negated
    const negated = /no es una garant[ií]a|no garantiz|not a guarantee|not risk-free/i;
    assert.ok(negated.test(html), 'Forbidden word found but not negated');
  } else {
    assert.ok(true, 'No forbidden words found');
  }
});

test('app.js never uses innerHTML', () => {
  const js = readFileSync(JS_PATH, 'utf8');
  assert.strictEqual(js.includes('innerHTML'), false, 'app.js should not use innerHTML');
});

test('sitemap contains the URL', () => {
  const sitemap = readFileSync(SITEMAP_PATH, 'utf8');
  assert.ok(sitemap.includes('/evidencia/'), 'Sitemap should contain /evidencia/');
});

test('renderRows function correctly renders two rows and says "sin evidencia" for n=12', () => {
  // Mock document.createElement to return dummy objects
  global.document = {
    createElement: (tag) => ({ tag, textContent: '', children: [], appendChild(child) { this.children.push(child); } })
  };

  const cells = [
    { kind: 'SMC', tf: '1h', symbol: 'BTCUSDT', direction: 'LONG', n: 100, tasa_1r: '55.2', interval: '1', break_even: '1', baseline: '1', grade: '50' },
    { kind: 'Wedge', tf: '15m', symbol: 'ETHUSDT', direction: 'SHORT', n: 12, tasa_1r: '60.0', interval: '1', break_even: '1', baseline: '1', grade: '30' }
  ];

  const rows = renderRows(cells);
  assert.strictEqual(rows.length, 2, 'Should render 2 rows');

  // Second row (n=12) should have "sin evidencia" in the tasa_1r cell (index 5)
  const tasaCell = rows[1].children[5];
  assert.strictEqual(tasaCell.textContent, 'sin evidencia', 'n=12 should render as "sin evidencia"');

  // First row (n=100) should have the actual rate
  const tasaCell1 = rows[0].children[5];
  assert.strictEqual(tasaCell1.textContent, '55.2', 'n=100 should render the actual rate');

  delete global.document;
});
