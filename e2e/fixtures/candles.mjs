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

/** Filas de GET /fapi/v1/klines (open time en milisegundos). */
export function toBinanceKlines(candles = doubleBottomCandles()) {
  return candles.map((c) => [
    c.time * 1000,
    String(c.open),
    String(c.high),
    String(c.low),
    String(c.close),
    String(c.volume),
    c.time * 1000 + 59_999,
    '0',
    0,
    '0',
    '0',
    '0',
  ]);
}
