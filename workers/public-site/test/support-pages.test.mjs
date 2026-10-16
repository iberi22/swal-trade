import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DONATION_CONFIG, renderSupport } from '../static/apoyar/apoyar.js';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

test('páginas nuevas de apoyo y extensión existen', () => {
  assert.ok(existsSync(join(STATIC, 'apoyar', 'index.html')), 'falta static/apoyar/index.html');
  assert.ok(existsSync(join(STATIC, 'apoyar', 'apoyar.js')), 'falta static/apoyar/apoyar.js');
  assert.ok(existsSync(join(STATIC, 'extension', 'index.html')), 'falta static/extension/index.html');
  assert.ok(existsSync(join(STATIC, 'extension', 'swal-trade-extension.zip')), 'falta el zip de la extensión');
  assert.ok(statSync(join(STATIC, 'extension', 'swal-trade-extension.zip')).size > 1000, 'el zip está vacío o corrupto');

  for (const img of [
    'sidepanel-chart-1280x800.png',
    'sidepanel-pulse-1280x800.png',
    'sidepanel-explain-1280x800.png',
    'sidepanel-settings-1280x800.png',
  ]) {
    const p = join(STATIC, 'extension', 'img', img);
    assert.ok(existsSync(p), `falta captura ${img}`);
    assert.ok(statSync(p).size > 1000, `captura ${img} demasiado pequeña`);
  }
});

test('títulos y metadatos SEO en las páginas nuevas', () => {
  for (const p of ['apoyar', 'extension']) {
    const html = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/, `${p} sin título`);
    assert.match(html, /<meta name="description" content="[^"]+">/, `${p} sin meta description`);
    assert.match(html, /<link rel="canonical" href="https:\/\/trade\.swal\.network\/[^"]+">/, `${p} sin canonical`);
    assert.match(html, /<meta property="og:title" content="[^"]+">/, `${p} sin og:title`);
  }
  const apoyarHtml = readFileSync(join(STATIC, 'apoyar', 'index.html'), 'utf8');
  assert.match(apoyarHtml, /Apoya SWAL/i, 'el título de apoyar debe contener Apoya SWAL');

  const extHtml = readFileSync(join(STATIC, 'extension', 'index.html'), 'utf8');
  assert.match(extHtml, /Extensión para Binance/i, 'el título de extensión debe contener Extensión para Binance');
});

test('enlaces de pie en las páginas con pie compartido', () => {
  const pagesWithSharedFooter = [
    'index.html',
    'pricing/index.html',
    'terms/index.html',
    'privacy/index.html',
    'risk/index.html',
    'contact/index.html',
    'extension-privacy/index.html',
    'offline/index.html',
    'apoyar/index.html',
    'extension/index.html',
  ];

  for (const rel of pagesWithSharedFooter) {
    const html = readFileSync(join(STATIC, rel), 'utf8');
    assert.match(html, /<footer class="site-footer">/, `${rel} debe tener .site-footer`);
    assert.match(html, /href="\/apoyar\/"/, `${rel} debe enlazar a /apoyar/`);
    assert.match(html, /href="\/extension\/"/, `${rel} debe enlazar a /extension/`);
  }
});

test('sin scripts en línea en apoyar ni extensión', () => {
  for (const p of ['apoyar', 'extension']) {
    const html = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const match of scriptTags) {
      const attrs = match[1];
      const inlineContent = match[2].trim();
      assert.match(attrs, /src="[^"]+"/, `${p} tiene script sin src`);
      assert.equal(inlineContent, '', `${p} no debe tener código inline en el tag script`);
    }
  }
});

test('entradas en sitemap.xml para apoyar y extensión', () => {
  const sitemap = readFileSync(join(STATIC, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/trade\.swal\.network\/apoyar\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/trade\.swal\.network\/extension\/<\/loc>/);
});

test('apoyar.js muestra "Disponible pronto" con configuración vacía', () => {
  assert.equal(DONATION_CONFIG.GITHUB_SPONSORS_URL, '', 'GITHUB_SPONSORS_URL debe iniciar vacío');
  assert.deepEqual(DONATION_CONFIG.CRYPTO_WALLETS, [], 'CRYPTO_WALLETS debe iniciar vacío');

  function createNode(tag = '', id = '') {
    return {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      _rawText: '',
      children: [],
      get textContent() {
        if (this.children.length > 0) {
          return this.children.map(c => c.textContent).join(' ');
        }
        return this._rawText;
      },
      set textContent(v) {
        this._rawText = String(v ?? '');
      },
      replaceChildren(...nodes) {
        this.children = nodes;
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
    };
  }

  function makeMockDoc() {
    const sponsorsEl = createNode('div', 'sponsors-container');
    const cryptoEl = createNode('div', 'crypto-container');
    return {
      getElementById(id) {
        if (id === 'sponsors-container') return sponsorsEl;
        if (id === 'crypto-container') return cryptoEl;
        return null;
      },
      createElement(tag) {
        return createNode(tag);
      },
      _sponsorsEl: sponsorsEl,
      _cryptoEl: cryptoEl,
    };
  }

  // Con configuración vacía (hoy)
  const doc = makeMockDoc();
  renderSupport(DONATION_CONFIG, doc);
  assert.match(doc._sponsorsEl.textContent, /Disponible pronto/i);
  assert.match(doc._cryptoEl.textContent, /Disponible pronto/i);

  // Cuando se añade una URL de sponsors
  const doc2 = makeMockDoc();
  renderSupport({ GITHUB_SPONSORS_URL: 'https://github.com/sponsors/iberi22', CRYPTO_WALLETS: [] }, doc2);
  assert.equal(doc2._sponsorsEl.children[0].tagName, 'A');
  assert.equal(doc2._sponsorsEl.children[0].href, 'https://github.com/sponsors/iberi22');

  // Cuando se añade una wallet cripto
  const doc3 = makeMockDoc();
  renderSupport({
    GITHUB_SPONSORS_URL: '',
    CRYPTO_WALLETS: [{ network: 'Bitcoin', asset: 'BTC', address: 'real_address_example' }]
  }, doc3);
  assert.equal(doc3._cryptoEl.children[0].tagName, 'UL');
  assert.match(doc3._cryptoEl.textContent, /BTC \(Bitcoin\)/);
});

test('sin direcciones cripto inventadas en el código', () => {
  for (const f of ['apoyar/index.html', 'apoyar/apoyar.js', 'extension/index.html']) {
    const text = readFileSync(join(STATIC, f), 'utf8');
    // Patrones de direcciones cripto reales o inventadas (BTC, ETH, Tron, Solana)
    assert.doesNotMatch(text, /\b0x[a-fA-F0-9]{40}\b/, `dirección EVM encontrada en ${f}`);
    assert.doesNotMatch(text, /\bbc1[a-z0-9]{38,59}\b/, `dirección Bech32 encontrada en ${f}`);
    assert.doesNotMatch(text, /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/, `dirección legacy Bitcoin encontrada en ${f}`);
    assert.doesNotMatch(text, /\bT[A-Za-z1-9]{33}\b/, `dirección Tron encontrada en ${f}`);
  }
});

test('landing tiene fila clara de CTAs', () => {
  const html = readFileSync(join(STATIC, 'index.html'), 'utf8');
  assert.match(html, /<a[^>]+href="\/analisis\/"[^>]*>Analizar un gráfico<\/a>/);
  assert.match(html, /<a[^>]+href="\/extension\/"[^>]*>Instalar la extensión<\/a>/);
  assert.match(html, /<a[^>]+href="\/guardian\/"[^>]*>Guardián de riesgo<\/a>/);
  assert.match(html, /<a[^>]+href="\/apoyar\/"[^>]*>Apoya SWAL<\/a>/);
});
