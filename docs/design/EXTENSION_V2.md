# Extension v0.2: gestion de posicion, IA con tu propia clave y metricas de cuenta

Diseno (Opus, 2026-10-18). Estado: aprobado para implementar por tareas T0 a T14. Honestidad: la medicion de `docs/research/AUDIT_PATRONES_2026-10-18.md` no encontro patron ni indicador que supere al azar tras costes; la extension explica y gestiona riesgo, no promete rentabilidad.

## Decisiones

1. **Pestanas** Operacion / Analisis / Ajustes dentro del panel lateral. Toda la logica va en `apps/extension/src/lib/*` (vitest corre en `node`, no hay pruebas de componentes Svelte).
2. **Posicion abierta**: se detecta con una clave de **solo lectura** (Ed25519 generada dentro de la extension, no exportable; HMAC como respaldo en Firefox ESR). Leer la tabla de la pagina (DOM) es solo una pista opcional, protegida por una prueba de viabilidad (T0), nunca para metricas ni para la IA. Sin clave: entrada manual de la posicion y las mismas reglas.
3. **IA propia del usuario** desde el service worker (nunca desde la pagina). Lista curada de proveedores: OpenCode, OpenRouter, OpenAI, Anthropic, Gemini y localhost. No se permiten URL arbitrarias (exigiria `https://*/*`). Selector de modelos desde `GET https://opencode.ai/inference/v1/models`. Los modelos `*-free` pueden usar lo que se envia para entrenar: aviso de una linea.
4. **Historial y metricas**: primero importar un CSV (sin clave), luego API de solo lectura (ultimos ~6 meses), la lectura del DOM es opcional. La exportacion asincrona de Binance queda aplazada.
5. **Menos texto**: en modo `position` se muestra la tarjeta de posicion (6 lineas o menos), 3 reglas, grafico bajo; hallazgos, pulso, titulares y radar colapsados con resumen de una linea. En modo `flat` el dimensionador compacto. Nunca el dimensionador si puede haber una posicion abierta.
6. **Privacidad de la IA**: por defecto solo cifras relativas (porcentajes, R, apalancamiento, banderas), sin USD, cantidad, capital, ids ni marcas de tiempo absolutas. Cada llamada la inicia el usuario. Pantalla de consentimiento que nombra al proveedor y los campos.

## Modo del panel (reductor puro `lib/account/panel-mode.ts`)

`loading` (menos de 2 s sin snapshot) / `position` / `flat` / `unknown` / `no-data`. Si el snapshot caduca y el modo previo era `position`, se queda en `position` con `stale`: nunca se vuelve al dimensionador mientras pueda haber una posicion.

## Reglas deterministas (`lib/account/rules.ts`)

NO_STOP, STOP_BEYOND_LIQ, STOP_NEAR_LIQ (0,8 de la distancia a liquidacion), RISK_OVER_RULE, LEV_OVER_RULE, LIQ_CLOSE (menos de 3 ATR), DAILY_LIMIT, FUNDING_AGAINST, AVERAGING_DOWN, STOP_WIDENED, REVENGE, STALE. Texto de 90 caracteres o menos. Ninguna regla sugiere direccion, promediar, tomar ganancias ni "mover a break-even" como mejora.

## Seguridad

- Clave de lectura con lista cerrada de rutas (`READ_ALLOWLIST`), sin rutas de escritura; `acct:test` rechaza claves con retiros o trading habilitados.
- Guarda de remitente: los mensajes `acct:*` y `ai:*` solo desde el panel de la propia extension, nunca desde content scripts.
- Boveda en IndexedDB (origen de la extension), claves de IA selladas con AES-GCM (solo frena lectura casual, no malware con acceso al perfil).
- `host_permissions` de fapi con rutas; `optional_host_permissions` para proveedores de IA; sin `downloads`, `tabs`, `scripting`, `cookies` ni `<all_urls>`.
- CSP `connect-src` con lista exacta; sin dependencias nuevas de ejecucion.
- El texto del LLM se muestra solo como texto, sin `{@html}`; el contenido del DOM o de titulares nunca entra al prompt.
- CSV exportado a prueba de formulas.

## Tareas

| id | titulo | depende de |
|---|---|---|
| T0 | Prueba de viabilidad de la fuente de datos (API contra DOM) | clave nueva de Bel y capturas anonimizadas |
| T1 | Port de `grade_cell` a TypeScript | - |
| T2 | Esquema de ajustes (`rules`, `ai`, `domPositions`) | - |
| T3 | Tipos, posiciones y reductor de modo | - |
| T4 | Cliente firmado de solo lectura y boveda | - |
| T5 | Reglas deterministas | T3 |
| T6 | Planificador de historial | T3 |
| T7 | Importador de CSV | T3, cabecera real |
| T8 | Metricas y exportacion | T1, T3 |
| T9 | Proveedores de IA y cliente | - |
| T10 | Carga util y prompt de IA | T3, T5 |
| T11 | Enrutador del background y manifiesto | T2, T3, T4, T9 |
| T12 | Publicador DOM (opcional) | T0, T11 |
| T13 | Estructura de pestanas y reduccion de texto | T2, T3, T11 |
| T14 | UI de posicion, analisis, credenciales y documentos | T13, T5, T8, T10 |

Orden: T0 a T4 y T9 en paralelo; luego T5 a T8 y T10; luego T11, T12, T13 y T14 en ese orden (comparten `messages.ts`, `background.ts` y `App.svelte`).
