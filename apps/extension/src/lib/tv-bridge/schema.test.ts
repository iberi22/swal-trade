import { describe, expect, it } from 'vitest';
import {
  SWAL_CLEAR,
  SWAL_DRAW,
  SWAL_MAX_SHAPES,
  SWAL_MESSAGE_VERSION,
  SWAL_READY,
  buildClearMessage,
  buildDrawMessage,
  buildReadyMessage,
  coerceShape,
  coerceShapes,
  parseBridgeMessage,
  type BridgeDrawMessage,
  type BridgeReadyMessage,
  type BridgeShape,
} from './schema';

describe('Bridge Schema', () => {
  describe('coerceShape', () => {
    it('acepta una forma correcta', () => {
      const input = {
        id: 'valid-id',
        kind: 'level',
        style: 'solid',
        text: 'Nivel 1',
        points: [{ time: 1000, price: 50000 }],
      };
      expect(coerceShape(input)).toEqual(input);
    });

    it('descarta formas con kind inválido', () => {
      const input = {
        id: 'valid-id',
        kind: 'unknown-kind',
        style: 'solid',
        text: '',
        points: [{ time: 1000, price: 50000 }],
      };
      expect(coerceShape(input)).toBeNull();
    });

    it('descarta formas con style inválido', () => {
      const input = {
        id: 'valid-id',
        kind: 'level',
        style: 'unknown-style',
        text: '',
        points: [{ time: 1000, price: 50000 }],
      };
      expect(coerceShape(input)).toBeNull();
    });

    it('limpia text muy largo y descarta id ausente', () => {
      const longText = 'a'.repeat(100);
      const input1 = {
        id: 'valid-id',
        kind: 'level',
        style: 'solid',
        text: longText,
        points: [{ time: 1000, price: 50000 }],
      };
      const shape = coerceShape(input1);
      expect(shape?.text.length).toBe(48);
      expect(coerceShape({ ...input1, id: '' })).toBeNull();
    });

    it('valida cantidade de puntos exacta para un level (max/min 1)', () => {
      const base = { id: 'id', kind: 'level', style: 'solid', text: '' };
      expect(coerceShape({ ...base, points: [] })).toBeNull();
      expect(coerceShape({ ...base, points: [{ time: 1, price: 1 }] })).not.toBeNull();
      expect(
        coerceShape({
          ...base,
          points: [
            { time: 1, price: 1 },
            { time: 2, price: 2 },
          ],
        }),
      ).toBeNull();
    });

    it('valida que arrow tenga direction', () => {
      const base = {
        id: 'id',
        kind: 'arrow',
        style: 'solid',
        text: '',
        points: [{ time: 1, price: 1 }],
      };
      expect(coerceShape(base)).toBeNull();
      expect(coerceShape({ ...base, direction: 'up' })).not.toBeNull();
      expect(coerceShape({ ...base, direction: 'down' })).not.toBeNull();
      expect(coerceShape({ ...base, direction: 'side' })).toBeNull();
    });

    it('descarta puntos inválidos', () => {
      const base = { id: 'id', kind: 'level', style: 'solid', text: '' };
      expect(coerceShape({ ...base, points: [{ time: -1, price: 1 }] })).toBeNull();
      expect(coerceShape({ ...base, points: [{ time: 1, price: -1 }] })).toBeNull();
      expect(coerceShape({ ...base, points: [{ time: NaN, price: 1 }] })).toBeNull();
      expect(coerceShape({ ...base, points: [{ time: 1, price: Infinity }] })).toBeNull();
      expect(coerceShape({ ...base, points: [{ time: 1.5, price: 1 }] })).toBeNull(); // sin ms
    });
  });

  describe('coerceShapes', () => {
    it('corta en SWAL_MAX_SHAPES y descarta las inválidas', () => {
      const valid = {
        id: 'id',
        kind: 'level',
        style: 'solid',
        text: '',
        points: [{ time: 1, price: 1 }],
      };
      const invalid = { ...valid, kind: 'bad' };
      const raw = Array.from({ length: 100 }).map((_, i) => (i % 2 === 0 ? valid : invalid));
      const shapes = coerceShapes(raw);
      expect(shapes.length).toBe(50); // los pares son 50
    });
  });

  describe('parseBridgeMessage / builders', () => {
    it('construye y parsea clear', () => {
      const msg = buildClearMessage();
      expect(msg).toEqual({ type: SWAL_CLEAR, version: SWAL_MESSAGE_VERSION });
      const parsed = parseBridgeMessage(msg);
      expect(parsed).toEqual(msg);
    });

    it('construye y parsea ready', () => {
      const chart = { symbol: 'BTCUSDT', tf: '1d' };
      const msg = buildReadyMessage('mismatch', chart);
      expect(msg).toEqual({
        type: SWAL_READY,
        version: SWAL_MESSAGE_VERSION,
        ready: false,
        reason: 'mismatch',
        chart,
      });
      const parsed = parseBridgeMessage(msg) as BridgeReadyMessage;
      expect(parsed).toEqual(msg);

      const msgReady = buildReadyMessage('ready');
      expect(msgReady.ready).toBe(true);
      expect(parseBridgeMessage(msgReady)).toEqual(msgReady);
    });

    it('construye y parsea draw truncando formas al tope', () => {
      const valid: BridgeShape = {
        id: 'id',
        kind: 'level',
        style: 'solid',
        text: '',
        points: [{ time: 1, price: 1 }],
      };
      const many = Array.from({ length: 100 }, () => valid);
      const msg = buildDrawMessage(many, 'BTCUSDT@1d');
      expect(msg.shapes.length).toBe(SWAL_MAX_SHAPES);
      expect(msg.key).toBe('BTCUSDT@1d');

      const parsed = parseBridgeMessage(msg) as BridgeDrawMessage;
      expect(parsed.type).toBe(SWAL_DRAW);
      expect(parsed.shapes.length).toBe(SWAL_MAX_SHAPES);
      expect(parsed.key).toBe('BTCUSDT@1d');
    });

    it('ignora mensajes mal formados o de otra versión', () => {
      expect(parseBridgeMessage(null)).toBeNull();
      expect(parseBridgeMessage(123)).toBeNull();
      expect(parseBridgeMessage({ type: SWAL_DRAW, version: 0 })).toBeNull();
      expect(parseBridgeMessage({ type: 'other', version: SWAL_MESSAGE_VERSION })).toBeNull();
    });
  });
});
