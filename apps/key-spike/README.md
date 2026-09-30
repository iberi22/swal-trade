# key-spike — firma no custodiada en el navegador (Binance USDⓈ-M Futures TESTNET)

Spike mínimo, sin dependencias, que demuestra que una **clave privada generada dentro del
navegador** puede firmar peticiones contra la API de Binance sin que la clave salga del
dispositivo.

- `index.html` + `app.js` + `styles.css`: la página (módulos ES planos, sin frameworks,
  sin scripts externos).
- `signing.js`: módulo puro de ayuda (construcción de query, PEM, hex, base64, firma).
- `signing.test.mjs`: pruebas con `node --test`.

El endpoint está **fijado por constante** a `https://testnet.binancefuture.com`. No hay
ningún campo ni bandera para cambiar a mainnet.

## Qué demuestra

1. La clave privada se genera con `crypto.subtle.generateKey(..., extractable = false)`.
   El objeto `CryptoKey` se guarda directamente en IndexedDB (structured clone permitido);
   nunca se llama a `exportKey` sobre la parte privada. El material de la clave no se puede
   leer, ni por el código de la página.
2. La misma clave firma de verdad: HMAC-SHA256, RSASSA-PKCS1-v1_5 y Ed25519.
3. Las peticiones firmadas funcionan contra el testnet real.

## Cómo ejecutarlo

WebCrypto exige un contexto seguro. `localhost` cuenta como tal, así que basta con:

```bash
cd apps/key-spike
python3 -m http.server 8080
# abrir http://localhost:8080
```

Pruebas del módulo puro (no requieren servidor ni red):

```bash
node --test apps/key-spike/
```

## Paso a paso con Binance Futures Testnet

1. Genera **clave RSA** o **clave Ed25519** y copia el PEM de la clave pública.
2. Ve a <https://testnet.binancefuture.com> e inicia sesión.
3. En **API Management** crea una clave usando la opción de clave pública autogenerada
   (**Self-Generated RSA/Ed25519 Public Key**) y pega el PEM.
4. Copia la **API key** que te devuelve y pégala en el campo "API key" de la página;
   pulsa **Guardar API key**.
5. Opcional pero recomendado: en la página, **Sincronizar reloj** para corregir el desfase
   de tu reloj con el del servidor.
6. **Consultar balance**. Debe devolver tu balance de testnet.
7. **Orden de prueba**: crea un LIMIT BUY de 0.002 BTCUSDT al 50 % del mark price
   actual (redondeado a tick 0.1), es decir, muy lejos del mercado. No se ejecuta nunca.
   El `orderId` queda en el campo de texto.
8. **Cancelar orden** con ese `orderId`.

### HMAC en vez de RSA/Ed25519

Si prefieres el esquema clásico: **Usar clave HMAC** y pega el *API secret* de testnet.
El campo se borra inmediatamente y el secreto se importa como `CryptoKey` no exportable
(`importKey('raw', …, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`). La firma se
envía como hex. Con HMAC la clave privada **sí** salió del dispositivo al crearse en el
panel de Binance: el resto del spike (generación, no exportabilidad, borrado) es igual,
pero la garantía de no-custodia solo es completa con RSA o Ed25519.

### WebSocket

**Conectar y probar** abre `wss://testnet.binancefuture.com/ws-fapi/v1`, envía
`session.logon` con `apiKey`, `timestamp` y la firma Ed25519 sobre el payload de
parámetros ordenados alfabéticamente y unidos por `&`, y a continuación una consulta de
cuenta. El nombre del método de consulta es editable en la página
(por defecto `v2/account.balance`) porque la documentación del WS API cambia; también
puedes usar `account.status`.

## Qué prueba cada botón

| Botón | Qué demuestra |
| --- | --- |
| Generar clave RSA | Generación de RSASSA-PKCS1-v1_5 2048 no exportable y PEM SPKI legible |
| Generar clave Ed25519 | Generación Ed25519 no exportable y PEM SPKI |
| Usar clave HMAC | Importación de un secreto como clave no exportable, con borrado del campo |
| Guardar API key | Persistencia de un valor no secreto en IndexedDB |
| Copiar PEM | Exportación de la **pública** (nunca la privada) |
| Sincronizar reloj | Offset de reloj aplicado al `timestamp` |
| Consultar balance | GET `/fapi/v2/balance` firmado |
| Orden de prueba | POST `/fapi/v1/order` LIMIT lejos del mercado + lectura de `orderId` |
| Cancelar orden | DELETE `/fapi/v1/order` firmado |
| Probar `/fapi/v1/order/test` | POST al endpoint de validación, sin crear orden |
| Borrar claves | Eliminación de los registros de IndexedDB |
| Conectar y probar (WS) | `session.logon` firmado con Ed25519 sobre WebSocket |

## Modelo de amenazas (notas)

- **Claves no exportables.** `extractable: false` significa que ni siquiera el JavaScript de
  esta página puede extraer la clave privada. Un `postMessage`, una ruta de depuración o
  cualquier intento de `exportKey` sobre la parte privada falla.
- **XSS sigue siendo fatal mientras la página está comprometida.** La no exportabilidad
  impide *robar* la clave, no *usarla*. Si un atacante inyecta script en esta página, puede
  firmar peticiones arbitrarias con la clave mientras el documento esté abierto. Por eso el
  CSP es estricto (`script-src 'self'`, sin `unsafe-inline`, `base-uri 'none'`,
  `form-action 'none'`) y todo el DOM se actualiza con `textContent`, nunca con
  `innerHTML`. Aun así, la página es un spike, no una billetera.
- **Sin red de terceros.** `connect-src` está limitado a los hosts de testnet, así que la
  página no puede enviar la clave (ni las firmas) a ningún otro destino.
- **Solo testnet.** La constante de base URL no es configurable en la UI y la CSP bloquea
  cualquier otro host. Aun así, trata las claves de testnet como si fueran reales: los
  endpoints son los mismos.
- **Borrar claves.** Los objetos `CryptoKey` en IndexedDB se eliminan con
  `objectStore.clear()`, pero la clave ya usada pudo haber firmado peticiones que un
  atacante guardó. Rotar en el panel de Binance es la única rotación real.
- **Sin localStorage.** Nada se escribe fuera de IndexedDB, para que el rastro sea
  explícito y borrable con "Borrar datos de sitios".
- **El API key no es secreto** (va en la cabecera `X-MBX-APIKEY`), pero se trata como
  sensible igual: sin él, la clave privada sola no sirve de nada.

## Estructura

```
apps/key-spike/
  index.html      página, CSP en <meta>
  app.js          lógica de UI, IndexedDB, REST firmado, WebSocket
  signing.js      helpers puros (buildQuery, toPem, hexOf, b64Of, firmas)
  styles.css      estilos
  signing.test.mjs  node --test
  README.md       este archivo
```
