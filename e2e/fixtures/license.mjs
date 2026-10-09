// Token Ed25519 con el mismo formato que billing-worker/src/license.js:
// base64url(JSON) + "." + base64url(firma de los bytes ASCII del primer tramo).
import { generateKeyPairSync, sign } from 'node:crypto';

export function createLicense(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'acc_e2e',
    plan: 'pro_month',
    exp: now + 30 * 86400,
    iat: now,
    iss: 'swal-trade-billing',
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(body), privateKey);
  return {
    token: `${body}.${Buffer.from(signature).toString('base64url')}`,
    spkiBase64: Buffer.from(spki).toString('base64'),
    payload,
  };
}
