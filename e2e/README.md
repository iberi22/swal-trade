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
node mcp/stdio.test.mjs                   # exige packages/mcp/dist
```

`E2E_REUSE=1` reutiliza un `wrangler dev` que ya responda en ese puerto.

## Navegador en NixOS

En NixOS 25.05, `npx playwright install chromium` baja el build de fallback `ubuntu20.04-x64` (Chromium 141.0.7390.37, Playwright build v1194 para `@playwright/test` 1.56.1) a `~/.cache/ms-playwright/chromium-1194`. Ese binario arrancó en esta máquina sin `nix shell` ni `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Si en otra NixOS el dynamic linker rechaza ese binario:

1. `PLAYWRIGHT_BROWSERS_PATH` con los browsers de nix, por ejemplo `nix shell nixpkgs#playwright-driver.browsers`. La revisión tiene que coincidir con `@playwright/test` 1.56.1.
2. `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/ruta/al/chromium` (el config de Playwright lo pasa como `executablePath`; el test de la extensión también).

La extensión necesita el modo headless nuevo (`--headless=new` en `launchPersistentContext`) y `ignoreDefaultArgs: ['--disable-extensions']`.

## Cobertura

| Área | Archivo | Qué comprueba |
|---|---|---|
| Sitio | `site.spec.ts` | `/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/pricing/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/analisis/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/guardian/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/guardian/self-host/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/checkout/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/operativa/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/terms/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/privacy/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/risk/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/contact/` HTTP 200 y Content-Security-Policy |
| Sitio | `site.spec.ts` | `/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/pricing/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/analisis/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/guardian/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/guardian/self-host/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/checkout/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/operativa/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/terms/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/privacy/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/risk/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | `/contact/` renderiza sin errores de consola, violaciones CSP, ni promesas de rentabilidad |
| Sitio | `site.spec.ts` | los enlaces de nav y pie abren un documento 200 |
| Sitio | `analisis.spec.ts` | gráfico, fuerza, foco, temporalidad y miedo y codicia |
| Sitio | `analisis.spec.ts` | el panel de CVD se pinta bajo el gráfico con velas que traen volumen taker |
| Sitio | `analisis.spec.ts` | sin volumen taker el panel de CVD lo dice en lugar de inventar flujo |
| Sitio | `checkout.spec.ts` | secreto una vez, importe exacto, QR, sondeo hasta pago, licencia guardada |
| Sitio | `guardian.spec.ts` | el plan gratis muestra el exceso diario y solo la posición mayor |
| Sitio | `guardian.spec.ts` | una licencia Ed25519 válida desbloquea Pro |
| Extensión | `extension.spec.ts` | el panel lateral renderiza el gráfico y hallazgos desde velas mockeadas |
| Extensión | `extension.spec.ts` | la capa de gráfico renderiza cada hallazgo principal, no solo el seleccionado |
| Extensión | `extension.spec.ts` | el panel de CVD pinta el flujo de volumen de las velas mockeadas |
| Extensión | `extension.spec.ts` | la tarjeta de noticias muestra titulares de la api mockeada con tiempo relativo y sentimiento |
| Extensión | `extension.spec.ts` | la tarjeta de noticias se degrada a una nota cuando el servicio no tiene nada |
| Extensión | `extension.spec.ts` | los ajustes persisten en storage.local y controlan el símbolo y temporalidad |
| MCP | `stdio.test.mjs` | `listTools` devuelve solo las 5 permitidas y ninguna es de escritura ni destructiva |
| MCP | `stdio.test.mjs` | `analyze_chart` devuelve un doble suelo con fuerza y sin etiqueta de probabilidad |
| MCP | `stdio.test.mjs` | `propose_order` formula una orden tipo MARKET con stop y `sent: false` |
| MCP | `stdio.test.mjs` | no se hace ningún POST, solo peticiones GET a Binance (klines y premiumIndex) |

## Fuera de alcance

- Claves de Binance reales.
- Pagos reales.
- Despliegues.
- El overlay del gráfico nativo de Binance.
