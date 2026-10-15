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

Hay que desplegar `workers/public-site/static/extension-privacy/` a https://trade.swal.network/extension-privacy/ antes de enviar la ficha. Este trabajo no despliega.

## Textos en español

Descripción corta (128 caracteres, límite 132). Es la `description` del manifest:

```
Explica patrones sobre el gráfico de Binance o TradingView. No es un servicio de señales. Medimos: ningún patrón superó al azar.
```

Propósito único:

```
Explicar, sobre el gráfico del símbolo abierto en Binance Futures o TradingView, los patrones que el análisis encuentra en las velas públicas. No envía órdenes ni lee la cuenta.
```

Descripción completa:

```
SWAL Trade — Análisis de gráficos es un panel lateral para Chrome y una barra lateral para Firefox. Lee el símbolo que tienes abierto en Binance Futures o en un gráfico de TradingView, descarga las velas públicas de ese par y dibuja los patrones que encuentra el núcleo de análisis: niveles, confirmación e invalidación. La puntuación se llama fuerza. No es una probabilidad ni un porcentaje de acierto.

No es un servicio de señales. No abre ni cierra operaciones, no lee tu cuenta, no pide claves de API y no promete resultados.

Lo medimos. En BTC y ETH, de 1 minuto a 4 horas, con regla de cierre, comisiones y corrección por multiplicidad (2026-10), ningún patrón superó al azar. Sirve para entender el gráfico, no para predecirlo.

Con el interruptor del panel encendido, la extensión puede pintar los niveles del análisis sobre el propio gráfico de futuros de Binance; pide permiso para acceder a ese lienzo, pero no lee tu cuenta.

Qué sale del navegador:
- Velas públicas: GET https://fapi.binance.com/fapi/v1/klines (símbolo, temporalidad y límite).
- La vela en curso: websocket público wss://fstream.binance.com (símbolo y temporalidad).
- Titulares, solo BTC y ETH: GET https://trade.swal.network/api/news?symbol=BTC|ETH&limit=5.

No hay analítica, ni cookies de seguimiento, ni código remoto. Los ajustes se quedan en el almacenamiento de la extensión.

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
Explain, on the chart of the symbol open on Binance Futures or TradingView, the patterns the analysis finds in public candles. It does not place orders or read the account.
```

Full description:

```
SWAL Trade — Chart analysis is a Chrome side panel and a Firefox sidebar. It reads the symbol you have open on Binance Futures or on a TradingView chart, downloads that pair's public candles, and draws the patterns the analysis core finds: levels, confirmation, and invalidation. The score is called strength (fuerza). It is not a probability and it is not a success rate.

This is not a signal service. It does not open or close trades, it does not read your account, it does not ask for API keys, and it does not promise results.

We measured it. On BTC and ETH, from 1 minute to 4 hours, with a close rule, fees, and a multiplicity correction (2026-10), no pattern beat random. Use it to understand the chart, not to predict it.

What leaves the browser:
- Public candles: GET https://fapi.binance.com/fapi/v1/klines (symbol, timeframe, and limit).
- The live candle: public websocket wss://fstream.binance.com (symbol and timeframe).
- Headlines, BTC and ETH only: GET https://trade.swal.network/api/news?symbol=BTC|ETH&limit=5.

There is no analytics, no tracking cookies, and no remote code. Settings stay in extension storage.

Privacy notice: https://trade.swal.network/extension-privacy/
Source: https://github.com/iberi22/swal-trade (AGPL-3.0)
Not financial advice. Trading leveraged futures can wipe out your capital.
```

## Permisos y justificación

Pegar la columna que pida el formulario. Chrome revisa en inglés; la ficha pública puede ir en español. No pedimos `tabs`, `scripting`, `history`, `cookies`, `identity` ni `<all_urls>`.

| Permiso en el manifest | ¿Dónde? | Justificación (español) | Justification (English) — paste into Chrome Web Store |
|---|---|---|---|
| `storage` | Chrome y Firefox | Guarda en el navegador la temporalidad por defecto, la lista de símbolos y si el panel sigue la página (`storage.local`). El último símbolo de la sesión va a `storage.session`. No sale del dispositivo. | Stores the default timeframe, the symbol allowlist, and whether the panel follows the open page in `storage.local`. The last symbol of the session stays in `storage.session`. Nothing in storage is uploaded. |
| `sidePanel` | Solo Chrome | Abre el panel lateral al pulsar el icono. Firefox usa `sidebar_action` y no pide este permiso. | Opens the side panel when the toolbar icon is clicked. Firefox uses `sidebar_action` and does not request this permission. |
| `https://www.binance.com/*/futures/*` | Content script | En las páginas de futuros lee el símbolo de la URL, el botón de temporalidad visible y, solo si la página no lo pinta, el valor de unas claves concretas de intervalo en `localStorage`. No enumera el almacenamiento y no lee la cuenta. | On futures pages, reads the symbol from the URL, the visible timeframe button, and, only if the page does not show it, the value of a few known interval keys in `localStorage`. It does not enumerate storage and does not read the account. |
| `https://www.tradingview.com/chart/*` | Content script | Igual, en `/chart/*`: URL, título y control de intervalo. | Same on `/chart/*`: the URL, the page title, and the interval control. |
| `https://www.binance.com/static/chart/tradingview/*` | Content script | El iframe del mismo origen donde la pestaña "Trading View" de Binance monta el gráfico. Es el único punto desde el que se pueden pintar los niveles del análisis sobre el gráfico de la página, y solo si el usuario enciende el interruptor del panel. No lee la cuenta: dibuja entidades de libro de la API de TradingView. | The same-origin iframe where Binance's "Trading View" tab mounts the chart. It is the only place the analysis levels can be painted on the page chart, and only when the panel switch is turned on. It does not read the account: it creates locked drawing entities through the TradingView API. |
| `https://fapi.binance.com/fapi/v1/klines*` | Host | Velas públicas `GET /fapi/v1/klines`. La URL lleva símbolo, temporalidad y límite. Sin clave. | Public candles, `GET /fapi/v1/klines`. The URL carries the symbol, the timeframe, and a limit. No API key. |
| `https://fapi.binance.com/fapi/v1/depth*` | Host | Muros del libro: niveles grandes de `GET /fapi/v1/depth?symbol=BTCUSDT&limit=500`, cada 15 s y solo con el panel abierto. Sin clave. | Book walls: large levels from `GET /fapi/v1/depth?symbol=BTCUSDT&limit=500`, every 15 s and only while the panel is open. No API key. |
| `wss://fstream.binance.com/*` | Host | Websocket público de la vela en curso. Primero `/market/ws/<símbolo>@kline_<tf>`; si no abre, `/ws/<símbolo>@kline_<tf>`. | Public websocket for the live candle. First `/market/ws/<symbol>@kline_<tf>`; if that does not open, `/ws/<symbol>@kline_<tf>`. |
| `https://trade.swal.network/api/news*` | Host | Titulares públicos `GET /api/news?symbol=BTC\|ETH&limit=5`. Solo si el par es de BTC o de ETH. | Public headlines, `GET /api/news?symbol=BTC\|ETH&limit=5`. Only when the open pair is BTC or ETH. |
| `https://api.alternative.me/fng/*` | Host | Índice de miedo y codicia `GET /fng/?limit=1`, cacheado 1 h en el almacenamiento de la extensión. Dato público de un tercero. | Fear and Greed index, `GET /fng/?limit=1`, cached for 1 h in extension storage. A third-party public figure. |

El permiso `https://fstream.binance.com/*` (https, no websocket) no está: el código no lo usa.

## Privacidad en el formulario

URL: `https://trade.swal.network/extension-privacy/`

La página dice lo mismo que la tabla de arriba. No hay seguimiento, no hay claves y los hallazgos se calculan en el panel.

Datos que sí hay que declarar:

- Chrome: marcar **Website content**. Es el símbolo y la temporalidad del gráfico abierto. Se usan solo para pedir velas públicas y, en BTC y ETH, titulares.
- No marcar información de identificación, salud, pagos, autenticación, comunicaciones, ubicación, historial ni actividad del usuario. No leemos balances ni órdenes: el símbolo de un gráfico no es un dato de cuenta.
- Marcar las tres certificaciones de que no se vende ni se cede el dato, no se usa para otra finalidad y no se usa para crédito.

Firefox ya lo declara en el manifest: `data_collection_permissions.required = ["websiteContent"]`. No añadir otras categorías. En el formulario de AMO, la misma URL de privacidad.

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

Las dos son PNG 1280×800, RGB sin canal alfa, del panel real con velas de Binance mockeadas (la misma serie que `e2e/tests/extension.spec.ts`).

| Archivo | Qué enseña |
|---|---|
| `apps/extension/store-assets/sidepanel-chart-1280x800.png` | Gráfico, leyenda y hallazgos (fuerza, no probabilidad). BTCUSDT 15m. |
| `apps/extension/store-assets/sidepanel-news-1280x800.png` | Titulares mockeados y ajustes. |

Checklist antes de subir:

- [ ] Las dos miden 1280×800.
- [ ] No tienen canal alfa.
- [ ] Se lee «fuerza» y no una promesa de resultado.
- [ ] No hay una ruta local ni un dato de cuenta en la imagen.
- [ ] Chrome: subir las dos en la ficha (mínimo una; tamaño aceptado 1280×800).
- [ ] Firefox: las mismas dos.

Regenerar, con el build de Chrome ya hecho y las dependencias de `e2e/` instaladas:

```bash
cd apps/extension && npm run build
cd ../e2e && npm install
cd .. && node e2e/scripts/store-screenshots.mjs
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
2. Despliega la página de privacidad a https://trade.swal.network/extension-privacy/ y comprueba que abre.
3. «Nuevo elemento» y sube `.output/swal-trade-extension-0.1.0-chrome.zip`.
4. Ficha: categoría Productivity, idioma español por defecto, añade el inglés. Pega los textos de arriba. Icono: `public/icon/128.png`. Capturas: las dos de `store-assets/`.
5. Privacy: la URL de arriba. Marca Website content y las tres certificaciones. Pega la columna English de la tabla de permisos en cada campo «permission justification».
6. Revisa la vista previa. No escribas cifras de acierto ni promesas de resultado. Envía a revisión cuando la URL de privacidad ya responda en producción.

Firefox AMO (cuenta gratis):

1. Crea o entra en la cuenta de https://addons.mozilla.org/developers/ (no tiene cuota de registro).
2. Envía un complemento nuevo. Sube el zip de Firefox. Cuando pida las fuentes porque el código va empaquetado, sube `swal-trade-extension-0.1.0-sources.zip`.
3. Categoría Other. Mismos textos, mismas capturas, mismo icono de 128 y la misma URL de privacidad.
4. En la recogida de datos, deja solo el contenido del sitio (`websiteContent`), que ya declara el manifest: el símbolo y la temporalidad que salen hacia el mercado público.
5. Notas para el revisor: el panel explica patrones; no es un servicio de señales; la medición (BTC/ETH, 1m–4h, regla de cierre, comisiones, corrección por multiplicidad, 2026-10) no encontró un patrón que superara al azar. Firefox 128 soporta content scripts en el mundo `MAIN` de acuerdo a MDN Web Docs. Para reconstruir: `npm install && npm run build` dentro del zip de fuentes.

## Qué no decir en la ficha

No uses «ganancia garantizada», «rentabilidad», «win rate», «ingresos pasivos», «ROI» ni un porcentaje de acierto. La palabra del producto es fuerza. El resultado medido es que ningún patrón superó al azar en ese corte, no que operar sea seguro.
