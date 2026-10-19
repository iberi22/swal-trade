import type { LevelKind, LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';

/**
 * Tipos del análisis determinista de un dibujo Long/Short Position de
 * TradingView. Es una lectura de geometría y costes, no una predicción:
 * ningún nivel ni R:R tiene ventaja medida.
 */

export type DrawingSide = 'long' | 'short';

/** Dibujo Long/Short Position (entrada, stop, objetivo) tal como lo traza el usuario. */
export interface PositionDrawing {
  id: string;
  side: DrawingSide;
  entry: number;
  stop: number;
  target: number;
  symbol: string;
  createdAtMs?: number;
}

export type DrawingCheckSeverity = 'info' | 'warn';

export interface DrawingCheck {
  code: string;
  severity: DrawingCheckSeverity;
  text: string;
}

/** Un nivel del mapa visto desde la entrada: todo relativo, sin dirección. */
export interface DrawingLevelContext {
  price: number;
  kind: LevelKind;
  /** Tipos fusionados en la fila (el primero es `kind`), solo códigos. */
  kinds: LevelKind[];
  label: string;
  /** Distancia desde la entrada, en % del precio de entrada (magnitud). */
  distancePctFromEntry: number;
  /** Distancia desde la entrada en ATR(1h); null sin ATR. */
  distanceAtrFromEntry: number | null;
}

/** Tamaño de la posición al riesgo de la regla del usuario (riesgo = maxRiskPct). */
export interface DrawingSize {
  qty: number;
  notionalUsd: number;
  /** Margen al apalancamiento mínimo necesario. */
  marginUsd: number;
  minLeverage: number;
  /** Pérdida si salta el stop, comisiones incluidas. */
  lossUsd: number;
  lossPct: number;
  riskUsd: number;
  /** true si `lossUsd` incluye las comisiones de ida y vuelta. */
  lossIncludesFees: boolean;
}

export interface DrawingAtrs {
  atr1h: number | null;
  atr4h?: number | null;
  atrD?: number | null;
}

/** Filtros opcionales del contrato (mismos campos que SymbolFilters de trade-cards). */
export interface DrawingFilters {
  tickSize?: number;
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
}

export type DrawingEntryMode = 'mercado' | 'límite' | 'stop';

export interface DrawingAnalysis {
  drawing: PositionDrawing;
  symbol: string;
  side: DrawingSide;
  geometry: {
    /** Distancia stop como % de la entrada (riesgo bruto). */
    riskPct: number;
    /** Distancia objetivo como % de la entrada (recompensa bruta). */
    rewardPct: number;
    /** Recompensa / riesgo, 2 decimales. */
    rr: number;
    stopAtr1h: number | null;
    targetAtr1h: number | null;
    /** Distancia de la entrada al precio actual, signada (positiva si está por encima). */
    entryDistancePct: number;
    /** 'mercado' si la entrada está a ≤ 0,05 % del precio; 'límite' si reposa en el lado correcto; 'stop' si está al otro lado (entrada por stop, taker). */
    entryMode: DrawingEntryMode;
  };
  costs: {
    entryFeePct: number;
    exitFeePct: number;
    totalFeePct: number;
    /** Comisión de ida y vuelta como % del riesgo (stop). */
    feeShareOfRisk: number;
    /** R:R neto tras comisiones, 2 decimales. */
    netRr: number;
  };
  size: DrawingSize;
  levels: {
    /** Niveles estrictamente entre la entrada y el objetivo, ordenados por distancia a la entrada. */
    betweenEntryAndTarget: DrawingLevelContext[];
    /** Niveles a ≤ 0,3 ATR del stop (por encima o por debajo). */
    nearStop: DrawingLevelContext[];
    /** Nivel más próximo al otro lado del stop; null si no hay. */
    beyondStop: DrawingLevelContext | null;
    targetNearLevel: DrawingLevelContext | null;
    /** 'before' si el objetivo queda justo antes del nivel; 'after' si justo después. */
    targetNearLevelSide: 'before' | 'after' | null;
  };
  reach: {
    targetAtr4h: number | null;
    targetAtrD: number | null;
    /** Primer horizonte (1h, 4h, 24h) cuyo rango típico cubre el objetivo; null si ninguno. */
    smallestHorizon: '1h' | '4h' | '24h' | null;
  };
  funding: {
    ratePct8h: number | null;
    /** Coste por 8 h para el lado dibujado, como % del riesgo (negativo = cobra). */
    pctOfRiskPer8h: number | null;
    sidePays: boolean;
  };
  rules: {
    maxLeverageBreached: boolean;
    dailyLossBreached: boolean;
    stopWiderThanDaily: boolean;
  };
  checks: DrawingCheck[];
  summary: string;
}

export interface AnalyzeDrawingInput {
  drawing: PositionDrawing;
  price: number;
  levels: LevelRow[];
  atrs: DrawingAtrs;
  capital: number;
  rules: RulesSettings;
  filters?: DrawingFilters;
  fundingRatePct8h?: number | null;
}

/**
 * Resultado tipado del análisis: con geometría inválida (stop del lado
 * equivocado, orden roto, números no positivos) devuelve `ok:false` y NO
 * calcula R:R ni tamaño, en lugar de inventar cifras.
 */
export type DrawingAnalysisResult =
  | { ok: true; analysis: DrawingAnalysis }
  | { ok: false; reason: string };
