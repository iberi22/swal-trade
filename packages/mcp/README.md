# @swal-trade/mcp

Servidor MCP para swal-trade. Transporte **stdio**. Expone el análisis del núcleo (`analysis-core`), el contexto de mercado y las comprobaciones de riesgo del guardián, propuestas de orden y, **solo si se activan a propósito**, las herramientas de escritura (órdenes y grids) con `order_guard` y journal local.

Licencia: GNU AGPL-3.0 (ver `LICENSE` en la raíz del repositorio). Herramienta autodirigida, no asesoría de inversiones. **El servidor no da estrategia, ni señal, ni recomendación: ejecuta la instrucción explícita que recibe.**

## Registro en Claude Code

```bash
claude mcp add swal-trade -- npx -y @swal-trade/mcp
```

Variante de desarrollo local, desde la raíz del repo, después de `npm run build` en `packages/mcp`:

```bash
claude mcp add swal-trade -- node packages/mcp/dist/index.js
```

## Tools

| Tool | Tipo | Qué hace |
|---|---|---|
| `analyze_chart` | lectura | Velas públicas de `fapi` y hallazgos del núcleo, ordenados por fuerza. La fuerza es calidad del patrón, no probabilidad. |
| `market_context` | lectura | Tendencia en 1m, 5m, 1h y 4h (si el núcleo está), miedo y codicia (caché 1 h) y titulares. |
| `account_risk` | lectura | GETs firmados de solo lectura y las comprobaciones del guardián. |
| `propose_order` | lectura | Cantidad redondeada a `stepSize` y comprobada contra `minQty` y `MIN_NOTIONAL`, stop y violaciones. No envía nada. |
| `grid_plan` | lectura | Plan de grid: precio por nivel, cantidad por nivel, peor pérdida hasta el stop y niveles que no podrían descansar como post-only. **Siempre disponible**, no necesita keys. |
| `place_order` | escritura | Una orden de entrada más el `STOP_MARKET` obligatorio por el Algo Service. Requiere la bandera. |
| `close_position` | escritura | MARKET `reduceOnly` y cancelación de las órdenes y órdenes algo del símbolo. Requiere la bandera. |
| `grid_place` | escritura | El grid como órdenes límite post-only más un stop protector. Requiere la bandera. |

Las tres herramientas de escritura **no se registran** si `SWAL_MCP_TRADING` no es `enabled`: no aparecen en `listTools` y una llamada directa falla.

## Variables de entorno

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `BINANCE_API_KEY` | `account_risk`, herramientas de escritura | — | Key de futuros. Permiso de lectura y de trading. **Sin retiros.** |
| `BINANCE_API_SECRET` | `account_risk`, herramientas de escritura | — | Secreto HMAC-SHA256. No se imprime ni se escribe en el journal. |
| `SWAL_MCP_TRADING` | herramientas de escritura | sin valor | Debe ser exactamente `enabled` para registrar `place_order`, `close_position` y `grid_place`. |
| `SWAL_MCP_NETWORK` | no | `testnet` | `testnet` o `mainnet`. `mainnet` exige además `SWAL_MCP_MAINNET_CONFIRM=yes`. |
| `SWAL_MCP_MAINNET_CONFIRM` | solo si `SWAL_MCP_NETWORK=mainnet` | — | Debe ser `yes`. Sin las dos variables, las escrituras se quedan en testnet. |
| `SWAL_MCP_SYMBOLS` | herramientas de escritura | — | Lista blanca separada por comas o espacios, p. ej. `BTCUSDT,ETHUSDT`. Vacía = ninguna orden permitida. |
| `SWAL_MAX_NOTIONAL_USD` | herramientas de escritura | — | Nocional máximo por posición (y por grid), en USD. Sin tope no se opera. |
| `SWAL_MAX_LEVERAGE` | no | `1` | Apalancamiento máximo. Entero ≥ 1. |
| `SWAL_MCP_MAX_POSITIONS` | no | `1` | Posiciones abiertas máximas antes de rechazar una entrada nueva. |
| `SWAL_DAILY_LOSS_USD` | `account_risk` y herramientas de escritura | — | Pérdida diaria máxima en USD. Alcanzarla bloquea toda orden nueva (nunca un cierre). |
| `SWAL_MCP_JOURNAL` | no | `~/.swal-trade/journal.jsonl` | Fichero JSONL con una línea por escritura: petición, decisión del guard, respuestas del exchange. |
| `SWAL_WARN_FRACTION` | no | `0.7` | Fracción del límite diario que dispara el aviso `(0, 1]`. |
| `SWAL_TZ_OFFSET_HOURS` | no | `-5` | Zona horaria del día de PnL, de -12 a 14. |
| `SWAL_ANALYSIS_CORE` | no | `../../workers/public-site/static/analisis/analysis-core.js` relativo al paquete | Ruta al módulo que exporta `analyze`. |
| `BINANCE_FUTURES_URL` | no | `https://fapi.binance.com` | Origen HTTPS de las lecturas públicas. **No** afecta a las escrituras: su red la decide `SWAL_MCP_NETWORK`. |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` | no | — | Noticias locales, en ese orden de prueba. |

Las escrituras usan como base `https://testnet.binancefuture.com` por defecto y `https://fapi.binance.com` solo con `SWAL_MCP_NETWORK=mainnet` **y** `SWAL_MCP_MAINNET_CONFIRM=yes`.

## Qué garantiza el guard (`order_guard`)

Puerto a TypeScript de `crates/synapse-core/src/order_guard.rs` (`check_order`) más el kill switch diario de `risk.rs`. Es puro y **falla cerrado**: un número no finito, un tope ilegible o un PnL que no se puede leer rechazan la orden, nunca se interpretan como "sin límite".

1. El símbolo está en `SWAL_MCP_SYMBOLS` (una lista vacía no permite nada).
2. `notional_usd` ≤ `SWAL_MAX_NOTIONAL_USD`.
3. El stop es obligatorio y su distancia cabe dentro de la distancia segura de liquidación (80 % de `100 / apalancamiento`, igual que `propose_order`).
4. `leverage` ≤ `SWAL_MAX_LEVERAGE` (entero ≥ 1).
5. Kill switch diario: si el PnL del día (realizado + no realizado, calculado como en `account_risk`) llega a `-SWAL_DAILY_LOSS_USD`, no hay órdenes nuevas.
6. Posiciones abiertas < `SWAL_MCP_MAX_POSITIONS`, y ninguna posición existente sin `STOP_MARKET`.

Todos los motivos se acumulan y se devuelven juntos, como en la versión Rust.

## Qué hace cada escritura, paso a paso

`place_order` (`{symbol, side, notional_usd, stop_loss_pct, take_profit_pct?, leverage?, type: market|post_only}`):

1. Lee la bandera, los topes y las keys.
2. Comprueba que el journal se puede escribir: sin auditoría no hay orden.
3. Lee la cuenta con los mismos GETs firmados que `account_risk` y pasa el guard.
4. Lee `exchangeInfo` y el mercado, redondea la cantidad a `stepSize` (hacia abajo, nunca por encima) y comprueba `minQty` y `MIN_NOTIONAL`; el stop se alinea a `tickSize` hacia la entrada.
5. Fija apalancamiento y margen aislado en el exchange.
6. Envía la entrada: `MARKET`, o `LIMIT GTX` al mejor bid/ask si `type` es `post_only` (repreciando un tick lejos del libro ante `-5022` o `EXPIRED`, hasta 3 intentos).
7. Envía el stop protector por el Algo Service: `POST /fapi/v1/algoOrder` con `STOP_MARKET`, `closePosition` y `workingType MARK_PRICE`. **Si falla dos veces**, cierra con `MARKET reduceOnly`, cancela las órdenes del símbolo y devuelve error: una posición nunca queda sin stop.
8. Si se pidió `take_profit_pct`, coloca el `TAKE_PROFIT_MARKET` (su fallo no dispara el cierre, se reporta como aviso).

`close_position` (`{symbol}`): MARKET `reduceOnly` por el tamaño de la posición, cancelación de `/fapi/v1/allOpenOrders` y de `/fapi/v1/algoOpenOrders`. **El kill switch diario y el tope de posiciones no aplican**: cerrar es protector y no debe poder quedarse bloqueado.

`grid_plan` (`{symbol, lower, upper, levels, total_notional_usd, stop_loss_price}`): solo lectura. La dirección sale del stop (por debajo del rango = grid largo, por encima = corto), los precios se alinean a `tickSize` y las cantidades a `stepSize`, e informa del peor caso hasta el stop y de los niveles que cruzarían el libro. Devuelve un `plan_id` que `grid_place` acepta.

`grid_place` (`{plan_id}` o los mismos parámetros): el mismo guard y las mismas banderas, las órdenes como `LIMIT GTX` (máximo 20 niveles), un `STOP_MARKET` por debajo o por encima del rango, y el mismo cierre fail-closed si un nivel no puede descansar o el stop falla dos veces.

## Reglas de seguridad

- Nunca hay retiros. Este proceso no tiene tool de retiro ni de transferencia, en ningún modo.
- La key exige permisos mínimos: lectura de futuros USD-M y trading. Sin permiso de retiros.
- Toda orden lleva stop en el exchange (`STOP_MARKET` con `closePosition` por el Algo Service). `propose_order` no devuelve una orden sin stop, y `place_order` no envía una entrada sin su stop.
- El bloqueo por pérdida diaria no se puede saltar desde el agente. No existe ninguna tool que lo desactive.
- El agente explica cada orden antes de enviarla, y la persona configura si exige confirmación. Las descripciones de las tools lo recuerdan.
- Las estrategias y las señales automáticas del laboratorio siguen privadas y no se exponen por este MCP.
- El journal local guarda una línea por escritura con la petición, la decisión del guard y las respuestas del exchange. Ni la key, ni la firma, ni una URL firmada se escriben.

La firma es HMAC-SHA256 sobre el query (`recvWindow` 5000) más el desfase del reloj del servidor; los `POST` llevan el payload en el cuerpo y los `DELETE` en el query. Los errores de red no incluyen el secreto ni el query firmado.

`strength` es calidad del patrón, no una probabilidad. Sin una tabla de acierto medida, el núcleo no inventa porcentajes.

## Desarrollo

```bash
cd packages/mcp
npm install
npm test        # tsc + node --test
npm run build
```

Los tests usan `node:test` y un `fetch` simulado: no llaman a Binance ni a testnet, y no envían ninguna orden real.
