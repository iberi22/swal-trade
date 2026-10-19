# Modelo de Seguridad (Security Model)

Este documento complementa el [resumen de amenazas y vulnerabilidades](./SECURITY.md) para detallar las garantías verificables sobre la ejecución segura del sistema.

## Garantías de Seguridad

| Garantía | Mecanismo | Prueba |
|----------|-----------|--------|
| Se permite una orden que cumple todas las reglas | `packages/mcp/test/order-guard.test.mjs` | packages/mcp/test/order-guard.test.mjs::allows a compliant order |
| El stop de pérdida es obligatorio y debe estar dentro de la distancia de liquidación | `packages/mcp/test/order-guard.test.mjs` | packages/mcp/test/order-guard.test.mjs::the stop is mandatory and must be inside the safe liquidation distance |
| El límite nocional rechaza cualquier orden por encima de SWAL_MAX_NOTIONAL_USD | `packages/mcp/test/order-guard.test.mjs` | packages/mcp/test/order-guard.test.mjs::the notional cap refuses anything above SWAL_MAX_NOTIONAL_USD |
| El bloqueo de pérdida diaria rechaza nuevas órdenes y no puede omitirse | `packages/mcp/test/order-guard.test.mjs` | packages/mcp/test/order-guard.test.mjs::the daily loss lock refuses new orders and cannot be skipped |
| Se rechaza estrictamente la red mainnet sin confirmación | `packages/mcp/test/testnet-guard.test.mjs` | packages/mcp/test/testnet-guard.test.mjs::validateTestnetSafety strictly refuses mainnet |
| Se rechaza cualquier configuración de confirmación mainnet insegura | `packages/mcp/test/testnet-guard.test.mjs` | packages/mcp/test/testnet-guard.test.mjs::validateTestnetSafety refuses any SWAL_MCP_MAINNET_CONFIRM |
| Faltar claves de testnet genera rechazo sin filtrar los secretos | `packages/mcp/test/testnet-guard.test.mjs` | packages/mcp/test/testnet-guard.test.mjs::parseTestnetEnv refuses missing keys without leaking secrets |
| El trading de escritura está apagado a menos que la bandera lo habilite | `packages/mcp/test/trading-config.test.mjs` | packages/mcp/test/trading-config.test.mjs::trading is off unless the flag says enabled |
| Usar mainnet requiere tanto la bandera de red como confirmación explícita | `packages/mcp/test/trading-config.test.mjs` | packages/mcp/test/trading-config.test.mjs::mainnet needs both the network flag and the confirmation |
| El límite nocional y de pérdida diaria son requisitos para escribir órdenes | `packages/mcp/test/trading-config.test.mjs` | packages/mcp/test/trading-config.test.mjs::the notional cap and the daily loss limit are required for writes |
| La API de control restringe el tamaño del body, la autorización y el estado de salud | `packages/mcp/test/chart-bridge.test.mjs` | packages/mcp/test/chart-bridge.test.mjs::daemon control API: auth, health shape, body cap, and extension-not-connected error |
| El servidor Radar se vincula y no expone cabeceras CORS permisivas | `radar/tests/test_api_contract.py` | radar/tests/test_api_contract.py::test_health_contract_and_no_cors_headers |
| Enviar notas al Radar verifica la longitud y requiere token de autenticación | `radar/tests/test_api_contract.py` | radar/tests/test_api_contract.py::test_post_note_token_auth_and_length |
| La extensión solo llama a una lista cerrada de rutas de lectura de Binance (solo GET); una ruta fuera de la lista falla antes de salir a la red | `apps/extension/src/lib/account/binance-signed.ts` | apps/extension/src/lib/account/binance-signed.test.ts::rutas fuera de la lista fallan antes de fetch |
| Los mensajes `acct:*` y `ai:*` solo los atiende el background cuando vienen del panel de la propia extensión, nunca de un content script | `apps/extension/src/lib/background/router.ts` | apps/extension/src/lib/background/router.test.ts::rejects content scripts and foreign senders for every acct:* and ai:* message |
| La clave privada Ed25519 se genera dentro de la extensión y no se puede exportar | `apps/extension/src/lib/account/vault.ts` | apps/extension/src/lib/account/vault.test.ts::devuelve PEM publico y una privada no exportable |
| Una clave con permiso de retiros habilitado se rechaza y no se guarda | `apps/extension/src/lib/background/router.ts` | apps/extension/src/lib/background/router.test.ts::refuses a key with withdrawals enabled |
| La carga útil enviada a la IA no lleva valores absolutos (importes, cantidades, capital, ids, fechas) en modo relativo | `apps/extension/src/lib/ai/payload.ts` | apps/extension/src/lib/ai/payload.test.ts::relative mode leaks no absolute values |
| La CSP limita `connect-src` a una lista exacta de destinos | `apps/extension/wxt.config.ts` | apps/extension/src/lib/manifest-guard.test.ts::should keep connect-src to the exact list |
| El manifest no pide permisos prohibidos (`downloads`, `tabs`, `scripting`, `cookies`, `<all_urls>`) | `apps/extension/wxt.config.ts` | apps/extension/src/lib/manifest-guard.test.ts::should not contain forbidden permissions for chrome |
| Ninguna respuesta del background lleva la clave de API, el secreto ni la clave de la IA | `apps/extension/src/lib/background/router.ts` | apps/extension/src/lib/background/router.test.ts::never replies with the key or the secret |

## Qué NO está garantizado

Este modelo de seguridad es una mitigación estructurada, pero **no garantiza** inmunidad contra todo riesgo. Los siguientes escenarios están fuera de cobertura:
* **Caídas del exchange:** La red puede no responder y las órdenes pueden fallar por problemas en Binance (ej. timeout prolongado).
* **Una clave filtrada o exfiltrada:** Si el dispositivo es vulnerado y un actor lee tu clave de API, las garantías locales no pueden prevenir su uso desde otro cliente.
* **Procesos locales maliciosos:** Un malware en la máquina del usuario con permisos suficientes puede evadir los controles locales.
* **Errores de usuario:** El sistema aplica límites duros, pero una configuración inadecuada en los parámetros (ej. stop excesivamente alejado) no será prevenida si cumple las reglas matemáticas.
* **Ningún sistema aquí predice el éxito:** Este software es puramente infraestructural y autodirigido. Absolutamente nada en este modelo ni en las herramientas **garantiza ganancia** ni ninguna clase de rentabilidad; operar en mercados implica riesgo de pérdida total.
* **Lo que hace el proveedor de IA con los datos:** al pulsar «Analizar», la extensión envía la carga útil que ves en «Ver lo que se envía» al proveedor que elegiste, con tu propia clave. Qué guarda, registra o usa ese proveedor está fuera de nuestro control y de esta tabla.
* **Malware con acceso al perfil del navegador:** la bóveda sella las claves de IA con AES-GCM solo para frenar una lectura casual. Un programa malicioso con acceso a tu perfil puede leer lo que la extensión puede leer.
* **Modelos gratuitos:** los modelos `*-free` pueden usar lo que envías para entrenar. El panel lo avisa, pero no puede impedirlo.
* **Una clave con futuros habilitados puede operar en Binance:** la extensión solo tiene rutas de lectura y rechaza claves con retiros, pero si la clave que pegaste tiene trading de futuros habilitado, cualquier otro programa que la tenga puede abrir y cerrar órdenes en Binance. Usa una clave de solo lectura con IP restringida.
