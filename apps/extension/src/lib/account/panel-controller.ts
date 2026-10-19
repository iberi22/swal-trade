import { nextMode, type DataSource, type Mode } from './panel-mode';
import type { AccountSnapshot, PositionView } from './types';
import { shortPrice } from '../findings-view';

/** Cada cuánto se pide la cuenta al background mientras el panel se ve. */
export const SNAPSHOT_POLL_MS = 10_000;
/** Paso del reloj interno: reevalúa el modo (p. ej. fin de `loading`) sin red. */
export const CLOCK_MS = 1_000;

export type PanelTab = 'operacion' | 'analisis' | 'ajustes' | 'escaner' | 'mistrades';
export const PANEL_TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: 'operacion', label: 'Operación' },
  { id: 'analisis', label: 'Análisis' },
  { id: 'ajustes', label: 'Ajustes' },
  { id: 'escaner', label: 'Escáner' },
  { id: 'mistrades', label: 'Mis trades' },
];
export const PANEL_TAB_KEY = 'panelTab';

export function parsePanelTab(value: unknown): PanelTab {
  return PANEL_TABS.some((tab) => tab.id === value) ? (value as PanelTab) : 'operacion';
}

/** Pestaña a la que lleva una tecla de la barra (flechas, Inicio, Fin); null si no es de navegación. */
export function tabForKey(current: PanelTab, key: string): PanelTab | null {
  const index = PANEL_TABS.findIndex((tab) => tab.id === current);
  const last = PANEL_TABS.length - 1;
  if (key === 'ArrowRight') return PANEL_TABS[index >= last ? 0 : index + 1]!.id;
  if (key === 'ArrowLeft') return PANEL_TABS[index <= 0 ? last : index - 1]!.id;
  if (key === 'Home') return PANEL_TABS[0]!.id;
  if (key === 'End') return PANEL_TABS[last]!.id;
  return null;
}

export interface PanelState {
  mode: Mode;
  stale: boolean;
  snapshot: AccountSnapshot | null;
  error: string | null;
}

/** Posición abierta en el símbolo dado, o null. */
export function positionFor(snapshot: AccountSnapshot | null, symbol: string): PositionView | null {
  return snapshot?.positions.find((p) => p.symbol === symbol && Number.isFinite(p.size) && p.size !== 0) ?? null;
}

/** Lee la respuesta del background a `acct:snapshot`. Basura => error, nunca excepción. */
export function parseSnapshotReply(raw: unknown): { snapshot: AccountSnapshot | null; error: string | null } {
  if (!raw || typeof raw !== 'object') return { snapshot: null, error: 'bad_reply' };
  const reply = raw as { snapshot?: unknown; error?: unknown };
  const error = typeof reply.error === 'string' && reply.error ? reply.error : null;
  const snap = reply.snapshot as Partial<AccountSnapshot> | null | undefined;
  if (!snap || typeof snap !== 'object' || typeof snap.fetchedAt !== 'number' || !Array.isArray(snap.positions)) {
    return { snapshot: null, error: error ?? 'no_snapshot' };
  }
  return { snapshot: snap as AccountSnapshot, error };
}

export interface PanelContext {
  symbol: string;
  /** `settings.acctMeta.configured`: sin clave no se pide nada. */
  configured: boolean;
  /** Las velas públicas del símbolo cargaron sin error. */
  klinesOk: boolean;
}

export interface PanelControllerDeps {
  send(message: { type: 'acct:snapshot'; symbol: string }): Promise<unknown>;
  now(): number;
  isVisible(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  onChange(state: PanelState): void;
}

export interface PanelController {
  setContext(context: PanelContext): void;
  /** Llamar cuando cambie `document.visibilityState`. */
  visibilityChanged(): void;
  /** Un paso del reloj interno (lo llama el intervalo; público para probar). */
  tick(): void;
  state(): PanelState;
  stop(): void;
}

export function createPanelController(deps: PanelControllerDeps): PanelController {
  let context: PanelContext | null = null;
  let symbolSince = deps.now();
  let snapshot: AccountSnapshot | null = null;
  let error: string | null = null;
  let lastMode: Mode = 'loading';
  let lastFetchAt = -Infinity;
  let inFlight = false;
  let current: PanelState = { mode: 'loading', stale: false, snapshot: null, error: null };
  let timer: unknown = null;
  let stopped = false;

  function recompute() {
    if (!context) return;
    const source: DataSource = context.configured ? 'api' : 'none';
    const result = nextMode({
      symbol: context.symbol,
      klinesOk: context.klinesOk,
      source,
      snapshot: snapshot ?? undefined,
      lastMode,
      error: error ?? undefined,
      now: deps.now(),
      sinceSymbolChangeMs: deps.now() - symbolSince,
    });
    // Sin cuenta que consultar, la falta de velas públicas es lo único que se puede decir.
    const mode: Mode = result.mode === 'unknown' && !context.klinesOk ? 'no-data' : result.mode;
    lastMode = mode;
    const next: PanelState = { mode, stale: result.stale, snapshot, error };
    if (
      next.mode !== current.mode ||
      next.stale !== current.stale ||
      next.snapshot !== current.snapshot ||
      next.error !== current.error
    ) {
      current = next;
      deps.onChange(next);
    }
  }

  function fetchSnapshot() {
    if (!context || !context.configured || inFlight || stopped) return;
    const symbol = context.symbol;
    inFlight = true;
    lastFetchAt = deps.now();
    deps
      .send({ type: 'acct:snapshot', symbol })
      .then((raw) => {
        if (stopped || context?.symbol !== symbol) return;
        const parsed = parseSnapshotReply(raw);
        // Un fallo no borra la última cuenta buena: se queda como caducada.
        if (parsed.snapshot) snapshot = parsed.snapshot;
        error = parsed.error;
      })
      .catch(() => {
        if (stopped || context?.symbol !== symbol) return;
        error = 'net';
      })
      .finally(() => {
        inFlight = false;
        recompute();
      });
  }

  function evaluate() {
    if (deps.isVisible() && context?.configured && deps.now() - lastFetchAt >= SNAPSHOT_POLL_MS) {
      fetchSnapshot();
    }
    recompute();
  }

  function startClock() {
    if (timer === null) timer = deps.setInterval(() => controller.tick(), CLOCK_MS);
  }

  const controller: PanelController = {
    setContext(next) {
      const symbolChanged = !context || context.symbol !== next.symbol;
      const keyChanged = !context || context.configured !== next.configured;
      context = next;
      if (symbolChanged) {
        symbolSince = deps.now();
        snapshot = null;
        error = null;
        lastMode = 'loading';
        lastFetchAt = -Infinity;
      }
      if (keyChanged && !next.configured) {
        snapshot = null;
        error = null;
        lastMode = 'loading';
      }
      if (symbolChanged || keyChanged) lastFetchAt = -Infinity;
      startClock();
      evaluate();
    },
    visibilityChanged() {
      // Al volver a verse se pide de inmediato: el dato pudo caducar con el panel oculto.
      if (deps.isVisible()) lastFetchAt = -Infinity;
      evaluate();
    },
    tick() {
      evaluate();
    },
    state() {
      return current;
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
    },
  };
  return controller;
}

// --- Qué se ve en cada modo (T13) ---------------------------------------

export interface PanelSections {
  position: boolean;
  sizing: boolean;
  /** Pulso de mercado, titulares y radar. */
  market: boolean;
  /** Una línea de aviso, o null. */
  notice: string | null;
}

/**
 * Reglas del panel por modo. El dimensionador NUNCA se ve en `position`,
 * tampoco con el dato caducado: ahí puede haber una posición abierta.
 */
export function sectionsForMode(mode: Mode, symbol: string): PanelSections {
  switch (mode) {
    case 'position':
      return { position: true, sizing: false, market: true, notice: null };
    case 'flat':
      return { position: false, sizing: true, market: true, notice: null };
    case 'unknown':
      return {
        position: false,
        sizing: true,
        market: true,
        notice: 'No sé si tienes posición. Conecta una clave de solo lectura (Ajustes).',
      };
    case 'no-data':
      return { position: false, sizing: false, market: false, notice: `Sin velas públicas para ${symbol}` };
    case 'loading':
    default:
      return { position: false, sizing: false, market: true, notice: 'comprobando…' };
  }
}

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * Líneas de la tarjeta de posición (6 como máximo). La gravedad va en el
 * texto, no en el color: `SIN STOP` y `CADUCADO` van en mayúsculas.
 */
export function positionCardLines(position: PositionView, stale: boolean): string[] {
  const side = position.side === 'long' ? 'LARGO' : 'CORTO';
  const lines = [
    `${side} · ${num(position.size, 6)} ${position.symbol}`,
    `Entrada ${shortPrice(position.entry)}`,
    `Marca ${shortPrice(position.mark)}`,
    `uPnL ${position.uPnl > 0 ? '+' : ''}${num(position.uPnl, 2)} USDT`,
    position.stop ? `Stop ${shortPrice(position.stop.price)}` : 'SIN STOP',
  ];
  const liq = liqDistancePct(position);
  lines.push(liq === null ? 'Liquidación: sin dato' : `Liquidación a ${num(liq, 1)} % (${shortPrice(position.liq)})`);
  if (stale) lines[5] = `${lines[5]} · CADUCADO`;
  return lines;
}

/** Distancia de la marca a la liquidación, en % de la marca; null sin dato. */
export function liqDistancePct(position: Pick<PositionView, 'mark' | 'liq'>): number | null {
  const { mark, liq } = position;
  if (liq === null || !Number.isFinite(liq) || liq <= 0 || !Number.isFinite(mark) || mark <= 0) return null;
  return (Math.abs(mark - liq) / mark) * 100;
}
