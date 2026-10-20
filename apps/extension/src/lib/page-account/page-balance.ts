// Reglas de la caja de cuenta que NO dependen del DOM: que activo le toca a un
// par, si el saldo leido sirve para ese par, cuanto se enseña y cuando el dato
// esta viejo. Todo puro y testeable.
//
// Regla dura: el capital de la pagina solo se usa cuando el activo del saldo
// casa con el activo de cotizacion del par (BTCUSDC -> USDC, BTCUSDT -> USDT).
// Si no casa, el panel cae al capital manual y lo dice.

import { floorToDecimals } from '../sizing';
import type { PageBalance } from './parse-balance';

/** A partir de aqui el saldo de la pagina se considera viejo (60 s). */
export const PAGE_BALANCE_STALE_MS = 60_000;

/** Activo con el que se cuenta el capital manual cuando no hay dato de pagina. */
export const MANUAL_CAPITAL_ASSET = 'USDT';

/**
 * Activos de cotizacion conocidos, del mas largo al mas corto: `BTCUSDC` tiene
 * que casar con `USDC` (4 letras) antes que con nada de 3. `parse-balance` usa
 * esta misma lista para aceptar un activo suelto del encabezado.
 */
export const KNOWN_QUOTES: readonly string[] = ['USDE', 'USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI'];

/** Activo de cotizacion de un par (`BTCUSDC` -> `USDC`); null si no se sabe. */
export function quoteAssetOf(symbol: unknown): string | null {
  if (typeof symbol !== 'string') return null;
  const upper = symbol.trim().toUpperCase();
  if (!/^[0-9A-Z]{4,20}$/.test(upper)) return null;
  for (const quote of KNOWN_QUOTES) {
    if (upper.length > quote.length && upper.endsWith(quote)) return quote;
  }
  return null;
}

/** Activo del saldo normalizado a mayusculas; null si la pagina no lo dijo. */
export function balanceAsset(balance: PageBalance | null | undefined): string | null {
  if (!balance || typeof balance.asset !== 'string') return null;
  const asset = balance.asset.trim().toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(asset) ? asset : null;
}

/**
 * Saldo de margen de la pagina para ese par, o null si no hay dato o si el
 * activo no casa con el de cotizacion (nunca se usa un saldo de otro activo).
 */
export function balanceForSymbol(
  balance: PageBalance | null | undefined,
  symbol: string,
): { asset: string; value: number } | null {
  const quote = quoteAssetOf(symbol);
  if (!quote) return null;
  const asset = balanceAsset(balance);
  if (asset === null || asset !== quote) return null;
  const value = balance?.marginBalance;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return { asset, value };
}

/** Importe de un saldo para la pantalla: recortado hacia ABAJO, nunca al alza. */
export function floorBalanceForDisplay(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 0.01 ? floorToDecimals(value, 2) : floorToDecimals(value, 8);
}

/** Separa los miles de la parte entera con puntos (`1234567` -> `1.234.567`). */
function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits[i];
  }
  return out;
}

/**
 * Numero con coma decimal y punto de miles, sin depender del ICU del entorno:
 * `Intl` sin datos completos (Node con `small-icu`) dejaba `1000,50` donde el
 * navegador enseña `1.000,50`, y la cifra no puede cambiar segun donde corra.
 */
function formatDecimal(value: number, decimals: number, trimZeros: boolean): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart = '0', fracRaw = ''] = fixed.split('.');
  const frac = trimZeros ? fracRaw.replace(/0+$/, '') : fracRaw;
  const body = frac ? `${groupThousands(intPart)},${frac}` : groupThousands(intPart);
  return value < 0 ? `-${body}` : body;
}

/** Texto de un saldo: `71,96 USDC` (recortado, nunca redondeado al alza). */
export function formatBalanceAmount(value: number, asset: string): string {
  const floored = floorBalanceForDisplay(value);
  const text = floored >= 0.01 ? formatDecimal(floored, 2, false) : formatDecimal(floored, 8, true);
  return asset ? `${text} ${asset}` : text;
}

/** Segundos enteros transcurridos; null si no hay sello creible. */
export function pageBalanceAgeSeconds(
  capturedAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - capturedAtMs) / 1000));
}

/** true cuando el dato de la pagina ya paso su umbral de caducidad. */
export function isBalanceStale(
  capturedAtMs: number | null | undefined,
  nowMs: number,
  staleMs = PAGE_BALANCE_STALE_MS,
): boolean {
  const age = pageBalanceAgeSeconds(capturedAtMs, nowMs);
  if (age === null) return false;
  return age * 1000 > staleMs;
}

/**
 * Linea de la caja de cuenta: `saldo de la página: 71,96 USDC (hace 12 s)`.
 * Cuando el dato ya caduco se añade `, dato viejo`.
 */
export function formatPageBalanceLine(input: {
  value: number;
  asset: string;
  capturedAtMs: number | null | undefined;
  nowMs: number;
  staleMs?: number;
}): string {
  const { value, asset, capturedAtMs, nowMs } = input;
  const head = `saldo de la página: ${formatBalanceAmount(value, asset)}`;
  const age = pageBalanceAgeSeconds(capturedAtMs, nowMs);
  if (age === null) return head;
  const stale = isBalanceStale(capturedAtMs, nowMs, input.staleMs ?? PAGE_BALANCE_STALE_MS);
  return `${head} (hace ${age} s${stale ? ', dato viejo' : ''})`;
}
