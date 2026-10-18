import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const workflowPath = path.resolve(process.cwd(), '.github/workflows/release.yml');

test('release workflow tests', async (t) => {
  let content = '';

  await t.test('release.yml exists', () => {
    assert.ok(fs.existsSync(workflowPath), 'release.yml should exist');
    content = fs.readFileSync(workflowPath, 'utf8');
  });

  await t.test('tag filter regex present', () => {
    assert.match(content, /tags:\s*\n\s*-\s*['"]?v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+['"]?/, 'must have v[0-9]+.[0-9]+.[0-9]+ tag trigger');
  });

  await t.test('every uses is SHA-pinned', () => {
    const lines = content.split('\n');
    let usesCount = 0;
    let pinnedCount = 0;
    for (const line of lines) {
      if (line.match(/^\s*-?\s*uses:/)) {
        usesCount++;
        if (line.match(/uses:.*@[0-9a-f]{40}/)) {
          pinnedCount++;
        }
      }
    }
    assert.ok(usesCount > 0, 'must have uses statements');
    assert.strictEqual(pinnedCount, usesCount, 'all uses must be pinned to SHA');
  });

  await t.test('permissions are at job level and contents: write appears exactly once in release job', () => {
    const writeMatches = content.match(/contents:\s*write/g) || [];
    assert.strictEqual(writeMatches.length, 1, 'contents: write must appear exactly once');

    const releaseIdx = content.indexOf('\n  release:');
    assert.ok(releaseIdx > -1, 'must have a release job');
    const writeIdx = content.indexOf('contents: write');
    assert.ok(writeIdx > releaseIdx, 'contents: write must be in the release job');

    assert.ok(!content.match(/^permissions:/m), 'should not have top-level permissions');
  });

  await t.test('no pull_request_target', () => {
    assert.ok(!content.includes('pull_request_target'), 'must not use pull_request_target');
  });

  await t.test('no wrangler or npm publish strings', () => {
    assert.ok(!content.includes('wrangler'), 'must not deploy with wrangler');
    assert.ok(!content.includes('npm publish'), 'must not use npm publish');
  });

  await t.test('gate job runs release-check', () => {
    assert.ok(content.includes('release-check.mjs'), 'must run release-check.mjs');
  });

  await t.test('has workflow_dispatch', () => {
    assert.ok(content.includes('workflow_dispatch:'), 'must have workflow_dispatch trigger');
  });

  await t.test('extract release notes', () => {
    const dummyChangelog = `
## [1.0.0] - 2023-01-01
### Added
- Feature 1

## [0.1.0] - 2022-01-01
### Fixed
- Bug 1
`;
    fs.writeFileSync('dummy-changelog.md', dummyChangelog);

    // Simulate what the workflow does for 0.1.0
    const cmd = `awk '/^## \\\[0.1.0\\\]/ {flag=1; print; next} /^## \\\[/ {if(flag) exit} flag' dummy-changelog.md`;
    const output = execSync(cmd, { encoding: 'utf8' });

    fs.unlinkSync('dummy-changelog.md');

    assert.ok(output.includes('## [0.1.0] - 2022-01-01'), 'must include version header');
    assert.ok(output.includes('### Fixed'), 'must include fixed section');
    assert.ok(!output.includes('## [1.0.0]'), 'must not include previous versions');
  });
});
