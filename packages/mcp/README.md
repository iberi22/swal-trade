# @swal-trade/mcp

Servidor MCP de **solo lectura** para swal-trade. Transporte **stdio**. Expone el análisis del núcleo (`analysis-core`), el contexto de mercado y las mismas comprobaciones de riesgo que el guardián. No envía órdenes.

Licencia: GNU AGPL-3.0 (ver `LICENSE` en la raíz del repositorio). Herramienta autodirigida, no asesoría de inversión.

## Registro en Claude Code

Publicado (cuando el paquete esté en el registro):

```bash
claude mcp add swal-trade -- npx -y @swal-trade/mcp
```

Variante de desarrollo local, desde la raíz del repo, después de `npm run build` en `packages/mcp`:

```bash
claude mcp add swal-trade -- node packages/mcp/dist/index.js
```

El binario del paquete es `swal-trade-mcp` (`node packages/mcp/dist/index.js`).

## Tools

| Tool | Lectura | Qué hace |
|---|---|---|
| `analyze_chart` | sí | Velas públicas de `fapi` y hallazgos del núcleo, ordenados por fuerza. La fuerza es calidad del patrón, no probabilidad. |
| `explain_analysis(symbol, timeframe)` | sí | Analiza el gráfico con el mismo núcleo y pide al endpoint alojado `POST /api/explain` una explicación en español sencillo de los patrones principales: qué significan, qué los confirmaría o invalidaría y qué riesgo manejar. Sin `SWAL_EXPLAIN_URL`, sin red o con error del hosting devuelve el respaldo determinista construido con los mismos hallazgos. |
| `market_context` | sí | Tendencia en 1m, 5m, 1h y 4h (si el núcleo está), miedo y codicia (caché 1 h) y titulares. |
| `account_risk` | sí | GETs firmados de solo lectura y las comprobaciones del guardián. |
| `propose_order` | sí | Cantidad, stop y violaciones. No envía nada. |

No hay `place_order`, `grid_plan`, `grid_place` ni ninguna tool de escritura en este build. Order placement tools are disabled in this build.

## Variables de entorno

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `BINANCE_API_KEY` | solo `account_risk` | — | Key de futuros. Permiso de lectura. Sin retiros. |
| `BINANCE_API_SECRET` | solo `account_risk` | — | Secreto HMAC-SHA256. No se imprime. |
| `SWAL_DAILY_LOSS_USD` | sí para `account_risk` | — | Pérdida diaria máxima en USD (número > 0). |
| `SWAL_MAX_LEVERAGE` | no | sin tope | Apalancamiento máximo. |
| `SWAL_MAX_NOTIONAL_USD` | no | sin tope | Nocional máximo por posición, en USD. |
| `SWAL_WARN_FRACTION` | no | `0.7` | Fracción del límite diario que dispara el aviso `(0, 1]`. |
| `SWAL_TZ_OFFSET_HOURS` | no | `-5` | Zona horaria del día de PnL, de -12 a 14. |
| `SWAL_ANALYSIS_CORE` | no | `../../workers/public-site/static/analisis/analysis-core.js` relativo al paquete | Ruta al módulo que exporta `analyze`. |
| `SWAL_EXPLAIN_URL` | no | `https://trade.swal.network/api/explain` | Endpoint alojado del explicador. Solo HTTPS. Vacío = modo offline: `explain_analysis` devuelve el respaldo determinista y no abre conexión. |
| `SWAL_EXPLAIN_TIMEOUT_MS` | no | `20000` | Tiempo de espera del explicador alojado (máximo 60000). |
| `BINANCE_FUTURES_URL` | no | `https://fapi.binance.com` | Origen HTTPS del futuro USD-M. |
| `BRAVE_API_KEY` | no | — | Noticias locales: Brave News Search (`X-Subscription-Token`). Primera opción. |
| `TAVILY_API_KEY` | no | — | Noticias locales: Tavily `POST /search` con `topic: news` y `Authorization: Bearer`. Segunda opción. |
| `FIRECRAWL_API_KEY` | no | — | Noticias locales: Firecrawl `POST /v2/search` con `sources: ["news"]`. Tercera opción. |

`propose_order` lee los topes de nocional y apalancamiento, pero no consulta el PnL del día: ese chequeo es de `account_risk` (`dailyLossEvaluated: false`).

Si el núcleo no está en disco, `analyze_chart` responde `analysis core not available` y `market_context` deja la tendencia en null con el mismo texto.

`explain_analysis` no envía órdenes ni promete resultados. El resultado lleva `source` (`ai` o `fallback`), `disclaimer` y `caution`: la fuerza del patrón no es una probabilidad y la tasa de acierto histórica no está medida. El prompt del servicio alojado es público (`workers/public-site/src/explain-prompt.js`); este paquete solo replica el respaldo determinista, igual que hace con las noticias.

`news` prueba las claves en este orden: `BRAVE_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`. La primera que devuelve titulares gana. Si no hay claves, o ninguna devuelve titulares, se consulta `https://trade.swal.network/api/news`. Si tampoco hay nada, `news` es null y la nota es `requires local backend news source or Socio SWAL`. El tono de cada titular es un léxico de palabras (heurística, no asesoría).

## Reglas de seguridad

Tomadas de la decisión 4 en `docs/ARCHITECTURE_ANALYSIS_EXTENSION_MCP.md`:

- Nunca hay retiros. Este proceso no tiene tool de retiro ni de transferencia.
- La key exige permisos mínimos: lectura de futuros USD-M. Sin permiso de retiro. En este build tampoco hace falta permiso de trading, porque no se envía ninguna orden.
- Toda orden propuesta lleva stop en el exchange (`STOP_MARKET` con `closePosition`). `propose_order` no devuelve una orden sin stop.
- El bloqueo por pérdida diaria no se puede saltar desde el agente. `account_risk` lo informa (`daily_hit`) y no existe una tool que lo desactive.
- El agente explica cada orden antes de enviarla, y la persona configura si exige confirmación. Aquí el envío está desactivado: la propuesta vuelve con `sent: false`.
- Las estrategias y las señales automáticas del laboratorio siguen privadas y no se exponen por este MCP.

La firma es HMAC-SHA256 sobre el query (`recvWindow` 5000) más el desfase del reloj del servidor. Solo `GET`. Los errores de red no incluyen el secreto ni el query firmado.

`strength` es calidad del patrón, no una probabilidad. Sin una tabla de acierto medida, el núcleo no inventa porcentajes.

## Desarrollo

```bash
cd packages/mcp
npm install
npm test
npm run build
```

Los tests usan `node:test` y un `fetch` simulado. No llaman a Binance ni a Alternative.me.
