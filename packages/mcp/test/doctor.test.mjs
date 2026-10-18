import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctorText } from '../dist/doctor.js';

const mockDeps = {
  fetchJson: async () => ({ ok: true }),
  nodeVersion: 'v22.1.0',
  resolveCore: () => '/path/to/core.js',
  exists: () => true
};

test('output formatting for human output', async () => {
  const result = await runDoctor({}, mockDeps);
  const text = formatDoctorText(result);
  assert.ok(text.includes('System Check:'));
  assert.ok(text.includes('✅ [node] PASS: Node v22.1.0'));
});

test('JSON output lists exactly: bridge, binance_keys, core, node, radar, write_tools', async () => {
  const result = await runDoctor({}, mockDeps);
  const checkIds = result.checks.map(c => c.id).sort();
  assert.deepEqual(checkIds, ['binance_keys', 'bridge', 'core', 'node', 'radar', 'write_tools']);
});

test('BINANCE_API_SECRET does not leak in human output', async () => {
  const env = { BINANCE_API_SECRET: 'fake-secret-value-123' };
  const result = await runDoctor(env, mockDeps);
  const text = formatDoctorText(result);
  assert.ok(!text.includes('fake-secret-value-123'));
});

test('BINANCE_API_SECRET does not leak in JSON output', async () => {
  const env = { BINANCE_API_SECRET: 'fake-secret-value-123' };
  const result = await runDoctor(env, mockDeps);
  const jsonStr = JSON.stringify(result);
  assert.ok(!jsonStr.includes('fake-secret-value-123'));
});

test('node version v18.0.0 fails', async () => {
  const deps = { ...mockDeps, nodeVersion: 'v18.0.0' };
  const result = await runDoctor({}, deps);
  assert.equal(result.ok, false);
  const nodeCheck = result.checks.find(c => c.id === 'node');
  assert.equal(nodeCheck.status, 'fail');
});

test('node version v22.1.0 passes', async () => {
  const deps = { ...mockDeps, nodeVersion: 'v22.1.0' };
  const result = await runDoctor({}, deps);
  const nodeCheck = result.checks.find(c => c.id === 'node');
  assert.equal(nodeCheck.status, 'pass');
  // Need to ensure all pass for overall ok to be true, unless missing keys warn
  // warning doesn't fail overall ok
  assert.equal(result.ok, true);
});

test('SWAL_MCP_TRADING=enabled warns and shows testnet', async () => {
  const env = { SWAL_MCP_TRADING: 'enabled' };
  const result = await runDoctor(env, mockDeps);
  const writeToolsCheck = result.checks.find(c => c.id === 'write_tools');
  assert.equal(writeToolsCheck.status, 'warn');
  assert.ok(writeToolsCheck.detail.includes('testnet'));
});

test('fetchJson reject for radar warns (not fail) and overall ok === true', async () => {
  const deps = {
    ...mockDeps,
    fetchJson: async (url) => {
      if (url.includes('47322')) throw new Error('radar down');
      return { ok: true };
    }
  };
  const result = await runDoctor({}, deps);
  const radarCheck = result.checks.find(c => c.id === 'radar');
  assert.equal(radarCheck.status, 'warn');
  assert.equal(result.ok, true);
});

test('fetchJson reject for bridge warns (not fail) and overall ok === true', async () => {
  const deps = {
    ...mockDeps,
    fetchJson: async (url) => {
      if (url.includes('47330')) throw new Error('bridge down');
      return { ok: true };
    }
  };
  const result = await runDoctor({}, deps);
  const bridgeCheck = result.checks.find(c => c.id === 'bridge');
  assert.equal(bridgeCheck.status, 'warn');
  assert.equal(result.ok, true);
});

test('node version invalid format falls back safely', async () => {
  const deps = { ...mockDeps, nodeVersion: 'invalid' };
  const result = await runDoctor({}, deps);
  const nodeCheck = result.checks.find(c => c.id === 'node');
  assert.equal(nodeCheck.status, 'fail');
  assert.equal(result.ok, false);
});

test('missing core file path leads to core fail', async () => {
  const deps = { ...mockDeps, exists: () => false };
  const result = await runDoctor({}, deps);
  const coreCheck = result.checks.find(c => c.id === 'core');
  assert.equal(coreCheck.status, 'fail');
  assert.equal(result.ok, false);
});
