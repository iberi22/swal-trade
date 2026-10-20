import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  tabs: { query: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: browserMock }));

import { FUTURES_TAB_PATTERN } from '../scanner/open-pair';
import { pickActiveTabId, resolveActiveBinanceTabId } from './tab-scope';

interface FakeTab {
  id: number;
  active: boolean;
  url: string;
  windowId: number;
}

/**
 * Simula `chrome.tabs.query`: con `currentWindow: true` devuelve solo las
 * pestañas de la ventana del panel (1); sin él, las de todas las ventanas.
 */
function withWindows(tabs: FakeTab[], currentWindowId = 1) {
  browserMock.tabs.query.mockImplementation(async (query: { currentWindow?: boolean }) =>
    query?.currentWindow ? tabs.filter((tab) => tab.windowId === currentWindowId) : tabs,
  );
}

const tab = (id: number, windowId: number, active = false): FakeTab => ({
  id,
  active,
  windowId,
  url: 'https://www.binance.com/en/futures/BTCUSDT',
});

beforeEach(() => {
  browserMock.tabs.query.mockReset();
});

describe('pickActiveTabId', () => {
  it('elige la pestaña activa aunque no sea la primera', () => {
    expect(
      pickActiveTabId([
        { id: 11, active: false },
        { id: 22, active: true },
        { id: 33, active: false },
      ]),
    ).toBe(22);
  });

  it('sin ninguna activa usa la primera con id', () => {
    expect(pickActiveTabId([{ id: 11 }, { id: 22 }])).toBe(11);
    expect(pickActiveTabId([{ active: true }, { id: 22 }])).toBe(22);
  });

  it('ignora pestañas sin id entero', () => {
    const tabs = [{ id: undefined, active: true }, { id: 1.5 }, { id: 7 }] as const;
    expect(pickActiveTabId(tabs)).toBe(7);
    // El id 0 es un entero válido (viene del contrato de pestañas).
    expect(pickActiveTabId([{ id: 0 }])).toBe(0);
  });

  it('devuelve null cuando no hay ninguna pestaña utilizable', () => {
    expect(pickActiveTabId([])).toBeNull();
    expect(pickActiveTabId(null)).toBeNull();
    expect(pickActiveTabId(undefined)).toBeNull();
    expect(pickActiveTabId([{ active: true }])).toBeNull();
  });
});

describe('resolveActiveBinanceTabId', () => {
  it('con dos ventanas en futures se queda con la activa de la ventana del panel', async () => {
    // La ventana 2 (otra ventana) está primero en la lista y con la 33 activa;
    // la ventana 1 (la del panel) tiene la 22 activa.
    const tabs = [tab(33, 2, true), tab(34, 2), tab(21, 1), tab(22, 1, true)];
    withWindows(tabs);
    // Sin acotar a la ventana, la búsqueda devuelve la 33 (activa de la otra
    // ventana) y el panel enseñaría el dibujo ajeno.
    expect(pickActiveTabId(tabs)).toBe(33);
    await expect(resolveActiveBinanceTabId()).resolves.toBe(22);
    expect(browserMock.tabs.query).toHaveBeenCalledTimes(1);
    expect(browserMock.tabs.query).toHaveBeenCalledWith({
      url: FUTURES_TAB_PATTERN,
      currentWindow: true,
    });
  });

  it('si la ventana del panel no tiene ninguna activa usa la primera con id', async () => {
    withWindows([tab(21, 1), tab(22, 1), tab(33, 2, true)]);
    await expect(resolveActiveBinanceTabId()).resolves.toBe(21);
  });

  it('null cuando la ventana del panel no tiene futures abierto', async () => {
    withWindows([tab(33, 2, true)]);
    await expect(resolveActiveBinanceTabId()).resolves.toBeNull();
  });

  it('null si la consulta de pestañas falla', async () => {
    browserMock.tabs.query.mockRejectedValue(new Error('sin permiso'));
    await expect(resolveActiveBinanceTabId()).resolves.toBeNull();
  });
});
