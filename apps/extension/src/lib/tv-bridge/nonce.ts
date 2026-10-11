/**
 * Nonce por carga de página.
 *
 * El content script aislado y el puente MAIN-world viven en dos mundos
 * distintos de la misma pestaña: no comparten objetos de JavaScript. El DOM sí
 * es común, así que el nonce viaja en un atributo de `<html>`.
 *
 * Sirve para que el puente solo obidez mensajes de nuestra propia extensión en
 * esta página, y para que un script de la página no pueda fabricarlos: el valor
 * sale de `crypto.getRandomValues` y nadie más lo conoce.
 */

import { randomHex } from './random';

export const NONCE_ATTRIBUTE = 'data-swal-tv-nonce';

/** Lo mínimo del DOM que hace falta para publicar y leer el nonce. */
export interface NonceDocument {
  documentElement?: {
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
  } | null;
}

/** 32 caracteres hexadecimales: lo que rompe las conjeturas, no la cripto. */
export function createNonce(): string {
  return randomHex(32);
}

export function publishNonce(doc: NonceDocument | null | undefined, nonce: string): void {
  try {
    doc?.documentElement?.setAttribute(NONCE_ATTRIBUTE, nonce);
  } catch {
    // Sin atributo no hay nonce: el puente descartará los mensajes.
  }
}

/**
 * Lee el nonce publicado. Se llama en cada mensaje a propósito: el content
 * script aislado puede cargar después del puente.
 */
export function readNonce(doc: NonceDocument | null | undefined): string | null {
  try {
    const value = doc?.documentElement?.getAttribute(NONCE_ATTRIBUTE);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
