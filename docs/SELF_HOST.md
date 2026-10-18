# Guía de Self-Host: Guardián de Riesgo

El Guardián de Riesgo (`scripts/guardian/risk_guardian.py`) te permite vigilar tu cuenta de Binance de forma determinista y recibir alertas. Se ejecuta localmente en tu propia máquina.

## 1. Prerrequisitos
- Python 3.10 o superior instalado.
- Ningún paquete de `pip` adicional es necesario (utiliza solo la biblioteca estándar de Python).

## 2. API Key de Binance (solo lectura)
Para usar el Guardián, debes crear una clave API en Binance:
- El permiso debe ser de **solo lectura** (read-only).
- **NUNCA** actives retiros.
- Se recomienda fuertemente configurar una restricción de IP (allowlist) para mayor seguridad.
- Nota: Las claves son de read-only / solo lectura para evitar cualquier operación. El Guardián en estado normal NO realiza operaciones.

## 3. Archivo de Entorno (.env)
Configura las variables de entorno necesarias. Usa nombres, pero nunca guardes los valores reales en repositorios o foros.
- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`
- `GUARDIAN_DAILY_LOSS_USD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Crea el archivo `~/.config/risk-guardian.env` y otórgale permisos estrictos:
```bash
chmod 600 ~/.config/risk-guardian.env
```

## 4. Ejecutar una vez para probar
Antes de configurar un servicio en segundo plano, prueba la conexión y lectura de datos:
```bash
python3 scripts/guardian/risk_guardian.py --once
```

## 5. Linux: systemd (User Unit)
Para ejecutar en segundo plano en Linux, utiliza un user unit de `systemd`.
El archivo de referencia se encuentra en `scripts/guardian/risk-guardian.service`.
Cópialo a `~/.config/systemd/user/risk-guardian.service`, recarga el demonio y habilítalo:
```bash
systemctl --user daemon-reload
systemctl --user enable --now risk-guardian
```

## 6. macOS: launchd
En macOS, utiliza `launchd` creando un archivo plist en `~/Library/LaunchAgents/com.swal.guardian.plist`.
Asegúrate de cambiar las rutas de Python y del proyecto a tu entorno real. Ejemplo válido:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.swal.guardian</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>source ~/.config/risk-guardian.env &amp;&amp; exec /usr/bin/env python3 scripts/guardian/risk_guardian.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>~/swal-trade</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>~/Library/Logs/com.swal.guardian.log</string>
    <key>StandardErrorPath</key>
    <string>~/Library/Logs/com.swal.guardian.err</string>
</dict>
</plist>
```

Carga el plist con:
```bash
launchctl load ~/Library/LaunchAgents/com.swal.guardian.plist
```

## 7. Windows: Task Scheduler
Para Windows, utiliza el Programador de Tareas. Usa el comando `schtasks` para crear la tarea que se inicie al iniciar sesión:

```cmd
schtasks /Create /TN "RiskGuardian" /TR "cmd.exe /c \"C:\Ruta\A\python.exe C:\Ruta\A\swal-trade\scripts\guardian\risk_guardian.py\"" /SC ONLOGON /RL HIGHEST
```
*Nota: Configura el Programador de Tareas para reiniciar la tarea si falla (restart on failure).*

## 8. Android: Termux
En Android mediante Termux, asegúrate de mantener el proceso vivo en segundo plano.
Usa `termux-wake-lock` para evitar que Android suspenda la ejecución. Luego, inicia el script usando `tmux` o mediante `termux-services`:

```bash
termux-wake-lock
python3 scripts/guardian/risk_guardian.py
```

## 9. Lo que este software NO hace
- El Guardián por defecto es de solo lectura. No enviará órdenes de compra o venta a menos que actives deliberadamente `GUARDIAN_ENFORCE=true`.
- Nunca actives `GUARDIAN_ENFORCE` si no comprendes totalmente el riesgo. El modo ENFORCE cierra todas las posiciones al alcanzar un límite de pérdidas.
- **Sin consejos financieros:** Ninguna funcionalidad de este repositorio, incluyendo sus hit rates u observaciones (como "fuerza de patrón"), implica un consejo de rentabilidad. No hay promesa de ganancias, ni probabilidad implícita.
