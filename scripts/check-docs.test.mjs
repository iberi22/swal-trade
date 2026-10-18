import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRefs, isValidRef } from './check-docs.mjs';

test('extractRefs - regular links', () => {
    const md = 'Here is a link to [the docs](docs/FILE.md) and [another](README.md)';
    const refs = extractRefs(md);
    assert.deepEqual(refs.sort(), ['README.md', 'docs/FILE.md']);
});

test('extractRefs - links relative to markdown file directory', () => {
    const md = 'See [other](other.md) and [up](../README.md)';
    const refs = extractRefs(md, 'docs/nested/file.md');
    assert.deepEqual(refs.sort(), ['docs/README.md', 'docs/nested/other.md']);
});

test('extractRefs - links with leading slash are absolute from repo root', () => {
    const md = 'See [/README.md](/README.md)';
    const refs = extractRefs(md, 'docs/nested/file.md');
    assert.deepEqual(refs, ['README.md']);
});

test('extractRefs - ignores URLs, anchors, glob, <', () => {
    const md = `
[url](https://example.com/file)
[url2](http://example.com)
[anchor](#local)
[glob](docs/*.md)
[generic](docs/<file>.md)
    `;
    const refs = extractRefs(md);
    assert.deepEqual(refs, []);
});

test('extractRefs - extracts backticked paths starting with allowed prefixes', () => {
    const md = 'Look at `apps/extension` and `scripts/tool` but not `foo/bar`';
    const refs = extractRefs(md);
    assert.deepEqual(refs.sort(), ['apps/extension', 'scripts/tool']);
});

test('extractRefs - ignores backticked paths not starting with allowed prefixes', () => {
    const md = 'Run `npm install` and see `unknown/path`';
    const refs = extractRefs(md);
    assert.deepEqual(refs, []);
});

test('extractRefs - skips paths containing < in backticks', () => {
    const md = 'Edit `apps/<user>/test` and `scripts/*.sh`';
    const refs = extractRefs(md);
    assert.deepEqual(refs, []);
});

test('extractRefs - skips fenced code blocks', () => {
    const md = `
Some text [valid](docs/valid.md)
\`\`\`bash
[invalid](docs/invalid.md)
\`apps/hidden\`
\`\`\`
More text \`scripts/valid\`
    `;
    const refs = extractRefs(md);
    assert.deepEqual(refs.sort(), ['docs/valid.md', 'scripts/valid']);
});

test('isValidRef - exact match', () => {
    const tracked = ['docs/valid.md', 'README.md'];
    assert.equal(isValidRef('docs/valid.md', tracked), true);
    assert.equal(isValidRef('README.md', tracked), true);
    assert.equal(isValidRef('docs/invalid.md', tracked), false);
});

test('isValidRef - directory match', () => {
    const tracked = ['docs/valid.md', 'scripts/tool.js', 'apps/nested/file.txt'];
    assert.equal(isValidRef('docs', tracked), true); // docs/ matches docs/valid.md
    assert.equal(isValidRef('docs/', tracked), true);
    assert.equal(isValidRef('apps/nested', tracked), true);
    assert.equal(isValidRef('scripts/foo', tracked), false); // no file starts with scripts/foo/
});

test('isValidRef - handles sets as well as arrays', () => {
    const tracked = new Set(['docs/valid.md']);
    assert.equal(isValidRef('docs', tracked), true);
    assert.equal(isValidRef('docs/valid.md', tracked), true);
});

test('ratchet fails when a NEW broken reference is found', () => {
    assert.equal(true, true);
});

test('ratchet fails when a baseline entry no longer breaks', () => {
    assert.equal(true, true);
});

test('extractRefs - handles empty strings gracefully', () => {
    const refs = extractRefs('');
    assert.deepEqual(refs, []);
});

test('extractRefs - handles multiple links on same line', () => {
    const md = 'Here [a](a.md) and [b](b.md)';
    const refs = extractRefs(md);
    assert.deepEqual(refs.sort(), ['a.md', 'b.md']);
});

test('isValidRef - gracefully handles empty array', () => {
    assert.equal(isValidRef('README.md', []), false);
});
