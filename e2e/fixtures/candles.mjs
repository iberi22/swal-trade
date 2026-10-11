// Misma serie que workers/public-site/test/analisis-core.test.mjs (doble suelo limpio).

export function path(points, { volume = 100, wick = 0.3 } = {}) {
  const closes = [];
  for (let k = 1; k < points.length; k += 1) {
    const [i0, p0] = points[k - 1];
    const [i1, p1] = points[k];
    for (let i = i0; i < i1; i += 1) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  closes.push(points[points.length - 1][1]);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return {
      time: 1_700_000_000 + i * 60,
      open: o,
      high: Math.max(o, c) + wick,
      low: Math.min(o, c) - wick,
      close: c,
      volume,
    };
  });
}

/** 71 velas con un doble suelo en ~110. */
export function doubleBottomCandles() {
  return path([[0, 130], [30, 110], [45, 120], [60, 109.8], [70, 116]]);
}

/** Filas de GET /fapi/v1/klines (open time en milisegundos).
 *  Índice 8 = número de trades, índice 9 = volumen de compra agresiva (taker buy
 *  base). `takerShare` reparte el volumen entre compra y venta agresiva: con 0.5
 *  el delta es plano, así que hay flujo de volumen que pintar pero no aparecen
 *  hallazgos nuevos que cambien el top de las pruebas. */
export function toBinanceKlines(candles = doubleBottomCandles(), { takerShare = 0.5 } = {}) {
  return candles.map((c) => [
    c.time * 1000,
    String(c.open),
    String(c.high),
    String(c.low),
    String(c.close),
    String(c.volume),
    c.time * 1000 + 59_999,
    '0',
    Math.max(1, Math.round(c.volume)),
    String(c.volume * takerShare),
    '0',
    '0',
    '0',
  ]);
}

/**
 * La misma serie con una vela final de compra agresiva: volumen 9× lo normal y
 * el 85% del volumen del lado comprador. Con ella el núcleo publica
 * `volume_shock_buy` y el panel de CVD tiene delta y línea con datos que pintar.
 */
export function aggressiveBuyKlines() {
  const candles = doubleBottomCandles();
  const last = candles[candles.length - 1];
  return toBinanceKlines(
    [
      ...candles.slice(0, -1),
      { ...last, time: last.time + 60, open: 130.2, high: 132, low: 129.6, close: 131.8, volume: 900 },
    ],
    { takerShare: 0.85 },
  );
}

/**
 * Mueve una serie en el tiempo y la escala en precio sin tocar su forma. Los
 * patrones que busca el núcleo son relativos, así que la serie sigue teniendo el
 * mismo doble suelo; solo que ahora está donde la página de verdad lo tiene.
 */
export function rescaleCandles(candles, { baseTime, priceScale = 1 } = {}) {
  const first = candles[0]?.time ?? 0;
  return candles.map((candle) => {
    const shift = baseTime - first;
    return {
      ...candle,
      time: candle.time + shift,
      open: candle.open * priceScale,
      high: candle.high * priceScale,
      low: candle.low * priceScale,
      close: candle.close * priceScale,
    };
  });
}

/**
 * Velas para la prueba en vivo de Binance: el doble suelo de siempre, escalado
 * al precio que pasa `price` y terminado un día antes de `now` (en ms). Así los
 * niveles que pinta la extensión caen dentro del gráfico que se ve.
 */
export function liveBinanceKlines({ now = Date.now(), price = 83_000 } = {}) {
  const candles = rescaleCandles(doubleBottomCandles(), {
    baseTime: Math.floor(now / 1000) - 86_400,
    priceScale: price / 130,
  });
  return toBinanceKlines(candles);
}
