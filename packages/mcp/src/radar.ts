import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "./types.js";

export const DEFAULT_RADAR_URL = "http://127.0.0.1:47322";
export const RADAR_TIMEOUT_MS = 4000;
export const RADAR_DOWN_ERROR = "radar local apagado: systemctl --user start swal-radar";
export const RADAR_TOOL_NOTE = "These are experimental alerts measured forward, not trade recommendations.";

export interface CompactAlert {
  id: number;
  symbol: string;
  tf: string;
  direction: string;
  title: string;
  entry: number;
  stop: number;
  target_1r: number;
  target_2r: number;
  strength: number;
  status: string;
  outcomes: { outcome_r: number | null; mfe_r: number | null; mae_r: number | null; resolved_at?: string | null };
  taken_by_user: boolean;
}

export function parseRadarUrl(rawUrl?: string): { ok: true; url: string } | { ok: false; error: string } {
  const candidate = (rawUrl || "").trim() || DEFAULT_RADAR_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
      return { ok: false, error: `radar URL must be http://127.0.0.1 or http://localhost only (got ${candidate})` };
    }
    return { ok: true, url: candidate.replace(/\/+$/, "") };
  } catch {
    return { ok: false, error: `invalid radar URL: ${candidate}` };
  }
}

export function readRadarToken(explicitPath?: string): { ok: true; token: string } | { ok: false; error: string } {
  const tokenPath = explicitPath ?? process.env.SWAL_RADAR_TOKEN_PATH ?? path.join(process.env.HOME || os.homedir(), ".config", "swal-trade", "radar-token");
  try {
    if (!fs.existsSync(tokenPath)) return { ok: false, error: `radar token no encontrado: ${tokenPath}` };
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token ? { ok: true, token } : { ok: false, error: `radar token vacio: ${tokenPath}` };
  } catch {
    return { ok: false, error: `radar token no legible: ${tokenPath}` };
  }
}

function parseNum(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function compactAlert(raw: unknown): CompactAlert {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const o = (r.outcomes && typeof r.outcomes === "object" ? r.outcomes : null) as Record<string, unknown> | null;
  return {
    id: typeof r.id === "number" ? r.id : Number(r.id) || 0,
    symbol: String(r.symbol ?? ""),
    tf: String(r.tf ?? ""),
    direction: String(r.direction ?? ""),
    title: String(r.title ?? ""),
    entry: parseNum(r.entry) ?? 0,
    stop: parseNum(r.stop) ?? 0,
    target_1r: parseNum(r.target_1r) ?? 0,
    target_2r: parseNum(r.target_2r) ?? 0,
    strength: parseNum(r.strength) ?? 0,
    status: String(r.status ?? ""),
    outcomes: {
      outcome_r: parseNum(o?.outcome_r ?? r.outcome_r),
      mfe_r: parseNum(o?.mfe_r ?? r.mfe_r),
      mae_r: parseNum(o?.mae_r ?? r.mae_r),
      ...(r.resolved_at ? { resolved_at: String(r.resolved_at) } : {}),
    },
    taken_by_user: Boolean(r.taken_by_user),
  };
}

async function safeFetchJson(url: string, init: RequestInit, fetchFn: FetchLike): Promise<{ ok: true; status: number; data: any } | { ok: false; error: string }> {
  try {
    const signal = init.signal ?? AbortSignal.timeout(RADAR_TIMEOUT_MS);
    const res = await fetchFn(url, { ...init, signal });
    let json: any = null;
    try { json = await res.json(); } catch {}
    return res.ok ? { ok: true, status: res.status, data: json } : { ok: false, error: json?.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: RADAR_DOWN_ERROR };
  }
}

export async function fetchRadarAlerts(opts: { baseUrl: string; status?: "active" | "resolved" | "all"; symbol?: string; limit?: number; fetchFn: FetchLike }): Promise<{ ok: true; alerts: CompactAlert[] } | { ok: false; error: string }> {
  const statusParam = opts.status ?? "active";
  const limit = opts.limit ?? 20;
  const url = `${opts.baseUrl}/v1/alerts?status=${encodeURIComponent(statusParam)}&limit=${opts.symbol ? 100 : limit}`;
  const res = await safeFetchJson(url, { method: "GET" }, opts.fetchFn);
  if (!res.ok) return res;
  const rawList = Array.isArray(res.data?.alerts) ? res.data.alerts : [];
  let list = rawList.map(compactAlert);
  if (opts.symbol) {
    const sym = opts.symbol.trim().toUpperCase();
    list = list.filter((a: CompactAlert) => a.symbol.toUpperCase() === sym);
  }
  return { ok: true, alerts: list.slice(0, limit) };
}

export async function fetchRadarStats(opts: { baseUrl: string; fetchFn: FetchLike }): Promise<{ ok: true; stats: Record<string, unknown> } | { ok: false; error: string }> {
  const res = await safeFetchJson(`${opts.baseUrl}/v1/stats`, { method: "GET" }, opts.fetchFn);
  if (!res.ok) return res;
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, any>;
  const overall = data.overall && typeof data.overall === "object" ? { ...data.overall } : {};
  if ((typeof overall.n_resolved === "number" ? overall.n_resolved : 0) < 30) overall.label = "sin evidencia (n<30)";
  return {
    ok: true,
    stats: {
      overall,
      by_kind: Array.isArray(data.by_kind) ? data.by_kind : [],
      taken: data.taken && typeof data.taken === "object" ? data.taken : {},
      note: typeof data.note === "string" ? data.note : "Un alerta es un experimento, nunca una promesa (sin evidencia).",
    },
  };
}

export async function markRadarAlertTaken(opts: { baseUrl: string; alertId: number; taken: boolean; note?: string; tokenPath?: string; fetchFn: FetchLike }): Promise<{ ok: true; alert: CompactAlert } | { ok: false; error: string }> {
  const tokenRes = readRadarToken(opts.tokenPath);
  if (!tokenRes.ok) return tokenRes;
  const body: Record<string, unknown> = { taken: opts.taken };
  if (opts.note !== undefined) body.note = opts.note;
  const res = await safeFetchJson(`${opts.baseUrl}/v1/alerts/${opts.alertId}/note`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Radar-Token": tokenRes.token },
    body: JSON.stringify(body),
  }, opts.fetchFn);
  if (!res.ok) return res;
  return { ok: true, alert: compactAlert(res.data?.alert ?? res.data) };
}
