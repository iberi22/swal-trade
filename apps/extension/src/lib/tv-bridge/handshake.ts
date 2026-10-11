import { SWAL_MAX_SHAPES } from './schema';

export const SWAL_HELLO = 'swal:hello';

export interface BridgeHello {
  type: typeof SWAL_HELLO;
  session: string;
  enabled: boolean;
}

export function buildHello(session: string, enabled: boolean): BridgeHello {
  return { type: SWAL_HELLO, session, enabled };
}

export function parseHello(raw: unknown): BridgeHello | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== SWAL_HELLO) return null;
  if (typeof msg.session !== 'string') return null;
  return {
    type: SWAL_HELLO,
    session: msg.session,
    enabled: msg.enabled === true,
  };
}

export function withinShapeBudget(count: number): boolean {
  return count <= 4 * SWAL_MAX_SHAPES;
}

export class DrawRateLimit {
  private timestamps: number[] = [];
  constructor(public maxPerSecond: number) {}

  allow(now: number): boolean {
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);
    if (this.timestamps.length >= this.maxPerSecond) return false;
    this.timestamps.push(now);
    return true;
  }
}

import { randomHex } from './random';
export function createSession(): string {
  return randomHex(16);
}

export interface BridgeChannel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  disconnect(): void;
}

/**
 * Establece el canal de comunicación síncrono por el DOM.
 * Crea un elemento `<swal-link>` en `document.documentElement` y lo escucha.
 * El primero que llega lo crea. El segundo lo encuentra, lo saca del DOM,
 * y usa ese nodo desvinculado (detached) como bus de eventos.
 */
export function establishLink(role: 'bridge' | 'content', timeoutMs = 3000): Promise<BridgeChannel> {
  return new Promise((resolve, reject) => {
    const TAG = 'SWAL-LINK';
    const INBOUND = role === 'bridge' ? 'swal:to-bridge' : 'swal:to-content';
    const OUTBOUND = role === 'bridge' ? 'swal:to-content' : 'swal:to-bridge';

    // Si ya existe el elemento creado por la otra parte
    let el = document.documentElement.querySelector(TAG);

    if (el) {
      // Somos los segundos. Sacamos el elemento del DOM para que quede privado.
      el.remove();
      const channel = createChannel(el as HTMLElement, INBOUND, OUTBOUND);
      // Avisamos al primero de que el enlace está listo
      el.dispatchEvent(new CustomEvent('swal:link'));
      resolve(channel);
    } else {
      // Somos los primeros. Lo creamos.
      el = document.createElement(TAG);
      document.documentElement.appendChild(el);

      const timer = setTimeout(() => {
        el?.remove();
        reject(new Error('Link timeout'));
      }, timeoutMs);

      el.addEventListener('swal:link', () => {
        clearTimeout(timer);
        // Cuando nos avisan, el elemento ya ha sido sacado del DOM por el otro script
        resolve(createChannel(el as HTMLElement, INBOUND, OUTBOUND));
      }, { once: true });
    }
  });
}

function createChannel(element: HTMLElement, inboundEvent: string, outboundEvent: string): BridgeChannel {
  const listeners = new Set<(msg: unknown) => void>();

  const handleEvent = (ev: Event) => {
    if (ev instanceof CustomEvent && typeof ev.detail === 'string') {
      try {
        const payload = JSON.parse(ev.detail);
        for (const listener of listeners) {
          listener(payload);
        }
      } catch {
        // Ignoramos JSON mal formado
      }
    }
  };

  element.addEventListener(inboundEvent, handleEvent);

  return {
    send(message: unknown) {
      element.dispatchEvent(new CustomEvent(outboundEvent, { detail: JSON.stringify(message) }));
    },
    onMessage(listener: (message: unknown) => void) {
      listeners.add(listener);
    },
    disconnect() {
      element.removeEventListener(inboundEvent, handleEvent);
      listeners.clear();
    }
  };
}
