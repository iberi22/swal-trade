import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (dir, f) => readFileSync(join(ROOT, dir, f), 'utf8');

// Tablas que crean las migraciones.
const created = new Set();
for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql'))) {
  for (const m of read('migrations', f).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)) {
    created.add(m[1].toLowerCase());
  }
}

// Tablas que el codigo usa en sentencias SQL (INSERT INTO / FROM / UPDATE / DELETE FROM sobre D1).
// Solo se miran literales de cadena que empiezan por una sentencia SQL.
function tablesUsedBy(src) {
  const used = new Set();
  const stmt = /['"`]\s*(?:INSERT INTO|SELECT[^'"`]*?\bFROM|UPDATE|DELETE FROM)\s+([a-z_]+)/gi;
  for (const m of src.matchAll(stmt)) used.add(m[1].toLowerCase());
  return used;
}

test('toda tabla de D1 que usa el Worker existe en alguna migracion', () => {
  const missing = [];
  for (const f of readdirSync(join(ROOT, 'src')).filter((x) => x.endsWith('.js'))) {
    for (const t of tablesUsedBy(read('src', f))) {
      if (!created.has(t)) missing.push(`${f}: ${t}`);
    }
  }
  assert.deepEqual(missing, [], `tablas usadas sin migracion (D1_ERROR: no such table en produccion): ${missing.join(', ')}`);
});

test('el detector de esquema ve las tablas conocidas', () => {
  for (const t of ['snapshots', 'news', 'explain_kv', 'backups', 'heartbeats', 'backup_rate_limits']) {
    assert.ok(created.has(t), `la migracion de ${t} no se detecta`);
  }
});
