#!/usr/bin/env node
// Verifica el contenido del glosario sin dependencias.
// Uso (desde apps/extension): node scripts/glossary-check.mjs
// Comprueba: claves de prosa de cada entrada, claves huérfanas, longitudes,
// palabras prohibidas, marcadores {x} bien formados y texto plano.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/glossary');
const entriesSrc = readFileSync(resolve(root, 'entries.ts'), 'utf8');
const messages = JSON.parse(readFileSync(resolve(root, 'glossary.es.json'), 'utf8'));

const FIELDS = ['title', 'short', 'what', 'read', 'up', 'down', 'range', 'watch'];
const LIMITS = { title: 60, short: 110, what: 320, read: 320, up: 220, down: 220, range: 220, watch: 220 };
const CATEGORIES = ['niveles', 'patrones', 'sentimiento', 'cierres', 'flujo', 'riesgo', 'escaner'];
const REQUIRED_UI = [
  'search_placeholder', 'view_in_learn', 'measured_history', 'insufficient', 'vs_chance', 'n_events',
  'past_frequency', 'current_trend', 'trend_up', 'trend_down', 'trend_range',
  'disclaimer_reference', 'disclaimer_no_edge',
];
const REQUIRED_STATS = ['promising', 'no_evidence', 'negative', 'none'];
const PLACEHOLDERS = new Set(['n', 'rate', 'low', 'high', 'baseline', 'lift', 'trend']);

// Palabras prohibidas (sin tildes, minúsculas). `\b` solo en las que son palabra completa.
const FORBIDDEN = [
  { re: /\bcomprar\b/, label: 'comprar' },
  { re: /\bvender\b/, label: 'vender' },
  { re: /\bentra\b/, label: 'entra' },
  { re: /senal de compra/, label: 'señal de compra' },
  { re: /senal de venta/, label: 'señal de venta' },
  { re: /garantiz/, label: 'garantiz*' },
  { re: /\bsiempre\b/, label: 'siempre' },
  { re: /\bseguro\b/, label: 'seguro' },
];
const FORBIDDEN_OUTSIDE_STATS = [
  { re: /win rate/, label: 'win rate' },
  { re: /tasa de acierto/, label: 'tasa de acierto' },
];

const plain = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const errors = [];
const fail = (message) => errors.push(message);

const ids = [...entriesSrc.matchAll(/^ {4}id: '([^']+)'/gm)].map((m) => m[1]);
const categories = [...entriesSrc.matchAll(/^ {4}category: '([^']+)'/gm)].map((m) => m[1]);
if (ids.length === 0) fail('entries.ts: no se encontraron entradas');
if (new Set(ids).size !== ids.length) fail('entries.ts: ids repetidos');
if (categories.length !== ids.length) fail('entries.ts: hay entradas sin category');
for (const category of categories) if (!CATEGORIES.includes(category)) fail(`categoría desconocida: ${category}`);

for (const id of ids) {
  for (const field of FIELDS) {
    const key = `glossary.${id}.${field}`;
    const value = messages[key];
    if (typeof value !== 'string' || value.trim() === '') fail(`falta la clave ${key}`);
  }
}
for (const category of CATEGORIES) {
  if (typeof messages[`glossary.category.${category}`] !== 'string') fail(`falta glossary.category.${category}`);
}
for (const name of REQUIRED_UI) if (typeof messages[`glossary.ui.${name}`] !== 'string') fail(`falta glossary.ui.${name}`);
for (const name of REQUIRED_STATS) if (typeof messages[`glossary.stats.${name}`] !== 'string') fail(`falta glossary.stats.${name}`);

const known = new Set(ids);
for (const [key, value] of Object.entries(messages)) {
  if (typeof value !== 'string') {
    fail(`${key}: el valor no es texto`);
    continue;
  }
  const parts = key.split('.');
  if (parts[0] !== 'glossary') fail(`${key}: clave fuera del espacio glossary.`);
  const isProse = parts.length === 3 && known.has(parts[1]);
  const isStats = parts[1] === 'stats';
  if (isProse) {
    const field = parts[2];
    if (!FIELDS.includes(field)) fail(`${key}: campo desconocido`);
    else if (value.length > LIMITS[field]) fail(`${key}: ${value.length} caracteres (máximo ${LIMITS[field]})`);
  } else if (parts[1] !== 'category' && parts[1] !== 'ui' && !isStats) {
    fail(`${key}: clave huérfana (el id no existe en entries.ts)`);
  }
  if (/[\r\n]/.test(value)) fail(`${key}: contiene saltos de línea`);
  if (/[<>`]|\*\*|^#|\]\(/.test(value)) fail(`${key}: HTML o markdown`);
  const text = plain(value);
  for (const { re, label } of FORBIDDEN) if (re.test(text)) fail(`${key}: palabra prohibida "${label}"`);
  if (!isStats) {
    for (const { re, label } of FORBIDDEN_OUTSIDE_STATS) if (re.test(text)) fail(`${key}: "${label}" fuera de glossary.stats`);
  }
  // Marcadores: solo {nombre} con nombre conocido; sin llaves sueltas.
  const names = [...value.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  for (const name of names) if (!PLACEHOLDERS.has(name)) fail(`${key}: marcador no válido {${name}}`);
  if (/[{}]/.test(value.replace(/\{[^{}]*\}/g, ''))) fail(`${key}: llave sin cerrar`);
  if (isProse && names.length > 0) fail(`${key}: la prosa no admite marcadores (las cifras vienen de stats.json)`);
  if (isProse && /\d+\s?%\s+(de los casos|de acierto)/.test(text)) fail(`${key}: cifra de acierto en la prosa`);
}

if (errors.length > 0) {
  console.error(`glossary-check: ${errors.length} problema(s)`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`glossary-check: OK (${ids.length} entradas, ${Object.keys(messages).length} claves)`);
