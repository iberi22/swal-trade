import {
  SWAL_DRAW,
  SWAL_SET_RESOLUTION,
  SWAL_RESOLUTION_ACK,
  SWAL_MESSAGE_VERSION,
  parseBridgeMessage,
  type BridgeMessage,
  type BridgeResolution,
  type BridgeResolutionAckMessage,
} from './schema';
import { parseHello, DrawRateLimit, withinShapeBudget } from './handshake';

export function createBridgeMessageHandler(
  session: {
    start: () => void;
    stop: () => void;
    apply: (msg: BridgeMessage) => void;
    setResolution?: (res: BridgeResolution) => BridgeResolutionAckMessage;
  },
  rate: DrawRateLimit,
  onAck?: (ack: BridgeResolutionAckMessage) => void,
) {
  let running = false;
  let seenHello = false;

  const ensureRunning = () => {
    if (running) return;
    running = true;
    session.start();
  };

  const stop = () => {
    running = false;
    session.stop();
  };

  return (data: unknown) => {
    const raw = data as { type?: unknown; shapes?: unknown } | undefined;
    if (raw && raw.type === SWAL_SET_RESOLUTION) {
      const message = parseBridgeMessage(data);
      if (message && message.type === SWAL_SET_RESOLUTION) {
        const ack = session.setResolution
          ? session.setResolution(message.resolution)
          : {
              type: SWAL_RESOLUTION_ACK,
              version: SWAL_MESSAGE_VERSION,
              ok: false,
              resolution: message.resolution,
              error: 'unsupported',
            };
        onAck?.(ack);
      }
      return;
    }

    if (!seenHello) {
      const hello = parseHello(data);
      if (!hello) return;
      seenHello = true;
      if (hello.enabled) ensureRunning();
      return;
    }

    if (raw && raw.type === SWAL_DRAW && Array.isArray(raw.shapes) && !withinShapeBudget(raw.shapes.length)) {
      return;
    }
    if (raw && raw.type === SWAL_DRAW && !rate.allow(Date.now())) return;

    const message = parseBridgeMessage(data);
    if (!message) return;

    if (message.type === SWAL_DRAW) {
      ensureRunning();
    } else if (message.type === 'swal:clear') {
      stop();
    } else if (message.type === 'swal:ready' || message.type === 'swal:resolution-ack') {
      return;
    }

    session.apply(message as BridgeMessage);
  };
}
