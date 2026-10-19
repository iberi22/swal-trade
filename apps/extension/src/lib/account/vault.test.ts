import { describe, expect, it } from 'vitest';
import { createMemoryVault, generateEd25519Signing, generateWrappingKey, openSecret, sealSecret } from './vault';

describe('boveda en memoria', () => {
  it('get/put/delete/clear', async () => {
    const v = createMemoryVault();
    expect(await v.get('a')).toBeUndefined();
    await v.put('a', 1);
    await v.put('b', { x: 2 });
    expect(await v.get('a')).toBe(1);
    expect(await v.get('b')).toEqual({ x: 2 });
    await v.delete('a');
    expect(await v.get('a')).toBeUndefined();
    await v.clear();
    expect(await v.get('b')).toBeUndefined();
  });
});

describe('sealSecret / openSecret', () => {
  it('round trip con IV aleatorio de 12 bytes', async () => {
    const key = await generateWrappingKey();
    const a = await sealSecret('sk-secreto', key);
    const b = await sealSecret('sk-secreto', key);
    expect(atob(a.iv)).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toContain('sk-secreto');
    expect(await openSecret(a, key)).toBe('sk-secreto');
  });

  it('falla con otra clave o datos alterados', async () => {
    const k1 = await generateWrappingKey();
    const k2 = await generateWrappingKey();
    const sealed = await sealSecret('hola', k1);
    await expect(openSecret(sealed, k2)).rejects.toThrow('no se pudo abrir el secreto');
    const flipped = { ...sealed, ct: (sealed.ct[0] === 'A' ? 'B' : 'A') + sealed.ct.slice(1) };
    await expect(openSecret(flipped, k1)).rejects.toThrow();
  });
});

describe('generateEd25519Signing', () => {
  it('devuelve PEM publico y una privada no exportable', async () => {
    const { privateKey, publicPem } = await generateEd25519Signing();
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n$/);
    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', privateKey)).rejects.toThrow();
  });
});
