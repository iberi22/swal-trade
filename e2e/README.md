# e2e

Pruebas de extremo a extremo del repo público `swal-trade`. No usan claves reales: Binance, alternative.me y `pay.swal.network` se interceptan.

Tres áreas:

1. **Sitio** (`workers/public-site`), servido por `npx wrangler@4.149.0 dev --local --port <libre>` desde Playwright `webServer`. Wrangler 4.118 (workerd hasta 2026-08-06) no arranca `compatibility_date = "2026-09-16"`.
2. **Extensión** (`apps/extension/.output/chrome-mv3`) en Chromium con `--load-extension` y headless new.
3. **MCP** (`packages/mcp`) por STDIO con el cliente del SDK. El CLI llama a `fetch` global (`createServer()` sin `fetchFn`); `mcp/fetch-preload.mjs` lo sustituye con `--import`.

## Cómo correrlo

Desde la raíz del repo, o desde aquí:

```bash
./e2e/run-all.sh
```

El script instala dependencias, Chromium de Playwright, construye la extensión y el MCP, elige un puerto libre (`E2E_PORT`) y corre las tres áreas. No hace commit, push ni deploy.

Por separado, con el build ya hecho:

```bash
cd e2e
npm install
npx playwright install chromium
export E2E_PORT=18787   # o un puerto libre
npx playwright test --project=site
npx playwright test --project=extension   # exige apps/extension/.output/chrome-mv3
npm run e2e:binance-live                  # opcional: red + página pública de Binance
node mcp/stdio.test.mjs                   # exige packages/mcp/dist
```

`E2E_REUSE=1` reutiliza un `wrangler dev` que ya responda en ese puerto.

## Navegador en NixOS

En NixOS 25.05, `npx playwright install chromium` baja el build de fallback `ubuntu20.04-x64` (Chromium 141.0.7390.37, Playwright build v1194 para `@playwright/test` 1.56.1) a `~/.cache/ms-playwright/chromium-1194`. Ese binario arrancó en esta máquina sin `nix shell` ni `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Si en otra NixOS el dynamic linker rechaza ese binario:

1. `PLAYWRIGHT_BROWSERS_PATH` con los browsers de nix, por ejemplo `nix shell nixpkgs#playwright-driver.browsers`. La revisión tiene que coincidir con `@playwright/test` 1.56.1.
2. `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/ruta/al/chromium` (el config de Playwright lo pasa como `executablePath`; el test de la extensión también).

La extensión necesita el modo headless nuevo (`--headless=new` en `launchPersistentContext`) y `ignoreDefaultArgs: ['--disable-extensions']`.

## Qué cubre

- Cada página (`/`, `/pricing/`, `/analisis/`, `/guardian/`, `/guardian/self-host/`, `/checkout/`, `/operativa/`, `/terms/`, `/privacy/`, `/risk/`, `/contact/`) responde 200, con las mismas directivas CSP que `cspFor` en `workers/public-site/src/worker.js` (el orden puede diferir: en local, `_headers` coloca `connect-src` antes de `base-uri` en las rutas sin bloque propio). Sin errores de consola ni `securitypolicyviolation`. Los enlaces visibles de nav y pie navegan (en `/guardian/` el enlace Self-host del plan Pro está oculto; se pulsa el visible).
- Afirmaciones de rentabilidad: la misma expresión que `workers/public-site/test/site-pages.test.mjs`. `/risk/` puede decir «rentabilidad pasada». `/operativa/` conserva la etiqueta de KPI «Win Rate» (ese test de páginas no escanea el panel).
- `/analisis/`: velas con un doble suelo conocido, canvas, lista con «fuerza» y sin «probabilidad», clic que enfoca, cambio de temporalidad que pide `interval=1h&limit=500`, miedo y codicia mockeado.
- `/checkout/`: contrato de `billing-worker` (`/v1/plans`, alta, factura, poll pending→paid, `/v1/license`). El secreto se muestra una vez y el botón sigue al checkbox. Importe `10.0037`, QR SVG, `localStorage['swal.license']`.
- `/guardian/`: cuenta firmada (mock) que rompe el límite diario y tiene BTC sin stop. El plan gratis vigila solo la posición grande. Pro entra con un token Ed25519 generado en el test (`node:crypto`) y la SPKI servida en el mock de `/v1/pubkey`.
- Extensión: panel lateral `sidepanel.html`, gráfico y hallazgos.
- **Opcional**, `npm run e2e:binance-live` (o `E2E_BINANCE_LIVE=1 npx playwright test --project=binance-live`): contra la página pública `https://www.binance.com/en/futures/BTCUSDT`. Necesita red, descarga la página de verdad y tarda ~30 s. Comprueba que la extensión pinta los niveles en la pestaña Trading View del gráfico de Binance y que los borra al apagar el interruptor. Sin la variable de entorno la prueba se salta.
- MCP: `listTools` solo tiene `account_risk`, `analyze_chart`, `market_context`, `propose_order`. `analyze_chart` y `propose_order` (`sent: false`). Ningún POST.
