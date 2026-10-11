import { SWAL_DRAW, parseBridgeMessage, type BridgeMessage } from './schema';
import { parseHello, DrawRateLimit, withinShapeBudget } from './handshake';

export function createBridgeMessageHandler(
  session: { start: () => void; stop: () => void; apply: (msg: BridgeMessage) => void },
  rate: DrawRateLimit
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
    if (!seenHello) {
      const hello = parseHello(data);
      if (!hello) return;
      seenHello = true;
      if (hello.enabled) ensureRunning();
      return;
    }

    const raw = data as { type?: unknown; shapes?: unknown } | undefined;
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
    } else if (message.type === 'swal:ready') {
      return;
    }

    session.apply(message as BridgeMessage);
  };
}
