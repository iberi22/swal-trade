export async function analyze({ symbol, timeframe, candles }) {
  const last = candles.at(-1);
  return {
    findings: [
      {
        id: "low",
        kind: "pattern",
        label: "Low",
        explanation: "weaker pattern",
        from: candles[0]?.time ?? 0,
        to: last?.time ?? 0,
        levels: [],
        direction: "flat",
        strength: 0.2,
        evidence: { candles: candles.length },
      },
      {
        id: "high",
        kind: "pattern",
        label: "High",
        explanation: "stronger pattern",
        from: 1,
        to: 2,
        levels: [11],
        direction: "up",
        strength: 0.9,
        evidence: {},
      },
    ],
    trend: { symbol, timeframe, candles: candles.length, lastClose: last?.close ?? null },
    levels: [11],
    generatedAt: "2026-10-09T00:00:00.000Z",
  };
}
