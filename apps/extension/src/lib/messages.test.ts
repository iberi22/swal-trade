import { describe, expect, it } from 'vitest';
import { parsePrivilegedMessage, parseRuntimeMessage } from './messages';
import { SWAL_MESSAGE_VERSION, SWAL_POSITION_TOOLS } from './tv-bridge/schema';
import { TV_POSITION_TOOLS } from './tv-paint';

const tools = {
  type: SWAL_POSITION_TOOLS,
  version: SWAL_MESSAGE_VERSION,
  symbol: 'BTCUSDT',
  minmov: 1,
  pricescale: 100,
  tools: [{ id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2000 }],
};

describe('parseRuntimeMessage · herramientas de posición', () => {
  it('acepta el relevo del content script', () => {
    expect(parseRuntimeMessage({ type: TV_POSITION_TOOLS, tools })).toEqual({
      type: TV_POSITION_TOOLS,
      tools,
    });
  });

  it('rechaza el relevo si el payload no cumple el contrato', () => {
    expect(parseRuntimeMessage({ type: TV_POSITION_TOOLS })).toBeNull();
    expect(
      parseRuntimeMessage({ type: TV_POSITION_TOOLS, tools: { ...tools, pricescale: 'x' } }),
    ).toBeNull();
  });

  it('no confunde un privilegiado con un mensaje de página', () => {
    expect(parseRuntimeMessage({ type: 'ai:analyze' })).toBeNull();
    expect(parsePrivilegedMessage({ type: TV_POSITION_TOOLS, tools })).toBeNull();
  });
});
