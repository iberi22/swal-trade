# Extensión SWAL Trade

Panel lateral para Chrome y Firefox. Muestra el símbolo que tienes abierto en Binance Futures o TradingView, un gráfico propio de velas y los hallazgos del núcleo de análisis. No pide claves y no lee la cuenta.

Herramienta autodirigida, no asesoría de inversión. Licencia AGPL-3.0, la misma del repositorio.

## Desarrollo

Desde `apps/extension`:

```bash
npm install
npm run dev          # Chrome, con recarga
npm run dev:firefox  # Firefox
npm test             # parsers y helper de hallazgos
npm run build        # Chrome → .output/chrome-mv3
npm run build:firefox
```

El alias `@swal/analysis-core` apunta a `workers/public-site/static/analisis/analysis-core.js`. Si ese archivo todavía no está, el build usa un stub que devuelve hallazgos vacíos.

## Cargar el build en Chrome

1. `npm run build`
2. Abre `chrome://extensions`
3. Activa el modo de desarrollador
4. "Cargar extensión descomprimida" y elige `apps/extension/.output/chrome-mv3`
5. Abre un futuro (`https://www.binance.com/en/futures/BTCUSDT`) o un gráfico de TradingView
6. Pulsa el icono de SWAL. El panel se abre al lado

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
| `storage` | Recordar el último símbolo y temporalidad en `storage.session`, mientras el navegador sigue abierto |
| `https://www.binance.com/*` | Content script en `/*/futures/*`. Lee la URL y, si hace falta, el texto del botón de temporalidad activo |
| `https://www.tradingview.com/*` | Content script en `/chart/*`. Lee la URL, el título de la página y el control de intervalo |
| `https://fapi.binance.com/*` | Velas públicas `GET /fapi/v1/klines` |
| `https://fstream.binance.com/*` y `wss://fstream.binance.com/*` | Websocket público de la vela en curso |

No pedimos `tabs`, `scripting`, `history`, `cookies` ni acceso a otros sitios. La CSP de las páginas de la extensión es `script-src 'self'; object-src 'self'`: no hay código remoto. Lightweight Charts va dentro del build (Apache-2.0).

## Privacidad

No hace falta una API key. La extensión no lee balances, órdenes, formularios, cookies ni el almacenamiento de Binance o TradingView. El content script solo obtiene símbolo y temporalidad.

Lo único que sale del navegador son peticiones de mercado público a Binance Futures (`fapi.binance.com` y `fstream.binance.com`): velas históricas y la vela en curso. El símbolo viaja en esa URL porque es un dato de mercado, no de tu cuenta. Los hallazgos se calculan en el panel. En el manifest de Firefox eso se declara como `data_collection_permissions.required: ["websiteContent"]`.

El websocket vive en el panel mientras está abierto. El service worker de Manifest V3 se duerme y no mantiene un socket.
