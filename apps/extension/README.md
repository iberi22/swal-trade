# Extensión SWAL Trade

Panel lateral para Chrome y Firefox. Muestra el símbolo que tienes abierto en Binance Futures o TradingView, un gráfico propio de velas con los niveles de cada hallazgo, los titulares del símbolo y los hallazgos del núcleo de análisis. No pide claves y no lee la cuenta.

Herramienta autodirigida, no asesoría de inversión. Licencia AGPL-3.0, la misma del repositorio.

## Desarrollo

Desde `apps/extension`:

```bash
npm install
npm run dev          # Chrome, con recarga
npm run dev:firefox  # Firefox
npm test             # temporalidades, leyenda del gráfico, titulares y ajustes
npm run build        # Chrome → .output/chrome-mv3
npm run build:firefox
npm run icons        # PNG 16/32/48/128 desde public/icon/icon.svg
npm run zip          # .output/*-chrome.zip
npm run zip:firefox  # .output/*-firefox.zip y el zip de fuentes para AMO
```

Los textos de la ficha, las justificaciones de permisos y los pasos de alta están en `docs/STORE_LISTING.md`. El aviso de la extensión es [trade.swal.network/extension-privacy/](https://trade.swal.network/extension-privacy/). Esos comandos no publican nada.

El alias `@swal/analysis-core` apunta a `workers/public-site/static/analisis/analysis-core.js`. Si ese archivo todavía no está, usa `vendor/analysis-core.js` (lo copia `npm run zip` para el zip de fuentes de AMO; no se commitea) y, si tampoco está, un stub que devuelve hallazgos vacíos.

## Cargar el build en Chrome

1. `npm run build`
2. Abre `chrome://extensions`
3. Activa el modo de desarrollador
4. "Cargar extensión descomprimida" y elige `apps/extension/.output/chrome-mv3`
5. Abre un futuro (`https://www.binance.com/en/futures/BTCUSDT`) o un gráfico de TradingView
6. Pulsa el icono de SWAL. El panel se abre al lado

Si la barra de intervalos de la página está a la vista, el panel la sigue: cambia
de temporalidad y el gráfico se recarga solo. Si la página la tiene plegada o
guardada en `localStorage`, también: el content script la busca en un puñado de
claves concretas (ver `src/lib/page-probe.ts`).

## Cargar el build en Firefox

1. `npm run build:firefox`
2. Abre `about:debugging#/runtime/this-firefox`
3. "Cargar complemento temporal…" y elige `apps/extension/.output/firefox-mv3/manifest.json`
4. El complemento temporal se quita al cerrar Firefox
5. Pulsa el icono de SWAL para abrir la barra lateral (menú Ver → Barras laterales)

Firefox no tiene `chrome.sidePanel`. El manifest de Firefox usa `sidebar_action` y no pide el permiso `sidePanel`. El clic en el icono llama a `sidebarAction.toggle()`. El fondo de Firefox queda como página de eventos (`background.scripts`), que es lo que genera WXT para Firefox MV3; Chrome usa un service worker.

En Firefox 140+ el instalador muestra que la extensión transmite "contenido del sitio". Es el símbolo, que viaja a la API pública de Binance. No hay otra categoría más estrecha. No declara datos de cuenta, de pago ni de identidad.

## Permisos

| Permiso | Para qué |
|---|---|
| `sidePanel` (solo Chrome) | Abrir el panel lateral al pulsar el icono |
| `storage` | Ajustes en `storage.local`; último símbolo y temporalidad en `storage.session`, mientras el navegador sigue abierto |
| `https://www.binance.com/*/futures/*` | Content script en `/*/futures/*`. Lee la URL, el botón de temporalidad activo y, si hace falta, la clave de `localStorage` que guarda el intervalo |
| `https://www.tradingview.com/chart/*` | Content script en `/chart/*`. Lee la URL, el título de la página y el control de intervalo |
| `https://www.binance.com/static/chart/tradingview/*` | El iframe del mismo origen donde la pestaña Trading View monta el gráfico. Es el único punto donde el puente MAIN-world puede pintar |
| `https://trade.swal.network/api/news*` | Titulares públicos `GET /api/news?symbol=BTC\|ETH&limit=5` |
| `https://fapi.binance.com/fapi/v1/klines*` | Velas públicas `GET /fapi/v1/klines` |
| `wss://fstream.binance.com/*` | Websocket público de la vela en curso (`/market/ws/` y el respaldo `/ws/`) |

No pedimos `tabs`, `scripting`, `history`, `cookies` ni acceso a otros sitios. La CSP de las páginas de la extensión es `script-src 'self'; object-src 'self'`: no hay código remoto. Lightweight Charts va dentro del build (Apache-2.0).

## Privacidad

No hace falta una API key. La extensión no lee balances, órdenes, formularios, cookies ni datos de cuenta.

**Símbolo y temporalidad.** El content script lee la URL, el botón de intervalo activo y, solo si la página no lo pinta, la clave de `localStorage` que guarda el intervalo. Son unas veinte claves concretas (`binance_kline_interval`, `chart_interval`…), se leen de una en una y solo su valor. **Nunca se enumera el almacenamiento**: es donde vive la información de cuenta, y no se toca.

**Titulares.** `GET https://trade.swal.network/api/news?symbol=BTC|ETH&limit=5` pide solo el activo del símbolo abierto. La respuesta trae título, fuente, fecha y un tono por léxico.

**Market data.** Lo demás que sale del navegador son peticiones de mercado público a Binance Futures (`fapi.binance.com` y `fstream.binance.com`): velas históricas y la vela en curso. El símbolo viaja en esa URL porque es un dato de mercado, no de tu cuenta. Los hallazgos se calculan en el panel. En el manifest de Firefox eso se declara como `data_collection_permissions.required: ["websiteContent"]`.

**Ajustes.** Temporalidad por defecto, lista blanca de símbolos y si el panel sigue a la página. Van en `storage.local` de la extensión, no en la página.

El websocket vive en el panel mientras está abierto. El service worker de Manifest V3 se duerme y no mantiene un socket.

## Qué pinta el gráfico

El núcleo (`analyzeSync`) devuelve un `top` diverso de hallazgos. La extensión dibuja
**todos** los del `top`, no solo el elegido:

- un marcador por `from`/`to` de cada hallazgo, anclado a la vela más cercana;
- una línea sólida por cada nivel y dos líneas de decisión, `levels.confirm` y
  `levels.invalidate`, esta última punteada;
- una leyenda bajo el gráfico con el nombre del hallazgo y sus dos precios.

Pulsar un hallazgo, en la leyenda o en la lista, lo resalta: el resto se queda en
el mismo tono, más flojo. Sin rojo ni verde: un solo tono hueso, igual que
`workers/public-site/static/tokens.css`.

## Pintar sobre el gráfico de Binance (pestaña Trading View)

Con el interruptor **"Pintar en el gráfico de Binance (pestaña Trading View)"** del
panel (apagado por defecto), los niveles de los hallazgos se dibujan también
sobre el gráfico de la página, no solo sobre el del panel.

Cómo funciona:

1. El panel calcula los hallazgos de siempre (mismas velas públicas, mismo
   núcleo) y los convierte en formas: `src/lib/tv-bridge/shapes.ts`.
2. Manda un mensaje de runtime al content script aislado de cada pestaña de
   futuros abierta (`src/lib/tv-paint-send.ts`).
3. El content script aislado (`src/entrypoints/content.ts`) establece un canal privado (`MessageChannel`) en `document_start` (ver modelo de confianza) y reenvía la orden solo por ese puerto.
4. El puente MAIN-world (`src/entrypoints/binance-tv-bridge.content.ts`) escucha únicamente por el puerto privado y valida el mensaje (tipo, versión, límite de tasa, tope de 60 formas, puntos numéricos), busca
   `tradingViewApi` en el iframe del mismo origen de la pestaña **Trading View**,
   espera a que el chart tenga rango visible y dibuja.

Detalles que importan:

- **Solo la pestaña Trading View.** La pestaña "Original" es el lienzo propio de
  Binance y no expone API: el panel lo dice ("cambia a la pestaña Trading View").
- **Un tono neutro y opacidad baja**, igual que el gráfico del panel. Las formas
  se crean bloqueadas (`locked` / `disableSelection`) para que no se muevan sin
  querer.
- **Solo se borra lo nuestro.** El puente lleva su propio libro de ids
  (`src/lib/tv-bridge/registry.ts`); lo que haya dibujado el usuario se queda.
- **Cambio de símbolo o temporalidad:** el puente se suscribe a
  `onSymbolChanged` / `onIntervalChanged` (con sondeo de respaldo) y redibuja.
- **Nada de cuenta.** No lee balances, órdenes ni formularios, y no pulsa nada en
  la página salvo el banner de cookies en las pruebas.

## Pruebas

`npm test` en `apps/extension` cubre el contrato de mensajes (rechaza tipo,
versión, nonce, formas hinchadas y NaN), la conversión de hallazgo a forma y el
libro de ids de entidades.

La prueba de extremo a extremo contra la página pública de Binance es **opt-in**
porque necesita red y Binance puede cambiar su DOM:

```bash
cd e2e
npm install && npx playwright install chromium
(cd ../apps/extension && npm run build)   # hace falta el build
E2E_BINANCE_LIVE=1 npx playwright test --project=binance-live
# o
npm run e2e:binance-live
```

Carga la página pública `https://www.binance.com/en/futures/BTCUSDT`, descarta el
banner de cookies, cambia a la pestaña Trading View, enciende el interruptor y
comprueba con `tradingViewApi.activeChart().getAllShapes()` que las formas
aparecen y que desaparecen al apagarlo. Las velas van mockeadas
(`e2e/fixtures/candles.mjs`), así que el resultado no depende del mercado de hoy.

### Modelo de confianza (MAIN-world bridge)

La API del gráfico está en el mundo de la página (`MAIN`). Nuestro puente tiene que vivir ahí, pero un content script `MAIN` comparte ventana con cualquier script de la página (incluyendo anuncios o tag managers), lo que abría la puerta a que otro script fabricara un mensaje de dibujo y pintara en el gráfico del usuario inventando análisis.

Para solucionarlo, los dos scripts (el aislado y el puente) se saludan en la fase `document_start` (antes de que la página ejecute nada) mediante un `MessageChannel`. El puente entrega un puerto privado que el script aislado atrapa. A partir de ahí, el puente ignora por completo `window.postMessage` y atiende solo los mensajes que lleguen por ese puerto. La autenticidad la da el canal, no una clave o un nonce en el mensaje.
