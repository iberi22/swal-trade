// SPDX-License-Identifier: AGPL-3.0-only
// Helpers puros del checkout (sin DOM, sin red): se prueban con node --test.

export const API_BASE = 'https://pay.swal.network';
export const LS_ACCOUNT = 'swal.account'; // JSON {account_id, account_secret}
export const LS_LICENSE = 'swal.license'; // JSON {token, plan, account_id, expires_at, valid_until, grace_days, stored_at}
export const DEFAULT_PLAN = 'pro_month';
export const POLL_INTERVAL_MS = 15000;

export const PLAN_LABELS = {
  pro_month: 'Pro mensual (30 días)',
  pro_quarter: 'Pro trimestral (90 días)',
  pro_year: 'Pro anual (365 días)',
};

/** Plan de ?plan=...: solo los conocidos; cualquier otra cosa cae al mensual. */
export function parsePlan(search, known = Object.keys(PLAN_LABELS)) {
  const v = new URLSearchParams(search || '').get('plan');
  return v && known.includes(v) ? v : DEFAULT_PLAN;
}

/**
 * Importe exacto a pagar. El Worker ya manda `amount_display` ("10.0037"); esto lo
 * valida y lo parte en parte entera, "base" (2 decimales) y TAG (decimales 3 y 4+),
 * que es lo que identifica el pago. Si falta display, lo deriva de amount_units.
 * @returns {{text:string, whole:string, base:string, tag:string}}
 */
export function formatAmount({ amount_display, amount_units, decimals }) {
  let text = amount_display;
  if (!text && amount_units != null && Number.isInteger(decimals)) {
    text = unitsToDisplay(amount_units, decimals);
  }
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) {
    throw new TypeError('importe invalido');
  }
  let [whole, frac = ''] = text.split('.');
  frac = frac.padEnd(4, '0');
  return { text: `${whole}.${frac}`, whole, base: frac.slice(0, 2), tag: frac.slice(2) };
}

/** Unidades base (string entero) -> decimal, con >= 4 decimales y sin ceros de sobra. */
export function unitsToDisplay(units, decimals) {
  const s = String(units);
  if (!/^\d+$/.test(s)) throw new TypeError('unidades invalidas');
  const padded = s.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  let frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  frac = frac.padEnd(4, '0');
  return `${whole}.${frac}`;
}

/** Estados de factura del Worker -> {label, tone, final}. */
export function mapStatus(status) {
  switch (status) {
    case 'pending':
      return { label: 'Esperando tu pago…', tone: 'wait', final: false };
    case 'paid':
      return { label: 'Pago recibido', tone: 'ok', final: true };
    case 'expired':
      return { label: 'Factura vencida (pasaron 30 min). Crea otra; si ya enviaste el pago, escríbenos con el hash.', tone: 'bad', final: true };
    case 'manual_review':
      return { label: 'Pago detectado pero con un importe distinto: queda en revisión manual. Escríbenos con el hash de la transacción.', tone: 'warn', final: true };
    default:
      return { label: `Estado desconocido: ${String(status)}`, tone: 'warn', final: false };
  }
}

/** Métodos de /v1/plans agrupados por red, con etiquetas legibles. */
export const NETWORK_LABELS = { bsc: 'BNB Smart Chain (BEP-20)', tron: 'Tron (TRC-20)' };
export function methodKey(m) { return `${m.network}:${m.token}`; }
export function methodLabel(m) { return `${m.token} en ${NETWORK_LABELS[m.network] || m.network}`; }

/** "10" -> "10.00 USDT" para mostrar el precio de lista. */
export function formatPrice(priceDisplay) {
  const n = Number(priceDisplay);
  return Number.isFinite(n) ? `${n.toFixed(2)} USD` : `${priceDisplay} USD`;
}

/** Mensaje de error legible desde el cuerpo {error, message} del Worker. */
export function apiErrorMessage(status, body) {
  if (status === 429) return 'Demasiados intentos desde tu conexión. Espera un minuto y reintenta.';
  if (status === 451) return 'El servicio no está disponible en tu país.';
  if (status === 401) return 'Credencial de cuenta inválida. Revisa tu secreto.';
  if (status === 402) return 'Aún no hay suscripción activa en esta cuenta.';
  const m = body && (body.message || body.error);
  return m ? String(m) : `Error ${status}`;
}

/** Secreto pegado: Worker genera 32 bytes base64url (43 chars). */
export function isPlausibleSecret(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(s.trim());
}

export function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' });
}

export function secretFileContents(accountId, secret) {
  return [
    'SWAL Trade - secreto de cuenta',
    '',
    `account_id: ${accountId}`,
    `account_secret: ${secret}`,
    '',
    'Guárdalo en un lugar seguro. Sin este secreto no puedes recuperar tu membresía.',
    'Nadie de SWAL te lo pedirá nunca.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Codificador QR minimo: modo byte, correccion M, versiones 1-6 (hasta 106 bytes).
// Suficiente para direcciones BSC (42) y Tron (34).
// ---------------------------------------------------------------------------

// versión -> [codewords de datos totales, ecc por bloque, bloques]  (nivel M)
const QR_M = { 1: [16, 10, 1], 2: [28, 16, 1], 3: [44, 26, 1], 4: [64, 18, 2], 5: [86, 24, 2], 6: [108, 16, 4] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Bytes de correccion Reed-Solomon para `data` con `n` simbolos. */
export function rsEcc(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const res = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ res[0];
    res.shift(); res.push(0);
    for (let j = 0; j < n; j++) res[j] ^= gmul(gen[j + 1], f);
  }
  return res;
}

/** BCH(15,5) de formato: nivel M = 00, mascara 0-7, XOR 0x5412. */
export function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let v = data << 10;
  for (let i = 4; i >= 0; i--) if ((v >> (i + 10)) & 1) v ^= 0x537 << i;
  return ((data << 10) | v) ^ 0x5412;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Palabras de código (datos + ECC intercaladas) para un texto UTF-8. */
export function qrCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    if (bytes.length <= QR_M[v][0] - 2) { version = v; break; } // 4+8 bits de cabecera ~ 2 bytes
  }
  if (!version) throw new RangeError('texto demasiado largo para el QR');
  const [dataCw, eccPer, blocks] = QR_M[version];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = dataCw * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0; data.length < dataCw; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const short = Math.floor(dataCw / blocks);
  const longCount = dataCw % blocks;
  const dBlocks = []; const eBlocks = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const len = short + (b >= blocks - longCount ? 1 : 0);
    const chunk = data.slice(off, off + len); off += len;
    dBlocks.push(chunk); eBlocks.push(rsEcc(chunk, eccPer));
  }
  const out = [];
  const maxD = Math.max(...dBlocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of dBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < eccPer; i++) for (const b of eBlocks) out.push(b[i]);
  return { version, codewords: out, dataCodewords: data };
}

function buildBase(version) {
  const n = 17 + 4 * version;
  const m = Array.from({ length: n }, () => new Array(n).fill(null)); // null = libre
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < n && c < n) m[r][c] = v; };
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      set(r0 + dr, c0 + dc, inside && (edge || inner) ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 ? 0 : 1); set(i, 6, i % 2 ? 0 : 1); }
  const ap = ALIGN[version];
  for (const r of ap) for (const c of ap) {
    if (m[r][c] !== null) continue; // choca con un finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
    }
  }
  set(n - 8, 8, 1); // modulo oscuro
  // reservar formato (se rellena luego)
  const reserved = [];
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) reserved.push([8, i]); if (m[i][8] === null) reserved.push([i, 8]); }
  for (let i = 0; i < 8; i++) { if (m[8][n - 1 - i] === null) reserved.push([8, n - 1 - i]); if (m[n - 1 - i][8] === null) reserved.push([n - 1 - i, 8]); }
  for (const [r, c] of reserved) m[r][c] = 0;
  const fixed = m.map((row) => row.map((v) => v !== null));
  return { n, m, fixed };
}

function placeFormat(m, n, mask) {
  const f = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const v = (f >> i) & 1; // i=0 es el LSB
    // serie vertical: columna 8 (junto al finder superior izquierdo y al inferior izquierdo)
    if (i < 6) m[i][8] = v; else if (i < 8) m[i + 1][8] = v; else m[n - 15 + i][8] = v;
    // serie horizontal: fila 8 (junto al finder superior derecho y al superior izquierdo)
    if (i < 8) m[8][n - 1 - i] = v; else if (i < 9) m[8][15 - i] = v; else m[8][14 - i] = v;
  }
}

/** Recorrido zig-zag de módulos de datos (misma ruta para escribir y para leer). */
function dataPath(n, fixed) {
  const path = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i;
      for (const c of [col, col - 1]) if (!fixed[r][c]) path.push([r, c]);
    }
    up = !up;
  }
  return path;
}

function penalty(m) {
  const n = m.length; let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const cur = pass ? m[j][i] : m[i][j]; const prev = pass ? m[j - 1][i] : m[i][j - 1];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]; const rev = [...pat].reverse();
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    for (const q of [pat, rev]) {
      let h = true; let v = true;
      for (let k = 0; k < 11; k++) { if (m[i][j + k] !== q[k]) h = false; if (m[j + k][i] !== q[k]) v = false; }
      if (h) p += 40; if (v) p += 40;
    }
  }
  let dark = 0; for (const row of m) for (const v of row) dark += v;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** Matriz QR (array de filas de 0/1) para `text`. Devuelve también versión y máscara. */
export function qrMatrix(text) {
  const { version, codewords } = qrCodewords(text);
  const { n, m: base, fixed } = buildBase(version);
  const path = dataPath(n, fixed);
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((r) => r.slice());
    path.forEach(([r, c], k) => { m[r][c] = (bits[k] || 0) ^ (MASKS[mask](r, c) ? 1 : 0); });
    placeFormat(m, n, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score, mask };
  }
  return { matrix: best.m, version, mask: best.mask, size: n, fixed };
}

/** Lee los datos de vuelta de una matriz (para pruebas de ida y vuelta). */
export function qrReadCodewords(matrix, version, mask, fixed) {
  const n = matrix.length;
  const path = dataPath(n, fixed);
  const bits = path.map(([r, c]) => matrix[r][c] ^ (MASKS[mask](r, c) ? 1 : 0));
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cws.push(b);
  }
  return cws;
}

/** SVG (string) del QR con zona silenciosa de 4 módulos. Sin scripts ni recursos externos. */
export function qrSvg(text, { scale = 6, dark = '#000', light = '#fff' } = {}) {
  const { matrix, size } = qrMatrix(text);
  const q = 4; const total = size + 2 * q;
  let d = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * scale}" height="${total * scale}" shape-rendering="crispEdges" role="img" aria-label="Código QR de la dirección de pago"><rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
