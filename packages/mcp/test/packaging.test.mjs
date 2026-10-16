import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCorePath, packageRoot, DEFAULT_CORE_RELATIVE, PACKAGED_CORE_RELATIVE } from '../dist/core.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveCorePath: en un checkout usa el fichero del repo', () => {
  assert.equal(resolveCorePath({}), path.resolve(packageRoot(), DEFAULT_CORE_RELATIVE));
});

test('resolveCorePath: instalado sin repo, usa la copia empaquetada', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'swal-pkg-'));
  try {
    mkdirSync(path.join(root, 'core'));
    copyFileSync(path.join(PKG, DEFAULT_CORE_RELATIVE), path.join(root, PACKAGED_CORE_RELATIVE));
    assert.equal(resolveCorePath({}, root), path.join(root, PACKAGED_CORE_RELATIVE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCorePath: sin repo ni copia devuelve la ruta del repo (el error la nombra)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'swal-pkg-'));
  try {
    assert.equal(resolveCorePath({}, root), path.resolve(root, DEFAULT_CORE_RELATIVE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCorePath: SWAL_ANALYSIS_CORE manda sobre todo', () => {
  assert.equal(resolveCorePath({ SWAL_ANALYSIS_CORE: '/tmp/otro-core.js' }), '/tmp/otro-core.js');
});

test('npm run build deja listos el núcleo y la licencia para empaquetar (sin depender de prepack)', () => {
  rmSync(path.join(PKG, 'core'), { recursive: true, force: true });
  rmSync(path.join(PKG, 'LICENSE'), { force: true });
  execFileSync('node', [path.join(PKG, 'scripts/bundle-core.mjs')], { stdio: 'pipe' });
  assert.ok(existsSync(path.join(PKG, 'core/analysis-core.js')));
  assert.ok(existsSync(path.join(PKG, 'LICENSE')));
});

test('el tarball incluye binarios, núcleo y licencia, y no incluye fuentes ni tests', () => {
  execFileSync('node', [path.join(PKG, 'scripts/bundle-core.mjs')], { stdio: 'pipe' });
  assert.ok(existsSync(path.join(PKG, PACKAGED_CORE_RELATIVE)));
  const out = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: PKG, encoding: 'utf8' });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const must of ['dist/index.js', 'dist/bridge-daemon.js', 'core/analysis-core.js', 'LICENSE', 'README.md', 'package.json']) {
    assert.ok(files.includes(must), `falta ${must} en el tarball`);
  }
  for (const f of files) {
    assert.ok(!/^(src|test|scripts)\//.test(f), `no debe publicarse ${f}`);
    assert.ok(!/\.(env|pem|key)$/.test(f), `no debe publicarse ${f}`);
  }
});
