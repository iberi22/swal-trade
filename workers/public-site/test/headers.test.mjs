import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('_headers has correct cache control and csp', () => {
  const content = fs.readFileSync(new URL('../static/_headers', import.meta.url), 'utf8');

  assert(!content.includes('immutable'), 'should not contain immutable');

  const lines = content.split('\n');
  const rules = new Map();
  let currentPath = null;

  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      currentPath = line.trim();
      if (!rules.has(currentPath)) {
        rules.set(currentPath, []);
      }
    } else if (currentPath) {
      rules.get(currentPath).push(line.trim());
    }
  }

  // Cache-Control assertions
  const maxAgeRe = /max-age=(\d+)/;

  for (const [path, headers] of rules.entries()) {
    for (const header of headers) {
      const match = header.match(maxAgeRe);
      if (match) {
        assert(parseInt(match[1], 10) <= 86400, `max-age should not exceed 86400 in path ${path}`);
      }
    }
  }

  const getHeader = (path, name) => {
    const headers = rules.get(path) || [];
    const prefix = name + ':';
    const found = headers.find(h => h.startsWith(prefix));
    return found ? found.slice(prefix.length).trim() : null;
  };

  assert.equal(getHeader('/*.css', 'Cache-Control'), 'public, max-age=300, must-revalidate');
  assert.equal(getHeader('/*.js', 'Cache-Control'), 'public, max-age=300, must-revalidate');
  assert.equal(getHeader('/*/*.js', 'Cache-Control'), 'public, max-age=300, must-revalidate');
  assert.equal(getHeader('/*/*/*.js', 'Cache-Control'), 'public, max-age=300, must-revalidate');

  assert.equal(getHeader('/favicon.svg', 'Cache-Control'), 'public, max-age=86400');

  assert.equal(getHeader('/*.html', 'Cache-Control'), 'no-cache');
  assert.equal(getHeader('/', 'Cache-Control'), 'no-cache');

  assert.equal(getHeader('/sitemap.xml', 'Cache-Control'), 'public, max-age=3600');
  assert.equal(getHeader('/robots.txt', 'Cache-Control'), 'public, max-age=3600');

  // CSP assertions
  const cspCheckout = getHeader('/checkout/*', 'Content-Security-Policy');
  assert(cspCheckout.includes('connect-src \'self\' https://pay.swal.network'), 'checkout csp should have correct connect-src');

  const cspGuardian = getHeader('/guardian/*', 'Content-Security-Policy');
  assert(cspGuardian.includes('connect-src \'self\' https://fapi.binance.com https://api.binance.com https://api.telegram.org https://pay.swal.network'), 'guardian csp should have correct connect-src');

  const cspAnalisis = getHeader('/analisis/*', 'Content-Security-Policy');
  assert(cspAnalisis.includes('connect-src \'self\' https://fapi.binance.com wss://fstream.binance.com https://api.alternative.me'), 'analisis csp should have correct connect-src');

  const cspBackup = getHeader('/backup/*', 'Content-Security-Policy');
  assert(cspBackup.includes('connect-src \'self\' https://pay.swal.network'), 'backup csp should have correct connect-src');
});
