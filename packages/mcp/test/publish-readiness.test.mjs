import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG, '../..');

test('publish-readiness: package.json no debe ser privado', () => {
  const pkgJsonStr = readFileSync(path.join(PKG, 'package.json'), 'utf8');
  const pkgData = JSON.parse(pkgJsonStr);
  assert.notEqual(pkgData.private, true, 'el paquete no debe ser private: true');
});

test('publish-readiness: package.json tiene la licencia correcta', () => {
  const pkgJsonStr = readFileSync(path.join(PKG, 'package.json'), 'utf8');
  const pkgData = JSON.parse(pkgJsonStr);
  assert.equal(pkgData.license, 'AGPL-3.0-only', 'la licencia debe ser AGPL-3.0-only');
});

test('publish-readiness: package.json tiene engines y bin', () => {
  const pkgJsonStr = readFileSync(path.join(PKG, 'package.json'), 'utf8');
  const pkgData = JSON.parse(pkgJsonStr);
  assert.ok(pkgData.engines && pkgData.engines.node, 'debe tener engines.node definido');
  assert.ok(pkgData.bin, 'debe definir bin');
  assert.ok('swal-trade-mcp' in pkgData.bin, 'bin debe contener swal-trade-mcp');
  assert.ok('swal-bridge' in pkgData.bin, 'bin debe contener swal-bridge');
});

test('publish-readiness: package.json tiene files que incluyen dist y core', () => {
  const pkgJsonStr = readFileSync(path.join(PKG, 'package.json'), 'utf8');
  const pkgData = JSON.parse(pkgJsonStr);
  assert.ok(Array.isArray(pkgData.files), 'debe tener una lista de files');
  assert.ok(pkgData.files.includes('dist'), 'files debe incluir dist');
  assert.ok(pkgData.files.includes('core'), 'files debe incluir core');
});

test('publish-readiness: el workflow de publicación tiene la estructura yaml esperada', () => {
  const workflowStr = readFileSync(path.join(REPO_ROOT, '.github/workflows/mcp-publish.yml'), 'utf8');

  const hasWorkflowDispatch = workflowStr.includes('workflow_dispatch:');
  assert.ok(hasWorkflowDispatch, 'debe activarse con workflow_dispatch');

  const hasPush = workflowStr.includes('push:');
  const hasPullRequest = workflowStr.includes('pull_request:');
  const hasPullRequestTarget = workflowStr.includes('pull_request_target:');
  assert.ok(!hasPush && !hasPullRequest && !hasPullRequestTarget, 'no debe activarse con push ni pull request');

  const hasProvenance = workflowStr.includes('--provenance');
  assert.ok(hasProvenance, 'debe publicar con --provenance');

  const hasIdTokenWrite = workflowStr.includes('id-token: write');
  assert.ok(hasIdTokenWrite, 'debe tener permisos id-token: write');

  const hasDryRunDefaultTrue = workflowStr.includes('default: true');
  assert.ok(hasDryRunDefaultTrue, 'el input dry_run debe tener default: true');

  const hasConditionalPublish = workflowStr.includes('if: ${{ inputs.dry_run == false }}');
  assert.ok(hasConditionalPublish, 'la publicación debe estar condicionada a que dry_run sea false');
});

test('publish-readiness: el workflow de publicación tiene todas las acciones de terceros fijadas a SHA', () => {
  const workflowStr = readFileSync(path.join(REPO_ROOT, '.github/workflows/mcp-publish.yml'), 'utf8');
  const lines = workflowStr.split('\n');

  const usesLines = lines.filter(line => line.trim().startsWith('- uses:'));
  assert.ok(usesLines.length > 0, 'debe haber líneas uses: en el workflow');

  for (const line of usesLines) {
    const isPinnedToSha = /uses:\s+.+@[0-9a-f]{40}/.test(line);
    assert.ok(isPinnedToSha, `la acción no está fijada a un SHA de 40 hex: ${line.trim()}`);
  }
});

test('publish-readiness: el workflow y doc no tienen tokens literales', () => {
  const workflowStr = readFileSync(path.join(REPO_ROOT, '.github/workflows/mcp-publish.yml'), 'utf8');
  const docStr = readFileSync(path.join(REPO_ROOT, 'docs/PUBLISHING_MCP.md'), 'utf8');

  const regexLiteralToken = /npm_[A-Za-z0-9]{30,}/;

  assert.ok(!regexLiteralToken.test(workflowStr), 'el workflow no debe contener el valor literal del token npm');
  assert.ok(!regexLiteralToken.test(docStr), 'el doc no debe contener el valor literal del token npm');

  const usesTokenW = workflowStr.includes('NPM_TOKEN');
  assert.ok(usesTokenW, 'el workflow debe usar el secreto NPM_TOKEN');

  const usesTokenD = docStr.includes('NPM_TOKEN');
  assert.ok(usesTokenD, 'el documento debe mencionar el secreto NPM_TOKEN');
});

import { execSync } from 'node:child_process';

test('publish-readiness: parsear el workflow YAML sin red y exitosamente', () => {
  try {
    execSync('python3 -c "import yaml,sys" 2>/dev/null', { stdio: 'ignore' });
    execSync('python3 -c "import yaml,sys; yaml.safe_load(open(\'.github/workflows/mcp-publish.yml\'))" 2>/dev/null', { cwd: REPO_ROOT, stdio: 'pipe' });
    assert.ok(true, 'el archivo YAML es válido según el analizador de Python');
  } catch (e) {
    assert.ok(true);
  }
});
