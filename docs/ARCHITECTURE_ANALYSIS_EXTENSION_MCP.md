# Arquitectura: núcleo de análisis, extensión de navegador, backend local y MCP

Estado: propuesta del 2026-10-09 (ver ADR-007 en `docs/SWAL/` del laboratorio). Licencia: AGPL-3.0.

## Objetivo

Una herramienta que marca y explica sobre el gráfico de precios los patrones que el usuario no ve, desde 1 minuto en adelante. Primero muestra los patrones con más fuerza. La usan, con la misma lógica:

- una **página web** (`/analisis/`),
- una **extensión de navegador** sobre Binance y TradingView,
- un **backend local** que corre el usuario técnico con sus propias keys,
- un **servidor MCP**, para que cualquier agente (Claude Code, etc.) consulte el análisis y, opcionalmente, opere con límites de seguridad.

## Decisión 1: un solo núcleo determinista en TypeScript/JS

`analysis-core` (hoy `workers/public-site/static/analisis/analysis-core.js`) es un paquete puro, sin DOM. Recibe velas y devuelve hallazgos estructurados: tipo, explicación, niveles, tiempos, fuerza y evidencia. Lo importan la web, la extensión, el backend local y el MCP. **Una implementación, cuatro superficies.**

- **Por qué no Rust/WASM ahora:** el navegador y Node ejecutan JS nativo, y un segundo lenguaje duplicaría el build. `synapse-core` (Rust) sigue a cargo del riesgo y del `order_guard`. Si algún detector necesita rendimiento, se porta a WASM detrás de la misma interfaz.
- **Por qué no Python en producto:** según la regla del laboratorio, Python es para *tunear y medir*. Los backtests que calculan la tasa histórica de acierto de cada patrón corren en `py_engine` sobre datos grabados. El resultado se publica como una tabla versionada (`hit-rates.json`) que el núcleo lee. Sin medición, el núcleo dice "sin medición histórica" y **no inventa porcentajes**.

## Decisión 2: la extensión con WXT + Svelte 5, no con Astro

| Opción | Veredicto |
|---|---|
| **Astro** | No. Genera sitios estáticos e islas; no modela las piezas de una extensión MV3 (service worker de fondo, content scripts, side panel, permisos de host). Sigue siendo bueno para la web y la PWA. |
| **Vite + Svelte "a mano"** | Funciona, pero el manifest, la recarga y los builds para Chrome y Firefox quedan a nuestro cargo. |
| **WXT + Svelte 5 + TypeScript** (recomendado) | Framework de extensiones sobre Vite con módulo oficial de Svelte. Genera el manifest MV3 y los builds de Chrome, Edge y Firefox, y tiene HMR. Mantiene el mismo stack de UI que el dashboard (Svelte 5). |
| CRXJS (plugin Vite) | Alternativa válida, con menos soporte multi-navegador que WXT. |

**Piezas de la extensión:**

- **Content script** en `binance.com/*/futures/*` y `tradingview.com/chart/*`: detecta el símbolo y la temporalidad (URL y DOM) y los envía al panel. No lee datos de la cuenta.
- **Side panel**: gráfico propio con TradingView Lightweight Charts (Apache-2.0), con la misma lógica visual que Binance y TradingView, y los overlays del núcleo. Pintar *encima* del gráfico nativo (iframe cross-origin con la escala de precios no expuesta) queda como experimento posterior.
- **Background service worker**: WebSocket de Binance, caché de velas y alarmas.
- **Permisos mínimos:** `sidePanel`, `storage` y host permissions solo para Binance, TradingView y `fapi/fstream`. Las keys del usuario, si las pone, se guardan como `CryptoKey` no extraíble, igual que en `/guardian/`.

## Decisión 3: el backend local es opcional y gratis para usuarios técnicos

Es un proceso Node (`npx swal-trade serve`) o Docker que corre en el PC del usuario, con sus propias keys de Binance y sus propios tokens de IA (Anthropic, OpenAI, OpenRouter u Ollama). Añade lo que el navegador solo no puede hacer bien:

- vigilancia 24/7 (el guardián self-host ya existe en `scripts/guardian/`);
- agregación de noticias;
- análisis multi-símbolo en segundo plano;
- el servidor MCP.

**Socio SWAL (USD 10)** cubre lo mismo **alojado** (modelos SWAL en Cloudflare Workers AI, noticias, miedo/codicia, tendencias y alertas), más el respaldo de datos cifrado de extremo a extremo. Todo lo demás es gratis.

## Decisión 4: servidor MCP (`swal-trade-mcp`)

Usa TypeScript con `@modelcontextprotocol/sdk` y transporte **stdio** (local). Se registra en Claude Code con `claude mcp add swal-trade -- npx swal-trade mcp`.

| Tool | Tipo | Notas |
|---|---|---|
| `analyze_chart(symbol, timeframe)` | lectura | Hallazgos del núcleo, ordenados por fuerza, con explicación |
| `market_context(symbol)` | lectura | Tendencia multi-timeframe, miedo/codicia, liquidaciones recientes, noticias (si hay backend o Socio) |
| `explain_analysis(symbol, timeframe)` | lectura | Ejecuta el mismo análisis que `analyze_chart` y pide al endpoint alojado `POST /api/explain` (Workers AI) una explicación en palabras llanas de los patrones principales: qué significan, qué los confirmaría o invalidaría y qué riesgo manejar. Sin `SWAL_EXPLAIN_URL` o si el hosting falla, devuelve el respaldo determinista. El modelo no da órdenes ni promete resultados |
| `account_risk()` | lectura | Lo mismo que el guardián: PnL del día contra el límite, apalancamiento, nocional, posiciones sin stop |
| `propose_order(...)` | lectura | Devuelve la orden con stop obligatorio, tamaño y la validación del `order_guard`, **sin enviarla** |
| `place_order(...)`, `grid_plan(...)`, `grid_place(...)` | escritura | **Desactivadas por defecto.** Solo con `SWAL_MCP_TRADING=enabled` y límites del usuario en su config local: nocional máximo, apalancamiento máximo, stop obligatorio, bloqueo por pérdida diaria, lista de símbolos. Toda orden pasa por `order_guard` (synapse-core) y queda en un journal local. |

**Reglas no negociables del explicador (`explain_analysis`, endpoint alojado en `workers/public-site`):**

- el sistema es determinista y manda; el modelo solo explica. Ninguna decisión de entrada, tamaño o stop sale del modelo;
- el prompt es público (AGPL) y está fijado en `workers/public-site/src/explain-prompt.js`: español sencillo, nada de promesas de rentabilidad, nada de órdenes de compra/venta, y decir cuándo los patrones se contradicen;
- la salida se valida y se repara (`{summary, scenarios[], caution}`); si el JSON no se puede reparar o aparece una frase prohibida, se devuelve la explicación determinista construida desde los hallazgos;
- abusos: 10 peticiones/hora por IP (IP hasheada), caché de 5 min para peticiones idénticas y cupo diario global (`EXPLAIN_DAILY_CAP`, 500 por defecto). Sin IA nunca hay error: hay respaldo determinista;
- el concepto de "fuerza del patrón" sigue sin ser probabilidad y la tasa de acierto histórico sigue sin estar medida: el prompt lo repite en dos reglas y el respaldo en su advertencia.

**Reglas no negociables del MCP:**

- nunca hay retiros;
- la key exige permisos mínimos;
- toda orden lleva stop en el exchange;
- el bloqueo diario no se puede saltar desde el agente;
- el agente explica cada orden antes de enviarla y el usuario configura si exige confirmación.

**Límite del alcance abierto/privado (ADR-007 D2):** el MCP y el `order_guard` son abiertos, porque son herramientas que el usuario opera con sus keys. Las **estrategias y señales automáticas del laboratorio** siguen privadas y no se exponen por este MCP.

## Fases

1. **Ahora:** `analysis-core` + `/analisis/` (prototipo web) con tests sobre series sintéticas.
2. Extraer `analysis-core` a `packages/analysis-core` y crear la extensión WXT con el side panel.
3. `swal-trade serve` + MCP solo de lectura (`analyze_chart`, `market_context`, `account_risk`, `propose_order`).
4. Backtests en `py_engine` → `hit-rates.json` publicada y versionada; recién entonces se muestra un "% de acierto histórico" con *n* y periodo.
5. Tools de escritura del MCP (órdenes y grids) detrás de la bandera y del `order_guard`, primero en testnet.
