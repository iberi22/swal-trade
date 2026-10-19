import { describe, expect, it } from 'vitest';
import {
  ALLOWED_RESOLUTIONS,
  SWAL_CLEAR,
  SWAL_DRAW,
  SWAL_MAX_SHAPES,
  SWAL_MESSAGE_VERSION,
  SWAL_READY,
  SWAL_RESOLUTION_ACK,
  SWAL_SET_RESOLUTION,
  SWAL_SET_READ,
  SWAL_POSITION_TOOLS,
  SWAL_MAX_POSITION_TOOLS,
  MAX_POSITION_TOOL_ID,
  MAX_POSITION_TOOL_NAME,
  buildPositionToolsMessage,
  buildSetReadMessage,
  coercePositionTool,
  parsePositionToolsMessage,
  buildClearMessage,
  buildDrawMessage,
  buildReadyMessage,
  buildResolutionAckMessage,
  buildSetResolutionMessage,
  coerceShape,
  coerceShapes,
  isBridgeResolution,
  parseBridgeMessage,
  type BridgeDrawMessage,
  type BridgeReadyMessage,
  type BridgeResolutionAckMessage,
  type BridgeSetResolutionMessage,
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

    it('construye y valida set-resolution y resolution-ack', () => {
      for (const res of ALLOWED_RESOLUTIONS) {
        expect(isBridgeResolution(res)).toBe(true);
        expect(parseBridgeMessage(buildSetResolutionMessage(res))).toEqual(buildSetResolutionMessage(res));
      }
      expect(isBridgeResolution('2')).toBe(false);
      expect(parseBridgeMessage({ type: SWAL_SET_RESOLUTION, version: SWAL_MESSAGE_VERSION, resolution: '2' })).toBeNull();
      const ackOk = buildResolutionAckMessage(true, '15');
      expect(parseBridgeMessage(ackOk)).toEqual(ackOk);
      const ackErr = buildResolutionAckMessage(false, '1D', 'unsupported');
      expect(parseBridgeMessage(ackErr)).toEqual(ackErr);
      expect(parseBridgeMessage({ type: SWAL_RESOLUTION_ACK, version: SWAL_MESSAGE_VERSION, ok: 'bad', resolution: '15' })).toBeNull();
    });

    it('ignora mensajes mal formados o de otra versión', () => {
      expect(parseBridgeMessage(null)).toBeNull();
      expect(parseBridgeMessage(123)).toBeNull();
      expect(parseBridgeMessage({ type: SWAL_DRAW, version: 0 })).toBeNull();
      expect(parseBridgeMessage({ type: 'other', version: SWAL_MESSAGE_VERSION })).toBeNull();
    });
  });

  describe('lectura de posiciones (swal:set-read / swal:position-tools)', () => {
    const tool = {
      id: 'shape-1',
      name: 'LineToolRiskRewardLong',
      entry: 81917.9,
      stopLevel: 592530,
      profitLevel: 592530,
    };
    const message = {
      type: SWAL_POSITION_TOOLS,
      version: SWAL_MESSAGE_VERSION,
      symbol: 'BTCUSDT',
      minmov: 1,
      pricescale: 100,
      tools: [tool],
    };

    it('valida el control de encendido de la lectura', () => {
      expect(parseBridgeMessage(buildSetReadMessage(true))).toEqual(buildSetReadMessage(true));
      expect(parseBridgeMessage(buildSetReadMessage(false))).toEqual(buildSetReadMessage(false));
      expect(parseBridgeMessage({ type: SWAL_SET_READ, version: SWAL_MESSAGE_VERSION })).toBeNull();
      expect(parseBridgeMessage({ type: SWAL_SET_READ, version: SWAL_MESSAGE_VERSION, enabled: 'true' })).toBeNull();
      expect(parseBridgeMessage({ type: SWAL_SET_READ, version: SWAL_MESSAGE_VERSION + 1, enabled: true })).toBeNull();
    });

    it('acepta un mensaje válido y descarta campos desconocidos', () => {
      const parsed = parseBridgeMessage({ ...message, extra: 'nope', tools: [{ ...tool, color: 'red' }] });
      expect(parsed).toEqual(message);
      expect(parsed && 'tools' in parsed && parsed.tools[0]).not.toHaveProperty('color');
    });

    it('normaliza el símbolo a mayúsculas y acepta la lista vacía', () => {
      const parsed = parsePositionToolsMessage({ ...message, symbol: 'btcusdt', tools: [] });
      expect(parsed?.symbol).toBe('BTCUSDT');
      expect(parsed?.tools).toEqual([]);
    });

    it('rechaza NaN, Infinity, tipos equivocados y símbolo inválido', () => {
      const badMessages: unknown[] = [
        { ...message, minmov: Number.NaN },
        { ...message, pricescale: Number.POSITIVE_INFINITY },
        { ...message, minmov: '1' },
        { ...message, pricescale: 0 },
        { ...message, symbol: 'bt c' },
        { ...message, symbol: 42 },
        { ...message, tools: 'nope' },
        { ...message, version: 1 },
      ];
      for (const raw of badMessages) expect(parsePositionToolsMessage(raw)).toBeNull();
      expect(parseBridgeMessage(null)).toBeNull();
      expect(parseBridgeMessage({ type: SWAL_POSITION_TOOLS, version: SWAL_MESSAGE_VERSION })).toBeNull();

      // Una herramienta rota no invalida el mensaje: se tira y queda la lista vacía.
      const badTools: unknown[] = [
        { ...tool, entry: Number.NaN },
        { ...tool, entry: '81917.9' },
        { ...tool, entry: 0 },
        { ...tool, stopLevel: null },
        { ...tool, profitLevel: -1 },
        { ...tool, id: 7 },
        { ...tool, name: '' },
        'nope',
        null,
      ];
      for (const raw of badTools) {
        const parsed = parsePositionToolsMessage({ ...message, tools: [raw] });
        expect(parsed).not.toBeNull();
        expect(parsed?.tools).toEqual([]);
      }
    });

    it('corta textos y el número de herramientas a los topes del contrato', () => {
      const long = 'x'.repeat(500);
      const coerced = coercePositionTool({ ...tool, id: long, name: long });
      expect(coerced?.id).toHaveLength(MAX_POSITION_TOOL_ID);
      expect(coerced?.name).toHaveLength(MAX_POSITION_TOOL_NAME);
      const many = Array.from({ length: 40 }, (_v, i) => ({ ...tool, id: `id-${i}` }));
      const parsed = parsePositionToolsMessage({ ...message, tools: many });
      expect(parsed?.tools).toHaveLength(SWAL_MAX_POSITION_TOOLS);
      const built = buildPositionToolsMessage('btcusdt', 1, 100, many);
      expect(built.tools).toHaveLength(SWAL_MAX_POSITION_TOOLS);
      expect(built.symbol).toBe('BTCUSDT');
    });
  });
});
