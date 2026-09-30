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
