// Comprueba los catálogos de src/locales. Gemelo en Node de src/lib/i18n/check.ts.
// Uso: node scripts/i18n-check.mjs [--allow-missing]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowMissing = process.argv.includes('--allow-missing');

const localesTs = readFileSync(join(root, 'src/lib/i18n/locales.ts'), 'utf8');
const codes = [...localesTs.matchAll(/\{ code: '([^']+)', nativeName/g)].map((m) => m[1]);
if (codes.length !== 20) {
  console.error(`Se esperaban 20 locales en locales.ts y hay ${codes.length}`);
  process.exit(1);
}

const isFlat = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
const placeholders = (s) => [...new Set([...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();

const files = {};
const errors = [];
const warnings = [];
for (const code of codes) {
  const path = join(root, 'src/locales', `${code}.json`);
  if (!existsSync(path)) continue;
  try {
    files[code] = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    files[code] = null;
    errors.push(`${code}: JSON inválido (${e.message})`);
  }
}

const src = files.es;
const srcOk = isFlat(src);
if (!srcOk) errors.push('es: fuente ausente o no es JSON plano de strings');
const rows = [];
for (const code of codes) {
  const data = files[code];
  if (data === undefined) {
    errors.push(`${code}: archivo ausente`);
    rows.push({ locale: code, missing: '-', extra: '-', problems: 'ausente' });
    continue;
  }
  if (!isFlat(data)) {
    if (data !== null) errors.push(`${code}: no es JSON plano de strings`);
    rows.push({ locale: code, missing: '-', extra: '-', problems: 'inválido' });
    continue;
  }
  if (!srcOk) continue;
  const missing = Object.keys(src).filter((k) => !(k in data));
  const extra = Object.keys(data).filter((k) => !(k in src));
  let problems = 0;
  for (const [k, v] of Object.entries(data)) {
    if (v.trim() === '') { errors.push(`${code}: valor vacío en ${k}`); problems++; }
    if (/[<>]/.test(v)) { errors.push(`${code}: HTML en ${k}`); problems++; }
    if (k in src && placeholders(v).join() !== placeholders(src[k]).join()) {
      errors.push(`${code}: placeholders distintos en ${k}`); problems++;
    }
  }
  for (const k of missing) (allowMissing ? warnings : errors).push(`${code}: falta ${k}`);
  for (const k of extra) errors.push(`${code}: sobra ${k}`);
  rows.push({ locale: code, missing: missing.length, extra: extra.length, problems });
}

console.table(rows);
for (const w of warnings) console.warn(`aviso  ${w}`);
for (const e of errors) console.error(`error  ${e}`);
if (errors.length > 0) {
  console.error(`i18n:check falló con ${errors.length} problema(s)`);
  process.exit(1);
}
console.log(`i18n:check ok (${codes.length} locales${warnings.length ? `, ${warnings.length} avisos` : ''})`);
