import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const rel = (p) => '/' + p.slice(STATIC.length + 1).replace(/index\.html$/, '');
const all = htmlFiles(STATIC);
// Páginas de marketing/legales de esta isla. operativa (panel con KPIs), guardian y checkout son de otros dueños.
const PUBLIC = ['/', '/pricing/', '/terms/', '/privacy/', '/risk/', '/contact/', '/extension-privacy/', '/apoyar/', '/extension/'];
const OTHER_OWNED = ['/guardian/', '/checkout/'];

const FORBIDDEN = /ganancia[s]? garantizad|rentabilidad|win\s?rate|ingreso[s]? pasivo|retorno[s]? garantizad|\bROI\b|\+\d+(\.\d+)?\s?%/i;

test('páginas públicas existen', () => {
  for (const p of PUBLIC) assert.ok(existsSync(join(STATIC, p, 'index.html')), p);
  assert.ok(existsSync(join(STATIC, 'operativa', 'index.html')));
  for (const f of ['sitemap.xml', 'robots.txt', 'favicon.svg', 'site.css']) assert.ok(existsSync(join(STATIC, f)), f);
});

test('sin afirmaciones de rentabilidad (excepto la advertencia de /risk/)', () => {
  for (const p of PUBLIC) {
    let text = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    if (p === '/risk/') text = text.replaceAll('rentabilidad pasada', ''); // advertencia legal permitida
    assert.doesNotMatch(text, FORBIDDEN, `afirmación prohibida en ${p}`);
  }
});

test('cada página enlaza aviso de riesgo, descargo y pie', () => {
  for (const f of all) {
    const r = rel(f);
    if (OTHER_OWNED.some((o) => r.startsWith(o))) continue;
    const t = readFileSync(f, 'utf8');
    assert.match(t, /href="\/risk\/"/, `${r} sin enlace a /risk/`);
    assert.match(t, /href="\/terms\/"/, `${r} sin enlace a /terms/`);
    assert.match(t, /href="\/privacy\/"/, `${r} sin enlace a /privacy/`);
  }
  for (const p of PUBLIC) {
    const t = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    assert.match(t, /No es asesoría financiera; operar futuros con apalancamiento puede hacerte perder todo tu capital/, p);
    assert.match(t, /<footer class="site-footer">/, p);
  }
});

test('páginas legales marcadas como borrador y con SEO básico', () => {
  for (const p of ['/terms/', '/privacy/', '/risk/', '/contact/']) {
    assert.match(readFileSync(join(STATIC, p, 'index.html'), 'utf8'), /Borrador pendiente de revisión legal/, p);
  }
  for (const p of PUBLIC) {
    const t = readFileSync(join(STATIC, p, 'index.html'), 'utf8');
    for (const re of [/<title>[^<]+<\/title>/, /<meta name="description"/, /<link rel="canonical"/, /<meta property="og:title"/]) assert.match(t, re, `${p} ${re}`);
  }
});

test('enlaces internos resuelven a archivos existentes', () => {
  for (const f of all) {
    const r = rel(f);
    if (OTHER_OWNED.some((o) => r.startsWith(o))) continue;
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/(?:href|src)="([^"#?]*)(?:[?#][^"]*)?"/g)) {
      const u = m[1];
      if (!u || /^(https?:|mailto:|data:)/.test(u)) continue;
      const path = u.startsWith('/') ? u : join(r.endsWith('/') ? r : dirname(r), u);
      if (OTHER_OWNED.some((o) => path.startsWith(o))) continue; // las construye otro agente
      const target = path.endsWith('/') ? join(STATIC, path, 'index.html') : join(STATIC, path);
      assert.ok(existsSync(target), `${r} enlaza a ${u} que no existe`);
    }
  }
});

test('sin recursos de terceros en HTML ni CSS propios', () => {
  for (const f of all) {
    const r = rel(f);
    if (OTHER_OWNED.some((o) => r.startsWith(o))) continue;
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /<(?:script|img)[^>]+src="https?:\/\//i, r);
    assert.doesNotMatch(t, /<link[^>]+rel="stylesheet"[^>]+href="https?:\/\//i, r);
  }
  assert.doesNotMatch(readFileSync(join(STATIC, 'site.css'), 'utf8'), /https?:\/\//);
});
