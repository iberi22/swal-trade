# Política de seguridad

## Reportar una vulnerabilidad

Usa el reporte privado de GitHub: en la pestaña **Security** de este repositorio, pulsa **Report a vulnerability**. No abras issues públicos ni publiques detalles hasta que haya un arreglo.

Incluye: componente afectado, pasos para reproducir, impacto y, si puedes, una propuesta de corrección. Confirmaremos la recepción lo antes posible y coordinaremos la divulgación contigo.

Prioridad máxima: cualquier ruta por la que una clave, una firma o un saldo de un usuario pueda salir del navegador o quedar accesible a otro código.

**Alcance:** todo el contenido de este repositorio y el sitio <https://trade.swal.network>. Fuera de alcance: ataques de denegación de servicio volumétricos e ingeniería social.

## Resumen del modelo de amenazas

La PWA (en desarrollo) manejará claves de API de Binance Futures. Amenazas consideradas:

| Amenaza | Riesgo | Mitigación prevista |
|---|---|---|
| **XSS** | Un script inyectado lee o usa la clave | CSP estricta sin `unsafe-inline`, Trusted Types, SRI, cero scripts de terceros; clave no extraíble (WebCrypto), de modo que un XSS puede pedir firmas mientras la app esté desbloqueada, pero no exfiltrar la clave; guardián de riesgo antes de firmar |
| **Extensiones de navegador maliciosas** | Leen la página, la memoria o el almacenamiento | Bóveda en Web Worker aislado, autobloqueo, material descartado al bloquear; recomendar un perfil de navegador limpio. No se puede garantizar protección total frente a una extensión con permisos amplios |
| **Cadena de suministro** | Una dependencia o el build introducen código malicioso | Dependencias fijadas y auditadas (`pnpm audit`, `cargo audit`), acciones de CI fijadas por SHA, Dependabot, build reproducible con hash publicado, attestation de procedencia |
| **Dispositivo robado o comprometido** | Acceso a datos locales | Cifrado en reposo (AES-GCM) con clave derivada de passkey o de frase con Argon2id, autobloqueo, clave sin permiso de retiro, subcuenta con saldo limitado |

Límite inherente: un navegador no puede usar lista blanca de IP en la API key, por lo que se recomienda una subcuenta con saldo acotado.

## Requisitos obligatorios para las claves de los usuarios

1. **Sin permiso de retiro**, siempre. La app lo comprueba y rechaza la clave si lo tiene.
2. Preferir clave **generada en el dispositivo y no extraíble**; HMAC solo con aviso de que es la opción menos protegida.
3. Cifrado en reposo (AES-GCM) con clave derivada de **passkey (WebAuthn PRF)** o de una frase con **Argon2id** (>= 19 MiB, t=2, p=1, OWASP). Nada de `localStorage`.
4. **Autobloqueo** por inactividad; al bloquear se descarta todo material en memoria.
5. **CSP estricta** sin `unsafe-inline`, Trusted Types, SRI, **cero scripts de terceros**, `connect-src` cerrada, dependencias fijadas y auditadas (`pnpm audit` en el CI local).
6. **Build reproducible con hash publicado** y código del cliente abierto para auditoría.
7. Ninguna clave, firma ni saldo pasa por el Worker ni por logs; verificable por CSP y código.
8. Recomendar **subcuenta** con saldo limitado y explicar que un navegador no puede usar lista blanca de IP.
9. **Confirmación explícita** de cada orden (hasta que el usuario active automatización con límites), y límites de riesgo aplicados antes de firmar.
10. Aviso de **disponibilidad por país** (Futures no disponible para residentes de EE. UU., Reino Unido minorista, etc.) y bloqueo de la función de pago para esos residentes.
11. Aviso legal: **herramienta autodirigida, no asesoría de inversión**.

Estos requisitos describen el diseño objetivo de la PWA; hoy todavía no hay código de cliente que los implemente.

## Secretos en este repositorio

Este repositorio no debe contener claves, tokens ni archivos `.env`. El CI ejecuta gitleaks sobre todo el historial. Si encuentras un secreto, repórtalo por el canal privado de arriba.
