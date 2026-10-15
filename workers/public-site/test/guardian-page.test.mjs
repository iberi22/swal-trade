import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARDIAN = join(HERE, '..', 'static', 'guardian');
const HTML = readFileSync(join(GUARDIAN, 'index.html'), 'utf8');
const CSS = readFileSync(join(GUARDIAN, 'guardian.css'), 'utf8');

// Texto visible: título + cuerpo sin <script>, comentarios ni etiquetas.
const TITLE = HTML.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
const BODY = HTML.replace(/<head[\s\S]*?<\/head>/i, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]+>/g, ' ');
const VISIBLE = `${TITLE} ${BODY}`;

// Formas sin tilde de palabras que llevan tilde en español (sin tocar identificadores ni rutas).
const UNACCENTED = [
  /\bguardian\b/i, /\bposicion\b/i, /\blimite\b/i, /\bperdida\b/i, /\bmaximo\b/i,
  /\bgestion\b/i, /\bunicamente\b/i, /\basesoria\b/i, /\bpestana\b/i, /\beste abierta\b/i,
  /\bordenes\b/i, /\bcriptografica\b/i, /\bconfiguracion\b/i, /\bcodigo\b/i, /\bultimo\b/i,
  /\benvio\b/i, /\bdia\b/i, /\bde mas\b/i, /\baqui\b/i, /\btambien\b/i, /\bnumero\b/i,
  /\bdias\b/i, /\bminimo\b/i, /\bsesion\b/i, /\bconexion\b/i, /\bnotificacion\b/i,
  /\bsimbolo\b/i, /\bpublica\b/i, /\binvalida\b/i, /\bvalida\b/i, /\bautomaticamente\b/i,
  /\bejecutalo\b/i, /\bguia\b/i, /\bversion\b/i, /\blibreria\b/i, /\bestandar\b/i,
  /\benvia\b/i, /\bveras\b/i,
];

test('guardian: título y cabecera con la tilde correcta', () => {
  assert.match(TITLE, /^Guardián de riesgo/);
  assert.match(HTML, /<h1>Guardián de riesgo/);
});

test('guardian: sin formas sin tilde comunes en el texto visible', () => {
  for (const re of UNACCENTED) {
    const hit = VISIBLE.match(re);
    assert.equal(hit, null, `forma sin tilde "${hit?.[0]}" en el texto visible de /guardian/`);
  }
});

test('guardian: enlaza el favicon una sola vez y sin duplicar iconos ni manifiesto', () => {
  assert.match(HTML, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.equal((HTML.match(/rel="icon"/g) || []).length, 1, 'icono duplicado');
  assert.equal((HTML.match(/rel="manifest"/g) || []).length, 1, 'manifiesto duplicado');
  assert.equal((HTML.match(/rel="apple-touch-icon"/g) || []).length, 1, 'apple-touch-icon duplicado');
});

test('guardian.css: el punto de estado solo se pinta si el elemento tiene texto', () => {
  // Un <p class="err"> vacío (el error del formulario) no debe mostrar "●" bajo el botón.
  assert.doesNotMatch(CSS, /\.(err|ok)::before/);
  assert.match(CSS, /\.err:not\(:empty\)::before/);
  assert.match(CSS, /\.ok:not\(:empty\)::before/);
});
