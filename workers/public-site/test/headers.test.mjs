import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('_headers has correct cache control and csp', () => {
  const content = fs.readFileSync(new URL('../static/_headers', import.meta.url), 'utf8');

  assert(!content.includes('immutable'), 'should not contain immutable');

  const lines = content.split('\n');
  const rawRules = new Map(); // Keep raw pattern to rules mapping
  let currentPath = null;

  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      currentPath = line.trim();
      if (!rawRules.has(currentPath)) {
        rawRules.set(currentPath, []);
      }
    } else if (currentPath) {
      rawRules.get(currentPath).push(line.trim());
    }
  }

  // Cache-Control assertions for raw rules max-age
  const maxAgeRe = /max-age=(\d+)/;
  for (const [path, headers] of rawRules.entries()) {
    for (const header of headers) {
      const match = header.match(maxAgeRe);
      if (match) {
        assert(parseInt(match[1], 10) <= 86400, `max-age should not exceed 86400 in path ${path}`);
      }
    }
  }

  // Splat matcher logic
  const getHeadersForPath = (targetPath) => {
    let resolvedHeaders = [];
    for (const [pattern, headers] of rawRules.entries()) {
      // Very basic splat matcher: replace * with .* and ^pattern$
      // Cloudflare splats matches anything
      const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
      const re = new RegExp(regexStr);
      if (re.test(targetPath)) {
        resolvedHeaders = resolvedHeaders.concat(headers);
      }
    }
    return resolvedHeaders;
  };

  const getHeaderValue = (headers, name) => {
    const prefix = name + ':';
    // Cloudflare joins them with a comma if multiple match
    const matching = headers.filter(h => h.startsWith(prefix)).map(h => h.slice(prefix.length).trim());
    if (matching.length === 0) return null;
    return matching.join(', ');
  };

  const assertPathHeader = (path, name, expected) => {
    const headers = getHeadersForPath(path);
    const value = getHeaderValue(headers, name);
    assert.equal(value, expected, `Expected header ${name} for path ${path} to be ${expected}, got ${value}`);
  }

  // Check that no path gets two Cache-Control rules joined
  assertPathHeader('/analisis/analisis.js', 'Cache-Control', 'public, max-age=300, must-revalidate');
  assertPathHeader('/tokens.css', 'Cache-Control', 'public, max-age=300, must-revalidate');
  assertPathHeader('/pricing/', 'Cache-Control', 'no-cache');
  assertPathHeader('/', 'Cache-Control', 'no-cache');
  assertPathHeader('/index.html', 'Cache-Control', 'no-cache');
  assertPathHeader('/favicon.svg', 'Cache-Control', 'public, max-age=86400');
  assertPathHeader('/sitemap.xml', 'Cache-Control', 'public, max-age=3600');
  assertPathHeader('/robots.txt', 'Cache-Control', 'public, max-age=3600');

  // CSP assertions (CSP detaches with ! so we just check raw patterns or check it ends with correct CSP)
  const cspCheckout = getHeaderValue(rawRules.get('/checkout/*'), 'Content-Security-Policy');
  assert(cspCheckout.includes('connect-src \'self\' https://pay.swal.network'), 'checkout csp should have correct connect-src');

  const cspGuardian = getHeaderValue(rawRules.get('/guardian/*'), 'Content-Security-Policy');
  assert(cspGuardian.includes('connect-src \'self\' https://fapi.binance.com https://api.binance.com https://api.telegram.org https://pay.swal.network'), 'guardian csp should have correct connect-src');

  const cspAnalisis = getHeaderValue(rawRules.get('/analisis/*'), 'Content-Security-Policy');
  assert(cspAnalisis.includes('connect-src \'self\' https://fapi.binance.com wss://fstream.binance.com https://api.alternative.me'), 'analisis csp should have correct connect-src');

  const cspBackup = getHeaderValue(rawRules.get('/backup/*'), 'Content-Security-Policy');
  assert(cspBackup.includes('connect-src \'self\' https://pay.swal.network'), 'backup csp should have correct connect-src');
});
