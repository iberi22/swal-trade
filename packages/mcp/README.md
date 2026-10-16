# @swal-trade/mcp

Servidor MCP para swal-trade. Transporte **stdio**. Expone el análisis del núcleo (`analysis-core`), el contexto de mercado y las comprobaciones de riesgo del guardián, propuestas de orden y, **solo si se activan a propósito**, las herramientas de escritura (órdenes y grids) con `order_guard` y journal local.

Licencia: GNU AGPL-3.0 (ver `LICENSE` en la raíz del repositorio). Herramienta autodirigida, no asesoría de inversiones. **El servidor no da estrategia, ni señal, ni recomendación: ejecuta la instrucción explícita que recibe.**

## Úsalo con tu propia herramienta, en local

El servidor habla MCP por stdio: cualquier CLI o editor con soporte MCP lo arranca como un proceso hijo en tu máquina. Tus claves de Binance solo viven en tu entorno local; nada de esto pasa por servidores de SWAL (salvo el explicador y las noticias opcionales, que no llevan claves).

**Hoy, desde un clon del repositorio** (el paquete aún no está publicado en npm):

```bash
git clone https://github.com/iberi22/swal-trade && cd swal-trade/packages/mcp
npm ci && npm run build
```

Después, registra `node /ruta/absoluta/swal-trade/packages/mcp/dist/index.js` en tu herramienta:

| Herramienta | Comando |
|---|---|
| Claude Code | `claude mcp add swal-trade -- node /ruta/packages/mcp/dist/index.js` |
| Codex CLI | `codex mcp add swal-trade -- node /ruta/packages/mcp/dist/index.js` |
| opencode | `opencode mcp add swal-trade -- node /ruta/packages/mcp/dist/index.js` |
| Gemini CLI, Cursor, otros | Añade un servidor `stdio` con `command: node` y `args: ["/ruta/packages/mcp/dist/index.js"]` en su fichero de configuración MCP (en Gemini CLI, `mcpServers` de `~/.gemini/settings.json`). No probado en esta máquina. |

Cuando el paquete esté publicado en npm, sustituye `node /ruta/...` por `npx -y @swal-trade/mcp`. Antes de publicar, ejecuta `npm run build` (compila y copia el núcleo y la licencia al paquete; no depende de ganchos de npm, que muchos entornos desactivan con `ignore-scripts`) y después `node scripts/verify-pack.mjs`, que empaqueta, instala en un directorio vacío y llama a `analyze_chart` desde el paquete instalado (el tarball lleva su propia copia del núcleo de análisis en `core/`).

**Claves.** No las pongas en la configuración de la herramienta (los ficheros de configuración suelen acabar en copias de seguridad y repositorios). Usa un script que lea un fichero `chmod 600` y exporte solo lo necesario, y una clave de Binance **sin permiso de retiro**; para solo lectura basta con la de lectura.

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; . "$HOME/.config/swal-trade/mcp.env"; set +a   # BINANCE_API_KEY, BINANCE_API_SECRET, SWAL_*
exec node /ruta/packages/mcp/dist/index.js
```

**Gráfico de Binance.** Hace falta el demonio `swal-bridge` y la extensión; está explicado en la sección *Claude en tu gráfico* más abajo.

**Qué necesita red.** Las velas y el contexto de mercado salen de la API pública de Binance. El explicador (`explain_analysis`) llama a `trade.swal.network/api/explain` con los hallazgos y sin claves; con `SWAL_EXPLAIN_URL=` vacío funciona sin conexión y devuelve el respaldo determinista.

**Qué no incluye.** Las herramientas `radar_*` hablan con un radar local (`127.0.0.1:47322`) que no forma parte de este repositorio; sin él responden que no está disponible. Ver `docs/OPEN_VS_PRIVATE.md`.

## Estado de las herramientas de escritura (2026-10-11)

`place_order`, `close_position` y `grid_place` están **en desarrollo y no se deben usar con dinero real**. Vienen desactivadas por defecto y apuntan a testnet salvo doble confirmación. Hasta pasar una prueba en testnet, úsalas solo en testnet.

Puntos abiertos de la revisión (rounds 7 y 7b): **ninguno**. Los hallazgos de la última revisión independiente están cerrados:

- una fila ausente en `positionRisk` **no** se lee como “posición plana”: es una lectura no concluyente, falla cerrado y no cancela ninguna orden;
- una reducción fallida del exceso sobre `SWAL_MAX_NOTIONAL_USD` se reporta como aviso, nunca se silencia;
- una entrada post-only sin fill resuelto se cancela **una sola vez** (sin doble `DELETE`);
- el resto en reposo de una entrada post-only parcialmente ejecutada se cancela justo después de armar el stop, y `resting:false` solo se informa con la cancelación confirmada; si ese resto se llenó antes de cancelarse, se relee la posición y se informa el fill real;
- el nocional del cap se deriva de `positionRisk` (`|positionAmt| × markPrice`, exposición bruta por fila, también en modo hedge) cuando la cuenta lo reporta en cero o ausente, y falla cerrado si no puede derivarse;
- hay tests que fijan que un aplanamiento **fallido** del grid deja la intención pendiente (sin `grid_place_outcome`), y el contrapunto con aplanamiento correcto.

## Primera prueba en testnet

Para verificar las herramientas de escritura en Binance Futures Testnet antes de usarlas:

1. **Crear claves de testnet:**
   - Inicia sesión en [https://testnet.binancefuture.com](https://testnet.binancefuture.com) (con cuenta GitHub o email).
   - En el panel inferior, haz clic en **API Key** y genera una clave de prueba.
   - Copia la clave de API y la clave secreta generadas.

2. **Crear el archivo `testnet.env`:**
   Guarda las claves en el archivo dedicado `~/.config/swal-trade/testnet.env` (nunca uses claves reales de mainnet aquí):
   ```bash
   mkdir -p ~/.config/swal-trade
   cat << 'EOF' > ~/.config/swal-trade/testnet.env
   BINANCE_TESTNET_API_KEY=tu_api_key_de_testnet
   BINANCE_TESTNET_API_SECRET=tu_api_secret_de_testnet
   EOF
   chmod 600 ~/.config/swal-trade/testnet.env
   ```

3. **Ejecutar el smoke test (un solo comando):**
   Desde la raíz del repositorio:
   ```bash
   node packages/mcp/scripts/testnet-smoke.mjs
   ```
   Para validar herramientas y lecturas de cuenta sin enviar órdenes, usa el modo dry-run:
   ```bash
   node packages/mcp/scripts/testnet-smoke.mjs --dry
   ```
   El smoke test ejecuta: `account_risk` → `place_order` (tamaño mínimo con stop de protección ~1.5%) → verificación de posición y stop con `account_risk` → `close_position` → verificación de cuenta plana. Registra cada paso en el journal (`/tmp/swal-testnet-journal.jsonl`). Si ocurre cualquier estado inesperado, ejecuta un cierre de emergencia y alerta con `MANUAL ACTION REQUIRED`.

4. **Registrar el wrapper de testnet en Claude Code:**
   Para disponer de las herramientas de escritura en un entorno aislado de testnet dentro de Claude Code:
   ```bash
   claude mcp add --scope user swal-trade-testnet -- packages/mcp/scripts/swal-trade-mcp-testnet.sh
   ```
   El wrapper carga únicamente `~/.config/swal-trade/testnet.env`, fuerza `SWAL_MCP_TRADING=enabled` y `SWAL_MCP_NETWORK=testnet`, desactiva cualquier confirmación de mainnet y aplica límites conservadores (nocional 60 USD, porque BTCUSDT exige al menos 50 en testnet; apalancamiento 2; pérdida diaria 10 USD).


## Tools

| Tool | Tipo | Qué hace |
|---|---|---|
| `analyze_chart` | lectura | Velas públicas de `fapi` y hallazgos del núcleo, ordenados por fuerza. La fuerza es calidad del patrón, no probabilidad. |
| `explain_analysis(symbol, timeframe)` | lectura | Analiza el gráfico con el mismo núcleo y pide al endpoint alojado `POST /api/explain` una explicación en español sencillo de los patrones principales: qué significan, qué los confirmaría o invalidaría y qué riesgo manejar. Sin `SWAL_EXPLAIN_URL`, sin red o con error del hosting devuelve el respaldo determinista construido con los mismos hallazgos. |
| `market_context` | lectura | Tendencia en 1m, 5m, 1h y 4h (si el núcleo está), miedo y codicia (caché 1 h) y titulares. |
| `account_risk` | lectura | GETs firmados de solo lectura y las comprobaciones del guardián. |
| `propose_order` | lectura | Cantidad redondeada a `stepSize` y comprobada contra `minQty` y `MIN_NOTIONAL`, stop y violaciones. No envía nada. |
| `grid_plan` | lectura | Plan de grid: precio por nivel, cantidad por nivel, peor pérdida hasta el stop y niveles que no podrían descansar como post-only. **Siempre disponible**, no necesita keys. |
| `place_order` | escritura | Una orden de entrada más el `STOP_MARKET` obligatorio por el Algo Service. Requiere la bandera. |
| `close_position` | escritura | MARKET `reduceOnly` y cancelación de las órdenes y órdenes algo del símbolo. Requiere la bandera. |
| `grid_place` | escritura | El grid como órdenes límite post-only más un stop protector. Requiere la bandera. |
| `radar_alerts` | lectura | Lista compacta y validada de alertas del radar local con métricas hacia adelante. |
| `radar_stats` | lectura | Resumen estadístico del radar local con intervalos Wilson y nota de honestidad. |
| `radar_mark_taken` | nota local | Registra si el usuario tomó un alerta y nota (≤ 200 caracteres) en el radar local. No envía órdenes. |

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
| `SWAL_MCP_JOURNAL` | no | `~/.swal-trade/journal.jsonl` | Fichero JSONL con una línea por escritura: petición, decisión del guard, respuestas del exchange. Tiene que ser un fichero regular **escribible** (la comprobación es un append real, no el permiso del directorio): si no, no se envía nada. |
| `SWAL_MCP_STARTUP_FLATTEN` | no | sin valor | Con `yes`, el barrido de arranque aplana las posiciones huérfanas que encuentre. Sin él, solo las informa. |
| `SWAL_WARN_FRACTION` | no | `0.7` | Fracción del límite diario que dispara el aviso `(0, 1]`. |
| `SWAL_TZ_OFFSET_HOURS` | no | `-5` | Zona horaria del día de PnL, de -12 a 14. |
| `SWAL_ANALYSIS_CORE` | no | `../../workers/public-site/static/analisis/analysis-core.js` relativo al paquete | Ruta al módulo que exporta `analyze`. |
| `SWAL_EXPLAIN_URL` | no | `https://trade.swal.network/api/explain` | Endpoint alojado del explicador. Solo HTTPS. Vacío = modo offline: `explain_analysis` devuelve el respaldo determinista y no abre conexión. |
| `SWAL_EXPLAIN_TIMEOUT_MS` | no | `20000` | Tiempo de espera del explicador alojado (máximo 60000). |
| `BINANCE_FUTURES_URL` | no | `https://fapi.binance.com` | Origen HTTPS de las lecturas públicas. **No** afecta a las escrituras: su red la decide `SWAL_MCP_NETWORK`. |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` | no | — | Noticias locales, en ese orden de prueba. |

Las escrituras usan como base `https://testnet.binancefuture.com` por defecto y `https://fapi.binance.com` solo con `SWAL_MCP_NETWORK=mainnet` **y** `SWAL_MCP_MAINNET_CONFIRM=yes`. Lecturas y escrituras derivan la red del **mismo** parse (`readNetwork`): `grid_plan` y el barrido de arranque usan esa base y ninguna otra, así que un plan nunca se tarifa contra una red distinta de la que se coloca.

## Qué garantiza el guard (`order_guard`)

`explain_analysis` no envía órdenes ni promete resultados. El resultado lleva `source` (`ai` o `fallback`), `disclaimer` y `caution`: la fuerza del patrón no es una probabilidad y la tasa de acierto histórica no está medida. El prompt del servicio alojado es público (`workers/public-site/src/explain-prompt.js`); este paquete solo replica el respaldo determinista, igual que hace con las noticias.

`news` prueba las claves en este orden: `BRAVE_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`. La primera que devuelve titulares gana. Si no hay claves, o ninguna devuelve titulares, se consulta `https://trade.swal.network/api/news`. Si tampoco hay nada, `news` es null y la nota es `requires local backend news source or Socio SWAL`. El tono de cada titular es un léxico de palabras (heurística, no asesoría).

Puerto a TypeScript de `crates/synapse-core/src/order_guard.rs` (`check_order`) más el kill switch diario de `risk.rs`. Es puro y **falla cerrado**: un número no finito, un tope ilegible o un PnL que no se puede leer rechazan la orden, nunca se interpretan como "sin límite".

1. El símbolo está en `SWAL_MCP_SYMBOLS` (una lista vacía no permite nada).
2. `notional_usd` ≤ `SWAL_MAX_NOTIONAL_USD`.
3. El stop es obligatorio y su distancia cabe dentro de la distancia segura de liquidación (80 % de `100 / apalancamiento`, igual que `propose_order`).
4. `leverage` ≤ `SWAL_MAX_LEVERAGE` (entero ≥ 1).
5. Kill switch diario: si el PnL del día (realizado + no realizado **negativo**, calculado como en `account_risk`) llega a `-SWAL_DAILY_LOSS_USD`, no hay órdenes nuevas.
6. El nocional se compara con la exposición del símbolo: sus posiciones más sus órdenes de entrada en reposo más sus órdenes algo que abren exposición. Para un grid, la exposición que añade es el `total_notional_usd` completo, no la de un solo nivel.
6. Posiciones abiertas < `SWAL_MCP_MAX_POSITIONS`, y ninguna posición existente sin `STOP_MARKET`.

Todos los motivos se acumulan y se devuelven juntos, como en la versión Rust.

## Qué hace cada escritura, paso a paso

`place_order` (`{symbol, side, notional_usd, stop_loss_pct, take_profit_pct?, leverage?, type: market|post_only}`):

1. Lee la bandera, los topes y las keys.
2. Comprueba que el journal se puede escribir: sin auditoría no hay orden.
3. Lee la cuenta con los mismos GETs firmados que `account_risk` y pasa el guard.
4. Lee `exchangeInfo` y el mercado, redondea la cantidad a `stepSize` (hacia abajo, nunca por encima) y comprueba `minQty` y `MIN_NOTIONAL`; el stop se alinea a `tickSize` hacia la entrada.
5. Fija apalancamiento y margen aislado en el exchange.
6. **Después** de fijar el apalancamiento, lee la estimación de liquidación del exchange y comprueba que el stop cabe dentro de ella. Leerla antes usaría la liquidación del apalancamiento anterior, que no es el de esta orden.
7. Escribe en el journal una línea de **intención** antes de enviar y una de **resultado** después, con el `clientOrderId` de la orden.
8. Envía la entrada: `MARKET`, o `LIMIT GTX` al mejor bid/ask si `type` es `post_only` (repreciando un tick lejos del libro ante `-5022` o `EXPIRED`, hasta 3 intentos; una respuesta con `executedQty` cuenta como fill, aunque venga con `EXPIRED`).
9. Una respuesta ambigua (timeout, conexión cortada, 5xx) **no es un rechazo**: la orden se busca por `origClientOrderId` y se lee la posición neta. Si hubo fill, se protege; si no, se informa como no confirmada. Nunca se reintenta a ciegas.
10. Envía el stop protector por el Algo Service: `POST /fapi/v1/algoOrder` con `algoType CONDITIONAL`, **`triggerPrice`** (nunca `price`), `workingType MARK_PRICE`, `priceProtect TRUE` y `closePosition`. Solo cuenta como colocado si la respuesta trae `algoId` **y** un trigger del lado de la pérdida. **Si falla dos veces**, aplana la posición y solo entonces cancela: una posición nunca queda sin stop.
11. Si se pidió `take_profit_pct`, coloca el `TAKE_PROFIT_MARKET` con las mismas reglas (su fallo no dispara el cierre, se reporta como aviso).
12. Tras el fill, el nocional real es `avgPrice * executedQty`. Si supera `SWAL_MAX_NOTIONAL_USD` en más de un 1 %, el exceso se reduce con una orden `reduceOnly` y se informa.

El stop se comprueba además contra la estimación de liquidación del exchange (`liquidationPrice` de `positionRisk` **después de fijar el apalancamiento**, o el `maintMarginRatio` de `leverageBracket`), no solo contra `100 / apalancamiento`.

`close_position` (`{symbol}`): netea **todas** las filas de `positionRisk` del símbolo (modo one-way `BOTH`, o hedge `LONG` + `SHORT`), cierra el neto con MARKET `reduceOnly` redondeado **hacia arriba** a `stepSize`, lo vuelve a leer y repite hasta que el neto sea cero. Solo entonces cancela `/fapi/v1/allOpenOrders` y `/fapi/v1/algoOpenOrders`: si la posición sigue abierta no cancela nada, porque dejaría una posición viva sin stop. **El kill switch diario, el tope de posiciones, el tope de nocional y la lista blanca no aplican**: cerrar es protector y no debe poder quedarse bloqueado. Usa `parseCloseConfig`, así que un `SWAL_MAX_NOTIONAL_USD` ausente o una `SWAL_MCP_SYMBOLS` vacía no pueden atrapar una posición abierta. Como `place_order`, escribe una línea de **intención** antes de la primera orden de cierre y una de **resultado** después: un cierre que muere a la mitad deja una posición abierta y un intent sin resultado, que es lo que el barrido de arranque busca.

**Barrido de arranque.** Antes de cada escritura se lee el journal y se buscan las líneas de intención sin su línea de resultado: son escrituras cuya respuesta nunca llegó. Para cada una se pregunta al exchange por la posición neta; si está abierta se informa como **sin protección** en el resultado y en las notas. Solo se aplana si `SWAL_MCP_STARTUP_FLATTEN=yes`, porque cerrar una posición que el operador pueda haber cerrado a propósito no es una decisión que tome el barrido.

`grid_plan` (`{symbol, lower, upper, levels, total_notional_usd, stop_loss_price}`): solo lectura. La dirección sale del stop (por debajo del rango = grid largo, por encima = corto), los precios se alinean a `tickSize` y las cantidades a `stepSize`, e informa del peor caso hasta el stop y de los niveles que cruzarían el libro. Devuelve un `plan_id` que `grid_place` acepta. **Un nivel que no puede alinearse a `tickSize` o cuya cantidad se redondea a cero hace fallar el plan entero**: la escalera que se coloca es siempre la que se pidió, nunca una más pequeña con un aviso.

`grid_place` (`{plan_id}` o los mismos parámetros): el mismo guard y las mismas banderas, las órdenes como `LIMIT GTX` (máximo 20 niveles), un `STOP_MARKET` por debajo o por encima del rango, y el mismo cierre fail-closed si un nivel no puede descansar o el stop falla dos veces. Un nivel solo cuenta como colocado si la respuesta es `NEW`; una respuesta `EXPIRED`/`-5022` con `executedQty` es un fill; solo se reprecian las respuestas repreciables; una repreciación nunca cruza el stop; y ante un timeout se busca la orden por `clientOrderId` antes de reintentar nada. Antes del primer nivel escribe una línea de **intención** con la escalera completa (nivel, lado, precio y cantidad) y una de **resultado** al terminar: un proceso que muere entre dos niveles deja órdenes en reposo y el registro final nunca existe.

`grid_plan` rechaza (no fusiona) dos niveles que caen en el mismo tick, porque serían una sola orden del doble del tamaño. La distancia del stop y la comprobación de liquidación se miden desde el **peor nivel** (el más cercano al stop), no desde la entrada media. Como en `place_order`, la estimación de liquidación del grid se lee **después** de fijar el apalancamiento: `positionRisk` solo informa `liquidationPrice` para el apalancamiento vigente.


## Claude en tu gráfico

Permite que un agente local de IA (como Claude Code conectado a este servidor MCP) lea el estado del gráfico abierto en el navegador y dibuje niveles, zonas, líneas de tendencia y flechas sobre el gráfico de TradingView de Binance Futures mediante la extensión de navegador SWAL Trade.

### Arquitectura de servicio único y modo cliente

Para evitar colisiones de puerto cuando varias sesiones de Claude Code (o sus subagentes) se ejecutan concurrentemente, la conexión con la extensión está desacoplada en un servicio local siempre activo:

1. **Servicio demonio (`swal-bridge`)**:
   - Escucha en `127.0.0.1:47321` para la conexión WebSocket única de la extensión de navegador.
   - Expone una API de control HTTP local en `127.0.0.1:47330` (autenticada mediante el encabezado `X-Bridge-Token` con el token de `~/.config/swal-trade/chart-bridge-token`).
   - Se mantiene siempre en ejecución como servicio de usuario en systemd o mediante `npm run bridge`.

2. **Modo cliente en MCP (`SWAL_MCP_CHART_BRIDGE=client`)**:
   - Es el **modo predeterminado y recomendado** para los usuarios.
   - Cada proceso MCP invocado por Claude Code actúa como cliente HTTP ligero de la API de control.
   - **No abre ni vincula ningún puerto local**: múltiples sesiones de Claude Code y subagentes concurrentes pueden consultar y pintar en el mismo gráfico simultáneamente sin conflictos de `EADDRINUSE`.
   - Si el servicio no está corriendo, las herramientas devuelven un error claro en español: `"servicio swal-bridge apagado: systemctl --user start swal-bridge"`.
   - El modo embebido `SWAL_MCP_CHART_BRIDGE=enabled` se mantiene disponible para retrocompatibilidad y suites de pruebas aisladas.

### Cómo activarlo

1. **Instalar e iniciar el servicio demonio**:
   ```bash
   # Copiar el servicio systemd de usuario
   mkdir -p ~/.config/systemd/user
   cp scripts/swal-bridge.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now swal-bridge

   # Verificar estado:
   systemctl --user status swal-bridge
   ```
   *(Alternativa manual sin systemd: `npm run bridge` o `npx swal-bridge`)*.

2. **Configurar el servidor MCP en modo cliente**:
   Define la variable de entorno en tu wrapper o configuración MCP:
   ```bash
   export SWAL_MCP_CHART_BRIDGE=client
   # Opcional (puerto de control por defecto 47330):
   # export SWAL_BRIDGE_CONTROL_PORT=47330
   ```

3. **Token de emparejamiento**:
   Al iniciar por primera vez, el demonio genera un token criptográfico seguro (32 bytes aleatorios en base64url) en:
   ```bash
   ~/.config/swal-trade/chart-bridge-token
   ```
   El archivo se crea con permisos restrictivos `0600` (solo legible por tu usuario local).

4. **En la extensión de navegador**:
   - Abre el panel lateral de la extensión SWAL Trade en tu navegador.
   - Despliega la sección **Ajustes**.
   - Activa el interruptor **"Permitir que Claude use el gráfico"**.
   - Copia el token de `~/.config/swal-trade/chart-bridge-token` y pégalo en el campo "Token de emparejamiento" (el campo lo mantiene enmascarado).
   - El indicador cambiará a **"Claude conectado"** (punto verde).

### Cómo varias sesiones de Claude comparten un mismo gráfico

Cada sesión de Claude Code —incluyendo subagentes lanzados en paralelo— ejecuta su propio proceso MCP con `SWAL_MCP_CHART_BRIDGE=client`. Dado que los clientes MCP solo realizan peticiones HTTP locales hacia el demonio `swal-bridge` y leen el token en cada llamada:
- Ninguna sesión MCP compite por el puerto del navegador.
- El navegador mantiene una única conexión WebSocket estable con el demonio local.
- Todas las sesiones pueden solicitar el estado del gráfico (`chart_state`) y pintar formas (`chart_paint`) sobre la misma pestaña activa.

### Las cuatro herramientas MCP

Cuando `SWAL_MCP_CHART_BRIDGE=client` (o `enabled`), se registran automáticamente 4 herramientas:

- `chart_state`: devuelve el estado actual del gráfico (`{ connected, symbol, timeframe, paintEnabled, tabUrlHost }`).
- `chart_paint({ shapes })`: valida y dibuja formas en el gráfico de Binance abierto. Se validan con los mismos límites que la extensión (máximo 30 formas, texto ≤ 60 caracteres, marcas de tiempo y precios finitos y positivos). Todas las formas dibujadas por Claude llevan automáticamente el prefijo visual distintivo `"IA:"`.
- `chart_clear`: borra inmediatamente las formas que el puente dibujó en el gráfico.
- `chart_set_timeframe({ timeframe })`: solicita cambiar la temporalidad del gráfico (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`).

### Modelo de seguridad

- **Solo local**: tanto el servidor WebSocket (`127.0.0.1:47321`) como la API de control HTTP (`127.0.0.1:47330`) se vinculan estrictamente a `127.0.0.1` (localhost). No escuchan en interfaces externas ni exponen puertos a la red.
- **Sin encabezados CORS**: la API de control HTTP no incluye encabezados CORS, bloqueando solicitudes iniciadas por sitios web desde navegadores.
- **Autenticación con token**: tanto el WebSocket como la API de control requieren el token de emparejamiento. Las comparaciones se ejecutan en tiempo constante (`crypto.timingSafeEqual`) contra ataques de temporización.
- **Límite de cuerpo**: la API de control y el WebSocket rechazan cualquier carga útil que supere los 64 KB (`413 Payload Too Large`).
- **Validación de Origin**: el WebSocket rechaza conexiones cuyo encabezado `Origin` no provenga de una extensión de navegador (`chrome-extension://` o `moz-extension://`).
- **Un solo cliente de extensión activo**: solo se admite una extensión conectada a la vez en el demonio.
- **Solo lectura y dibujo — nunca trading**: el puente no tiene acceso a cookies, credenciales, órdenes, balances ni DOM de cuentas. Solo reenvía formas geométricas de análisis y lee el símbolo/temporalidad activa.
- **Tiempo de espera**: las peticiones tienen un timeout estricto de 5 segundos; si la extensión o la pestaña no responden, devuelven un error limpio y explicativo.

## Radar local

Permite a Claude u otros clientes MCP consultar los experimentos de entrada detectados por el servicio local `swal-radar`, revisar su evolución hacia adelante (forward outcomes) y registrar si el usuario tomó un alerta.

Las herramientas de radar están siempre registradas (modo solo lectura + notas locales), independientemente de `SWAL_MCP_TRADING`.

> **El servicio `swal-radar` no forma parte de este repositorio**: vive en el repositorio privado del laboratorio. Estas herramientas solo hablan con él; sin él devuelven `radar local apagado`. Ver `docs/OPEN_VS_PRIVATE.md`.

### Herramientas

- `radar_alerts({ status, symbol, limit })`: devuelve una lista compacta y validada de alertas (`id`, `symbol`, `tf`, `direction`, `title`, `entry`, `stop`, `target_1r`, `target_2r`, `strength`, `status`, `outcomes`, `taken_by_user`). Admite filtro por estado (`active`, `resolved`, `all`), símbolo y límite (1..100, por defecto 20).
- `radar_stats()`: estadísticas generales, por tipo de patrón y de alertas tomadas por el usuario, acompañadas de la nota de honestidad del radar. Si `n < 30`, el texto indica explícitamente `"sin evidencia (n<30)"`.
- `radar_mark_taken({ alert_id, taken, note })`: registra si el usuario tomó el alerta y una nota opcional (≤ 200 caracteres) mediante `POST /v1/alerts/<id>/note` autenticado con `X-Radar-Token`.

### Nota de honestidad y modelo de seguridad

- **Experimentos, no señales**: cada alerta es un experimento medido hacia adelante; nuestro backtest no halló evidencia de superar el azar. No constituyen recomendaciones de trading.
- **Solo local**: se conecta a `http://127.0.0.1:47322` por defecto (o `SWAL_RADAR_URL` si apunta a `http://127.0.0.1` o `http://localhost`). Cualquier URL no local es rechazada de inmediato.
- **Token protegido**: el token vive en `~/.config/swal-trade/radar-token` (permisos 0600). Se lee en tiempo de llamada y nunca se imprime ni se expone en salidas de herramientas ni mensajes de error.
- **Tolerancia y fallos limpios**: timeouts estrictos de 4 segundos. Si el servicio radar está apagado, devuelve `radar local apagado: systemctl --user start swal-radar`.

## Reglas de seguridad

- Nunca hay retiros. Este proceso no tiene tool de retiro ni de transferencia, en ningún modo.
- La key exige permisos mínimos: lectura de futuros USD-M y trading. Sin permiso de retiros.
- Toda orden lleva stop en el exchange (`STOP_MARKET` con `closePosition` por el Algo Service). `propose_order` no devuelve una orden sin stop, y `place_order` no envía una entrada sin su stop.
- El bloqueo por pérdida diaria no se puede saltar desde el agente. No existe ninguna tool que lo desactive. Cuenta el PnL realizado del día más **solo el no realizado negativo**, posición a posición: un ganador de +400 no tapa un perdedor de -120.
- Las tres herramientas de escritura llevan `destructiveHint: true`. Se ejecutan dentro de un mutex de proceso, y los topes incluyen las órdenes que ya descansan en el símbolo (las de entrada suman exposición; las `reduceOnly`/`closePosition` no).
- Las herramientas de lectura usan la misma base que las de escritura cuando `SWAL_MCP_TRADING=enabled`: una orden se explica contra la red a la que se envía.
- El agente explica cada orden antes de enviarla, y la persona configura si exige confirmación. Las descripciones de las tools lo recuerdan.
- Las estrategias y las señales automáticas del laboratorio siguen privadas y no se exponen por este MCP.
- El journal local guarda una línea por escritura con la petición, la decisión del guard y las respuestas del exchange, más una línea de intención antes de cada envío y su resultado. Ni la key, ni la firma, ni una URL firmada se escriben. La comprobación previa abre el fichero en modo append: un journal de solo lectura detiene la escritura antes de que se envíe nada, no después.

La firma es HMAC-SHA256 sobre el query (`recvWindow` 15000) más el desfase del reloj del servidor; los `POST` llevan el payload en el cuerpo y los `DELETE` en el query. Los errores de red no incluyen el secreto ni el query firmado.

`strength` es calidad del patrón, no una probabilidad. Sin una tabla de acierto medida, el núcleo no inventa porcentajes.

## Desarrollo

```bash
cd packages/mcp
npm install
npm test        # tsc + node --test
npm run build
```

Los tests usan `node:test` y un `fetch` simulado: no llaman a Binance ni a testnet, y no envían ninguna orden real.
