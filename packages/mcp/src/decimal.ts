// Decimal helpers for exchange filters.
//
// Binance publishes its filters as decimal strings (stepSize "0.001",
// tickSize "0.1", minNotional "5") and only accepts quantities and prices that
// are aligned to them: a float round trip loses that alignment, and a price one
// tick off is rejected with -1111 before anything is sent. Everything here
// works on decimal strings with BigInt arithmetic, so the alignment is exact.

export type DecimalInput = string | number;

interface Parts {
  digits: bigint;
  dp: number;
}

/** Guard against absurd exponents from a corrupt filter value. */
const MAX_DP = 18;

/** Expand exponential notation and drop a leading "+" so the strict regex can run. */
function normalizeText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const exp = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
  if (!exp) return text.replace(/^\+/, "");
  const sign = exp[1] === "-" ? "-" : "";
  const int = exp[2] || "0";
  const frac = exp[3] || "";
  const shift = Number(exp[4]);
  if (!Number.isInteger(shift) || Math.abs(shift) > 40) return null;
  const digits = `${int}${frac}`;
  const point = int.length + shift;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = `${digits}${"0".repeat(point - digits.length)}`;
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${out}`;
}

function parseParts(raw: DecimalInput): Parts | null {
  const text = typeof raw === "number" ? normalizeText(String(raw)) : normalizeText(raw);
  if (text == null) return null;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  if (!match[2] && !match[3]) return null;
  const dp = (match[3] ?? "").length;
  if (dp > MAX_DP) return null;
  const digits = BigInt(`${match[2] || "0"}${match[3] ?? ""}`);
  return { digits: match[1] === "-" ? -digits : digits, dp };
}

function scale(parts: Parts, dp: number): bigint {
  return parts.digits * 10n ** BigInt(dp - parts.dp);
}

function format(digits: bigint, dp: number): string {
  const negative = digits < 0n;
  const abs = negative ? -digits : digits;
  const text = abs.toString().padStart(dp + 1, "0");
  const intPart = dp === 0 ? text : text.slice(0, text.length - dp);
  const frac = dp === 0 ? "" : text.slice(text.length - dp).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${frac ? `.${frac}` : ""}`;
}

export type RoundMode = "floor" | "ceil" | "nearest";

/**
 * Align `rawValue` to a multiple of `rawStep`. Returns a decimal string, or
 * null when either input is not a usable decimal.
 */
export function roundDecimal(rawValue: DecimalInput, rawStep: DecimalInput, mode: RoundMode): string | null {
  const value = parseParts(rawValue);
  const step = parseParts(rawStep);
  if (!value || !step || step.digits <= 0n) return null;
  const dp = Math.max(value.dp, step.dp);
  const scaledValue = scale(value, dp);
  const scaledStep = scale(step, dp);
  let units = scaledValue / scaledStep;
  const remainder = scaledValue % scaledStep;
  if (remainder !== 0n) {
    if (mode === "floor" && scaledValue < 0n) units -= 1n;
    if (mode === "ceil" && scaledValue > 0n) units += 1n;
    if (mode === "nearest") {
      const magnitude = remainder < 0n ? -remainder : remainder;
      if (magnitude * 2n >= scaledStep) units += scaledValue < 0n ? -1n : 1n;
    }
  }
  return format(units * scaledStep, dp);
}

/** Quantity: never round up, the order must not exceed what was asked for. */
export const floorToStep = (value: DecimalInput, step: DecimalInput): string | null => roundDecimal(value, step, "floor");

/** Price at or above the requested value. */
export const ceilToStep = (value: DecimalInput, step: DecimalInput): string | null => roundDecimal(value, step, "ceil");

/** Nearest aligned price. */
export const nearestStep = (value: DecimalInput, step: DecimalInput): string | null => roundDecimal(value, step, "nearest");

/** Number of decimals in a filter value, for messages and tests. */
export function decimalsOf(rawStep: DecimalInput): number | null {
  const parts = parseParts(rawStep);
  return parts ? parts.dp : null;
}

/**
 * Adds `times` multiples of `rawStep` to `rawValue` exactly. A float subtraction
 * of 99999.9 - 0.1 gives 99999.79999999, which then floors to the wrong tick, so
 * repricing has to happen in decimal space.
 */
export function shiftStep(rawValue: DecimalInput, rawStep: DecimalInput, times: number): string | null {
  const value = parseParts(rawValue);
  const step = parseParts(rawStep);
  if (!value || !step || step.digits <= 0n || !Number.isInteger(times)) return null;
  const dp = Math.max(value.dp, step.dp);
  const scaledStep = scale(step, dp);
  const units = scaledStep === 0n ? 0n : scale(value, dp) / scaledStep;
  if (scaledStep === 0n || scale(value, dp) % scaledStep !== 0n) return null;
  return format((units + BigInt(times)) * scaledStep, dp);
}

/** Decimal string (or number) to a JS number, for comparisons and messages. */
export function decimalNumber(raw: DecimalInput): number {
  return typeof raw === "number" ? raw : Number(raw);
}

/**
 * A computed number to a decimal string that `roundDecimal` accepts.
 *
 * Dividing two prices gives a double with up to seventeen decimals, which
 * `parseParts` refuses on purpose. Trimming to twelve decimals is the honest
 * version of that number: the exchange filters have at most eight, and a
 * quantity rounded up to stepSize does not care about the twelfth decimal.
 */
export function toDecimalText(value: number, maxDp = 12): string {
  if (!Number.isFinite(value)) return String(value);
  const text = value
    .toFixed(Math.max(0, Math.min(maxDp, MAX_DP)))
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return text === "-0" || text === "" ? "0" : text;
}
