# Radar — Alertas deterministas y medición forward en tiempo real

Servicio local en ejecución continua (*always-on*) que convierte los hallazgos del núcleo de análisis determinista en alertas medibles para futuros de Binance (`BTCUSDC` y `ETHUSDC`), evalúa el desenlace real de cada alerta vela a vela (1m), vincula las operaciones manuales del usuario y expone una API local para la extensión de navegador y Claude.

---

## Nota de honestidad (Regla de la Casa)

> **Un alerta es un experimento, nunca una promesa.**
>
> Nuestro estudio riguroso de backtest (*walk-forward*, 92 celdas con corrección Holm y BH) demostró que **ningún patrón técnico supera al azar con significancia estadística tras corrección por multiplicidad**. Por tanto, este servicio no promete señales ganadoras ni ventajas mágicas.
>
> Todas las estadísticas reportadas por Radar:
> 1. Muestran la etiqueta **`sin evidencia (n<30)`** mientras la muestra de alertas resueltas sea inferior a 30.
> 2. Expresan las tasas de acierto a 1R y 2R acompañadas de sus **intervalos de confianza de Wilson al 95%** (`low` – `high`).
> 3. Descuentan un coste de ida y vuelta de **0,08%** (comisiones *taker* estándar de futuros) para calcular el resultado neto en múltiplos de riesgo (`net_r`).

---

## Arquitectura del sistema

```
┌────────────────────────────────────────────────────────┐
│                   Binance Futures API                  │
│  - Klines públicas (300 velas 15m/1h, 150 velas 1m)    │
│  - GET /fapi/v1/userTrades (lectura firmada de fills)  │
└───────────────▲──────────────────────▲─────────────────┘
                │                      │
┌───────────────┴──────────────┐ ┌─────┴─────────────────┐
│     radar/sources/core.py    │ │   radar/binance.py    │
│ (Node helper radar/detect.mjs│ │ (Solo GET firmado,    │
│  -> analysis-core.js)        │ │  retry en -1021)      │
└───────────────┬──────────────┘ └─────┬─────────────────┘
                │                      │
┌───────────────▼──────────────────────▼─────────────────┐
│                    radar/store.py                      │
│        SQLite WAL (~/.local/share/swal-trade/radar.db)  │
│          - alerts (geometría, MFE, MAE, R neto)        │
│          - user_trades (enlaces a trades manuales)     │
└───────────────▲────────────────────────────────────────┘
                │
┌───────────────┴──────────────┐ ┌───────────────────────┐
│       radar/evaluate.py      │ │      radar/api.py     │
│ Lifecycle 1m: pending ->     │ │ HTTP 127.0.0.1:47322  │
│ triggered -> win/loss/expire │ │ Sin CORS, auth token  │
└──────────────────────────────┘ └───────────────────────┘
```

### 1. Detección (Reutilización del núcleo JS)
- Llama al núcleo determinista (`analysis-core.js`) vía `radar/detect.mjs` pasándole las últimas 300 velas cerradas en JSON por `stdin`.
- Filtra hallazgos que tengan geometría medible ($R/R \ge 1.0$ para 1R):
  - Dirección: `long` o `short`
  - Entrada (`entry`): precio `confirm`
  - Stop (`stop`): precio `invalidate`
  - Riesgo: $|entry - stop| > 0$
  - Objetivos: `target_1r = entry ± 1 · risk` y `target_2r = entry ± 2 · risk`
- Desduplica alertas activas mediante `symbol + tf + kind + rounded levels`.

### 2. Ciclo de vida de la alerta (velas 1m)
- **`pending`**: la alerta espera hasta que una vela de 1m **cierra más allá** del nivel de entrada (`close > entry` en long, `close < entry` en short). Si transcurren 24 velas de su temporalidad sin activarse, expira (`expired`).
- **`triggered`**: la alerta está activa en mercado. Se registran continuamente la máxima excursión favorable (`mfe_r`) y adversa (`mae_r`) en unidades $R$.
- **`loss`**: si el precio toca el stop. **Regla conservadora**: si stop y objetivo son tocados dentro de la misma vela de 1m, se contabiliza como `loss`.
- **`win_1r` / `win_2r`**: cuando el precio toca el objetivo 1R o 2R.
- **`expired`**: si tras activarse transcurren 96 velas de su temporalidad sin alcanzar ni el stop ni el objetivo, se cierra a precio de mercado (`mtm_r`).

### 3. Operaciones manuales (opcional, desactivado por defecto)
- Solo con `RADAR_SYNC_USER_TRADES=1`. Sin esa variable el radar no usa ninguna clave de Binance: solo lee klines públicas.
- Cada 2 minutos, si `BINANCE_API_KEY` y `BINANCE_API_SECRET` están presentes en el entorno:
  - Lee `GET /fapi/v1/userTrades` de futuros para los pares seguidos (`recvWindow 15000`, reintento en error `-1021`).
  - **Seguridad**: el código contiene una aserción estricta (`assert method == 'GET'`), impidiendo por construcción la emisión de órdenes.
  - Si un fill manual coincide en par, dirección y ocurre mientras la alerta estaba `pending`/`triggered` (o hasta 15 minutos tras la activación), vincula la operación marcando `taken_by_user = 1`, anotando el precio real de entrada y el PnL realizado.

---

## Contrato de la API Local (HTTP 127.0.0.1)

El servicio escucha únicamente en `127.0.0.1` (puerto configurable `RADAR_PORT`, por defecto `47322`).
**Sin cabeceras CORS**: las extensiones de navegador utilizan *host permissions*; los sitios web de terceros no pueden acceder a esta API.

### `GET /v1/health`
Estado del servicio y metadatos de escaneo.
```json
{
  "ok": true,
  "version": "1.0.0",
  "symbols": ["BTCUSDC", "ETHUSDC"],
  "tfs": ["15m", "1h"],
  "last_scan": "2026-10-15T23:55:35Z",
  "db": "~/.local/share/swal-trade/radar.db"
}
```

### `GET /v1/alerts?status=active|resolved|all&limit=50`
Lista de alertas según su estado:
- `active`: alertas en estado `pending` o `triggered`.
- `resolved`: alertas en estado `win_1r`, `win_2r`, `loss` o `expired`.
- `all`: todas las alertas.

```json
{
  "alerts": [
    {
      "id": 12,
      "source": "core",
      "symbol": "BTCUSDC",
      "tf": "15m",
      "kind": "double_top",
      "title": "Doble techo",
      "direction": "short",
      "entry": 82000.0,
      "stop": 82500.0,
      "target_1r": 81500.0,
      "target_2r": 81000.0,
      "strength": 0.85,
      "status": "pending",
      "created_at": "2026-10-15T23:50:00Z",
      "triggered_at": null,
      "resolved_at": null,
      "outcome_r": null,
      "mfe_r": 0.0,
      "mae_r": 0.0,
      "taken_by_user": false,
      "user_entry": null,
      "user_pnl": null
    }
  ]
}
```

### `GET /v1/stats`
Estadísticas agregadas globales, por patrón y de alertas tomadas por el usuario:
```json
{
  "overall": {
    "n_resolved": 15,
    "triggered_rate": 0.65,
    "win_rate_1r": 0.40,
    "ci_1r": {"rate": 0.40, "low": 0.1982, "high": 0.6425},
    "win_rate_2r": 0.20,
    "ci_2r": {"rate": 0.20, "low": 0.0704, "high": 0.4518},
    "avg_net_r": -0.12,
    "label": "sin evidencia (n<30)"
  },
  "by_kind": [],
  "taken": {},
  "note": "Un alerta es un experimento, nunca una promesa; nuestro backtest no halló evidencia de superar el azar (sin evidencia). Estadísticas muestran intervalos Wilson 95%."
}
```

### `POST /v1/alerts/<id>/note`
Permite al usuario o a Claude marcar manualmente una alerta como tomada o registrar notas (hasta 200 caracteres).
- **Cabecera requerida**: `X-Radar-Token: <token>` (el token se crea automáticamente en `~/.config/swal-trade/radar-token` con permisos `0600` en el primer arranque).
- **Cuerpo JSON**:
  ```json
  {
    "taken": true,
    "note": "Entrada manual ejecutada en 82010"
  }
  ```

---

## Cómo ejecutar

### Modo de prueba rápida (`--once`)
Ejecuta un ciclo completo (escaneo de mercado, detección, almacenamiento, evaluación sobre 1m y resumen) sin persistir demonio:
```bash
python3 -m radar --once
```

Con base de datos y puerto temporales:
```bash
RADAR_DB=/tmp/radar-smoke.db RADAR_PORT=47399 python3 -m radar --once
```

### Ejecución en segundo plano / Demonio
```bash
python3 -m radar
```

### Servicio systemd de usuario
La plantilla `radar/swal-radar.service.in` lleva dos marcadores, `@REPO_DIR@` y `@ENV_FILE@`.
Sustitúyelos por la ruta de tu clon y de tu archivo de entorno (o usa `scripts/install-linux-services.sh`, cuando exista):
```bash
sed -e "s|@REPO_DIR@|$PWD|" -e "s|@ENV_FILE@|$HOME/.config/swal-trade/radar.env|" \
  radar/swal-radar.service.in > ~/.config/systemd/user/swal-radar.service
systemctl --user daemon-reload && systemctl --user enable --now swal-radar
```
