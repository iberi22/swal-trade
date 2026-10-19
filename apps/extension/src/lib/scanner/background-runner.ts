// Vigilancia con el panel cerrado (v1.1): un ciclo por alarma de chrome.alarms, con el mismo motor
// que el panel (reloj del servidor, universo, ciclo de 5 minutos, enfriamiento, estadisticas).
// Logica pura e inyectable: el service worker solo le pasa fetch, almacenamiento, insignia y avisos.
// Solo datos publicos de Binance; sin cuenta ni IA.
import { EventLog, MAX_ROWS, NotificationGate, eventKey, type ScannerEvent } from './events';
import { CooldownTracker, type TrackedEvent } from './movers';
import {
  FAPI, ServerClock, lastClosedOpen, runScanCycle,
  type ResponseLike, type ScanFetch, type ScanResult, type ScanState,
} from './scan-cycle';
import {
  EVENTS_KEY, EXCHANGE_TIMEOUT_MS, PANEL_ACTIVE_KEY, TICKER_TIMEOUT_MS, UNIVERSE_TTL_MS,
  badgeText, cellsForEvent, parseStoredEvents, passesThreshold, serializeEvents, statusFor,
} from './scanner-runner';
import { loadScannerSettings, type KeyValueStorage, type ScannerSettings } from './settings';
import { fetchMoversStats, type MoversStats } from './stats';
import { btcSymbolFor, filterByVolume, scanSymbols, selectUniverse } from './universe';
import { isMutedEvent, notificationText, type ScannerRowEvent } from './view';

export const ALARM_NAME = 'scanner-cycle';
export const ALARM_PERIOD_MIN = 5;
export const HEALTH_KEY = 'scanner.health';
export const BG_STATE_KEY = 'scanner.bgState';
export const BG_UNIVERSE_KEY = 'scanner.bgUniverse';
/** Si el panel escaneo hace menos que esto, la alarma no escanea (evita doble ciclo y doble aviso). */
export const PANEL_FRESH_MS = 6 * 60_000;
/** Tope de pares por ciclo para que el worker termine muy por debajo de 30 s (se queda con los de mas volumen). */
export const MAX_SYMBOLS = 150;
const BAR_MS = ALARM_PERIOD_MIN * 60_000;
const ALIGN_DELAY_MS = 3000;
const DEFAULT_RETRY_S = 60;
const DEFAULT_BAN_S = 300;

export interface AlarmSpec {
  name: string;
  when: number;
  periodInMinutes: number;
}

/** Alarma que debe existir: null si la vigilancia en segundo plano esta apagada. */
export function desiredAlarm(settings: Pick<ScannerSettings, 'enabled' | 'backgroundMode'>, nowMs: number): AlarmSpec | null {
  if (!settings.enabled || !settings.backgroundMode) return null;
  let when = Math.floor(nowMs / BAR_MS) * BAR_MS + ALIGN_DELAY_MS;
  if (when <= nowMs) when += BAR_MS;
  return { name: ALARM_NAME, when, periodInMinutes: ALARM_PERIOD_MIN };
}

export interface ScannerHealth {
  lastCycleAt: number | null;
  lastStatus: string;
  cycles: number;
  errors: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function parseHealth(raw: unknown): ScannerHealth | null {
  if (!isObj(raw)) return null;
  if (!fin(raw.cycles) || !fin(raw.errors)) return null;
  const last = fin(raw.lastCycleAt) && raw.lastCycleAt > 0 ? raw.lastCycleAt : null;
  const status = typeof raw.lastStatus === 'string' && /^[a-z_]{1,24}$/.test(raw.lastStatus) ? raw.lastStatus : 'unknown';
  return { lastCycleAt: last, lastStatus: status, cycles: Math.max(0, Math.floor(raw.cycles)), errors: Math.max(0, Math.floor(raw.errors)) };
}

interface BgState {
  lastBarOpenMs: number | null;
  /** ms locales hasta los que no se pide nada (429/418). */
  blockedUntil: number | null;
}

function parseBgState(raw: unknown): BgState {
  if (!isObj(raw)) return { lastBarOpenMs: null, blockedUntil: null };
  return {
    lastBarOpenMs: fin(raw.lastBarOpenMs) ? raw.lastBarOpenMs : null,
    blockedUntil: fin(raw.blockedUntil) ? raw.blockedUntil : null,
  };
}

export type BackgroundOutcome =
  | 'off' | 'panel_active' | 'blocked' | 'same_bar' | 'busy'
  | 'ok' | 'paused' | 'banned' | 'error';

export interface BackgroundDeps {
  fetch: ScanFetch;
  storage: KeyValueStorage;
  /** Reloj local (ms). */
  now?: () => number;
  baseUrl?: string;
  setBadge?: (text: string) => void;
  notify?: (n: { title: string; message: string }) => void;
  /** Permiso opcional 'notifications' concedido. */
  notificationsAllowed?: () => Promise<boolean>;
}

export interface BackgroundScanner {
  onAlarm(): Promise<BackgroundOutcome>;
}

type Json =
  | { kind: 'ok'; body: unknown }
  | { kind: 'paused' | 'banned'; retryMs: number }
  | { kind: 'error' };

function retryMsOf(res: ResponseLike, fallbackS: number): number {
  const v = Number(res.headers.get('Retry-After'));
  return (Number.isFinite(v) && v > 0 ? v : fallbackS) * 1000;
}

/** Reconstruye el enfriamiento desde las filas guardadas, de la mas antigua a la mas reciente. */
export function rebuildCooldown(events: ReadonlyArray<ScannerEvent>): CooldownTracker {
  const cooldown = new CooldownTracker();
  const rows = [...events].sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const r of rows) {
    const t: TrackedEvent = {
      symbol: r.symbol,
      signal: r.signal,
      move: r.move,
      threshold: r.threshold,
      open_time_ms: r.createdAtMs,
      close_time_ms: r.createdAtMs,
      ...(r.count !== undefined ? { market: true, count: r.count } : {}),
    };
    cooldown.process([t]);
  }
  return cooldown;
}

export function createBackgroundScanner(deps: BackgroundDeps): BackgroundScanner {
  const localNow = deps.now ?? Date.now;
  const base = deps.baseUrl ?? FAPI;
  const clock = new ServerClock(deps.fetch, localNow, base);
  const gate = new NotificationGate();
  let busy = false;

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

  async function put(key: string, value: unknown): Promise<void> {
    try {
      await deps.storage.set(key, value);
    } catch {
      /* sin persistencia */
    }
  }

  async function readUniverse(settings: ScannerSettings): Promise<Json & { symbols?: string[] }> {
    try {
      const hit = (await deps.storage.get(BG_UNIVERSE_KEY)) as { quote?: unknown; at?: unknown; symbols?: unknown } | undefined;
      if (
        hit && hit.quote === settings.universe && fin(hit.at) && localNow() - hit.at >= 0
        && localNow() - hit.at < UNIVERSE_TTL_MS && Array.isArray(hit.symbols)
      ) {
        return { kind: 'ok', body: null, symbols: hit.symbols.filter((s): s is string => typeof s === 'string') };
      }
    } catch {
      /* cache ilegible */
    }
    const ex = await getJson(`${base}/fapi/v1/exchangeInfo`, EXCHANGE_TIMEOUT_MS);
    if (ex.kind !== 'ok') return ex;
    const symbols = selectUniverse(ex.body, settings.universe);
    await put(BG_UNIVERSE_KEY, { quote: settings.universe, at: localNow(), symbols });
    return { kind: 'ok', body: null, symbols };
  }

  async function announce(settings: ScannerSettings, fresh: ScannerEvent[]): Promise<void> {
    if (fresh.length === 0 || !settings.notifications || !deps.notify) return;
    let allowed = false;
    try {
      allowed = (await deps.notificationsAllowed?.()) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) return;
    gate.setOptions({ maxPerHour: settings.maxPerHour, quietHours: settings.quietHours });
    const res = gate.process(fresh, localNow(), (e) => isMutedEvent(e, settings));
    for (const e of res.notify) {
      const text = notificationText(e);
      if (text) deps.notify(text);
    }
    if (res.summary) deps.notify({ title: 'Escáner', message: res.summary });
  }

  function setBadge(settings: ScannerSettings, unseen: number): void {
    if (!deps.setBadge) return;
    try {
      deps.setBadge(badgeText(unseen, { enabled: true, badge: settings.badge, tabActive: false }));
    } catch {
      /* sin insignia */
    }
  }

  async function run(settings: ScannerSettings): Promise<BackgroundOutcome> {
    const now = localNow();
    const beat = await deps.storage.get(PANEL_ACTIVE_KEY).catch(() => undefined);
    if (fin(beat) && now - beat >= 0 && now - beat < PANEL_FRESH_MS) return 'panel_active';

    const bg = parseBgState(await deps.storage.get(BG_STATE_KEY).catch(() => undefined));
    if (bg.blockedUntil !== null && bg.blockedUntil > now) return 'blocked';

    let cycles = 0;
    let errors = 0;
    const prev = parseHealth(await deps.storage.get(HEALTH_KEY).catch(() => undefined));
    if (prev) { cycles = prev.cycles; errors = prev.errors; }
    const finish = async (outcome: BackgroundOutcome, status: string, patch: Partial<BgState> = {}): Promise<BackgroundOutcome> => {
      cycles++;
      if (outcome === 'error') errors++;
      await put(HEALTH_KEY, { lastCycleAt: localNow(), lastStatus: status, cycles, errors } satisfies ScannerHealth);
      await put(BG_STATE_KEY, { ...bg, ...patch } satisfies BgState);
      return outcome;
    };
    const halted = (kind: 'paused' | 'banned', retryMs: number) =>
      finish(kind, kind, { blockedUntil: localNow() + retryMs });

    await clock.ensure();
    if (bg.lastBarOpenMs !== null && lastClosedOpen(clock.now()) <= bg.lastBarOpenMs) return 'same_bar';

    const uni = await readUniverse(settings);
    if (uni.kind === 'paused' || uni.kind === 'banned') return halted(uni.kind, uni.retryMs);
    if (uni.kind !== 'ok' || !uni.symbols) return finish('error', 'error');

    const [tk, st] = await Promise.all([
      getJson(`${base}/fapi/v1/ticker/24hr`, TICKER_TIMEOUT_MS),
      fetchMoversStats(deps.fetch, 'study', { storage: deps.storage, now: localNow }),
    ]);
    const stats: MoversStats | null = st.cells.length > 0 ? st : null;
    if (tk.kind === 'paused' || tk.kind === 'banned') return halted(tk.kind, tk.retryMs);
    if (tk.kind !== 'ok') return finish('error', 'error');

    const q24 = filterByVolume(tk.body, settings.minQ24);
    const symbols = scanSymbols(uni.symbols, q24)
      .sort((a, b) => (q24[b] ?? 0) - (q24[a] ?? 0))
      .slice(0, MAX_SYMBOLS);

    const stored = parseStoredEvents(await deps.storage.get(EVENTS_KEY).catch(() => undefined));
    const log = new EventLog(MAX_ROWS, stored);
    const cooldown = rebuildCooldown(stored);
    const scanState: ScanState = { lastBarOpenMs: bg.lastBarOpenMs };

    const result: ScanResult = await runScanCycle({
      fetch: deps.fetch,
      now: () => clock.now(),
      universe: symbols,
      q24,
      cooldown,
      state: scanState,
      btcSymbol: btcSymbolFor(settings.universe),
      baseUrl: base,
    });

    const status = statusFor(result);
    if (result.status === 'paused' || result.status === 'banned') {
      const until = (result.status === 'paused' ? result.paused_until : result.banned_until) ?? null;
      const retry = until === null ? DEFAULT_RETRY_S * 1000 : Math.max(0, until - clock.now());
      return halted(result.status, retry);
    }
    if (result.status !== 'ok') {
      return finish(status.kind === 'error' ? 'error' : 'ok', result.status);
    }

    const outs = result.events.filter((o) => passesThreshold(settings, o));
    const rel = new Map<string, number | null>();
    for (const o of outs) {
      const ev = o.event as { symbol: string; signal: string; move: string; rel_btc?: unknown };
      rel.set(eventKey(ev), fin(ev.rel_btc) ? ev.rel_btc : null);
    }
    const { inserted, updated } = log.apply(outs);
    const fresh = [...inserted, ...updated];
    for (const e of fresh) {
      e.cells = cellsForEvent(stats, e);
      const r = rel.get(eventKey(e));
      if (r !== undefined && r !== null && e.count === undefined) (e as ScannerRowEvent).relBtc = r;
    }
    if (stats) for (const e of log.list()) e.cells = cellsForEvent(stats, e);

    if (fresh.length > 0) await put(EVENTS_KEY, serializeEvents(log.list()));
    setBadge(settings, log.unseenCount());
    await announce(settings, fresh);
    return finish('ok', 'ok', { lastBarOpenMs: scanState.lastBarOpenMs });
  }

  return {
    async onAlarm() {
      if (busy) return 'busy';
      busy = true;
      try {
        const settings = await loadScannerSettings(deps.storage);
        if (!settings.enabled || !settings.backgroundMode) return 'off';
        return await run(settings);
      } catch {
        return 'error';
      } finally {
        busy = false;
      }
    },
  };
}
