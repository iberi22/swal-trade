// Logica pura de la pestana Analisis: de TradeMetrics a lineas de texto, a la entrada de
// la carga util de IA, textos de error y consentimiento. Sin DOM ni red (se prueba en node).

import { normalizeStrength } from '../findings-view';
import type { HistoryMetricsInput, PayloadFinding } from '../ai/payload';
import { getProvider } from '../ai/providers';
import type { RulesSettings } from '../settings';
import type { Finding } from '../types';
import type { BucketStats, MetricsOptions, TradeMetrics } from './metrics';

export const HISTORY_MONTHS_LABEL = '6 meses';
export const HONESTY_LINE =
  'Cifras de tu pasado: no predicen el futuro ni prueban que tengas una ventaja.';
export const R_NOMINAL_NOTE = 'R nominal = neto / riesgo por operacion que indicas; no es R contra un stop real.';

/** Riesgo por operacion en USD: maxRiskPct del usuario sobre su capital; si no hay capital, el numero manual. */
export function riskPerTradeUsd(
  rules: Pick<RulesSettings, 'maxRiskPct'>,
  equity: number | null | undefined,
  manualUsd: number | null | undefined,
): number | null {
  if (typeof equity === 'number' && Number.isFinite(equity) && equity > 0) {
    const v = (rules.maxRiskPct * equity) / 100;
    return v > 0 ? v : null;
  }
  return typeof manualUsd === 'number' && Number.isFinite(manualUsd) && manualUsd > 0 ? manualUsd : null;
}

export function metricsOptionsFor(
  rules: RulesSettings,
  riskUsd: number,
  equity: number | null | undefined,
  tzOffsetMin = new Date().getTimezoneOffset(),
): MetricsOptions {
  return {
    riskPerTradeUsd: riskUsd,
    leverageRule: rules.maxLeverage,
    tzOffsetHours: -tzOffsetMin / 60,
    revengeMinutes: rules.revengeMinutes,
    ...(typeof equity === 'number' && equity > 0 ? { equity } : {}),
  };
}

function fix(v: number, d = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(d);
}
const pct = (v: number, d = 0): string => `${fix(v * 100, d)} %`;
const signed = (v: number, d = 2): string => `${v > 0 ? '+' : ''}${fix(v, d)}`;

export type TopBucketKind = 'symbol' | 'side' | 'hour';

/** Los k grupos con mas operaciones; empate por neto, luego por clave. */
export function topBuckets(
  metrics: Pick<TradeMetrics, 'byBucket'>,
  kind: TopBucketKind,
  k = 3,
): Array<{ key: string; stats: BucketStats }> {
  return Object.entries(metrics.byBucket[kind] ?? {})
    .map(([key, stats]) => ({ key, stats }))
    .sort((a, b) => b.stats.n - a.stats.n || b.stats.netUsd - a.stats.netUsd || a.key.localeCompare(b.key))
    .slice(0, k);
}

export function bucketText(kind: TopBucketKind, b: { key: string; stats: BucketStats }): string {
  const name = kind === 'hour' ? `${b.key.padStart(2, '0')}h` : b.key;
  return `${name} · n ${b.stats.n} · ${signed(b.stats.netUsd)} USD`;
}

export function gradeLine(metrics: Pick<TradeMetrics, 'n' | 'grade'>): string {
  if (metrics.n < 30 || metrics.grade.grade === 'no_evidence') {
    return `Nota: sin evidencia (n ${metrics.n}, hacen falta 30 como minimo)`;
  }
  switch (metrics.grade.grade) {
    case 'negative':
      return 'Nota: negativa en tu muestra';
    case 'promising':
      return 'Nota: prometedora, aun no validada (n<100)';
    case 'validated':
      return 'Nota: validada en tu muestra, sigue sin predecir el futuro';
    default:
      return 'Nota: sin evidencia';
  }
}

export interface MetricRow {
  label: string;
  value: string;
}

/** Filas del recuadro de metricas. Todas deterministas; sin promesas. */
export function metricRows(m: TradeMetrics): MetricRow[] {
  const wilson =
    m.winRateWilsonLow !== null && m.winRateWilsonHigh !== null
      ? ` (IC 95 %: ${pct(m.winRateWilsonLow)} a ${pct(m.winRateWilsonHigh)})`
      : '';
  return [
    { label: 'Operaciones (n)', value: String(m.n) },
    { label: 'Ganadoras', value: `${pct(m.winRate)}${wilson}` },
    { label: 'R nominal medio', value: signed(m.rNominalMean) },
    { label: 'Esperanza por operacion', value: `${signed(m.expectancyUsd)} USD` },
    { label: 'Factor de beneficio', value: m.profitFactor === null ? 'sin perdidas' : fix(m.profitFactor) },
    { label: 'Neto', value: `${signed(m.netUsd)} USD` },
    { label: 'Comisiones', value: `${fix(m.feesUsd)} USD` },
    { label: 'Funding', value: `${signed(m.fundingUsd)} USD` },
    {
      label: 'Caida maxima',
      value: `${fix(m.maxDrawdownUsd)} USD${m.maxDrawdownPctOfPeak !== null ? ` (${pct(m.maxDrawdownPctOfPeak)} del pico)` : ''}`,
    },
    { label: 'Duracion mediana', value: `${fix(m.medianHoldMin, 0)} min` },
    { label: 'Revancha (tras una perdida)', value: `${m.revengeCount}` },
    { label: 'Mas tamano tras perdida', value: `${m.sizeUpAfterLossCount}` },
  ];
}

/** TradeMetrics -> entrada de buildHistoryPayload. La nota de letra no aplica: grade null. */
export function historyInputFromMetrics(m: TradeMetrics): HistoryMetricsInput {
  const gross = m.netUsd + m.feesUsd - m.fundingUsd;
  const buckets: NonNullable<HistoryMetricsInput['buckets']> = [];
  for (const kind of ['symbol', 'side', 'hour'] as const) {
    for (const b of topBuckets(m, kind, 3)) {
      buckets.push({ by: kind, key: kind === 'hour' ? Number(b.key) : b.key, n: b.stats.n });
    }
  }
  return {
    n: m.n,
    wins: m.wins,
    meanR: m.rNominalMean,
    meanRCi: m.grade.meanNetRCi,
    profitFactor: m.profitFactor,
    feesPctGross: gross > 0 ? (m.feesUsd / gross) * 100 : null,
    fundingPctGross: gross > 0 ? (-m.fundingUsd / gross) * 100 : null,
    maxDrawdownPct: m.maxDrawdownPctOfPeak === null ? null : m.maxDrawdownPctOfPeak * 100,
    buckets,
    revenge: m.revengeCount,
    sizeUpAfterLoss: m.sizeUpAfterLossCount,
    grade: null,
  };
}

/** Texto del tipo `double_bottom` para el contexto de IA; lo que no encaje se omite. */
export function trendToken(trend: string | null | undefined): string | undefined {
  if (!trend) return undefined;
  const t = trend
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return t || undefined;
}

function invalidatePrice(f: Finding): number | null {
  for (const lv of f.levels ?? []) {
    if (lv && typeof lv === 'object' && typeof lv.invalidate === 'number' && Number.isFinite(lv.invalidate)) {
      return lv.invalidate;
    }
  }
  return null;
}

/** Hallazgos del analisis publico -> forma relativa para la IA (sin precios). */
export function findingsForPayload(findings: readonly Finding[], lastPrice: number | null): PayloadFinding[] {
  const out: PayloadFinding[] = [];
  for (const f of findings) {
    const dir = f.direction === 'up' || f.direction === 'down' ? f.direction : null;
    if (!dir || typeof f.kind !== 'string') continue;
    const inv = invalidatePrice(f);
    const invPct = inv !== null && lastPrice !== null && lastPrice > 0 ? (Math.abs(inv - lastPrice) / lastPrice) * 100 : 0;
    out.push({ kind: f.kind, dir, fuerza: normalizeStrength(f.strength), invalida_pct: invPct });
    if (out.length >= 3) break;
  }
  return out;
}

/** ATR simple (media de rango verdadero) de las ultimas `period` velas; null sin datos. */
export function atrOf(
  candles: ReadonlyArray<{ high: number; low: number; close: number }>,
  period = 14,
): number | null {
  if (candles.length < period + 1) return null;
  const tail = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    const c = tail[i]!;
    const prev = tail[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  const atr = sum / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export const AI_ERROR_TEXT: Record<string, string> = {
  no_key: 'Falta la clave del proveedor. Añádela en Ajustes.',
  auth: 'El proveedor rechazó la clave (autenticación).',
  rate_limit: 'El proveedor limitó las peticiones. Espera un poco.',
  timeout: 'El proveedor tardó demasiado.',
  no_consent: 'Falta tu consentimiento para este proveedor.',
  bad_payload: 'Los datos a enviar no son válidos.',
  net: 'No se pudo contactar con el proveedor (red o permiso del sitio).',
  bad_response: 'El proveedor devolvió una respuesta ilegible.',
};

export function aiErrorText(reason: unknown): string {
  const r = typeof reason === 'string' ? reason : '';
  if (AI_ERROR_TEXT[r]) return AI_ERROR_TEXT[r]!;
  if (/^http_\d+$/.test(r)) return `El proveedor respondió con error (${r.replace('http_', 'HTTP ')}).`;
  return 'No se pudo completar el análisis.';
}

export const HISTORY_ERROR_TEXT: Record<string, string> = {
  no_key: 'Falta la clave de lectura. Añádela en Ajustes.',
  ip_or_perm: 'Binance rechazó la clave: revisa la IP permitida y los permisos de lectura.',
  clock: 'El reloj de tu equipo está desfasado respecto a Binance.',
  net: 'Sin conexión con Binance.',
  incomplete: 'Una página de Binance no se pudo completar sin perder filas.',
  bad_reply: 'Binance devolvió una respuesta ilegible.',
  aborted: 'Carga detenida.',
};

export function historyErrorText(code: string): string {
  if (HISTORY_ERROR_TEXT[code]) return HISTORY_ERROR_TEXT[code]!;
  if (/^http_\d+$/.test(code)) return `Binance respondió con error (${code.replace('http_', 'HTTP ')}).`;
  return 'La carga se detuvo por un error.';
}

export const POSITION_FIELDS =
  'símbolo, temporalidad, lado, apalancamiento, tipo de margen, R actual, distancia al stop y a la liquidación en %, ' +
  'riesgo en % del capital, funding, minutos abiertos, reglas activas y hasta 3 patrones (tipo, dirección, fuerza)';
export const HISTORY_FIELDS =
  'número de operaciones, proporción de ganadoras con su intervalo, R medio, factor de beneficio, comisiones y funding ' +
  'en % del bruto, caída máxima en %, hasta 3 grupos (símbolo, lado u hora) con su conteo y los contadores de revancha y de más tamaño';

/** Texto de la pantalla de consentimiento: nombra al proveedor y los campos. */
export function consentText(providerId: string, redaction: 'relative' | 'absolute', kind: 'position' | 'history'): string {
  const label = getProvider(providerId)?.label ?? providerId;
  const fields = kind === 'position' ? POSITION_FIELDS : HISTORY_FIELDS;
  const extra =
    redaction === 'absolute' && kind === 'position'
      ? ' Además, precios de entrada, marca, stop y liquidación, y el nocional.'
      : ' Sin importes en USD, cantidades, capital, ids ni fechas absolutas.';
  return `Se enviarán a ${label}, y solo a ${label}: ${fields}.${extra}`;
}

export function exportFilename(kind: 'csv' | 'json', nowMs: number): string {
  const d = new Date(nowMs).toISOString().slice(0, 10);
  return `swal-historial-${d}.${kind}`;
}
