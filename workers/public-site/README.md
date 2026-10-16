# SynapseTrader — Dashboard Público (`trade.swal.network`)

Sitio web público y de solo lectura (sin registro ni autenticación para visitantes) para consultar el estado operativo, ranking de bots por puntos, posiciones abiertas y curva de capital de **SynapseTrader**.

Basado en el contrato de datos `synapse.public.snapshot/v1` documentado en `docs/SNAPSHOT_CONTRACT.md`.

---

## 🏛️ Arquitectura

```text
Synapse Engine (127.0.0.1:19234)
   │  GET /public/v1/snapshot (solo loopback local, sin auth)
   ▼
scripts/publish-public-snapshot.sh (systemd timer de usuario cada 60 s)
   │  POST https://trade.swal.network/ingest (Bearer $PUBLIC_INGEST_TOKEN)
   ▼
Cloudflare Worker "swal-trade"
   ├── Ingest: Comprobación token tiempo constante (crypto.subtle SHA-256)
   ├── Sanitizador estricto de privacidad (whitelist de campos)
   ├── Almacenamiento KV:
   │     • "latest" (último estado)
   │     • "history:YYYY-MM-DD" (primer snapshot diario, retención 90 días)
   ├── GET /public/v1/snapshot (público, Cache-Control max-age=30s)
   └── Cloudflare Static Assets (HTML/CSS/JS cliente sin dependencias)
```

**Ventaja de seguridad fundamental:** El bot opera de forma completamente aislada en su host local. Ninguna conexión entrante se abre desde internet hacia la máquina de trading; el sistema únicamente empuja datos hacia la nube mediante HTTPS saliente.

---

## 🔒 Reglas de Privacidad y Sanitización

1. **Nunca en el snapshot:**
   - Sin API keys ni secretos de exchanges.
   - Sin IDs de orden privados ni IDs internos de cuenta.
   - Sin balances absolutos de cuentas reales (`account.initial_capital` es forzado a `null` en modo `live` o `testnet`; solo se publica en `paper`).
   - Sin direcciones IP internas, rutas de archivos ni texto libre de logs.
2. **Sanitización del lado del servidor (Worker):**
   - El Worker reconstruye el objeto JSON desde cero conservando **únicamente** los campos permitidos por la whitelist del contrato.
   - Cualquier propiedad desconocida a cualquier nivel de profundidad es descartada automáticamente.
   - Límites duros de tamaño de arrays:
     - `bots`: máximo 100.
     - `open_positions`: máximo 100.
     - `recent_trades`: máximo 50.
     - `equity_curve`: máximo 500 puntos.
   - Rechazo de cuerpos de solicitud superiores a 512 KB con código HTTP 413.

---

## 🚀 Pasos de Despliegue

### 1. Crear el Namespace de KV en Cloudflare
Desde la raíz del proyecto o desde `workers/public-site/`:
```bash
npx wrangler kv namespace create SNAPSHOTS
```
Copia el ID generado y actualiza la sección `[[kv_namespaces]]` en `workers/public-site/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "SNAPSHOTS"
id = "TU_ID_DE_KV_AQUI"
```

### 2. Generar y Configurar el Token de Ingesta
Genera un token seguro de alta entropía (por ejemplo con `openssl`):
```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN"
```
Regístralo como secreto en el Cloudflare Worker:
```bash
cd workers/public-site
npx wrangler secret put PUBLIC_INGEST_TOKEN
# Pega el token generado cuando se te solicite
```

Noticias (`GET /api/news`, cron de 5 min con puerta de 30 min). Un secreto por proveedor; cualquiera basta, rotan con respaldo. Solo el nombre, el valor no va en el repo:

```bash
npx wrangler secret put BRAVE_API_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
```

Usan la D1 `DB` que ya está en `wrangler.toml` (migración `0002_news.sql`) y, si no hay D1, el KV `SNAPSHOTS`.

Latidos del guardián y del radar locales (`POST /heartbeat/guardian` y `POST /heartbeat/radar`, migración `0005_heartbeats.sql`). El token va en la cabecera `Authorization: Bearer`, nunca en la URL, porque los logs de Workers guardan la URL. Cada servicio escribe en D1 como mucho una vez por minuto. El cron de 5 min avisa por Telegram, en texto plano, una vez si un servicio lleva más de `HEARTBEAT_STALE_S` segundos (defecto 600) sin latir y otra cuando vuelve. Solo vigila servicios que ya latieron alguna vez.

```bash
npx wrangler d1 migrations apply swal-trade-public --remote
npx wrangler secret put HEARTBEAT_TOKEN
```

En el PC del dueño, en `~/.config/risk-guardian.env` (lo leen el guardián y el radar):

```bash
GUARDIAN_HEARTBEAT_URL=https://trade.swal.network/heartbeat/guardian
GUARDIAN_HEARTBEAT_TOKEN=<el mismo token>
RADAR_HEARTBEAT_URL=https://trade.swal.network/heartbeat/radar
RADAR_HEARTBEAT_TOKEN=<el mismo token>
```

### 3. Desplegar el Worker y los Assets Estáticos
```bash
cd workers/public-site
npx wrangler deploy
```

### 4. Configurar el Publicador en la Máquina de Trading
En el host donde corre el motor de trading (comandos desde la raíz de este repositorio; el motor que expone `/public/v1/snapshot` es privado):

1. Crea el archivo de token seguro con permisos restringidos (`600`):
   ```bash
   mkdir -p ~/.config/synapse
   echo "TU_TOKEN_GENERADO" > ~/.config/synapse/public-ingest-token
   chmod 600 ~/.config/synapse/public-ingest-token
   ```

2. Instala el script publicador en tu ruta de ejecutables de usuario (`~/.local/bin`):
   ```bash
   mkdir -p ~/.local/bin
   ln -sf "$(pwd)/scripts/publish-public-snapshot.sh" ~/.local/bin/publish-public-snapshot.sh
   chmod +x ~/.local/bin/publish-public-snapshot.sh
   ```

3. Instala y activa el timer de systemd de usuario:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp scripts/systemd/synapse-public-publisher.* ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now synapse-public-publisher.timer
   ```

4. Verifica el estado del timer:
   ```bash
   systemctl --user list-timers --all | grep synapse
   systemctl --user status synapse-public-publisher.timer
   ```

### 5. Explicador con IA (`POST /api/explain`)

El botón **Explicar con IA** de `/analisis/` manda el análisis que ya calculó `analysis-core` en el navegador y devuelve una explicación corta en español: qué significa cada patrón, qué lo confirmaría o invalidaría y qué riesgo manejar (stop, tamaño, apalancamiento 1x). El prompt vive en `src/explain-prompt.js` y es público a propósito: nunca promete rentabilidad ni da órdenes de entrada o salida, dice que la fuerza del patrón no es una probabilidad y que la tasa de acierto histórico no está medida.

Binding (`wrangler.toml`):

```toml
[ai]
binding = "AI"
```

Variables opcionales:

| Variable | Defecto | Uso |
|---|---|---|
| `EXPLAIN_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Modelo de Workers AI. Se elige ese porque es el instruct rápido del catálogo actual que admite JSON Mode (`response_format` con `json_schema`), así la respuesta ya sale validada. Cualquier otro modelo sirve: el worker repara y sanea el JSON. |
| `EXPLAIN_MAX_TOKENS` | `480` | Tope de tokens de salida. |
| `EXPLAIN_DAILY_CAP` | `500` | Llamadas al modelo por día UTC. Al agotarse (o con `0`) responde el respaldo determinista, nunca un error. |

Contrato: cuerpo `{symbol, timeframe, analysis:{top, trend, levels}}`; se rechaza con 400 un símbolo o temporalidad inválidos y más de 20 hallazgos. Respuesta `{source: "ai"|"fallback"|"cache", model, symbol, timeframe, asOf, summary, scenarios[{name, condition, invalidation, risk_note}], caution, disclaimer, reason}`.

Controles de abuso (migración `0003_explain.sql`, tabla `explain_kv` en la misma D1):

- **10 peticiones por hora e IP** en ventana móvil (la IP se guarda hasheada con SHA-256, nunca en claro). 429 con `Retry-After`. Si se configura un binding de Rate Limiting de Cloudflare llamado `EXPLAIN_RATE_LIMITER`, se usa además como freno de ráfaga.
- **Caché de 5 minutos** para peticiones idénticas: no gasta cupo ni tokens.
- **Cupo diario global** (`EXPLAIN_DAILY_CAP`).

Sin binding de IA, con JSON irrecuperable, con una frase prohibida en la respuesta o con el cupo agotado, el endpoint construye la explicación con reglas fijas a partir de los propios hallazgos y sus niveles (`source: "fallback"`). El worker nunca llama a un modelo real en los tests: se mockea `env.AI`.

---

## 🔐 Respaldo cifrado de extremo a extremo (Socio SWAL)

Página en `/backup/`. Cifra los ajustes del guardián, los de análisis y un diario local
en el **navegador** (`static/backup/backup-core.js`, PBKDF2-SHA256 con 600 000 iteraciones +
AES-256-GCM) y sube **solo el sobre cifrado**. Contrato E2EE (`docs/SWAL/GOAL.md`): ni la frase
de paso ni la clave derivada ni el texto en claro llegan al servidor; las claves de API de
Binance nunca se incluyen (denylist en `buildBackupData`, con test adverso).

Sobre (JSON, base64 salvo `v` e `iter`):

```json
{ "v": 1, "kdf": "PBKDF2-SHA256", "iter": 600000, "salt": "<16B>", "iv": "<12B>", "ct": "<GCM>" }
```

Parámetros obligatorios del sobre (se validan en el cliente y en el servidor **antes** de derivar
ninguna clave): `iter` entero entre 600 000 y 2 000 000, sal de exactamente 16 bytes e IV de
exactamente 12. `v`, `kdf`, `iter` y `salt` viajan además como **AAD** de AES-GCM: alterar
cualquiera de ellos rompe la etiqueta, así que no se puede rebajar el número de iteraciones de un
sobre ya cifrado. La frase de paso exige **12 caracteres** como mínimo, en `encryptBackup` y en la
página (`/backup/`), que muestra el motivo cuando falta.

Endpoints autenticados con `Authorization: Bearer <licencia Ed25519>` (la misma que `/guardian/`;
clave pública en `https://pay.swal.network/v1/pubkey`, campo `spki_base64`). La clave por cuenta
es el `sub` de la licencia.

| Método | Ruta | Cuerpo / respuesta | Notas |
|---|---|---|---|
| `PUT` | `/api/backup` | cuerpo = sobre | Tope **256 KB** (413). Guarda el sobre tal cual en D1. |
| `GET` | `/api/backup` | `{sub, dev, updated_at, size, envelope}` | 404 si no hay respaldo. Devuelve el sobre, nunca el texto. |
| `DELETE` | `/api/backup` | `{sub, dev, deleted:true}` | Borra el respaldo de la cuenta. |

Migración `0004_backup.sql`, tabla `backups(account_sub, updated_at, size, envelope)` (una fila
por cuenta) y migración `0005_backup_rate_limits.sql` para el límite por cuenta.

Licencia: además de la firma Ed25519 y de `exp`, el servidor exige `iss = swal-trade-billing`,
`iat` numérica, no futura (60 s de holgura) y no posterior a `exp`, y usa **solo** `sub` como
clave de fila (ni `account` ni `account_id`).

Límite por cuenta: **atómico en una sola sentencia D1** (`INSERT ... ON CONFLICT ... RETURNING`,
tabla `backup_rate_limits`), sin leer-y-escribir desde el isolate. Sin binding `DB` el endpoint
responde 503 (falla cerrado) en lugar de rebajar el límite a memoria. En `PUT`, un
`Content-Length` por encima de 256 KB se rechaza antes de bufferizar el cuerpo.

Variables (`wrangler.toml`, todas opcionales):

| Variable | Defecto | Uso |
|---|---|---|
| `BACKUP_LICENSE_PUBKEY` | — | Clave SPKI base64 de licencias. Si se fija, no se consulta la red. |
| `BACKUP_RATE_LIMIT` | `60` | Peticiones por hora y cuenta, para cuidar las escrituras de D1 (límite gratuito: 100 000 al día). |
| `BACKUP_DEV_OPEN` | — | `true` = **gratis durante desarrollo**: acepta cualquier token como cuenta `dev:<hash>`, sin licencia real. Solo tiene efecto en `localhost` / `127.0.0.1` / `::1` / `*.workers.dev`; en `trade.swal.network` (o cualquier otro host) se ignora y la petición se trata como licencia inválida (401). |

Tests: `node --test workers/public-site/test/` incluye `backup.test.mjs` (ida y vuelta, frase
incorrecta, texto alterado, unicidad de salt/IV, denylist de claves de Binance, 401/402 sin
licencia, tope de tamaño, el servidor guarda solo el sobre sin texto en claro y el interruptor
dev-open).

---

## 🧪 Pruebas y Validación Local

- **Tests unitarios del sanitizador:**
  ```bash
  node --test workers/public-site/test/
  ```

- **Verificación de sintaxis de scripts y código:**
  ```bash
  node --check workers/public-site/src/worker.js workers/public-site/static/app.js
  bash -n scripts/publish-public-snapshot.sh
  ```

- **Modo Demostración en Frontend:**
  Abre la página web con el parámetro de consulta `?demo=1` (ej. `http://localhost:8787/?demo=1` o `https://trade.swal.network/?demo=1`). En este modo, `app.js` carga los datos estáticos de `sample-snapshot.json` con bots simulados, operaciones de prueba y curva de capital.
