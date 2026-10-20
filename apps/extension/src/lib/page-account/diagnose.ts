// Cobertura del diagnostico anonimizado: que regiones de la pagina se
// localizaron de verdad y el esquema de cada una.
//
// Sale de las MISMAS funciones que usa el lector (`region.ts`), asi el informe
// dice exactamente lo que el parser ve (o no ve) en la pagina real. Sin esto,
// el volcado unico solo ensenaba la region mas rica: una caja de cuenta que no
// se reconocia pasaba desapercibida porque el historial llenaba el texto.
//
// Nada de valores: `anonymizeTree` tapa los digitos y los inputs. Nunca se
// manda el DOM crudo.

import {
  findAccountBalanceRegion,
  findHistoryRegion,
  findOpenPositionsRegion,
  type RegionOptions,
  type RegionSource,
} from './region';
import { anonymizeTree, treeToCompactText } from './snapshot';
import { countTextNodes, toTextTree, type DomNodeLike } from './tree';

/** Regiones que el lector necesita; el informe cubre las tres. */
export const DIAGNOSE_REGION_KEYS = ['balance', 'positions', 'history'] as const;
export type DiagnoseRegionKey = (typeof DIAGNOSE_REGION_KEYS)[number];

/** Nodos por region: los mismos que usa el lector por defecto. */
export const DIAGNOSE_MAX_NODES = 4000;
/** Texto maximo de cada esquema: una region, no un volcado de la pagina. */
export const DIAGNOSE_REGION_MAX_CHARS = 12_000;

export interface DiagnoseRegionReport {
  /** La region se localizo por sus etiquetas. */
  found: boolean;
  /** Nodos del esquema enviado (0 cuando no se encontro). */
  nodes: number;
  /** Esquema anonimizado y compacto; vacio cuando no se encontro. */
  outline: string;
}

export type DiagnoseRegions = Record<DiagnoseRegionKey, DiagnoseRegionReport>;

function emptyReport(): DiagnoseRegionReport {
  return { found: false, nodes: 0, outline: '' };
}

function reportOf(region: DomNodeLike | null, maxNodes: number): DiagnoseRegionReport {
  if (!region) return emptyReport();
  try {
    const tree = toTextTree(region, { maxNodes, maxDepth: 30 });
    if (tree.tag === 'unknown') return { found: true, nodes: 0, outline: '' };
    const anonymized = anonymizeTree(tree, { maxNodes });
    return {
      found: true,
      nodes: countTextNodes(anonymized, maxNodes),
      outline: treeToCompactText(anonymized, DIAGNOSE_REGION_MAX_CHARS),
    };
  } catch {
    // Un DOM raro no puede tumbar el diagnostico: se informa la region y ya.
    return { found: true, nodes: 0, outline: '' };
  }
}

/** Informe de cobertura de las tres regiones, en el orden del lector. */
export function describeRegions(source: RegionSource, opts: RegionOptions = {}): DiagnoseRegions {
  const requested = opts.maxNodes;
  const maxNodes =
    Number.isFinite(requested) && (requested as number) > 0
      ? Math.floor(requested as number)
      : DIAGNOSE_MAX_NODES;
  // El tope viaja también a la localización: así el diagnóstico mira lo mismo
  // que el lector y no serializa más de lo que el lector vería.
  const regionOpts: RegionOptions = { ...opts, maxNodes };
  return {
    balance: reportOf(findAccountBalanceRegion(source, regionOpts), maxNodes),
    positions: reportOf(findOpenPositionsRegion(source, regionOpts), maxNodes),
    history: reportOf(findHistoryRegion(source, regionOpts), maxNodes),
  };
}

/** Etiqueta corta de cada region para el resumen. */
const REGION_LABELS: Record<DiagnoseRegionKey, string> = {
  balance: 'caja de cuenta',
  positions: 'posiciones',
  history: 'historial',
};

/**
 * Resumen en una linea: `caja de cuenta ✓ 37 nodos · posiciones ✗ · historial
 * ✓ 128 nodos`. Sirve para saber de un vistazo que falta abrir o que el parser
 * no reconoce.
 */
export function regionSummary(regions: DiagnoseRegions): string {
  return DIAGNOSE_REGION_KEYS.map((key) => {
    const report = regions[key];
    const label = REGION_LABELS[key];
    if (!report?.found) return `${label} ✗`;
    return `${label} ✓ ${report.nodes} nodos`;
  }).join(' · ');
}

/**
 * Texto copiable del informe: el resumen, el esquema de CADA región y, solo si
 * ninguna se localizó, el volcado de respaldo (`outline`) para no perder el
 * diagnóstico anterior.
 */
export function composeDiagnoseText(regions: DiagnoseRegions, outline = ''): string {
  const found = DIAGNOSE_REGION_KEYS.filter((key) => regions[key]?.found);
  if (found.length === 0) {
    const fallback = outline.trim();
    return fallback ? `Regiones: ${regionSummary(regions)}\n\n${fallback}` : `Regiones: ${regionSummary(regions)}`;
  }
  const sections = found.map((key) => {
    const report = regions[key];
    return `== ${REGION_LABELS[key]} ==\n${report?.outline ?? ''}`;
  });
  return [`Regiones: ${regionSummary(regions)}`, ...sections].join('\n\n');
}
