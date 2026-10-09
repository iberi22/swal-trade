import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlan, formatAmount, unitsToDisplay, mapStatus, formatPrice, isPlausibleSecret,
  apiErrorMessage, rsEcc, formatBits, qrCodewords, qrMatrix, qrReadCodewords, qrSvg,
} from '../static/checkout/lib.js';

test('parsePlan: valido, desconocido y ausente', () => {
  assert.equal(parsePlan('?plan=pro_year'), 'pro_year');
  assert.equal(parsePlan('?plan=pro_quarter'), 'pro_quarter');
  assert.equal(parsePlan('?plan=hack'), 'pro_month');
  assert.equal(parsePlan(''), 'pro_month');
});

test('formatAmount: display del Worker y derivado de unidades', () => {
  assert.deepEqual(formatAmount({ amount_display: '10.0037' }), { text: '10.0037', whole: '10', base: '00', tag: '37' });
  assert.equal(formatAmount({ amount_display: '27' }).text, '27.0000');
  const a = formatAmount({ amount_units: '10003700000000000000', decimals: 18 });
  assert.equal(a.text, '10.0037');
  assert.equal(formatAmount({ amount_units: '96009900', decimals: 6 }).text, '96.0099');
  assert.throws(() => formatAmount({ amount_display: '1e3' }));
  assert.throws(() => formatAmount({}));
});

test('unitsToDisplay: casos limite', () => {
  assert.equal(unitsToDisplay('0', 6), '0.0000');
  assert.equal(unitsToDisplay('500', 6), '0.0005');
  assert.equal(unitsToDisplay('10000000', 6), '10.0000');
  assert.equal(unitsToDisplay('10123456', 6), '10.123456');
});

test('mapStatus: estados del Worker', () => {
  assert.equal(mapStatus('pending').final, false);
  assert.equal(mapStatus('paid').tone, 'ok');
  assert.equal(mapStatus('expired').final, true);
  assert.equal(mapStatus('manual_review').final, true);
  assert.equal(mapStatus('???').final, false);
});

test('formatPrice / secreto / errores', () => {
  assert.equal(formatPrice('10'), '10.00 USD');
  assert.ok(isPlausibleSecret('a'.repeat(43)));
  assert.ok(!isPlausibleSecret('corto'));
  assert.ok(!isPlausibleSecret('a b'.repeat(20)));
  assert.match(apiErrorMessage(429, null), /minuto/);
  assert.equal(apiErrorMessage(400, { message: 'plan desconocido: x' }), 'plan desconocido: x');
});

test('QR: Reed-Solomon contra el vector conocido HELLO WORLD v1-M', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEcc(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('QR: bits de formato conocidos (M, mascara 0 y 4 (tabla ISO))', () => {
  assert.equal(formatBits(0).toString(2).padStart(15, '0'), '101010000010010');
  assert.equal(formatBits(4).toString(2).padStart(15, '0'), '100010111111001');
});

const ADDRS = [
  '0x55d398326f99059fF775485246999027B3197955', // BSC, 42
  'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', // Tron, 34
  'x',
];

test('QR: version, cabecera y datos de ida y vuelta', () => {
  for (const addr of ADDRS) {
    const { version, dataCodewords } = qrCodewords(addr);
    assert.ok(version >= 1 && version <= 6);
    assert.equal(dataCodewords[0] >> 4, 0b0100); // modo byte
    const len = ((dataCodewords[0] & 0xf) << 4) | (dataCodewords[1] >> 4);
    assert.equal(len, addr.length);
    const { matrix, mask, size, fixed } = qrMatrix(addr);
    assert.equal(size, 17 + 4 * version);
    // leer los codewords de la matriz y comprobar que son los esperados
    const cws = qrReadCodewords(matrix, version, mask, fixed);
    assert.deepEqual(cws.slice(0, qrCodewords(addr).codewords.length), qrCodewords(addr).codewords);
  }
});

test('QR: patrones fijos presentes y SVG sin recursos externos', () => {
  const { matrix, size } = qrMatrix(ADDRS[0]);
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(matrix[r][c + i], 1); assert.equal(matrix[r + 6][c + i], 1);
      assert.equal(matrix[r + i][c], 1); assert.equal(matrix[r + i][c + 6], 1);
    }
    assert.equal(matrix[r + 3][c + 3], 1);
    assert.equal(matrix[r + 1][c + 1], 0);
  }
  assert.equal(matrix[size - 8][8], 1); // modulo oscuro
  const svg = qrSvg(ADDRS[1]);
  assert.match(svg, /^<svg /);
  assert.ok(!/http(?!:\/\/www\.w3\.org)|<script|href/i.test(svg));
});

test('QR: texto demasiado largo lanza', () => {
  assert.throws(() => qrMatrix('a'.repeat(200)), RangeError);
});
