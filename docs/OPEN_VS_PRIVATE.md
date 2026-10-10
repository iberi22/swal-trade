# Qué es abierto y qué es privado

Decisión de Belal (ADR-007 D2, 2026-10-09). Este repositorio (`swal-trade`) es **AGPL-3.0**. Una parte de la lógica del laboratorio es **propietaria** y vive en un repositorio privado. Este documento fija la frontera, para que ninguna contribución la cruce por error.

## Abierto (este repo, AGPL-3.0)

| Pieza | Ruta |
|---|---|
| Guardián de riesgo web y self-host | `workers/public-site/static/guardian/`, `scripts/guardian/` |
| Núcleo de análisis determinista (patrones, niveles, tendencia, perfil de volumen) | `workers/public-site/static/analisis/analysis-core.js` |
| Explicador con IA del sitio: endpoint, prompt, validación, respaldo determinista y controles de abuso | `workers/public-site/src/explain{,-prompt}.js`, `workers/public-site/static/analisis/explain-ui.js`, `packages/mcp/src/explain.ts` |
| Página de análisis, landing, precios, legales y checkout | `workers/public-site/static/` |
| Extensión de navegador (WXT + Svelte 5) | `apps/extension/` |
| Servidor MCP de **solo lectura** (`analyze_chart`, `market_context`, `explain_analysis`, `account_risk`, `propose_order`) | `packages/mcp/` |
| Núcleo de riesgo y validación de órdenes | `crates/synapse-core/` (`risk.rs`, `sizing.rs`, `order_guard.rs`) |
| Capa de noticias: adaptadores y normalización (las keys son secretos del despliegue, nunca código) | `workers/public-site`, `packages/mcp` |
| Tabla **agregada** de tasas de acierto históricas, cuando se publique: tipo, temporalidad, símbolo, n, tasa, intervalo y línea base | `hit-rates.public.json` |

## Privado (repo `synapse-trading`, no se publica)

- **Automatización de compra/venta:** daemon, orquestador y ejecución automática de órdenes.
- **Estrategias y señales** del laboratorio, incluido su research y sus parámetros.
- **Calibración propietaria:** el arnés de backtests que mide las tasas de acierto, los resultados por operación y los ajustes de pesos derivados de ellos. Solo se publica la tabla agregada.
- **Prompts y configuración del agente IA** del servicio alojado.
- **Cobro (billing-worker)** y operación: claves, direcciones, listas de sanciones.

## Reglas

1. El código abierto **no importa** nada del repo privado, y viceversa salvo por interfaces públicas (p. ej. el contrato de `analyze()`).
2. El MCP abierto expone **análisis, riesgo y propuestas**. Las herramientas que envían órdenes, si llegan, solo ejecutan instrucciones explícitas del usuario, con sus keys, sus límites y `order_guard`. **Nunca** exponen señales ni estrategias del laboratorio.
3. Ningún texto público promete rentabilidad. La "fuerza del patrón" no es una probabilidad. Un "% de acierto" solo se muestra si viene de la tabla agregada con *n*, periodo y comparación contra una línea base aleatoria.
4. **Gratis durante el desarrollo.** La membresía Socio SWAL (USD 10) está anunciada como "próximamente" y pagará solo el respaldo cifrado y el servicio alojado.
5. Antes de cada push al repo público se ejecutan el leak gate y gitleaks (hook del repositorio y `scripts/ci-local.sh`).
