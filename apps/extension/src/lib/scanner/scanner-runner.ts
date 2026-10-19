// Ejecutor del escaner en la pagina del panel (v1, sin segundo plano). Une ajustes, universo,
// reloj del servidor, ciclo de 5 minutos, almacen de eventos, estadisticas, avisos e insignia.
// Todo lo que toca el navegador se inyecta (fetch, almacenamiento, insignia, avisos, sonido), asi
// las partes puras y el bucle se prueban con dobles. Solo datos publicos de Binance.
import { EventLog, MAX_ROWS, NotificationGate, eventKey, type ScannerEvent } from './events';
import { CooldownTracker, SPEC, type Plan, type Plans } from './movers';
import {
  FAPI, ServerClock, lastClosedOpen, runScanCycle, scheduleNextCycle,
  type ResponseLike, type ScanEvent, type ScanFetch, type ScanResult, type ScanState,
} from './scan-cycle';
import {
  defaultScannerSettings, loadScannerSettings, saveScannerSettings,
  type KeyValueStorage, type ScannerSettings,
} from './settings';
import { fetchMoversStats, gradeFor, sanitizeCell, type MoversStats, type StatsCell } from './stats';
import { btcSymbolFor, filterByVolume, scanSymbols, selectUniverse, validSymbol } from './universe';
import { hhmm, isMutedEvent, notificationText, type ScannerRowEvent } from './view';

export const EVENTS_KEY = 'scanner.events';
/** Latido del panel (ms epoch) tras cada ciclo; la vigilancia en segundo plano lo lee para no duplicar. */
export const PANEL_ACTIVE_KEY = 'scanner.panelActive';
export const UNIVERSE_TTL_MS = 3600 * 1000;
export const EXCHANGE_TIMEOUT_MS = 15_000;
export const TICKER_TIMEOUT_MS = 8_000;
const HIDDEN_TEXT = 'En pausa mientras el panel está oculto';
const DEFAULT_RETRY_S = 60;
const DEFAULT_BAN_S = 300;

// ---------------------------------------------------------------- estado

export type StatusKind = 'off' | 'starting' | 'ok' | 'paused' | 'banned' | 'error';

export interface RunnerState {
  /** El ajuste esta encendido y el bucle activo. */
  running: boolean;
  loaded: boolean;
  settings: ScannerSettings;
  startedAt: number | null;
  lastCycleAt: number | null;
  nextCycleAt: number | null;
  scanning: boolean;
  events: ScannerRowEvent[];
  unseen: number;
  statusKind: StatusKind;
  statusText: string;
}

export function initialRunnerState(): RunnerState {
  return {
    running: false, loaded: false, settings: defaultScannerSettings(), startedAt: null, lastCycleAt: null,
    nextCycleAt: null, scanning: false, events: [], unseen: 0, statusKind: 'off', statusText: 'Apagado',
  };
}

export interface StatusUpdate {
  kind: StatusKind;
  text: string;
  /** ms (hora del servidor) hasta los que no se debe volver a pedir; null si no aplica. */
  retryUntil: number | null;
}

/** Estado y texto en espanol para el resultado de un ciclo. `toLocal` convierte hora del servidor a local. */
export function statusFor(result: ScanResult, toLocal: (serverMs: number) => number = (x) => x): StatusUpdate {
  switch (result.status) {
    case 'ok': {
      const failed = result.stats.failed;
      const base = `Vigilando ${result.stats.symbols} pares`;
      return { kind: 'ok', text: failed > 0 ? `${base} · ${failed} sin datos` : base, retryUntil: null };
    }
    case 'same_bar':
      return { kind: 'ok', text: 'Esperando la próxima vela de 5 minutos', retryUntil: null };
    case 'paused': {
      const until = result.paused_until ?? null;
      const at = until === null ? '' : ` hasta las ${hhmm(toLocal(until))}`;
      return { kind: 'paused', text: `Binance pidió esperar; en pausa${at}`, retryUntil: until };
    }
    case 'banned': {
      const until = result.banned_until ?? null;
      const at = until === null ? '' : ` hasta las ${hhmm(toLocal(until))}`;
      return { kind: 'banned', text: `Binance bloqueó las peticiones (418); el escáner se detiene${at}`, retryUntil: until };
    }
    case 'weight':
      return { kind: 'paused', text: 'Cerca del límite de peso de Binance; se salta este ciclo', retryUntil: null };
    case 'aborted':
      return { kind: 'error', text: 'Demasiados pares sin respuesta; se reintenta en el próximo ciclo', retryUntil: null };
    case 'empty':
    default:
      return { kind: 'error', text: 'Sin pares que vigilar: revisa el universo y el volumen mínimo', retryUntil: null };
  }
}

/** Insignia del icono: no vistos mientras la pestana no esta abierta; vacia si esta apagada o desactivada. */
export function badgeText(unseen: number, opts: { enabled: boolean; badge: boolean; tabActive: boolean }): string {
  if (!opts.enabled || !opts.badge || opts.tabActive || unseen <= 0) return '';
  return unseen > 99 ? '99+' : String(unseen);
}

// ---------------------------------------------------------------- celdas

/** Umbral minimo configurado para un nivel de volumen. Las filas de mercado usan el menor. */
export function thresholdFor(settings: ScannerSettings, tier: string | null): number {
  const t = settings.thresholds;
  if (tier === 'hi' || tier === 'mid' || tier === 'lo') return t[tier];
  return Math.min(t.hi, t.mid, t.lo);
}

export function passesThreshold(settings: ScannerSettings, o: ScanEvent): boolean {
  const e = o.event as { threshold?: unknown; tier?: unknown; market?: unknown };
  const tier = e.market === true || typeof e.tier !== 'string' ? null : e.tier;
  return Number(e.threshold) >= thresholdFor(settings, tier);
}

/** Celdas de estudio de cada modo para un evento (contexto exacto y, si no existe, el general). */
export function cellsForEvent(
  stats: MoversStats | null,
  e: Pick<ScannerEvent, 'signal' | 'threshold' | 'move' | 'tier' | 'marketWide'> & { count?: number },
): { follow: StatsCell | null; fade: StatsCell | null } {
  const out: { follow: StatsCell | null; fade: StatsCell | null } = { follow: null, fade: null };
  if (!stats || e.tier === null || e.count !== undefined) return out;
  for (const mode of ['follow', 'fade'] as const) {
    const direction = (mode === 'follow') === (e.move === 'up') ? 'long' : 'short';
    const base = { mode, direction, threshold: e.threshold, tier: e.tier, signal: e.signal } as const;
    const specific = gradeFor(stats, SPEC.version, { ...base, context: e.marketWide ? 'market_wide' : 'idio' }).cell;
    out[mode] = specific ?? gradeFor(stats, SPEC.version, { ...base, context: 'all' }).cell;
  }
  return out;
}

// ---------------------------------------------------------------- persistencia

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): number | null => (fin(x) ? x : null);

function parsePlan(x: unknown, mode: 'follow' | 'fade'): Plan | null {
  if (!isObj(x) || x.mode !== mode) return null;
  if (x.direction !== 'long' && x.direction !== 'short') return null;
  const { entry, stop, t1, t2, stop_dist } = x;
  if (!fin(entry) || !fin(stop) || !fin(t1) || !fin(t2) || !fin(stop_dist)) return null;
  return { mode, direction: x.direction, entry, stop, t1, t2, stop_dist };
}

function parsePlans(x: unknown): Plans | null {
  if (!isObj(x)) return null;
  const follow = parsePlan(x.follow, 'follow');
  const fade = parsePlan(x.fade, 'fade');
  return follow || fade ? { follow, fade } : null;
}

/** Una fila guardada, validada campo a campo; null si algo no encaja. */
export function parseStoredEvent(x: unknown): ScannerRowEvent | null {
  if (!isObj(x)) return null;
  if (typeof x.id !== 'string' || x.id.length === 0 || x.id.length > 80) return null;
  const market = x.symbol === 'MARKET';
  const symbol = market ? 'MARKET' : validSymbol(x.symbol);
  if (!symbol) return null;
  if (typeof x.signal !== 'string' || !/^[a-z0-9_]{1,24}$/.test(x.signal)) return null;
  if (![3, 5, 7].includes(x.threshold as number)) return null;
  if (x.move !== 'up' && x.move !== 'down') return null;
  if (!fin(x.createdAtMs) || !fin(x.updatedAtMs) || x.createdAtMs <= 0 || x.updatedAtMs <= 0) return null;
  if (typeof x.marketWide !== 'boolean') return null;
  const tier = x.tier === 'hi' || x.tier === 'mid' || x.tier === 'lo' ? x.tier : null;
  const cellsRaw = isObj(x.cells) ? x.cells : {};
  const follow = sanitizeCell(cellsRaw.follow);
  const fade = sanitizeCell(cellsRaw.fade);
  const e: ScannerRowEvent = {
    id: x.id,
    symbol,
    signal: x.signal,
    threshold: x.threshold as number,
    move: x.move,
    ret: numOrNull(x.ret),
    vol_ratio: numOrNull(x.vol_ratio),
    tier,
    q24: numOrNull(x.q24),
    takerImb: numOrNull(x.takerImb),
    marketWide: x.marketWide,
    createdAtMs: x.createdAtMs,
    updatedAtMs: x.updatedAtMs,
    prevThreshold: numOrNull(x.prevThreshold),
    plans: market ? null : parsePlans(x.plans),
    cells: { follow: follow && follow.mode === 'follow' ? follow : null, fade: fade && fade.mode === 'fade' ? fade : null },
    seen: x.seen === true,
  };
  if (market) {
    if (!fin(x.count) || x.count < 0) return null;
    e.count = Math.floor(x.count);
    e.symbols = Array.isArray(x.symbols)
      ? x.symbols.map(validSymbol).filter((s): s is string => s !== null).slice(0, 300)
      : [];
  } else if (fin(x.relBtc)) {
    e.relBtc = x.relBtc;
  }
  return e;
}

/** Lista guardada -> filas validas, sin duplicados, la mas reciente primero, como mucho 200. */
export function parseStoredEvents(raw: unknown): ScannerRowEvent[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
  const seen = new Set<string>();
  const out: ScannerRowEvent[] = [];
  for (const item of list.slice(0, MAX_ROWS * 2)) {
    const e = parseStoredEvent(item);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, MAX_ROWS);
}

export function serializeEvents(events: ReadonlyArray<ScannerEvent>): { v: 1; events: ScannerEvent[] } {
  return { v: 1, events: events.slice(0, MAX_ROWS).map((e) => ({ ...e })) };
}

// ---------------------------------------------------------------- sonido

/** Pitido corto con WebAudio; sin archivos de audio. Silencioso si el navegador lo bloquea. */
export function playBeep(): void {
  try {
    const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => void ctx.close().catch(() => {});
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    /* sin sonido */
  }
}

// ---------------------------------------------------------------- ejecutor

export interface RunnerDeps {
  fetch: ScanFetch;
  storage: KeyValueStorage;
  /** Reloj local (ms). */
  now?: () => number;
  baseUrl?: string;
  setBadge?: (text: string) => void;
  notify?: (n: { title: string; message: string }) => void;
  notificationsAllowed?: () => Promise<boolean>;
  beep?: () => void;
}

export interface ScannerRunner {
  subscribe(fn: (state: RunnerState) => void): () => void;
  getState(): RunnerState;
  /** Carga ajustes y eventos guardados; arranca si el ajuste esta encendido. */
  init(): Promise<void>;
  setSettings(patch: Partial<ScannerSettings>): Promise<ScannerSettings>;
  /** El panel se ve (document.visibilityState). Oculto, no se consulta nada. */
  setVisible(visible: boolean): void;
  /** La pestana Escaner esta abierta: limpia la insignia y, al salir, marca todo como visto. */
  setTabActive(active: boolean): void;
  destroy(): void;
}

type Json =
  | { kind: 'ok'; body: unknown }
  | { kind: 'paused' | 'banned'; retryMs: number }
  | { kind: 'error' };

function retryMsOf(res: ResponseLike, fallbackS: number): number {
  const v = Number(res.headers.get('Retry-After'));
  return (Number.isFinite(v) && v > 0 ? v : fallbackS) * 1000;
}

export function createScannerRunner(deps: RunnerDeps): ScannerRunner {
  const localNow = deps.now ?? Date.now;
  const base = deps.baseUrl ?? FAPI;
  const clock = new ServerClock(deps.fetch, localNow, base);
  const gate = new NotificationGate();
  const listeners = new Set<(s: RunnerState) => void>();
  const scanState: ScanState = { lastBarOpenMs: null };

  let state = initialRunnerState();
  let settings = state.settings;
  let log = new EventLog();
  let cooldown = new CooldownTracker();
  let stats: MoversStats | null = null;
  let universe: { quote: string; at: number; symbols: string[] } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let visible = true;
  let tabActive = false;
  let cycling = false;
  let generation = 0;
  let destroyed = false;
  let lastBadge: string | null = null;

  function snapshot(): RunnerState {
    return { ...state, settings, events: log.list().map((e) => ({ ...e })), unseen: log.unseenCount(), running };
  }

  function emit(patch: Partial<RunnerState> = {}): void {
    state = { ...state, ...patch };
    const next = snapshot();
    state = next;
    updateBadge(next.unseen);
    for (const fn of listeners) fn(next);
  }

  function updateBadge(unseen: number): void {
    if (!deps.setBadge) return;
    const text = badgeText(unseen, { enabled: running, badge: settings.badge, tabActive });
    if (text === lastBadge) return;
    lastBadge = text;
    try {
      deps.setBadge(text);
    } catch {
      /* sin insignia */
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(retryUntilServer: number | null): void {
    clearTimer();
    if (!running || destroyed) return;
    if (!visible) {
      emit({ nextCycleAt: null, statusKind: 'paused', statusText: HIDDEN_TEXT });
      return;
    }
    const serverNow = clock.now();
    let delay = scheduleNextCycle(serverNow);
    if (retryUntilServer !== null) delay = Math.max(delay, retryUntilServer - serverNow);
    emit({ nextCycleAt: localNow() + delay });
    const gen = generation;
    timer = setTimeout(() => {
      timer = null;
      if (gen === generation) void cycle();
    }, delay);
  }

  async function getJson(url: string, timeoutMs: number): Promise<Json> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await deps.fetch(url, { signal: ctl.signal });
      if (res.status === 418) return { kind: 'banned', retryMs: retryMsOf(res, DEFAULT_BAN_S) };
      if (res.status === 429) return { kind: 'paused', retryMs: retryMsOf(res, DEFAULT_RETRY_S) };
      if (!res.ok) return { kind: 'error' };
      return { kind: 'ok', body: await res.json() };
    } catch {
      return { kind: 'error' };
    } finally {
      clearTimeout(t);
    }
  }

  async function persist(): Promise<void> {
    try {
      await deps.storage.set(EVENTS_KEY, serializeEvents(log.list()));
    } catch {
      /* sin persistencia */
    }
  }

  async function announce(fresh: ScannerEvent[]): Promise<void> {
    if (fresh.length === 0 || (!settings.sound && !settings.notifications)) return;
    gate.setOptions({ maxPerHour: settings.maxPerHour, quietHours: settings.quietHours });
    const res = gate.process(fresh, localNow(), (e) => isMutedEvent(e, settings));
    if (res.notify.length === 0) return;
    if (settings.sound && visible) deps.beep?.();
    if (!settings.notifications || !deps.notify) return;
    let allowed = false;
    try {
      allowed = (await deps.notificationsAllowed?.()) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) return;
    for (const e of res.notify) {
      const text = notificationText(e);
      if (text) deps.notify(text);
    }
    if (res.summary) deps.notify({ title: 'Escáner', message: res.summary });
  }

  function absorb(result: ScanResult): ScannerEvent[] {
    const outs = result.events.filter((o) => passesThreshold(settings, o));
    const rel = new Map<string, number | null>();
    for (const o of outs) {
      const ev = o.event as { symbol: string; signal: string; move: string; rel_btc?: unknown };
      rel.set(eventKey(ev), numOrNull(ev.rel_btc));
    }
    const { inserted, updated } = log.apply(outs);
    const fresh = [...inserted, ...updated];
    for (const e of fresh) {
      e.cells = cellsForEvent(stats, e);
      const r = rel.get(eventKey(e));
      if (r !== undefined && r !== null && e.count === undefined) (e as ScannerRowEvent).relBtc = r;
    }
    // las estadisticas pueden haber llegado despues que la fila: se vuelven a consultar
    if (stats && stats.cells.length > 0) {
      for (const e of log.list()) e.cells = cellsForEvent(stats, e);
    }
    return fresh;
  }

  async function cycle(): Promise<void> {
    if (cycling || !running || !visible || destroyed) return;
    cycling = true;
    const gen = generation;
    emit({ scanning: true });
    let retryUntil: number | null = null;
    try {
      await clock.ensure();
      if (gen !== generation) return;
      // misma vela ya procesada (p. ej. el panel volvio a verse): no se pide nada
      if (scanState.lastBarOpenMs !== null && lastClosedOpen(clock.now()) <= scanState.lastBarOpenMs) return;
      const halted = (kind: 'paused' | 'banned', retryMs: number): void => {
        const until = clock.now() + retryMs;
        retryUntil = until;
        const at = hhmm(localNow() + retryMs);
        emit({
          statusKind: kind,
          statusText: kind === 'banned'
            ? `Binance bloqueó las peticiones (418); el escáner se detiene hasta las ${at}`
            : `Binance pidió esperar; en pausa hasta las ${at}`,
          lastCycleAt: localNow(),
        });
      };
      const failed = (text: string): void => {
        emit({ statusKind: 'error', statusText: text, lastCycleAt: localNow() });
      };

      if (!universe || universe.quote !== settings.universe || localNow() - universe.at >= UNIVERSE_TTL_MS) {
        const ex = await getJson(`${base}/fapi/v1/exchangeInfo`, EXCHANGE_TIMEOUT_MS);
        if (gen !== generation) return;
        if (ex.kind === 'paused' || ex.kind === 'banned') return halted(ex.kind, ex.retryMs);
        if (ex.kind !== 'ok') return failed('No se pudo leer la lista de pares de Binance; se reintenta');
        universe = { quote: settings.universe, at: localNow(), symbols: selectUniverse(ex.body, settings.universe) };
      }

      const [tk, st] = await Promise.all([
        getJson(`${base}/fapi/v1/ticker/24hr`, TICKER_TIMEOUT_MS),
        fetchMoversStats(deps.fetch, 'study', { storage: deps.storage, now: localNow }),
      ]);
      if (gen !== generation) return;
      if (st.cells.length > 0 || stats === null) stats = st;
      if (tk.kind === 'paused' || tk.kind === 'banned') return halted(tk.kind, tk.retryMs);
      if (tk.kind !== 'ok') return failed('No se pudo leer el volumen de 24 h de Binance; se reintenta');

      const q24 = filterByVolume(tk.body, settings.minQ24);
      const symbols = scanSymbols(universe.symbols, q24);
      const result = await runScanCycle({
        fetch: deps.fetch,
        now: () => clock.now(),
        universe: symbols,
        q24,
        cooldown,
        state: scanState,
        btcSymbol: btcSymbolFor(settings.universe),
        baseUrl: base,
      });
      if (gen !== generation) return;

      const status = statusFor(result, (serverMs) => localNow() + (serverMs - clock.now()));
      retryUntil = status.retryUntil;
      let fresh: ScannerEvent[] = [];
      if (result.status === 'ok') fresh = absorb(result);
      emit({ statusKind: status.kind, statusText: status.text, lastCycleAt: localNow() });
      if (fresh.length > 0) {
        await persist();
        await announce(fresh);
      }
    } catch {
      if (gen === generation) {
        emit({ statusKind: 'error', statusText: 'Error inesperado; se reintenta en el próximo ciclo', lastCycleAt: localNow() });
      }
    } finally {
      if (gen === generation) {
        cycling = false;
        void Promise.resolve(deps.storage.set(PANEL_ACTIVE_KEY, localNow())).catch(() => {});
        emit({ scanning: false });
        schedule(retryUntil);
      }
    }
  }

  function start(): void {
    if (running || destroyed) return;
    running = true;
    generation++;
    scanState.lastBarOpenMs = null;
    cooldown = new CooldownTracker();
    cycling = false;
    emit({
      startedAt: localNow(),
      statusKind: visible ? 'starting' : 'paused',
      statusText: visible ? 'Iniciando…' : HIDDEN_TEXT,
    });
    if (visible) void cycle();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    generation++;
    clearTimer();
    emit({ scanning: false, nextCycleAt: null, statusKind: 'off', statusText: 'Apagado' });
    cycling = false;
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => {
        listeners.delete(fn);
      };
    },
    getState: () => state,
    async init() {
      settings = await loadScannerSettings(deps.storage);
      try {
        log = new EventLog(MAX_ROWS, parseStoredEvents(await deps.storage.get(EVENTS_KEY)));
      } catch {
        log = new EventLog();
      }
      emit({ loaded: true });
      if (settings.enabled) start();
    },
    async setSettings(patch) {
      const next = await saveScannerSettings(deps.storage, { ...settings, ...patch });
      settings = next;
      emit();
      if (next.enabled && !running) start();
      else if (!next.enabled && running) stop();
      return next;
    },
    setVisible(v) {
      if (visible === v) return;
      visible = v;
      if (!running) return;
      if (!v) {
        clearTimer();
        emit({ nextCycleAt: null, statusKind: 'paused', statusText: HIDDEN_TEXT });
      } else {
        void cycle();
      }
    },
    setTabActive(active) {
      if (tabActive === active) return;
      tabActive = active;
      if (!active) {
        log.markAllSeen();
        void persist();
      }
      emit();
    },
    destroy() {
      destroyed = true;
      running = false;
      generation++;
      clearTimer();
      listeners.clear();
    },
  };
}
