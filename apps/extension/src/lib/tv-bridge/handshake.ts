import { SWAL_MAX_SHAPES } from './schema';
import { randomHex } from './random';

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

export function createSession(): string {
  return randomHex(16);
}

export interface BridgeChannel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  disconnect(): void;
}

export type LinkRole = 'bridge' | 'content';

/** Etiqueta del nodo de encuentro. */
export const LINK_TAG = 'swal-link';
/** Campana del lado aislado: «estoy aquí, enlaza conmigo». */
export const LINK_RENDEZVOUS_EVENT = 'swal:rendezvous';
/** Respuesta del puente, sobre el nodo que acaba de desvincular. */
export const LINK_ACK_EVENT = 'swal:link';
/** Versión del sobre de mensajes del canal. */
export const LINK_PROTOCOL_VERSION = 1;
/** Octetos del nonce por enlace (el aislado lo genera). */
export const LINK_NONCE_BYTES = 16;

/**
 * Cuánto aguanta el lado aislado a que el puente conteste a la campana.
 *
 * La respuesta es síncrona: si el puente está escuchando, contesta dentro del
 * mismo turno de `dispatchEvent`. Este tope solo acota el caso raro en que el
 * puente no exista (extensión recargada) y, sobre todo, acota cuánto tiempo
 * queda el `<swal-link>` en el DOM. Mantenerlo corto es parte del arreglo: el
 * nodo es lo único que un script de la página podría capturar.
 */
export const LINK_ACK_WAIT_MS = 1_000;

interface LinkEnvelope {
  v: typeof LINK_PROTOCOL_VERSION;
  n: string;
  m: unknown;
}

function parseEnvelope(raw: unknown): LinkEnvelope | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Record<string, unknown>;
  if (env.v !== LINK_PROTOCOL_VERSION) return null;
  if (typeof env.n !== 'string' || env.n.length < LINK_NONCE_BYTES * 2) return null;
  return { v: LINK_PROTOCOL_VERSION, n: env.n, m: env.m };
}

function validNonce(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < LINK_NONCE_BYTES * 2) return null;
  return raw;
}

function readNonceDetail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return validNonce((parsed as Record<string, unknown>).nonce);
  } catch {
    return null;
  }
}

/**
 * Canal privado sobre un nodo ya desvinculado del DOM.
 *
 * Cada mensaje viaja como `{ v, n, m }`: la versión del protocolo, el nonce del
 * enlace y el mensaje original. Un evento que no traiga ese nonce se descarta
 * sin avisar. Esto NO hace secreto el mundo MAIN —un script de la página que
 * esté escuchando la campana puede leer el nonce del `detail`—; lo que elimina
 * es la ventana de exposición larga y la inyección tardía por referencias
 * obsoletas (P1), porque el nodo solo existe durante el intercambio y el canal
 * es one-shot.
 */
function createChannel(
  node: HTMLElement,
  inboundEvent: string,
  outboundEvent: string,
  nonce: string,
): BridgeChannel {
  const listeners = new Set<(message: unknown) => void>();
  let open = true;

  const handleEvent = (ev: Event) => {
    if (!open) return;
    if (!(ev instanceof CustomEvent)) return;
    const envelope = parseEnvelope(ev.detail);
    if (!envelope || envelope.n !== nonce) return;
    for (const listener of listeners) {
      listener(envelope.m);
    }
  };

  const onPageHide = () => {
    channel.disconnect();
  };

  node.addEventListener(inboundEvent, handleEvent);
  window.addEventListener('pagehide', onPageHide);

  const channel: BridgeChannel = {
    send(message: unknown) {
      if (!open) return;
      const envelope: LinkEnvelope = { v: LINK_PROTOCOL_VERSION, n: nonce, m: message };
      node.dispatchEvent(new CustomEvent(outboundEvent, { detail: JSON.stringify(envelope) }));
    },
    onMessage(listener: (message: unknown) => void) {
      if (!open) return;
      listeners.add(listener);
    },
    disconnect() {
      if (!open) return;
      open = false;
      node.removeEventListener(inboundEvent, handleEvent);
      window.removeEventListener('pagehide', onPageHide);
      listeners.clear();
    },
  };

  return channel;
}

/**
 * Lado aislado: crea el punto de encuentro y llama a la puerta.
 *
 * El nodo `<swal-link>` se cuelga del DOM justo antes de la campana y el puente
 * —que espera en modo pasivo, sin nada expuesto— lo desvincula y contesta de
 * forma síncrona. Al volver de `dispatchEvent` el nodo ya no está en el DOM, así
 * que la ventana de exposición es de un turno, no de decenas de segundos.
 */
function initiateLink(): Promise<BridgeChannel> {
  return new Promise((resolve, reject) => {
    const nonce = randomHex(LINK_NONCE_BYTES);
    const node = document.createElement(LINK_TAG);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (removeNode: boolean) => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      node.removeEventListener(LINK_ACK_EVENT, onAck);
      window.removeEventListener('pagehide', onPageHide);
      if (removeNode) node.remove();
    };

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup(true);
      reject(new Error(reason));
    };

    const onAck = (ev: Event) => {
      if (settled) return;
      if (!(ev instanceof CustomEvent)) return;
      const acked = readNonceDetail(ev.detail);
      if (!acked || acked !== nonce) return;
      settled = true;
      // El puente ya lo desvinculó: nunca vuelve al DOM.
      cleanup(false);
      resolve(createChannel(node, 'swal:to-content', 'swal:to-bridge', nonce));
    };

    const onPageHide = () => {
      fail('Link cancelled');
    };

    node.addEventListener(LINK_ACK_EVENT, onAck);
    window.addEventListener('pagehide', onPageHide);
    document.documentElement.appendChild(node);

    window.dispatchEvent(
      new CustomEvent(LINK_RENDEZVOUS_EVENT, { detail: JSON.stringify({ nonce }) }),
    );

    // Normalmente el ack ya llegó (síncrono). Si no, el nodo no se queda
    // colgado: se retira y se rechaza en cuanto expire el tope.
    if (!settled) {
      timer = setTimeout(() => fail('Link timeout'), LINK_ACK_WAIT_MS);
    }
  });
}

/**
 * Lado puente (MAIN world): espera en modo pasivo, sin nodo expuesto.
 *
 * Arranca en `document_start`, mucho antes que el content script aislado. No
 * crea ni cuelga nada en el DOM: solo registra un listener de la campana. El
 * aislado puede llegar 5 s o 50 s después; no hay plazo porque no hay nada que
 * retirar. Cuando la campana suena, este lado desvincula el nodo y contesta en
 * el acto. Después del primer enlace el listener desaparece: no hay segunda
 * oportunidad ni canal huérfano si llega otra campana.
 */
function waitForRendezvous(): Promise<BridgeChannel> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener(LINK_RENDEZVOUS_EVENT, onRendezvous);
      window.removeEventListener('pagehide', onPageHide);
    };

    const onPageHide = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Link cancelled'));
    };

    const onRendezvous = (ev: Event) => {
      if (settled) return;
      if (!(ev instanceof CustomEvent)) return;
      const nonce = readNonceDetail(ev.detail);
      if (!nonce) return;
      // El nodo válido es el ÚLTIMO hijo: el aislado lo cuelga y lanza la
      // campana en el mismo turno, así que nadie pudo añadir nada después. Un
      // `<swal-link>` plantado antes por la página no sirve para secuestrar el
      // ack (y con él el nonce).
      const node = document.documentElement.lastElementChild;
      if (!node || node.localName !== LINK_TAG) return;

      // Fuera del DOM antes de devolver el control: desde aquí solo lo
      // referencian las dos partes.
      node.remove();
      settled = true;
      cleanup();
      node.dispatchEvent(
        new CustomEvent(LINK_ACK_EVENT, { detail: JSON.stringify({ nonce }) }),
      );
      resolve(createChannel(node, 'swal:to-bridge', 'swal:to-content', nonce));
    };

    window.addEventListener(LINK_RENDEZVOUS_EVENT, onRendezvous);
    window.addEventListener('pagehide', onPageHide);
  });
}

/**
 * Establece el canal de comunicación entre el puente y el content script.
 *
 * `'bridge'` (MAIN, `document_start`) espera de forma pasiva y sin plazo.
 * `'content'` (aislado, `document_idle`) inicia el encuentro cuando arranca.
 * El canal es one-shot y cada mensaje lleva el nonce del enlace (ver
 * `createChannel`).
 */
export function establishLink(role: LinkRole): Promise<BridgeChannel> {
  return role === 'bridge' ? waitForRendezvous() : initiateLink();
}
