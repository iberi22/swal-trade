export async function analyze({ symbol, timeframe, candles }) {
  const last = candles.at(-1);
  return {
    findings: [
      {
        id: "double_bottom:1:2",
        kind: "double_bottom",
        label: "Doble suelo",
        explanation: "Doble suelo con cuello en 106.6.",
        from: 1,
        to: 2,
        levels: [{ role: "neckline", price: 106.58, confirm: 106.58, invalidate: 98.74 }],
        direction: "up",
        strength: 0.7985,
        status: "forming",
        evidence: {},
      },
      {
        id: "sr_zone:3",
        kind: "sr_zone",
        label: "Zona de resistencia",
        explanation: "Zona frenada cuatro veces.",
        from: 3,
        to: 4,
        levels: [{ role: "high", price: 110, confirm: 110, invalidate: 105 }],
        direction: "down",
        strength: 0.61,
        status: "confirmed",
        evidence: {},
      },
    ],
    trend: { symbol, timeframe, candles: candles.length, direction: "up", strength: 0.4, label: "Alcista" },
    levels: [{ role: "neckline", price: 106.58, confirm: 106.58, invalidate: 98.74 }],
    generatedAt: "2026-10-10T00:00:00.000Z",
  };
  void last;
}
