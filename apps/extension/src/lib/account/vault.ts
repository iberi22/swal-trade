// Boveda de credenciales: interfaz, helpers de sellado AES-GCM y generacion de clave Ed25519.
// Puro y sin red; el adaptador de IndexedDB de produccion se anade aparte.

export interface Vault {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryVault(): Vault {
  const store = new Map<string, unknown>();
  return {
    async get(key) {
      return store.get(key);
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
}

export interface SealedSecret {
  iv: string;
  ct: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Clave AES-GCM de 256 bits para sellar secretos (no extraible). */
export function generateWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(plain: string, wrappingKey: CryptoKey): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    new TextEncoder().encode(plain),
  );
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function openSecret(sealed: SealedSecret, wrappingKey: CryptoKey): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(sealed.iv) as BufferSource },
      wrappingKey,
      base64ToBytes(sealed.ct) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Mensaje fijo: no se filtra nada del contenido sellado.
    throw new Error('no se pudo abrir el secreto');
  }
}

function toPem(spki: Uint8Array): string {
  const b64 = bytesToBase64(spki);
  const lines = b64.match(/.{1,64}/g) ?? [''];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** Genera un par Ed25519; la clave privada NO es extraible, la publica se devuelve en PEM (SPKI). */
export async function generateEd25519Signing(): Promise<{ privateKey: CryptoKey; publicPem: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, publicPem: toPem(spki) };
}
