import { describe, expect, it, vi } from 'vitest';

import { createBridgeMessageHandler } from './message-handler';
import { DrawRateLimit, buildHello } from './handshake';
import { SWAL_DRAW, SWAL_CLEAR, SWAL_READY, SWAL_SET_RESOLUTION, buildDrawMessage, buildClearMessage, buildReadyMessage, buildSetResolutionMessage, buildResolutionAckMessage } from './schema';

describe('Bridge Message Handler', () => {
  it('does not stop session when receiving a ready message', () => {
    const session = {
      start: vi.fn(),
      stop: vi.fn(),
      apply: vi.fn(),
    };
    const rate = new DrawRateLimit(4);
    const handler = createBridgeMessageHandler(session, rate);

    // Initial hello
    handler(buildHello('sess-1', true));
    expect(session.start).toHaveBeenCalledTimes(1);

    const readyMsg = buildReadyMessage('ready');
    handler(readyMsg);

    // It should explicitly ignore ready messages, NOT call stop()
    expect(session.stop).not.toHaveBeenCalled();
    // And it shouldn't apply it since it returned early
    expect(session.apply).not.toHaveBeenCalled();
  });

  it('draw -> ready -> draw keeps the session running', () => {
    const session = {
      start: vi.fn(),
      stop: vi.fn(),
      apply: vi.fn(),
    };
    const rate = new DrawRateLimit(4);
    const handler = createBridgeMessageHandler(session, rate);

    // Initial hello (disabled, so it doesn't start yet)
    handler(buildHello('sess-1', false));
    expect(session.start).not.toHaveBeenCalled();

    // Send a draw message -> should start the session
    const drawMsg = buildDrawMessage([{ id: '1', kind: 'level', style: 'solid', text: '', points: [{ time: 1, price: 1 }] }]);
    handler(drawMsg);

    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.apply).toHaveBeenCalledTimes(1);

    // Send a ready message -> shouldn't stop it
    handler(buildReadyMessage('ready'));
    expect(session.stop).not.toHaveBeenCalled();

    // Send another draw -> should remain running (start not called again since it's already running)
    const drawMsg2 = buildDrawMessage([{ id: '2', kind: 'level', style: 'solid', text: '', points: [{ time: 2, price: 2 }] }]);
    handler(drawMsg2);

    expect(session.start).toHaveBeenCalledTimes(1); // Still 1
    expect(session.apply).toHaveBeenCalledTimes(2);
    expect(session.stop).not.toHaveBeenCalled();
  });

  it('stops session ONLY on clear', () => {
    const session = {
      start: vi.fn(),
      stop: vi.fn(),
      apply: vi.fn(),
    };
    const rate = new DrawRateLimit(4);
    const handler = createBridgeMessageHandler(session, rate);

    handler(buildHello('sess-1', true));
    expect(session.start).toHaveBeenCalledTimes(1);

    handler(buildClearMessage());
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.apply).toHaveBeenCalledTimes(1); // apply gets called with clear msg
  });

  it('manages set-resolution message and calls onAck', () => {
    const session = {
      start: vi.fn(),
      stop: vi.fn(),
      apply: vi.fn(),
      setResolution: vi.fn().mockReturnValue(buildResolutionAckMessage(true, '15')),
    };
    const rate = new DrawRateLimit(4);
    const onAck = vi.fn();
    const handler = createBridgeMessageHandler(session, rate, onAck);

    const setResMsg = buildSetResolutionMessage('15');
    handler(setResMsg);

    expect(session.setResolution).toHaveBeenCalledWith('15');
    expect(onAck).toHaveBeenCalledWith(buildResolutionAckMessage(true, '15'));
  });
});
