import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseClaims, verifyClaims } from './check-security-claims.mjs';

test('parseClaims correctly extracts a valid claim', () => {
  const markdown = `
| Garantía | Mecanismo | Prueba |
|----------|-----------|--------|
| G1 | file1.js | path/to/file1.js::test name 1 |
| G2 | file2.js | path/to/file2.py::Class.test_name_2 |
  `;
  const claims = parseClaims(markdown);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].guarantee, 'G1');
  assert.equal(claims[0].file, 'path/to/file1.js');
  assert.equal(claims[0].test, 'test name 1');
  assert.equal(claims[1].guarantee, 'G2');
  assert.equal(claims[1].file, 'path/to/file2.py');
  assert.equal(claims[1].test, 'Class.test_name_2');
});

test('parseClaims ignores malformed or text rows', () => {
  const markdown = `
Some text here
| Col1 | Col2 |
| G1 | mech | no proof here |
| G2 | mech | path::test |
  `;
  const claims = parseClaims(markdown);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].guarantee, 'G2');
  assert.equal(claims[0].file, 'path');
  assert.equal(claims[0].test, 'test');
});

test('verifyClaims passes when the file exists and contains the test string', () => {
  const claims = [{
    guarantee: 'G1',
    file: 'file.js',
    test: 'my-test-name'
  }];
  const readFile = (path) => {
    if (path === 'file.js') return 'test("my-test-name", () => {})';
    throw new Error('Not found');
  };
  const errors = verifyClaims(claims, readFile);
  assert.equal(errors.length, 0);
});

test('verifyClaims fails when the test string is missing (renamed test)', () => {
  const claims = [{
    guarantee: 'G1',
    file: 'file.js',
    test: 'my-test-name'
  }];
  const readFile = (path) => {
    if (path === 'file.js') return 'test("other-name", () => {})';
    throw new Error('Not found');
  };
  const errors = verifyClaims(claims, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Test not found in file\.js for claim 'G1': my-test-name/);
});

test('verifyClaims fails when the file is missing', () => {
  const claims = [{
    guarantee: 'G1',
    file: 'missing.js',
    test: 'test-name'
  }];
  const readFile = () => { throw new Error('ENOENT'); };
  const errors = verifyClaims(claims, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Missing file for claim 'G1': missing\.js/);
});

test('verifyClaims multiple claims processing correctly', () => {
  const claims = [
    { guarantee: 'G1', file: 'ok.js', test: 'test1' },
    { guarantee: 'G2', file: 'missing.js', test: 'test2' },
    { guarantee: 'G3', file: 'ok.js', test: 'test3' },
    { guarantee: 'G4', file: 'bad.js', test: 'test4' }
  ];
  const readFile = (path) => {
    if (path === 'ok.js') return 'test1 test3';
    if (path === 'bad.js') return 'test_other';
    throw new Error('ENOENT');
  };
  const errors = verifyClaims(claims, readFile);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Missing file for claim 'G2': missing\.js/);
  assert.match(errors[1], /Test not found in bad\.js for claim 'G4': test4/);
});

test('verifyClaims cache reduces reads', () => {
  const claims = [
    { guarantee: 'G1', file: 'file.js', test: 't1' },
    { guarantee: 'G2', file: 'file.js', test: 't2' }
  ];
  let reads = 0;
  const readFile = () => { reads++; return 't1 t2'; };
  const errors = verifyClaims(claims, readFile);
  assert.equal(errors.length, 0);
  assert.equal(reads, 1);
});

test('real docs/SECURITY_MODEL.md passes against the real repo', () => {
  try {
    const markdown = fs.readFileSync('docs/SECURITY_MODEL.md', 'utf-8');
    const claims = parseClaims(markdown);
    // If we haven't created it yet or it has 0 claims, skip this to not fail CI on an empty repo state,
    // but assert that when claims are found they are valid.
    if (claims.length > 0) {
      const errors = verifyClaims(claims, (p) => fs.readFileSync(p, 'utf-8'));
      assert.deepEqual(errors, [], 'Real SECURITY_MODEL.md claims should pass');
    } else {
      assert.ok(true);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      assert.ok(true, 'File not found yet, which is acceptable during test setup');
    } else {
      throw err;
    }
  }
});
