// Parseo numerico de la UI de Binance Futures. Todo devuelve `null` en vez de
// lanzar: la pagina cambia y un valor raro no debe romper la extension.

export interface Amount {
  value: number;
  asset: string | null;
}

const NBSP = /[\u00a0\u202f]/g;
const UNICODE_MINUS = /[\u2212\u2013\u2014]/g;

/**
 * Numero desde texto. Acepta `82,644.1`, `0.0041106`, `+1.01`, `-0.91 USDC`,
 * `5,184`, `1,234,567`, `0,004` (coma decimal) y numeros ya numericos.
 * Devuelve null para `--`, ``, `n/a` o basura.
 */
export function parseNum(raw: unknown): number | null {
  try {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    let s = raw.replace(UNICODE_MINUS, '-').replace(NBSP, ' ').trim();
    if (!s) return null;
    s = s.replace(/[^0-9.,+-]/g, '');
    const negative = s.includes('-');
    s = s.replace(/[+-]/g, '');
    if (!s || !/\d/.test(s)) return null;
    const normalized = normalizeSeparators(s);
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  } catch {
    return null;
  }
}

/**
 * Coma = miles y punto = decimales (asi lo pinta Binance incluso en espanol),
 * pero si la ultima coma va despues del ultimo punto se interpreta como
 * decimal (`1.234,56` -> 1234.56). Una sola coma con 3 decimales y parte
 * entera distinta de `0` es separador de miles (`5,184` -> 5184); `0,004`
 * sigue siendo decimal.
 */
function normalizeSeparators(s: string): string {
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return s.replace(/\./g, '').replace(/,/g, '.');
    }
    return s.replace(/,/g, '');
  }
  if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2) {
      const intPart = parts[0] ?? '';
      const frac = parts[1] ?? '';
      if (frac.length === 3 && intPart.length > 0 && intPart.length <= 3 && intPart !== '0') {
        return intPart + frac;
      }
      return `${intPart}.${frac}`;
    }
    return parts.join('');
  }
  if (hasDot) {
    const parts = s.split('.');
    if (parts.length === 2) return s;
    const last = parts.pop() ?? '';
    return `${parts.join('')}.${last}`;
  }
  return s;
}

/** Importe con signo y, si aparece, el activo que lo sigue (`+1.01 USDC`). */
export function parseSignedAmount(raw: unknown): Amount | null {
  try {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? { value: raw, asset: null } : null;
    }
    if (typeof raw !== 'string') return null;
    const match = /([+-])?\s*(\d[\d.,]*)\s*([A-Za-z][A-Za-z0-9]{1,19})?/.exec(raw);
    if (!match) return null;
    const sign = match[1] === '-' ? '-' : '';
    const value = parseNum(`${sign}${match[2] ?? ''}`);
    if (value === null) return null;
    const asset = match[3] ? match[3].toUpperCase() : null;
    return { value, asset };
  } catch {
    return null;
  }
}

/** Porcentaje con signo: `-14.40%` -> -14.4. */
export function parsePercent(raw: unknown): number | null {
  try {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const match = /([+-]?\d[\d.,]*)\s*%/.exec(raw);
    if (!match) return null;
    return parseNum(match[1]);
  } catch {
    return null;
  }
}

/** Apalancamiento: `40x` -> 40. Rechaza 0, negativos y valores absurdos. */
export function parseLeverage(raw: unknown): number | null {
  try {
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw <= 0 || raw > 125) return null;
      return raw;
    }
    if (typeof raw !== 'string') return null;
    const match = /(\d{1,3}(?:[.,]\d+)?)\s*x\b/i.exec(raw);
    if (!match) return null;
    const value = parseNum(match[1]);
    if (value === null || value <= 0 || value > 125) return null;
    return value;
  } catch {
    return null;
  }
}

const UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  dia: 86_400_000,
  dias: 86_400_000,
  h: 3_600_000,
  hora: 3_600_000,
  horas: 3_600_000,
  m: 60_000,
  min: 60_000,
  minuto: 60_000,
  minutos: 60_000,
  s: 1_000,
  seg: 1_000,
  segundo: 1_000,
  segundos: 1_000,
};

/** Duracion a ms: `10h 35m`, `2d 3h`, `45m`, `(Duración 10h 35m)`. */
export function parseDuration(raw: unknown): number | null {
  try {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const re =
      /(\d+(?:[.,]\d+)?)\s*(dias|dia|d|horas|hora|h|minutos|minuto|min|m|segundos|segundo|seg|s)\b/g;
    let total = 0;
    let found = false;
    for (const match of text.matchAll(re)) {
      const value = parseNum(match[1]);
      const unit = UNIT_MS[match[2] ?? ''];
      if (value === null || unit === undefined || value < 0) continue;
      total += value * unit;
      found = true;
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

/**
 * Fecha `MM/DD/YYYY HH:mm:ss` de la pagina (hora local) a epoch ms.
 * `tzOffsetMinutes` usa la convencion de `Date#getTimezoneOffset`:
 * -300 para UTC-5. `10/19/2026 00:13:18` con -300 = `2026-10-19T05:13:18Z`.
 */
export function parseDate(raw: unknown, tzOffsetMinutes = 0): number | null {
  try {
    if (typeof raw !== 'string') return null;
    const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (!match) return null;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const hour = match[4] ? Number(match[4]) : 0;
    const minute = match[5] ? Number(match[5]) : 0;
    const second = match[6] ? Number(match[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const local = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(local);
    if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
    const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
    return local - offset * 60_000;
  } catch {
    return null;
  }
}

/** Primer numero de un texto (`0.0041106` en una celda con ruido). */
export function parsePrice(raw: unknown): number | null {
  try {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    for (const match of raw.matchAll(/[+-]?\d[\d.,]*/g)) {
      const value = parseNum(match[0]);
      if (value !== null) return value;
    }
    return null;
  } catch {
    return null;
  }
}
