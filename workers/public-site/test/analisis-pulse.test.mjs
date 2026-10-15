import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSymbol,
  quoteAsset,
  depthUrl,
  forceOrderUrl,
  klinesUrl,
  parseForceOrder,
  formatUsd,
  formatPrice,
  formatPct,
  fetchWalls,
  fetchRegimen,
  openLiquidationStream,
  startMarketPulse,
  PULSE_TIMEFRAMES,
  REST_ORIGIN,
  WS_ORIGIN,
} from '../static/analisis/market-pulse.js';

test('assertSymbol normaliza y valida pares', () => {
  assert.equal(assertSymbol('btcusdt'), 'BTCUSDT');
  assert.equal(assertSymbol('BTCUSDC'), 'BTCUSDC');
  assert.equal(assertSymbol('1000pepeusdc'), '1000PEPEUSDC');
  assert.throws(() => assertSymbol(''), /símbolo no válido/);
  assert.throws(() => assertSymbol('a'), /símbolo no válido/);
  assert.throws(() => assertSymbol('BTC/USDT'), /símbolo no válido/);
});

test('quoteAsset distingue pares USDT y USDC', () => {
  assert.equal(quoteAsset('BTCUSDT'), 'USDT');
  assert.equal(quoteAsset('ETHUSDT'), 'USDT');
  assert.equal(quoteAsset('BTCUSDC'), 'USDC');
  assert.equal(quoteAsset('1000PEPEUSDC'), 'USDC');
  assert.equal(quoteAsset('btcusdc'), 'USDC');
});

test('depthUrl y forceOrderUrl usan el origen correcto de Binance', () => {
  assert.equal(
    depthUrl('BTCUSDC', 500),
    `${REST_ORIGIN}/fapi/v1/depth?symbol=BTCUSDC&limit=500`,
  );
  assert.equal(
    depthUrl('1000PEPEUSDC', 2000), // límite acotado a 1000
    `${REST_ORIGIN}/fapi/v1/depth?symbol=1000PEPEUSDC&limit=1000`,
  );
  assert.equal(
    forceOrderUrl('BTCUSDC'),
    `${WS_ORIGIN}/btcusdc@forceOrder`,
  );
  assert.equal(
    forceOrderUrl('1000PEPEUSDC'),
    `${WS_ORIGIN}/1000pepeusdc@forceOrder`,
  );
});

test('klinesUrl construye la ruta para klines', () => {
  assert.equal(
    klinesUrl('BTCUSDT', '15m', 200),
    `${REST_ORIGIN}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=200`,
  );
});

test('parseForceOrder procesa mensajes forceOrder directos y envueltos', () => {
  // Mensaje directo de Binance forceOrder
  const directSell = JSON.stringify({
    e: 'forceOrder',
    E: 1700000000000,
    o: {
      s: 'BTCUSDT',
      S: 'SELL',
      o: 'LIMIT',
      f: 'IOC',
      q: '0.5',
      p: '65000.00',
      ap: '65100.00',
      X: 'FILLED',
      l: '0.5',
      z: '0.5',
      T: 1700000000100,
    },
  });
  const resSell = parseForceOrder(directSell);
  assert.ok(resSell);
  assert.equal(resSell.symbol, 'BTCUSDT');
  assert.equal(resSell.side, 'long'); // SELL liquida LONG
  assert.equal(resSell.price, 65100); // prefiere ap sobre p
  assert.equal(resSell.qty, 0.5); // prefiere z sobre q
  assert.equal(resSell.usd, 32550);
  assert.equal(resSell.at, 1700000000100);

  // Mensaje BUY liquida SHORT
  const directBuy = JSON.stringify({
    e: 'forceOrder',
    o: {
      s: 'BTCUSDC',
      S: 'BUY',
      p: '65000.00',
      q: '1.2',
      T: 1700000000200,
    },
  });
  const resBuy = parseForceOrder(directBuy);
  assert.ok(resBuy);
  assert.equal(resBuy.symbol, 'BTCUSDC');
  assert.equal(resBuy.side, 'short');
  assert.equal(resBuy.price, 65000);
  assert.equal(resBuy.qty, 1.2);
  assert.equal(resBuy.usd, 78000);

  // Mensaje envuelto en stream envelope
  const wrapped = JSON.stringify({
    stream: 'btcusdt@forceOrder',
    data: {
      e: 'forceOrder',
      o: {
        s: '1000PEPEUSDC',
        S: 'SELL',
        ap: '0.0095',
        z: '100000',
        T: 1700000000300,
      },
    },
  });
  const resWrapped = parseForceOrder(wrapped);
  assert.ok(resWrapped);
  assert.equal(resWrapped.symbol, '1000PEPEUSDC');
  assert.equal(resWrapped.side, 'long');
  assert.equal(resWrapped.usd, 950);

  // Casos inválidos
  assert.equal(parseForceOrder(''), null);
  assert.equal(parseForceOrder('not json'), null);
  assert.equal(parseForceOrder(JSON.stringify({ e: 'kline' })), null);
  assert.equal(parseForceOrder(JSON.stringify({ e: 'forceOrder', o: { s: 'BTC', S: 'OTHER' } })), null);
  assert.equal(parseForceOrder(JSON.stringify({ e: 'forceOrder', o: { s: 'BTC', S: 'SELL', p: -10, q: 1, T: 100 } })), null);
});

test('formatUsd formatea importes en español con la divisa adecuada', () => {
  assert.equal(formatUsd(0, 'USDT'), '0 USDT');
  assert.equal(formatUsd(-5, 'USDC'), '0 USDC');
  assert.equal(formatUsd(500.5, 'USDT'), '500,5 USDT');
  assert.equal(formatUsd(1500, 'USDC'), '1,5 mil USDC');
  assert.equal(formatUsd(2_500_000, 'USDC'), '2,50 M USDC');
});

test('formatPrice adapta decimales a la escala del precio', () => {
  assert.equal(formatPrice(NaN), '—');
  assert.equal(formatPrice(65432.1), '65.432,1');
  assert.equal(formatPrice(0.009412), '0,009412');
  assert.equal(formatPrice(0.00005432), '0,00005432');
});

test('formatPct formatea porcentaje con coma y dos decimales', () => {
  assert.equal(formatPct(null), '—');
  assert.equal(formatPct(1.2345), '1,23 %');
  assert.equal(formatPct(-0.5), '-0,50 %');
});

test('fetchWalls calcula muros o devuelve null ante error', async () => {
  const mockDepth = {
    bids: [
      ['67000', '10'],
      ['66900', '15'],
      ['66800', '100'], // muro bid
    ],
    asks: [
      ['67100', '10'],
      ['67200', '15'],
      ['67300', '120'], // muro ask
    ],
  };

  const fetchSuccess = async () => ({
    ok: true,
    json: async () => mockDepth,
  });

  const walls = await fetchWalls('BTCUSDC', fetchSuccess);
  assert.ok(walls);
  assert.ok(Number.isFinite(walls.mid));
  assert.ok(walls.bids.length > 0 || walls.asks.length > 0);

  const fetchFailure = async () => ({
    ok: false,
    status: 500,
  });
  const wallsFail = await fetchWalls('BTCUSDC', fetchFailure);
  assert.equal(wallsFail, null);
});

test('fetchRegimen obtiene tendencias para 15m, 1h, 4h', async () => {
  // Generar 60 velas sintéticas para que trendOf tenga suficientes datos
  const mockCandles = [];
  let price = 60000;
  for (let i = 0; i < 60; i++) {
    price += (i % 2 === 0 ? 10 : -5);
    mockCandles.push([
      1700000000000 + i * 900000,
      String(price),
      String(price + 20),
      String(price - 20),
      String(price + 5),
      '100',
      1700000000000 + (i + 1) * 900000,
      '50000',
      50,
      '25',
    ]);
  }

  const fetchSuccess = async () => ({
    ok: true,
    json: async () => mockCandles,
  });

  const regimen = await fetchRegimen('BTCUSDC', fetchSuccess);
  assert.ok(regimen);
  assert.equal(regimen.length, 3);
  assert.deepEqual(regimen.map((r) => r.timeframe), PULSE_TIMEFRAMES);
  assert.ok(['Alcista', 'Bajista', 'Lateral / mixta', 'up', 'down', 'neutral'].includes(regimen[0].label));

  const fetchFail = async () => ({ ok: false, status: 500 });
  const failedRegimen = await fetchRegimen('BTCUSDC', fetchFail);
  assert.equal(failedRegimen, null);
});

test('openLiquidationStream conecta y gestiona eventos y ciclo de vida', () => {
  let createdWs = null;
  const mockFactory = (url) => {
    const ws = {
      url,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      },
    };
    createdWs = ws;
    return ws;
  };

  const events = [];
  let isLive = false;
  const stream = openLiquidationStream(
    'BTCUSDC',
    {
      onEvent: (e) => events.push(e),
      onLive: (l) => { isLive = l; },
    },
    mockFactory,
  );

  assert.ok(createdWs);
  assert.equal(createdWs.url, 'wss://fstream.binance.com/market/ws/btcusdc@forceOrder');

  // Simular conexión abierta
  createdWs.readyState = 1;
  createdWs.onopen();
  assert.equal(isLive, true);

  // Enviar evento de BTCUSDC
  createdWs.onmessage({
    data: JSON.stringify({
      e: 'forceOrder',
      o: { s: 'BTCUSDC', S: 'SELL', ap: '65000', z: '1', T: 1700000000000 },
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].symbol, 'BTCUSDC');

  // Evento de otro símbolo se ignora
  createdWs.onmessage({
    data: JSON.stringify({
      e: 'forceOrder',
      o: { s: 'ETHUSDT', S: 'SELL', ap: '3500', z: '1', T: 1700000000000 },
    }),
  });
  assert.equal(events.length, 1);

  // Cerrar stream
  stream.close();
  assert.equal(createdWs.readyState, 3);
});

test('startMarketPulse orquesta muros, liquidaciones y visibilidad', async () => {
  let isVisible = true;
  const listeners = [];
  const mockVisibility = {
    current: () => isVisible,
    subscribe: (fn) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };

  const snapshots = [];
  const handle = startMarketPulse('BTCUSDC', {
    fetchImpl: async (url) => {
      if (url.includes('/depth')) {
        return {
          ok: true,
          json: async () => ({
            bids: [['65000', '10'], ['64900', '100']],
            asks: [['65100', '10'], ['65200', '100']],
          }),
        };
      }
      return { ok: true, json: async () => [] };
    },
    wsFactory: (url) => ({
      url,
      readyState: 1,
      onopen() {},
      close() {},
    }),
    visibility: mockVisibility,
    onChange: (snap) => snapshots.push(snap),
    depthRefreshMs: 50_000,
  });

  // Esperar a que se procese la primera emisión de muros
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(snapshots.length > 0);
  const latest = snapshots[snapshots.length - 1];
  assert.equal(latest.symbol, 'BTCUSDC');

  // Ocultar pestaña -> detiene timers y stream
  isVisible = false;
  listeners.forEach((fn) => fn());
  const hiddenCount = snapshots.length;
  assert.equal(snapshots[snapshots.length - 1].live, false);

  handle.stop();
});
