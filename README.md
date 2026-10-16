# swal-trade

Asistente de trading **no custodial** para Binance Futures, como PWA: **tus claves nunca salen de tu equipo**. Sin tokens propios, sin custodia, sin backend que toque tus claves.

> Herramienta autodirigida, no asesoría de inversión. Operar con derivados apalancados puede hacerte perder todo el capital.

Copyright (c) Brahyan Belalcazar (SWAL). Licencia [GNU AGPL-3.0](LICENSE).

## Estado

Fase de pruebas: **todo es gratis** mientras se verifica que funciona (ver [precios](https://trade.swal.network/pricing/)). Lo que hay hoy:

| Pieza | Qué es | Dónde |
|---|---|---|
| Sitio público | Análisis de gráficos en el navegador, Guardián de riesgo web, estado operativo del bot en paper, respaldo cifrado, páginas legales. <https://trade.swal.network> | [`workers/public-site`](workers/public-site) |
| Extensión de navegador | Panel lateral junto al gráfico de Binance Futures: patrones, tamaño de posición, pulso de mercado, pintado sobre el gráfico. Se instala a mano (aún no está en las tiendas): <https://trade.swal.network/extension/> | [`apps/extension`](apps/extension) |
| Servidor MCP | Análisis, contexto de mercado, riesgo de cuenta y puente al gráfico para **tu propia herramienta de IA en local** (Claude Code, Codex CLI, opencode…). Las herramientas que envían órdenes vienen desactivadas | [`packages/mcp`](packages/mcp) |
| Guardián de riesgo (Python, sin dependencias) | Vigila tu cuenta con una clave de **solo lectura** y avisa por Telegram del límite diario, del apalancamiento y de las posiciones sin stop | [`scripts/guardian`](scripts/guardian) |
| Núcleo de riesgo | Cálculo de riesgo, tamaño y validación de órdenes en Rust (WASM) | [`crates/synapse-core`](crates/synapse-core) |

Lo que **no** está aquí (repositorio privado, ver [`docs/OPEN_VS_PRIVATE.md`](docs/OPEN_VS_PRIVATE.md)): la automatización de órdenes, las estrategias, el cobro y el servicio local de radar. Ningún patrón ni estrategia tiene una ventaja estadística validada; no vendemos señales.

## Cómo comprobar que las claves no salen de tu equipo

La promesa no se basa en confiar en nosotros, sino en poder verificarla:

| Verificación | Estado |
|---|---|
| CSP estricta con `connect-src` limitada por página (el Guardián solo habla con Binance, Telegram y el servicio de licencias): el navegador no puede enviar datos a otro destino | implementada: `cspFor` en [`workers/public-site/src/worker.js`](workers/public-site/src/worker.js) y sus tests |
| Código del cliente abierto y auditable (este repositorio) | sí |
| Servidor MCP y guardián local: las claves viven en tu entorno y solo van a Binance | sí; el MCP no tiene herramientas de retiro y las de órdenes están apagadas por defecto |
| Build reproducible con hash publicado y attestation de procedencia | en construcción |
| Secreto no extraíble en el navegador (WebCrypto), sin permiso de retiro | implementado en el Guardián web: el secreto se importa como `CryptoKey` HMAC con `extractable: false` en IndexedDB (nunca vuelve a ser texto) y la API key, que es la parte pública del par, queda en `localStorage`. El Guardián avisa si la clave tiene retiros habilitados; usa siempre una sin permiso de retiro (`binance-ro.js`) |

Los requisitos de manejo de claves están en [SECURITY.md](SECURITY.md).

## Estructura del repositorio

```text
workers/public-site/   Worker de Cloudflare y sitio estático (análisis, guardián, respaldo, legales)
apps/extension/        Extensión MV3 (WXT + Svelte 5)
packages/mcp/          Servidor MCP por stdio y puente al gráfico
crates/synapse-core/   Núcleo de riesgo en Rust, compilado a WASM
scripts/guardian/      Guardián de riesgo para ejecutar en tu máquina (Python estándar)
scripts/               Publicador del snapshot, unidades systemd, CI local
e2e/                   Pruebas de extremo a extremo (Playwright, MCP stdio)
docs/                  Contrato del snapshot, fuentes de patrones, abierto frente a privado
.github/               CI (tests, gitleaks), Dependabot
```

## Desarrollo

```bash
scripts/ci-local.sh        # tests de Node + gitleaks si está instalado
```

## Seguridad

Para reportar una vulnerabilidad, lee [SECURITY.md](SECURITY.md).

---

## English (short)

**swal-trade** is a non-custodial trading assistant for Binance Futures. Your API keys stay on your machine: no custody, no tokens, no server that ever sees them.

- **Status:** testing phase, everything free. A website with in-browser chart analysis and a risk guardian, a browser extension, an MCP server (use it from your own AI CLI, locally: Claude Code, Codex CLI, opencode…), a stdlib-only Python risk guardian and a Rust/WASM risk core are all in this repository.
- **Not here:** order automation, strategies, billing and the local radar service live in a private repository (see `docs/OPEN_VS_PRIVATE.md`). No pattern or strategy has a validated statistical edge; we do not sell signals.
- **Security policy:** see [SECURITY.md](SECURITY.md). Use "Report a vulnerability" in the Security tab (GitHub private reporting).
- **Disclaimer:** self-directed tool, not investment advice. Leveraged derivatives can lose your entire capital.
- **License:** GNU AGPL-3.0. Copyright (c) Brahyan Belalcazar (SWAL).
