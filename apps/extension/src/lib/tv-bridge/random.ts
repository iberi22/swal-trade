/**
 * Aleatoriedad sin dependencias. `crypto.getRandomValues` existe en la página,
 * en el service worker y en Node 19+ (pruebas unitarias). Si faltara, se vuelve
 * a un contador con mezcla: nunca se usa para criptografía, solo para que un
 * script de la página no adivine el nonce.
 */

interface RandomBytes {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function cryptoRef(): RandomBytes | null {
  const globals = globalThis as unknown as { crypto?: RandomBytes };
  return globals.crypto ?? null;
}

let counter = 0;

/** `bytes` octetos aleatorios en hexadecimal. */
export function randomHex(bytes: number): string {
  const webcrypto = cryptoRef();
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    const buffer = new Uint8Array(bytes);
    webcrypto.getRandomValues(buffer);
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  counter = (counter + 1) % 0xffff;
  const seed = `${Date.now()}-${counter}-${Math.random()}`;
  let hash = 0x811c9dc5;
  let out = '';
  while (out.length < bytes * 2) {
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, bytes * 2);
}
