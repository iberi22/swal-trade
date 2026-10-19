import { describe, expect, it } from 'vitest';
import {
  CLOCK_MS,
  SNAPSHOT_POLL_MS,
  createPanelController,
  PANEL_TABS,
  parsePanelTab,
  liqDistancePct,
  parseSnapshotReply,
  positionCardLines,
  sectionsForMode,
  positionFor,
  tabForKey,
  type PanelControllerDeps,
  type PanelState,
} from './panel-controller';
import type { AccountSnapshot, PositionView } from './types';

const POSITION: PositionView = {
  symbol: 'BTCUSDT',
  side: 'long',
  size: 0.1,
  entry: 100,
  mark: 105,
  liq: 80,
  leverage: 5,
  marginType: 'cross',
  uPnl: 0.5,
  breakEven: null,
  notional: 10,
  stop: null,
  firstFillMs: null,
};

function snap(at: number, positions: PositionView[] = [POSITION]): AccountSnapshot {
  return { fetchedAt: at, equity: 1000, dailyPnl: null, positions, fundingRate: null, nextFundingMs: null };
}

function harness(reply: (symbol: string, at: number) => unknown | Promise<unknown>) {
  let now = 1_000_000;
  let visible = true;
  const sent: string[] = [];
  const states: PanelState[] = [];
  let tickFn: (() => void) | null = null;
  const deps: PanelControllerDeps = {
    send: async (m) => {
      sent.push(m.symbol);
      return reply(m.symbol, now);
    },
    now: () => now,
    isVisible: () => visible,
    setInterval: (fn) => {
      tickFn = fn;
      return 1;
    },
    clearInterval: () => {
      tickFn = null;
    },
    onChange: (s) => states.push(s),
  };
  const controller = createPanelController(deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    controller,
    sent,
    states,
    flush,
    advance(ms: number) {
      now += ms;
      tickFn?.();
    },
    setVisible(v: boolean) {
      visible = v;
      controller.visibilityChanged();
    },
    hasTimer: () => tickFn !== null,
  };
}

describe('createPanelController', () => {
  it('sin clave configurada: no pide nada y el modo es unknown', async () => {
    const h = harness(() => ({ snapshot: null }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: false, klinesOk: true });
    await h.flush();
    expect(h.sent).toEqual([]);
    expect(h.controller.state().mode).toBe('unknown');
    h.advance(SNAPSHOT_POLL_MS * 3);
    expect(h.sent).toEqual([]);
  });

  it('sin clave y sin velas públicas: no-data', () => {
    const h = harness(() => ({}));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: false, klinesOk: false });
    expect(h.controller.state().mode).toBe('no-data');
  });

  it('con clave pide al instante, muestra loading y pasa a position con la respuesta', async () => {
    const h = harness((_s, at) => ({ snapshot: snap(at), source: 'api', fetchedAt: at }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    expect(h.sent).toEqual(['BTCUSDT']);
    expect(h.controller.state().mode).toBe('loading');
    await h.flush();
    expect(h.controller.state().mode).toBe('position');
    expect(h.controller.state().stale).toBe(false);
    expect(positionFor(h.controller.state().snapshot, 'BTCUSDT')?.size).toBe(0.1);
  });

  it('pide cada 10 s y no antes', async () => {
    const h = harness((_s, at) => ({ snapshot: snap(at, []) }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    await h.flush();
    h.advance(SNAPSHOT_POLL_MS - CLOCK_MS);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    h.advance(CLOCK_MS);
    await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.controller.state().mode).toBe('flat');
  });

  it('con el panel oculto no pide; al volver a verse pide de inmediato', async () => {
    const h = harness((_s, at) => ({ snapshot: snap(at, []) }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    await h.flush();
    h.setVisible(false);
    h.advance(SNAPSHOT_POLL_MS * 5);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    h.setVisible(true);
    await h.flush();
    expect(h.sent).toHaveLength(2);
  });

  it('un error con posición previa la deja como position caducada, nunca flat', async () => {
    let fail = false;
    const h = harness((_s, at) => (fail ? { snapshot: null, source: 'none', error: 'net' } : { snapshot: snap(at) }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    await h.flush();
    fail = true;
    h.advance(SNAPSHOT_POLL_MS);
    await h.flush();
    const state = h.controller.state();
    expect(state.mode).toBe('position');
    expect(state.stale).toBe(true);
    expect(state.error).toBe('net');
  });

  it('una excepción de red también se queda en position caducada', async () => {
    let fail = false;
    const h = harness((_s, at) => {
      if (fail) throw new Error('boom');
      return { snapshot: snap(at) };
    });
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    await h.flush();
    fail = true;
    h.advance(SNAPSHOT_POLL_MS);
    await h.flush();
    expect(h.controller.state()).toMatchObject({ mode: 'position', stale: true, error: 'net' });
  });

  it('al cambiar de símbolo descarta la cuenta anterior y vuelve a loading', async () => {
    const h = harness((symbol, at) => ({ snapshot: snap(at, symbol === 'BTCUSDT' ? [POSITION] : []) }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    await h.flush();
    expect(h.controller.state().mode).toBe('position');
    h.controller.setContext({ symbol: 'ETHUSDT', configured: true, klinesOk: true });
    expect(h.controller.state().mode).toBe('loading');
    expect(h.sent).toEqual(['BTCUSDT', 'ETHUSDT']);
    await h.flush();
    expect(h.controller.state().mode).toBe('flat');
  });

  it('una respuesta tardía de otro símbolo se ignora', async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => (release = r));
    const h = harness((symbol) => (symbol === 'BTCUSDT' ? slow : { snapshot: snap(Date.now(), []) }));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    h.controller.setContext({ symbol: 'ETHUSDT', configured: true, klinesOk: true });
    release({ snapshot: snap(Date.now()) });
    await h.flush();
    expect(h.controller.state().snapshot).toBeNull();
  });

  it('loading termina por reloj aunque no llegue respuesta', () => {
    const h = harness(() => new Promise(() => {}));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: true, klinesOk: true });
    expect(h.controller.state().mode).toBe('loading');
    h.advance(2_500);
    expect(h.controller.state().mode).toBe('unknown');
  });

  it('stop apaga el reloj', () => {
    const h = harness(() => ({}));
    h.controller.setContext({ symbol: 'BTCUSDT', configured: false, klinesOk: true });
    expect(h.hasTimer()).toBe(true);
    h.controller.stop();
    expect(h.hasTimer()).toBe(false);
  });
});

describe('parseSnapshotReply', () => {
  it('acepta una cuenta válida y rechaza basura', () => {
    expect(parseSnapshotReply({ snapshot: snap(1) }).snapshot?.fetchedAt).toBe(1);
    expect(parseSnapshotReply({ snapshot: null, error: 'no_key' })).toEqual({ snapshot: null, error: 'no_key' });
    expect(parseSnapshotReply(undefined).error).toBe('bad_reply');
    expect(parseSnapshotReply({ snapshot: { fetchedAt: 'x' } }).snapshot).toBeNull();
  });
});

describe('pestañas', () => {
  it('parsePanelTab cae a operacion', () => {
    expect(parsePanelTab('ajustes')).toBe('ajustes');
    expect(parsePanelTab('escaner')).toBe('escaner');
    expect(parsePanelTab('nada')).toBe('operacion');
    expect(parsePanelTab(undefined)).toBe('operacion');
  });

  it('tabForKey navega con flechas y da la vuelta', () => {
    // Estructural: añadir pestañas nuevas (Mis trades, Aprender) no rompe esto.
    const last = PANEL_TABS[PANEL_TABS.length - 1]!.id;
    expect(tabForKey('operacion', 'ArrowRight')).toBe(PANEL_TABS[1]!.id);
    expect(tabForKey('ajustes', 'ArrowRight')).toBe(PANEL_TABS[3]!.id);
    expect(tabForKey(last, 'ArrowRight')).toBe(PANEL_TABS[0]!.id);
    expect(tabForKey('operacion', 'ArrowLeft')).toBe(last);
    expect(tabForKey(PANEL_TABS[1]!.id, 'ArrowLeft')).toBe(PANEL_TABS[0]!.id);
    expect(tabForKey('analisis', 'Home')).toBe('operacion');
    expect(tabForKey('analisis', 'End')).toBe(last);
    expect(tabForKey('analisis', 'a')).toBeNull();
  });
});

describe('sectionsForMode', () => {
  it('position nunca muestra el dimensionador', () => {
    const s = sectionsForMode('position', 'BTCUSDT');
    expect(s).toMatchObject({ position: true, sizing: false, market: true, notice: null });
  });
  it('flat y unknown muestran el dimensionador; unknown avisa', () => {
    expect(sectionsForMode('flat', 'BTCUSDT')).toMatchObject({ position: false, sizing: true, notice: null });
    const u = sectionsForMode('unknown', 'BTCUSDT');
    expect(u.sizing).toBe(true);
    expect(u.notice).toBe('No sé si tienes posición. Conecta una clave de solo lectura (Ajustes).');
  });
  it('loading no muestra ni posición ni dimensionador', () => {
    expect(sectionsForMode('loading', 'BTCUSDT')).toMatchObject({ position: false, sizing: false, notice: 'comprobando…' });
  });
  it('no-data oculta el mercado y nombra el símbolo', () => {
    expect(sectionsForMode('no-data', 'PEPEUSDT')).toMatchObject({
      sizing: false,
      market: false,
      notice: 'Sin velas públicas para PEPEUSDT',
    });
  });
});

describe('positionCardLines', () => {
  it('cabe en 6 líneas y avisa de SIN STOP y de caducado', () => {
    const lines = positionCardLines(POSITION, false);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('LARGO · 0.1 BTCUSDT');
    expect(lines).toContain('SIN STOP');
    expect(lines[5]).toBe('Liquidación a 23.8 % (80.00)');
    const stale = positionCardLines({ ...POSITION, stop: { price: 95, kind: 'algo' }, uPnl: -2 }, true);
    expect(stale).toHaveLength(6);
    expect(stale[4]).toBe('Stop 95.00');
    expect(stale[3]).toBe('uPnL -2 USDT');
    expect(stale[5]).toContain('CADUCADO');
  });
  it('liqDistancePct es null sin liquidación', () => {
    expect(liqDistancePct({ mark: 100, liq: null })).toBeNull();
    expect(positionCardLines({ ...POSITION, liq: null }, false)[5]).toBe('Liquidación: sin dato');
  });
});
