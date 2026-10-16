import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const html = readFileSync(join(STATIC, 'checkout', 'index.html'), 'utf8');
const js = readFileSync(join(STATIC, 'checkout', 'checkout.js'), 'utf8');

test('checkout: tiene el paso de acceso gratuito y los ids que usa el script', () => {
  for (const id of ['step-free', 'free-line', 'btn-free', 'intro', 'done-title']) {
    assert.match(html, new RegExp(`id="${id}"`), `falta #${id}`);
  }
  assert.match(html, /id="step-free" class="card hidden"/, 'el paso gratuito arranca oculto');
  assert.doesNotMatch(html, /Hazte socio Pro/);
});

test('checkout: solo usa la fase gratuita si el servidor publica free_until vigente', () => {
  assert.match(js, /data\.free_until && new Date\(data\.free_until\) > new Date\(\)/);
  assert.match(js, /if \(state\.freeUntil\) \{ show\('step-free'\); return; \}/);
});

test('checkout: activar el acceso pide la licencia con el secreto de la cuenta, sin factura', () => {
  assert.match(js, /btn-free'\)\.addEventListener\('click'/);
  assert.match(js, /fetchLicense\(\)/);
  assert.match(js, /lic\.plan === 'early_access'/);
});

test('checkout: en la fase gratuita no se reanuda ninguna factura vieja', () => {
  assert.match(js, /state\.freeUntil \? null : safeParse\(localStorage\.getItem\(LS_INVOICE\)/);
});
