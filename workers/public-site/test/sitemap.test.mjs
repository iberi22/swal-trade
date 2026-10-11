import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

function getDirsWithIndexHtml(dir, baseDir) {
  const out = [];
  const entries = readdirSync(dir);

  if (entries.includes('index.html')) {
    const rel = dir === baseDir ? '' : dir.slice(baseDir.length + 1) + '/';
    out.push(rel);
  }

  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...getDirsWithIndexHtml(p, baseDir));
    }
  }
  return out;
}

test('sitemap.xml has expected urls', () => {
  const sitemap = readFileSync(join(STATIC, 'sitemap.xml'), 'utf8');

  // Extract URLs from <loc> tags
  const matches = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)];
  const locs = matches.map(m => m[1]);

  // No duplicate locs
  const uniqueLocs = new Set(locs);
  assert.equal(locs.length, uniqueLocs.size, 'Duplicate URLs in sitemap');

  const dirs = getDirsWithIndexHtml(STATIC, STATIC);
  const expectedLocs = [];
  for (const dir of dirs) {
    if (dir.startsWith('checkout/')) continue;
    expectedLocs.push(`https://trade.swal.network/${dir}`);
  }

  // Assert locs set equals expected set
  const expectedSet = new Set(expectedLocs);
  const actualSet = new Set(locs);

  for (const loc of expectedSet) {
    assert.ok(actualSet.has(loc), `Missing ${loc} in sitemap`);
  }

  for (const loc of actualSet) {
    assert.ok(expectedSet.has(loc), `Unexpected ${loc} in sitemap`);
  }
});

test('robots.txt disallows checkout and references sitemap', () => {
  const robots = readFileSync(join(STATIC, 'robots.txt'), 'utf8');
  assert.match(robots, /Disallow:\s*\/checkout\//, 'robots.txt should disallow /checkout/');
  assert.match(robots, /Sitemap:\s*https:\/\/trade\.swal\.network\/sitemap\.xml/, 'robots.txt should reference sitemap');
});
