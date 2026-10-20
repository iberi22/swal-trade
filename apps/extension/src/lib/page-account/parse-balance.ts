// Parser de la caja de cuenta de Binance Futures (la que vive arriba del
// formulario de orden o en el desplegable de la cuenta).
//
// Texto de referencia (espanol):
//   'USDC Cruzado'
//   'Margen de mantenimiento 0.9782 USDC'
//   'Balance de margen 71.9636 USDC'
//   'Balance de Billetera 72.4075 USDC'
//   'PNL no realizado -0.4439 USDC'
//   'Disp. 70.83 USDC'
// En ingles: 'Margin Balance', 'Wallet Balance', 'Unrealized PNL',
// 'Maintenance Margin', 'Avbl'.
//
// Se apoya solo en etiquetas visibles (`labels.ts`) y en `numbers.ts`. Nunca
// lanza: un valor raro queda en null y el panel decide.

import { matchLabel, matchLabelPrefix, normalizeLabel, type LabelKey } from './labels';
import { parseSignedAmount } from './numbers';
import { collectTexts, type TextNode } from './tree';

export type PageBalanceMarginMode = 'cross' | 'isolated' | null;

export interface PageBalance {
  /** Activo de la cuenta (`USDC`, `USDT`...). Null si la pagina no lo dice. */
  asset: string | null;
  marginBalance: number | null;
  walletBalance: number | null;
  /** 'Disp.' / 'Avbl': lo que la pagina deja usar como margen. */
  available: number | null;
  unrealizedPnl: number | null;
  maintenanceMargin: number | null;
  marginMode: PageBalanceMarginMode;
}

/** Claves de la caja de cuenta, en el orden en que se intentan leer. */
export const BALANCE_VALUE_KEYS: readonly LabelKey[] = [
  'marginBalance',
  'walletBalance',
  'available',
  'unrealizedPnl',
  'maintenanceMargin',
];

const BALANCE_KEYS = new Set<LabelKey>(BALANCE_VALUE_KEYS);

/** Token de activo suelto dentro de un texto (`USDC` en `USDC Cruzado`). */
const STANDALONE_ASSET = /(?:^|[^A-Za-z0-9])([A-Z]{2,10})(?=$|[^A-Za-z0-9])/;

function marginModeOf(text: string): PageBalanceMarginMode {
  const normalized = normalizeLabel(text);
  if (/\b(?:cruzado|cross)\b/.test(normalized)) return 'cross';
  if (/\b(?:aislado|isolated)\b/.test(normalized)) return 'isolated';
  return null;
}

/** Activo de un texto corto de la caja (`USDC Cruzado` -> `USDC`). */
function assetOfBox(text: string): string | null {
  const normalized = normalizeLabel(text);
  if (!normalized || normalized.length > 24) return null;
  // La caja pone el activo junto al modo ('USDC Cruzado'); una fila de
  // posiciones ('BTCUSDC Perp. 30x Cruzado Short') trae demasiadas palabras.
  if (normalized.split(' ').length > 3) return null;
  const match = STANDALONE_ASSET.exec(text.toUpperCase());
  const candidate = match ? (match[1] as string) : null;
  if (!candidate || !/^[A-Z]{3,6}$/.test(candidate)) return null;
  return candidate;
}

interface BalanceRead {
  value: number | null;
  asset: string | null;
}

function readBalanceValue(text: string, labelAsset: string | null): BalanceRead {
  const amount = parseSignedAmount(text);
  return { value: amount?.value ?? null, asset: amount?.asset ?? labelAsset };
}

/**
 * Caja de cuenta visible en la pagina. Devuelve null si no hay ninguna de sus
 * etiquetas; si las hay, cada numero ausente queda en null. Nunca lanza.
 */
export function parseBalance(root: TextNode | null | undefined): PageBalance | null {
  try {
    if (!root || typeof root !== 'object') return null;
    const texts = collectTexts(root);
    const reads = new Map<LabelKey, BalanceRead>();
    let marginMode: PageBalanceMarginMode = null;
    let boxAsset: string | null = null;
    let sawLabel = false;

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? '';
      if (!text) continue;

      // El activo y el modo de margen viven en el encabezado de la caja.
      const mode = marginModeOf(text);
      if (mode !== null) {
        if (marginMode === null) marginMode = mode;
        if (boxAsset === null) boxAsset = assetOfBox(text);
      }

      const exact = matchLabel(text);
      const matched = exact ?? matchLabelPrefix(text);
      if (!matched || !BALANCE_KEYS.has(matched.key)) continue;
      sawLabel = true;
      if (reads.has(matched.key)) continue;

      // Etiqueta y valor en nodos distintos (lo habitual): el valor es el siguiente.
      let read: BalanceRead = exact
        ? { value: null, asset: matched.asset }
        : readBalanceValue(text, matched.asset);
      if (read.value === null) {
        const next = texts[i + 1] ?? '';
        if (next && matchLabel(next) === null && matchLabelPrefix(next) === null) {
          const nextRead = readBalanceValue(next, matched.asset);
          if (nextRead.value !== null) {
            read = nextRead;
            i += 1;
          }
        }
      }
      if (read.value !== null) reads.set(matched.key, read);
    }

    if (!sawLabel) return null;
    if (reads.size === 0 && marginMode === null) return null;

    const value = (key: LabelKey): number | null => reads.get(key)?.value ?? null;
    const asset =
      reads.get('marginBalance')?.asset ??
      reads.get('walletBalance')?.asset ??
      reads.get('available')?.asset ??
      boxAsset;

    return {
      asset,
      marginBalance: value('marginBalance'),
      walletBalance: value('walletBalance'),
      available: value('available'),
      unrealizedPnl: value('unrealizedPnl'),
      maintenanceMargin: value('maintenanceMargin'),
      marginMode,
    };
  } catch {
    return null;
  }
}
