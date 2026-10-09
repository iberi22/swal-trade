# Risk Guardian

`scripts/risk_guardian.py` vigila tu cuenta REAL de Binance USD-M Futures (USDT y USDC) y avisa por
Telegram cuando te acercas o pasas el limite de perdida diaria. Solo stdlib de Python.

## API key de Binance
- Para solo avisos: permiso **Lectura** unicamente (Enable Reading).
- Solo si usas `GUARDIAN_ENFORCE=true`: agrega **Futures trading**.
- **NUNCA** habilites retiros (withdrawals).
- Restringe la key a la IP de esta maquina.

## Variables
Van en `~/.config/risk-guardian.env` (lo carga systemd). **No pongas la key en ningun archivo dentro del repositorio**:
ese fichero lo lee tambien el bot, y con claves reales sus endpoints `/account/real/*` pueden operar.
| Variable | Defecto | Nota |
|---|---|---|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | - | requeridas. Si no hay `BINANCE_API_SECRET` se usa `BINANCE_SECRET_KEY` (nombre que usa el bot) |
| `GUARDIAN_DAILY_LOSS_USD` | - | requerida, > 0 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | - | sin token imprime en consola |
| `GUARDIAN_WARN_FRACTION` | 0.7 | aviso al 70% del limite |
| `GUARDIAN_MAX_NOTIONAL_USD`, `GUARDIAN_MAX_LEVERAGE` | off | avisos por posicion |
| `GUARDIAN_TZ_OFFSET_HOURS` | -5 | el dia empieza a medianoche local (Bogota) |
| `GUARDIAN_POLL_SECS` | 15 | minimo 5 |
| `GUARDIAN_ENFORCE` | false | cierra posiciones al alcanzar el limite |
| `GUARDIAN_REQUIRE_STOP` | true | avisa de posiciones sin stop (ver abajo); solo aviso, ignora ENFORCE |
| `GUARDIAN_STOP_ALERT_MINUTES` | 15 | reaviso maximo por posicion |
| `GUARDIAN_HEARTBEAT_URL` | off | URL a la que hacer GET en cada vuelta (dead-man, estilo healthchecks.io) |
| `BINANCE_FUTURES_URL` | https://fapi.binance.com | |

PnL del dia = realizado (PnL + comisiones + funding, en USDT/USDC/FDUSD/BUSD) + no realizado abierto.
Las comisiones pagadas en BNB no se cuentan: el PnL puede salir un poco optimista.

## Posiciones sin stop
Por cada posicion abierta (`positionAmt != 0`) consulta `GET /fapi/v1/openAlgoOrders` (Algo Service,
donde viven las ordenes condicionales de USD-M) y exige un `STOP_MARKET` del lado que cierra
(SELL para long, BUY para short; en hedge mode con el mismo `positionSide`) con `closePosition` o
`reduceOnly`. Si falta, manda por Telegram (texto plano) `SIN STOP: <simbolo> <LONG|SHORT> <cantidad>`,
como mucho una vez cada `GUARDIAN_STOP_ALERT_MINUTES` por posicion. **Nunca crea ni cancela ordenes**,
este o no `GUARDIAN_ENFORCE`. Si la consulta de ordenes falla se registra y no se avisa (no se sabe).
Requiere solo permiso de lectura. Desactivar: `GUARDIAN_REQUIRE_STOP=false`.

## Heartbeat (dead-man)
Con `GUARDIAN_HEARTBEAT_URL` hace GET a esa URL tras cada vuelta en que pudo leer la cuenta. Si el
servicio ciego/caido deja de pingear, healthchecks.io (u otro) te avisa. Un fallo del ping se registra
y no es fatal.

## Probar
```
python3 scripts/risk_guardian.py --once   # una lectura, imprime y NO envia nada
python3 scripts/risk_guardian.py          # bucle
```

## ENFORCE
Con `GUARDIAN_ENFORCE=true`, al alcanzar el limite cancela ordenes abiertas y **cierra las posiciones
REALES a mercado**. Es un lockout: lo que reabras ese dia se vuelve a cerrar en el siguiente poll.
Pruebalo primero en OFF.

## systemd (usuario)
Usar `scripts/systemd/risk-guardian.service` (copiar a `~/.config/systemd/user/`, ajustar rutas;
`.example` se conserva por compatibilidad). Tests: `cd scripts && python3 -m unittest test_risk_guardian`.
