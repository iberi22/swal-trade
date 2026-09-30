# Contrato del snapshot público — `synapse.public.snapshot/v1`

Página pública de solo lectura en **https://trade.swal.network** (sin registro). Muestra los puntos
y la operativa de los bots. Fuente de verdad del formato entre el backend (productor), el
publicador y el Worker (consumidor).

## Flujo

```
backend (127.0.0.1:19234)  GET /public/v1/snapshot   ← solo loopback, sin auth, solo lectura
        │
scripts/publish-public-snapshot.sh (timer systemd de usuario, cada 60 s)
        │  POST https://trade.swal.network/ingest   Authorization: Bearer $PUBLIC_INGEST_TOKEN
        ▼
Worker "swal-trade" (workers/public-site/) ── KV "latest" ──> GET /public/v1/snapshot (público, cache 30 s)
                                                  └─> GET /  página estática
```

Nada entra a la máquina local desde internet: el backend solo **empuja** hacia fuera.

## Reglas de privacidad (obligatorias)

- Nunca: API keys, secretos, IDs de orden del exchange, balance absoluto de cuentas **reales**,
  IPs, rutas del sistema de archivos, ni texto libre de logs.
- Cantidades en **porcentaje** respecto al capital inicial del bot. El capital absoluto solo se
  publica si `mode == "paper"`.
- Posiciones abiertas: símbolo, lado, precio de entrada, uPnL %, antigüedad. Sin tamaño absoluto.
- Si el backend no puede construir un campo, se omite o va `null`; nunca se inventa.

## Esquema

```jsonc
{
  "schema": "synapse.public.snapshot/v1",
  "generated_at": "2026-09-29T17:00:00Z",   // RFC3339 UTC
  "mode": "paper",                            // "paper" | "testnet" | "live"
  "engine": {
    "status": "running",                      // "running" | "paused" | "emergency_stop" | "degraded"
    "feed_ok": true,                          // hay precio de mercado con < 120 s de antigüedad
    "last_price_update_at": "2026-09-29T16:59:58Z",
    "uptime_s": 12345,
    "strategies_registered": 20
  },
  "account": {
    "initial_capital": 100.0,                 // solo si mode == "paper", si no null
    "equity_pct": 1.23,                       // (equity / initial - 1) * 100
    "daily_pnl_pct": -0.10,
    "max_drawdown_pct": 2.5,
    "open_positions": 2,
    "total_trades": 42,
    "win_rate": 47.6                          // %, null si total_trades == 0
  },
  "points_formula": "1 punto = 1 pb (0,01 %) de rendimiento neto acumulado del bot tras comisiones y funding",
  "bots": [
    {
      "id": "MomentumBreakout",
      "name": "Momentum Breakout",
      "status": "active",                     // "active" | "gated" | "disabled"
      "allocation_pct": 100.0,                // % del capital asignado por el gating; null si no aplica
      "fidelity": "diverges",                 // de simulator_fidelity: "verified" | "diverges" | "unmeasured"
      "research_verdict": "sin edge (PF 0.78 OOS)", // texto corto o null
      "points": -123,                         // round(sum(pnl_pct_neto) * 100)
      "trades": 10,
      "wins": 4,
      "win_rate": 40.0,
      "profit_factor": 0.8,                   // null si no hay pérdidas o trades == 0
      "pnl_pct": -1.23,
      "last_trade_at": "2026-09-29T12:00:00Z"
    }
  ],
  "open_positions": [
    { "bot": "MomentumBreakout", "symbol": "SOLUSDT", "side": "long",
      "entry_price": 115.87, "upnl_pct": 1.6, "opened_at": "2026-09-29T11:00:00Z" }
  ],
  "recent_trades": [                          // últimos 50 cerrados, más reciente primero
    { "bot": "MomentumBreakout", "symbol": "ETHUSDT", "side": "short",
      "entry_price": 2730.7, "exit_price": 2700.1, "pnl_pct": 1.1,
      "exit_reason": "TP", "opened_at": "...", "closed_at": "..." }
  ],
  "equity_curve": [                           // hasta 500 puntos, ascendente
    { "t": "2026-09-29T00:00:00Z", "equity_pct": 0.0 }
  ]
}
```

`bots` ordenado por `points` descendente. Tamaño objetivo < 200 KB.

## Estado honesto

La página muestra siempre `mode` y el aviso: *"Operativa en paper trading. Ninguna estrategia
tiene todavía una ventaja estadística validada fuera de muestra. No es asesoría financiera."*
mientras ninguna estrategia haya superado la validación fuera de muestra (puerta interna F4 del laboratorio).
