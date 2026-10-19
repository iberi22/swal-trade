import { describe, expect, it } from 'vitest';
import { pickActiveTabId } from './tab-scope';

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
