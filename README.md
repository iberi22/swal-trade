# swal-trade

Asistente de trading **no custodial** para Binance Futures, como PWA: **tus claves nunca salen de tu navegador**. Sin tokens propios, sin custodia, sin backend que toque tus claves.

> Herramienta autodirigida, no asesoría de inversión. Operar con derivados apalancados puede hacerte perder todo el capital.

Copyright (c) Brahyan Belalcazar (SWAL). Licencia [GNU AGPL-3.0](LICENSE).

## Estado

Fase temprana.

- Página pública de solo lectura en producción: <https://trade.swal.network> (estado operativo y ranking de bots en paper trading; código en [`workers/public-site`](workers/public-site)).
- La PWA (bóveda de claves, cliente de Binance, guardián de riesgo, diario) está **en desarrollo**: todavía no hay código en `apps/` ni `crates/`.

## Cómo comprobar que las claves no salen de tu navegador

La promesa no se basa en confiar en nosotros, sino en poder verificarla. Estado de cada mecanismo (todos **en construcción** hasta que exista la PWA):

| Verificación | Estado |
|---|---|
| CSP estricta con `connect-src` limitada a los dominios del exchange y del Worker SWAL: el navegador no puede enviar datos a otro destino | en construcción |
| Código del cliente abierto y auditable (este repositorio) | parcial: hoy solo la página pública |
| Build reproducible con hash publicado y attestation de procedencia | en construcción |
| Clave generada en el dispositivo y no extraíble (WebCrypto), sin permiso de retiro | en construcción |

Los requisitos de manejo de claves están en [SECURITY.md](SECURITY.md).

## Estructura del repositorio

```text
workers/public-site/   Worker de Cloudflare + página estática pública (/operativa)
crates/                Núcleo en Rust compilado a WASM (synapse-core), aún sin código
apps/                  La PWA, aún sin código
docs/                  Contrato del snapshot público
scripts/               Publicador del snapshot, unidades systemd, CI local
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

**swal-trade** is a non-custodial trading assistant PWA for Binance Futures. Your API keys never leave your browser: no custody, no tokens, no server that ever sees your keys.

- **Status:** early. A read-only public page is live at <https://trade.swal.network> (source in `workers/public-site`). The PWA is in development; `apps/` and `crates/` are placeholders.
- **How to verify the no-key-exfiltration claim** (all under construction): strict CSP with a closed `connect-src`, open-source client code, reproducible build with a published hash.
- **Security policy:** see [SECURITY.md](SECURITY.md). Use "Report a vulnerability" in the Security tab (GitHub private reporting).
- **Disclaimer:** self-directed tool, not investment advice. Leveraged derivatives can lose your entire capital.
- **License:** GNU AGPL-3.0. Copyright (c) Brahyan Belalcazar (SWAL).
