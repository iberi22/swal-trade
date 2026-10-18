import { parseRadarUrl } from "./radar.js";
import { DEFAULT_BRIDGE_CONTROL_PORT } from "./chart-bridge.js";

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  fetchJson: (url: string, timeoutMs: number) => Promise<any>;
  nodeVersion: string;
  resolveCore: () => string;
  exists: (path: string) => boolean;
}

export async function runDoctor(env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // Node version check
  const nodeMatch = deps.nodeVersion.match(/^v?(\d+)/);
  const major = nodeMatch ? parseInt(nodeMatch[1]!, 10) : 0;
  if (major >= 20) {
    checks.push({ id: 'node', status: 'pass', detail: `Node ${deps.nodeVersion}` });
  } else {
    checks.push({ id: 'node', status: 'fail', detail: `Node ${deps.nodeVersion} (>= 20 required)` });
  }

  // Core check
  const corePath = deps.resolveCore();
  if (deps.exists(corePath)) {
    checks.push({ id: 'core', status: 'pass', detail: `resolved and exists` });
  } else {
    checks.push({ id: 'core', status: 'fail', detail: `not found at ${corePath}` });
  }

  // Binance keys check
  const hasKey = !!env.BINANCE_API_KEY;
  const hasSecret = !!env.BINANCE_API_SECRET;
  if (hasKey && hasSecret) {
    checks.push({ id: 'binance_keys', status: 'pass', detail: 'set' });
  } else {
    checks.push({ id: 'binance_keys', status: 'warn', detail: `KEY: ${hasKey ? 'set' : 'unset'}, SECRET: ${hasSecret ? 'set' : 'unset'} (account tools unavailable)` });
  }

  // Write tools check
  if (env.SWAL_MCP_TRADING === 'enabled') {
    checks.push({ id: 'write_tools', status: 'warn', detail: 'order tools ON; testnet unless SWAL_MCP_NETWORK says otherwise' });
  } else {
    checks.push({ id: 'write_tools', status: 'pass', detail: 'disabled' });
  }

  // Radar check
  const radarUrlRes = parseRadarUrl(env.SWAL_RADAR_URL);
  const radarUrl = radarUrlRes.ok ? radarUrlRes.url : "http://127.0.0.1:47322";
  try {
    await deps.fetchJson(`${radarUrl}/v1/health`, 1500);
    checks.push({ id: 'radar', status: 'pass', detail: 'running' });
  } catch (err: any) {
    checks.push({ id: 'radar', status: 'warn', detail: `down (${err.message || String(err)})` });
  }

  // Bridge check
  const bridgePort = env.SWAL_BRIDGE_CONTROL_PORT ? parseInt(env.SWAL_BRIDGE_CONTROL_PORT, 10) : DEFAULT_BRIDGE_CONTROL_PORT;
  try {
    await deps.fetchJson(`http://127.0.0.1:${bridgePort}/v1/health`, 1500);
    checks.push({ id: 'bridge', status: 'pass', detail: 'running' });
  } catch (err: any) {
    checks.push({ id: 'bridge', status: 'warn', detail: `down (${err.message || String(err)})` });
  }

  // Sort checks by id just to be deterministic
  checks.sort((a, b) => a.id.localeCompare(b.id));

  const hasFail = checks.some(c => c.status === 'fail');
  return {
    ok: !hasFail,
    checks,
  };
}

export function formatDoctorText(result: DoctorResult): string {
  let out = `System Check:\n\n`;
  for (const check of result.checks) {
    const statusMark = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
    out += `${statusMark} [${check.id}] ${check.status.toUpperCase()}: ${check.detail}\n`;
  }
  return out;
}
