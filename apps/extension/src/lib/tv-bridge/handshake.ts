import { SWAL_MAX_SHAPES } from './schema';

export const SWAL_PORT = 'swal:port';
export const SWAL_HELLO = 'swal:hello';

export interface BridgeHello {
  type: typeof SWAL_HELLO;
  session: string;
  enabled: boolean;
}

export interface BridgePortMessage {
  type: typeof SWAL_PORT;
  session: string;
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

export function buildPort(session: string): BridgePortMessage {
  return { type: SWAL_PORT, session };
}

export function isPortFor(raw: unknown, session: string, ports: readonly MessagePort[] | null): boolean {
  if (!ports || ports.length === 0) return false;
  if (!raw || typeof raw !== 'object') return false;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== SWAL_PORT) return false;
  if (msg.session !== session) return false;
  return true;
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
