import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_CONFIG, renderInstallOffer } from '../static/instalacion/instalacion.js';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const PAGE = join(STATIC, 'instalacion', 'index.html');
const SCRIPT = join(STATIC, 'instalacion', 'instalacion.js');

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
  const offerEl = createNode('div', 'install-offer');
  return {
    getElementById(id) {
      return id === 'install-offer' ? offerEl : null;
    },
    createElement(tag) {
      return createNode(tag);
    },
    _offerEl: offerEl,
  };
}

function findAll(node, tag) {
  const out = [];
  for (const c of node.children) {
    if (c.tagName === tag) out.push(c);
    out.push(...findAll(c, tag));
  }
  return out;
}

test('página y script de instalación asistida existen', () => {
  assert.ok(existsSync(PAGE), 'falta static/instalacion/index.html');
  assert.ok(existsSync(SCRIPT), 'falta static/instalacion/instalacion.js');
});

test('sin scripts en línea en instalación asistida', () => {
  const html = readFileSync(PAGE, 'utf8');
  assert.match(html, /<script type="module" src="\/instalacion\/instalacion\.js"><\/script>/);
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const match of scriptTags) {
    assert.match(match[1], /src="[^"]+"/, 'script sin src');
    assert.equal(match[2].trim(), '', 'no debe tener código inline en el tag script');
  }
});

test('título y metadatos de instalación asistida', () => {
  const html = readFileSync(PAGE, 'utf8');
  assert.match(html, /<title>Instalación asistida[^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/trade\.swal\.network\/instalacion\/">/);
  assert.match(html, /<meta property="og:title" content="Instalación asistida[^"]*">/);
  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /href="\/risk\/"/);
  assert.match(html, /href="\/terms\/"/);
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/extension\/"/, 'debe enlazar a /extension/');
  assert.match(html, /href="\/guardian\/"/, 'debe enlazar a /guardian/');
});

test('instalación asistida declara qué no incluye y la seguridad', () => {
  const html = readFileSync(PAGE, 'utf8');
  assert.match(html, /Qué no incluye/);
  assert.match(html, /Señales de trading/);
  assert.match(html, /Ninguna promesa de ganancias/);
  assert.match(html, /Nunca operamos por ti/);
  assert.match(html, /Tu seguridad/);
  assert.match(html, /Nunca te pediremos tu contraseña, tus códigos 2FA/);
  assert.match(html, /solo de lectura y no debe tener permiso de retiro/);
  assert.match(html, /nunca se envía a nuestros servidores/);
  assert.match(html, /puedes eliminar la clave en cualquier momento/);
  assert.match(html, /id="install-offer"/);
});

test('instalación asistida no usa em dash ni signos de exclamación', () => {
  const html = readFileSync(PAGE, 'utf8');
  const js = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(html, /—/, 'em dash en la página');
  assert.doesNotMatch(js, /—/, 'em dash en el script');
  assert.doesNotMatch(html.replace(/<!DOCTYPE[^>]*>/i, ''), /!/, 'signo de exclamación en la página');
});

test('entrada en sitemap.xml para instalación asistida', () => {
  const sitemap = readFileSync(join(STATIC, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<url><loc>https:\/\/trade\.swal\.network\/instalacion\/<\/loc><\/url>/);
});

test('apoyar y extensión enlazan a instalación asistida', () => {
  for (const p of ['apoyar', 'extension']) {
    const html = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    assert.match(html, /<a href="\/instalacion\/">Ver instalación asistida<\/a>/, `${p} debe enlazar a /instalacion/`);
  }
});

test('configuración vacía muestra "Disponible pronto"', () => {
  assert.equal(INSTALL_CONFIG.PRICE_TEXT, '', 'PRICE_TEXT debe iniciar vacío');
  assert.equal(INSTALL_CONFIG.CONTACT_URL, '', 'CONTACT_URL debe iniciar vacío');
  assert.deepEqual(INSTALL_CONFIG.PAYMENT_METHODS, [], 'PAYMENT_METHODS debe iniciar vacío');

  const doc = makeMockDoc();
  renderInstallOffer(INSTALL_CONFIG, doc);
  assert.equal(doc._offerEl.children.length, 1);
  assert.equal(doc._offerEl.children[0].tagName, 'P');
  assert.equal(doc._offerEl.children[0].id, 'install-status');
  assert.match(doc._offerEl.textContent, /^Disponible pronto\. Estamos preparando la agenda y los medios de pago\.$/);
  assert.equal(findAll(doc._offerEl, 'A').length, 0);
});

test('precio sin contacto, o contacto sin precio, sigue en "Disponible pronto"', () => {
  for (const config of [
    { PRICE_TEXT: 'Sesión de 45 minutos', CONTACT_URL: '', PAYMENT_METHODS: ['Transferencia'] },
    { PRICE_TEXT: '   ', CONTACT_URL: 'https://example.com/agenda', PAYMENT_METHODS: [] },
  ]) {
    const doc = makeMockDoc();
    renderInstallOffer(config, doc);
    assert.match(doc._offerEl.textContent, /Disponible pronto/);
    assert.equal(findAll(doc._offerEl, 'A').length, 0);
  }
});

test('configuración completa muestra precio, medios de pago y enlace https', () => {
  const doc = makeMockDoc();
  renderInstallOffer({
    PRICE_TEXT: 'Sesión de 45 minutos: 1 pago por adelantado',
    CONTACT_URL: 'https://example.com/agenda/instalacion',
    PAYMENT_METHODS: ['Transferencia bancaria', '<img src=x onerror=alert(1)>'],
  }, doc);

  const price = findAll(doc._offerEl, 'P').find(p => p.className === 'price');
  assert.ok(price, 'falta el precio');
  assert.equal(price.textContent, 'Sesión de 45 minutos: 1 pago por adelantado');

  const items = findAll(doc._offerEl, 'LI').map(li => li.textContent);
  assert.deepEqual(items, ['Transferencia bancaria', '<img src=x onerror=alert(1)>'], 'medios de pago como texto plano');

  const links = findAll(doc._offerEl, 'A');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/agenda/instalacion');
  assert.equal(links[0].className, 'btn');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

test('contacto mailto: se acepta como enlace', () => {
  const doc = makeMockDoc();
  renderInstallOffer({ PRICE_TEXT: 'Precio por confirmar', CONTACT_URL: 'mailto:contacto@example.com', PAYMENT_METHODS: [] }, doc);
  const links = findAll(doc._offerEl, 'A');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'mailto:contacto@example.com');
});

test('javascript: en CONTACT_URL se trata como no configurado', () => {
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hola', 'http://example.com/agenda', '/agenda']) {
    const doc = makeMockDoc();
    renderInstallOffer({ PRICE_TEXT: 'Precio de prueba', CONTACT_URL: bad, PAYMENT_METHODS: ['Transferencia'] }, doc);
    assert.match(doc._offerEl.textContent, /Disponible pronto/, `${bad} debe tratarse como no configurado`);
    assert.equal(findAll(doc._offerEl, 'A').length, 0, `${bad} no debe generar enlace`);
  }
});

test('instalacion.js no tiene precios, teléfonos ni wallets escritos a mano', () => {
  const js = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(js, /\$\s?\d|\d\s?(USD|USDT|EUR|COP|€)\b/i, 'precio escrito en el código');
  assert.doesNotMatch(js, /\+\d[\d\s-]{6,}\d/, 'teléfono escrito en el código');
  assert.doesNotMatch(js, /\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/, 'número de teléfono escrito en el código');
  assert.doesNotMatch(js, /\b0x[a-fA-F0-9]{40}\b/, 'dirección EVM escrita en el código');
  assert.doesNotMatch(js, /\bbc1[a-z0-9]{38,59}\b/, 'dirección Bech32 escrita en el código');
  assert.doesNotMatch(js, /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/, 'dirección legacy escrita en el código');
  assert.doesNotMatch(js, /\bT[A-Za-z1-9]{33}\b/, 'dirección Tron escrita en el código');
});
