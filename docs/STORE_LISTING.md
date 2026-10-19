# Ficha de tienda — SWAL Trade 0.1.0

Paquete local de la extensión en `apps/extension`. Este documento no publica nada. Los zip salen en `apps/extension/.output/` y están en `.gitignore`.

| Campo | Valor |
|---|---|
| Versión | `0.1.0` |
| Idioma por defecto del manifest | español (`default_locale: es`) |
| Nombre en español | SWAL Trade — Análisis de gráficos |
| Nombre en inglés | SWAL Trade — Chart analysis |
| Nombre corto del icono | SWAL Trade |
| Página | https://trade.swal.network |
| Aviso de privacidad (URL de la ficha) | https://trade.swal.network/extension-privacy/ |
| Código | https://github.com/iberi22/swal-trade (AGPL-3.0) |
| Categoría Chrome Web Store | Productivity |
| Categoría Firefox (AMO) | Other |
| Id de Firefox | `extension@swal.network` |

La página de privacidad en `workers/public-site/static/extension-privacy/` ya está desplegada y pública en https://trade.swal.network/extension-privacy/.

## Textos en español

Descripción corta (128 caracteres, límite 132). Es la `description` del manifest:

```
Explica patrones sobre el gráfico de Binance o TradingView. No es un servicio de señales. Medimos: ningún patrón superó al azar.
```

Propósito único:

```
Explicar, sobre el gráfico del símbolo abierto en Binance Futures o TradingView, los patrones que el análisis encuentra en las velas públicas, y ayudar a gestionar el riesgo de la posición del propio usuario con una clave de solo lectura que él crea. No envía órdenes.
```

Descripción completa:

```
SWAL Trade — Análisis de gráficos es un panel lateral para Chrome y una barra lateral para Firefox. Lee el símbolo que tienes abierto en Binance Futures o en un gráfico de TradingView, descarga las velas públicas de ese par y dibuja los patrones que encuentra el núcleo de análisis: niveles, confirmación e invalidación. Incluye panel de flujo de volumen (CVD y delta taker), pulso de mercado (muros del libro, liquidaciones recientes, miedo/codicia y régimen), titulares y explicaciones educativas opcionales. La puntuación se llama fuerza. No es una probabilidad ni un porcentaje de acierto.

No es un servicio de señales. No abre ni cierra operaciones y no promete resultados. Solo si tú lo configuras, usa una clave de API de solo lectura (sin retiros) para mostrar tu posición abierta, aplicar reglas de riesgo y calcular métricas de tu propio historial de futuros. La clave se genera dentro del navegador y no sale de él, salvo en las peticiones firmadas a Binance. La IA es opcional, usa tu propia clave y solo se llama al pulsar un botón.

Lo medimos. En BTC y ETH, de 1 minuto a 4 horas, con regla de cierre, comisiones y corrección por multiplicidad (2026-10), ningún patrón superó al azar. Sirve para entender el gráfico, no para predecirlo.

Con el interruptor del panel encendido, la extensión puede pintar los niveles del análisis sobre el propio gráfico de futuros de Binance; pide permiso para acceder a ese lienzo; ese dibujo no lee tu cuenta.

Qué sale del navegador:
- Velas públicas: GET https://fapi.binance.com/fapi/v1/klines (símbolo, temporalidad y límite).
- Muros del libro: GET https://fapi.binance.com/fapi/v1/depth (símbolo y límite).
- La vela en curso y liquidaciones públicas: websocket público wss://fstream.binance.com (símbolo y temporalidad).
- Titulares, solo BTC y ETH: GET https://trade.swal.network/api/news?symbol=BTC|ETH&limit=5.
- Miedo y codicia: GET https://api.alternative.me/fng/?limit=1 (cacheado 1 h).
- Explicaciones con IA (solo si se enciende «Explicaciones con IA»): POST https://trade.swal.network/api/explain.
- Solo con una clave de solo lectura configurada: peticiones GET firmadas a https://fapi.binance.com (/fapi/v1/time, /fapi/v2/positionRisk, /fapi/v3/account, /fapi/v1/openOrders, /fapi/v1/openAlgoOrders, /fapi/v1/userTrades, /fapi/v1/income, /fapi/v1/premiumIndex) y una comprobación opcional en https://api.binance.com/sapi/v1/account/apiRestrictions.
- Solo si eliges un proveedor de IA y pulsas «Analizar»: una petición al proveedor elegido (OpenCode, OpenRouter, OpenAI, Anthropic, Gemini o un Ollama local), con tu clave y la carga útil que se muestra en «Ver lo que se envía».

No hay analítica, ni cookies de seguimiento, ni código remoto. Nada de tu cuenta va a servidores de SWAL. Los ajustes se quedan en el almacenamiento de la extensión; la clave y el historial, en la bóveda y el IndexedDB de la extensión.

Aviso: https://trade.swal.network/extension-privacy/
Código: https://github.com/iberi22/swal-trade (AGPL-3.0)
No es asesoría financiera. Operar futuros con apalancamiento puede hacerte perder todo tu capital.
```

## Textos en inglés

Short description (113 characters, limit 132). Manifest `description` when the browser language is English:

```
Explains patterns on the Binance or TradingView chart. Not a signal service. We measured: no pattern beat random.
```

Single purpose:

```
Explain, on the chart of the symbol open on Binance Futures or TradingView, the patterns the analysis finds in public candles. It does not place orders. With a read-only key the user creates, it also helps manage the risk of the user's own open position.
```

Full description:

```
SWAL Trade — Chart analysis is a Chrome side panel and a Firefox sidebar. It reads the symbol you have open on Binance Futures or on a TradingView chart, downloads that pair's public candles, and draws the patterns the analysis core finds: levels, confirmation, and invalidation. Includes a volume flow pane (CVD and taker delta), market pulse (order book walls, recent liquidations, fear/greed, and trend regime), headlines, and optional educational explanations. The score is called strength (fuerza). It is not a probability and it is not a success rate.

This is not a signal service. It does not open or close trades, and it does not promise results. Only if you set it up, it uses a read-only API key (no withdrawals) to show your open position, apply risk rules, and compute metrics from your own futures history. The key is generated inside the browser and never leaves it, except in signed requests to Binance. AI is optional, uses your own key, and is only called when you press a button.

We measured it. On BTC and ETH, from 1 minute to 4 hours, with a close rule, fees, and a multiplicity correction (2026-10), no pattern beat random. Use it to understand the chart, not to predict it.

What leaves the browser:
- Public candles: GET https://fapi.binance.com/fapi/v1/klines (symbol, timeframe, and limit).
- Order book walls: GET https://fapi.binance.com/fapi/v1/depth (symbol and limit).
- Live candle and public liquidations: public websocket wss://fstream.binance.com (symbol and timeframe).
- Headlines, BTC and ETH only: GET https://trade.swal.network/api/news?symbol=BTC|ETH&limit=5.
- Fear and greed: GET https://api.alternative.me/fng/?limit=1 (cached 1 h).
- AI explanations (only when "AI explanations" is turned on): POST https://trade.swal.network/api/explain.
- Only with a read-only key configured: signed GET requests to https://fapi.binance.com (/fapi/v1/time, /fapi/v2/positionRisk, /fapi/v3/account, /fapi/v1/openOrders, /fapi/v1/openAlgoOrders, /fapi/v1/userTrades, /fapi/v1/income, /fapi/v1/premiumIndex) and an optional check at https://api.binance.com/sapi/v1/account/apiRestrictions.
- Only if you pick an AI provider and press "Analyze": one request to the chosen provider (OpenCode, OpenRouter, OpenAI, Anthropic, Gemini or a local Ollama), with your key and the payload shown in "See what is sent".

There is no analytics, no tracking cookies, and no remote code. Nothing from your account goes to SWAL servers. Settings stay in extension storage; the key and the history stay in the extension's vault and IndexedDB.

Privacy notice: https://trade.swal.network/extension-privacy/
Source: https://github.com/iberi22/swal-trade (AGPL-3.0)
Not financial advice. Trading leveraged futures can wipe out your capital.
```

## Permisos y justificación

Pegar la columna que pida el formulario. Chrome revisa en inglés; la ficha pública puede ir en español. No pedimos `tabs`, `scripting`, `downloads`, `history`, `cookies`, `identity` ni `<all_urls>`. Los archivos CSV y JSON se guardan con un Blob y un enlace `download`, sin el permiso `downloads`.

| Permiso en el manifest | ¿Dónde? | Justificación (español) | Justification (English) — paste into Chrome Web Store |
|---|---|---|---|
| `storage` | Chrome y Firefox | Guarda en el navegador la temporalidad por defecto, la lista de símbolos y si el panel sigue la página (`storage.local`). El último símbolo de la sesión va a `storage.session`. No sale del dispositivo. | Stores the default timeframe, the symbol allowlist, and whether the panel follows the open page in `storage.local`. The last symbol of the session stays in `storage.session`. Nothing in storage is uploaded. |
| `sidePanel` | Solo Chrome | Abre el panel lateral al pulsar el icono. Firefox usa `sidebar_action` y no pide este permiso. | Opens the side panel when the toolbar icon is clicked. Firefox uses `sidebar_action` and does not request this permission. |
| `https://www.binance.com/*/futures/*` | Content script | En las páginas de futuros lee el símbolo de la URL, el botón de temporalidad visible y, solo si la página no lo pinta, el valor de unas claves concretas de intervalo en `localStorage`. No enumera el almacenamiento y no lee la cuenta. | On futures pages, reads the symbol from the URL, the visible timeframe button, and, only if the page does not show it, the value of a few known interval keys in `localStorage`. It does not enumerate storage and does not read the account. |
| `https://www.tradingview.com/chart/*` | Content script | Igual, en `/chart/*`: URL, título y control de intervalo. | Same on `/chart/*`: the URL, the page title, and the interval control. |
| `https://www.binance.com/static/chart/tradingview/*` | Content script | El iframe del mismo origen donde la pestaña "Trading View" de Binance monta el gráfico. Es el único punto desde el que se pueden pintar los niveles del análisis sobre el gráfico de la página, y solo si el usuario enciende el interruptor del panel. No lee la cuenta: dibuja entidades de libro de la API de TradingView. | The same-origin iframe where Binance's "Trading View" tab mounts the chart. It is the only place the analysis levels can be painted on the page chart, and only when the panel switch is turned on. It does not read the account: it creates locked drawing entities through the TradingView API. |
| `https://fapi.binance.com/fapi/v1/klines*` | Host | Velas públicas `GET /fapi/v1/klines`. La URL lleva símbolo, temporalidad y límite. Sin clave. | Public candles, `GET /fapi/v1/klines`. The URL carries the symbol, the timeframe, and a limit. No API key. |
| `https://fapi.binance.com/fapi/v1/depth*` | Host | Muros del libro: niveles grandes de `GET /fapi/v1/depth?symbol=BTCUSDT&limit=500`, cada 15 s y solo con el panel abierto. Sin clave. | Book walls: large levels from `GET /fapi/v1/depth?symbol=BTCUSDT&limit=500`, every 15 s and only while the panel is open. No API key. |
| `https://fapi.binance.com/fapi/v1/time*`, `/fapi/v2/positionRisk*`, `/fapi/v3/account*`, `/fapi/v1/openOrders*`, `/fapi/v1/openAlgoOrders*`, `/fapi/v1/userTrades*`, `/fapi/v1/income*`, `/fapi/v1/premiumIndex*` | Host | Lectura de la cuenta del usuario con su clave de solo lectura: posición, órdenes de stop abiertas, capital, fills e ingresos de los últimos meses. Solo `GET` firmado, desde una lista cerrada de rutas; sin rutas de escritura. Sin clave configurada no se llama a ninguna. | Reads the user's own account with their read-only key: position, open stop orders, equity, fills and income of the last months. Signed `GET` only, from a closed list of paths; there are no write routes. Without a configured key none of these is called. |
| `wss://fstream.binance.com/*` | Host | Websocket público de la vela en curso. Primero `/market/ws/<símbolo>@kline_<tf>`; si no abre, `/ws/<símbolo>@kline_<tf>`. | Public websocket for the live candle. First `/market/ws/<symbol>@kline_<tf>`; if that does not open, `/ws/<symbol>@kline_<tf>`. |
| `https://trade.swal.network/api/news*` | Host | Titulares públicos `GET /api/news?symbol=BTC\|ETH&limit=5`. Solo si el par es de BTC o de ETH. | Public headlines, `GET /api/news?symbol=BTC\|ETH&limit=5`. Only when the open pair is BTC or ETH. |
| `https://trade.swal.network/api/explain*` | Host | Explicador del panel: `POST /api/explain` con el símbolo, la temporalidad y los patrones detectados (y sus niveles). Solo si el usuario enciende «Explicaciones con IA»; arranca apagado y nunca envía datos de cuenta. | Panel explainer: `POST /api/explain` with the symbol, the timeframe, and the detected patterns (and their levels). Only when the user turns on "AI explanations"; off by default and it never sends account data. |
| `ws://127.0.0.1/*` | Host | Puente local opcional con un agente de IA en la máquina del usuario (Claude Code vía MCP). Solo se conecta cuando el usuario lo enciende explícitamente y pega el token de emparejamiento. El tráfico nunca sale de 127.0.0.1. | Optional local bridge with an AI agent running on the user's machine (Claude Code via MCP). Only connects when the user explicitly enables it and provides the pairing token. Traffic never leaves 127.0.0.1. |
| `http://127.0.0.1/*` | Host | Radar local opcional: consulta de alertas y estadísticas al servicio `swal-radar` en la máquina del usuario. Los datos nunca salen de 127.0.0.1. | Optional local radar: queries alerts and statistics from the `swal-radar` service on the user's machine. Traffic never leaves 127.0.0.1. |
| `https://api.alternative.me/fng/*` | Host | Índice de miedo y codicia `GET /fng/?limit=1`, cacheado 1 h en el almacenamiento de la extensión. Dato público de un tercero. | Fear and Greed index, `GET /fng/?limit=1`, cached for 1 h in extension storage. A third-party public figure. |
| `https://api.binance.com/sapi/v1/account/apiRestrictions*` | Host opcional | Una sola consulta firmada que comprueba que la clave no tiene retiros habilitados. Se pide al configurar la clave. | One signed query that checks the key has no withdrawals enabled. Requested when the key is configured. |
| `https://opencode.ai/inference/*`, `https://openrouter.ai/api/*`, `https://api.openai.com/v1/*`, `https://api.anthropic.com/v1/*`, `https://generativelanguage.googleapis.com/*` | Hosts opcionales | Proveedor de IA que el usuario elige, con su propia clave. El permiso se pide solo para el proveedor elegido y la llamada solo ocurre al pulsar «Analizar»; nunca hay una URL arbitraria. | The AI provider the user chooses, with their own key. The permission is requested only for the chosen provider and the call only happens when the user presses "Analyze"; there is never an arbitrary URL. |

El permiso `https://fstream.binance.com/*` (https, no websocket) no está: el código no lo usa.

## Privacidad en el formulario

URL: `https://trade.swal.network/extension-privacy/`

La página dice lo mismo que la tabla de arriba. No hay seguimiento, ninguna clave llega a servidores de SWAL y los hallazgos y las métricas se calculan en el panel.

Datos que sí hay que declarar:

- Chrome: marcar **Website content** (el símbolo y la temporalidad del gráfico abierto, para pedir velas públicas y, en BTC y ETH, titulares), **Financial and payment information** (posición, órdenes, capital, fills e ingresos que lee la clave de solo lectura del usuario) y **Authentication information** (la clave de API de solo lectura y, si se usa, la clave del proveedor de IA que el usuario pega). Ambas categorías se usan solo para la función visible (mostrar la posición, reglas de riesgo y métricas del propio usuario) y cumplen **Limited Use**: no se venden ni se ceden, no se usan para publicidad ni crédito, y nadie las lee a mano salvo con consentimiento. Ninguna llega a servidores de SWAL.
- No marcar información de identificación, salud, comunicaciones, ubicación, historial ni actividad del usuario.
- Marcar las tres certificaciones de que no se vende ni se cede el dato, no se usa para otra finalidad y no se usa para crédito.

Firefox declara hoy `data_collection_permissions.required = ["websiteContent"]`. Para publicar la versión con cuenta e IA hay que añadir en `apps/extension/wxt.config.ts` la clave `optional` con `authenticationInfo` y `financialAndPaymentInfo` (el usuario las concede al configurar la clave). Ese cambio de manifest no está hecho en este documento. En el formulario de AMO, la misma URL de privacidad.

### Nota para el revisor (Chrome y Firefox)

```
The extension reads the user's own Binance Futures account ONLY if the user creates and pastes a read-only API key (withdrawals refused; the extension checks this and rejects keys with withdrawals enabled). The key never leaves the browser except inside signed requests to Binance (fapi.binance.com, a closed list of GET paths; there are no write routes). An Ed25519 key can be generated inside the extension as a non-extractable CryptoKey. Metrics and rules are computed locally in the side panel.
The optional AI analysis sends a small payload only to the provider the user chose, using the user's own key, and only after the user presses a button and accepts a consent screen that names the provider and the fields. The exact payload is shown before and after in "See what is sent". By default it contains only relative numbers (percentages, R, leverage, flags): no USD amounts, quantities, equity, ids or absolute timestamps. Nothing is sent to our servers. The model's text is rendered as plain text. No remote code, no analytics. Exports (CSV/JSON) use a Blob and an <a download> link; the "downloads" permission is not requested.
```

## Iconos

Un solo tono (`#211D18` sobre transparente), generados en local desde `apps/extension/public/icon/icon.svg`. Sin assets externos.

| Archivo | Uso |
|---|---|
| `public/icon/16.png` | Barra, manifest |
| `public/icon/32.png` | Barra, manifest |
| `public/icon/48.png` | Barra, manifest; icono de AMO |
| `public/icon/128.png` | Manifest y icono de la ficha (Chrome y Firefox) |

Regenerar: `cd apps/extension && npm run icons` (`rsvg-convert` o ImageMagick).

## Capturas

Las cinco son PNG 1280×800, RGB sin canal alfa, del panel real con datos mockeados (la misma serie determinista que `e2e/tests/extension.spec.ts`).

| Archivo | Qué enseña |
|---|---|
| `apps/extension/store-assets/sidepanel-chart-1280x800.png` | Gráfico de velas, panel CVD (flujo de volumen delta taker), leyenda y hallazgos (fuerza, no probabilidad). BTCUSDT 15m. |
| `apps/extension/store-assets/sidepanel-pulse-1280x800.png` | Pulso de mercado: muros del libro de órdenes, liquidaciones recientes (5 y 15 min), índice de miedo y codicia y régimen por temporalidad. |
| `apps/extension/store-assets/sidepanel-explain-1280x800.png` | Explicación educativa con IA (opt-in): resumen didáctico y escenarios de confirmación e invalidación del análisis determinista. |
| `apps/extension/store-assets/sidepanel-news-1280x800.png` | Titulares públicos de mercado y sentimiento léxico. |
| `apps/extension/store-assets/sidepanel-settings-1280x800.png` | Ajustes de la extensión: temporalidad por defecto, lista de símbolos permitidos y sincronización con la página abierta. |

Checklist antes de subir:

- [ ] Todas miden 1280×800.
- [ ] No tienen canal alfa (RGB png24).
- [ ] Se lee «fuerza» y no una promesa de resultado.
- [ ] No hay una ruta local ni un dato de cuenta en la imagen.
- [ ] Chrome: subir las capturas en la ficha (máximo 5; tamaño aceptado 1280×800).
- [ ] Firefox: las mismas capturas.

Regenerar, con el build de Chrome ya hecho y las dependencias de `e2e/` instaladas:

```bash
cd apps/extension && npm run build
node apps/extension/scripts/store-screenshots.mjs
```

## Zip

Desde `apps/extension`:

```bash
npm test
npm run zip
npm run zip:firefox
```

Salida esperada:

- `.output/swal-trade-extension-0.1.0-chrome.zip`
- `.output/swal-trade-extension-0.1.0-firefox.zip`
- `.output/swal-trade-extension-0.1.0-sources.zip` (fuentes para AMO; WXT lo genera con el zip de Firefox)

`npm run zip` y `npm run zip:firefox` copian `workers/public-site/static/analisis/analysis-core.js` a `apps/extension/vendor/` (gitignored) antes de empaquetar, para que quien descomprima el zip de fuentes y haga `npm install && npm run build` use el mismo núcleo, no el stub. Las capturas no entran en ese zip. La copia va dentro del script porque un `prezip` no corre si npm tiene `ignore-scripts`.

Antes de subir, el contenido de los tres zip no debe tener rutas `/home/` ni secretos. Comprobar:

```bash
cd apps/extension/.output
for z in swal-trade-extension-0.1.0-*.zip; do
  echo "== $z =="
  unzip -l "$z" | head
  unzip -p "$z" | grep -nE '/home/|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]|AIza[0-9A-Za-z_-]{20}' && echo "REVISAR $z" || echo "sin rutas locales ni secretos evidentes"
done
```

## Pasos manuales para Bel

No los hace este repositorio. No hay push ni subida a ninguna tienda en este cambio.

Chrome Web Store (registro de desarrollador, 5 USD una sola vez):

1. Entra en https://chrome.google.com/webstore/devconsole con la cuenta de Google que será la editora y paga el registro único de 5 USD.
2. Comprueba que la página de privacidad (https://trade.swal.network/extension-privacy/) responde (ya está desplegada y pública).
3. «Nuevo elemento» y sube `.output/swal-trade-extension-0.1.0-chrome.zip`.
4. Ficha: categoría Productivity, idioma español por defecto, añade el inglés. Pega los textos de arriba. Icono: `public/icon/128.png`. Capturas: las de `store-assets/`.
5. Privacy: la URL de arriba. Marca Website content, Financial and payment information y Authentication information (Limited Use) y las tres certificaciones. Pega la nota para el revisor. Pega la columna English de la tabla de permisos en cada campo «permission justification».
6. Revisa la vista previa. No escribas cifras de acierto ni promesas de resultado. Envía a revisión (la URL de privacidad ya está desplegada y responde en producción).

Firefox AMO (cuenta gratis):

1. Crea o entra en la cuenta de https://addons.mozilla.org/developers/ (no tiene cuota de registro).
2. Envía un complemento nuevo. Sube el zip de Firefox. Cuando pida las fuentes porque el código va empaquetado, sube `swal-trade-extension-0.1.0-sources.zip`.
3. Categoría Other. Mismos textos, mismas capturas, mismo icono de 128 y la misma URL de privacidad.
4. En la recogida de datos, declara el contenido del sitio (`websiteContent`, requerido) y, como opcionales, la información de autenticación y la financiera (`authenticationInfo`, `financialAndPaymentInfo`) cuando el manifest las incluya. Pega la nota para el revisor de arriba.
5. Notas para el revisor: el panel explica patrones; no es un servicio de señales; la medición (BTC/ETH, 1m–4h, regla de cierre, comisiones, corrección por multiplicidad, 2026-10) no encontró un patrón que superara al azar. Firefox 128 soporta content scripts en el mundo `MAIN` de acuerdo a MDN Web Docs. Para reconstruir: `npm install && npm run build` dentro del zip de fuentes.

## Qué no decir en la ficha

No uses «ganancia garantizada», «rentabilidad», «win rate», «ingresos pasivos», «ROI» ni un porcentaje de acierto. La palabra del producto es fuerza. El resultado medido es que ningún patrón superó al azar en ese corte, no que operar sea seguro.
