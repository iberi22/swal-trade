# Escaner de movimientos: diseno y tareas (Opus, 2026-10-19)

Estado: aprobado para implementar. Referencia: https://github.com/iberi22/-Alertas-de-Movimiento-Binance-Futuros (MIT). Honestidad: la auditoria de `docs/research/AUDIT_PATRONES_2026-10-18.md` no encontro ventaja en patrones ni indicadores tras costes; el escaner muestra eventos de movimiento y, junto a cada uno, la estadistica medida de su celda (n, acierto con intervalo, R neto medio, grado). No promete tasa de acierto.

## Decisiones

1. **Sin "tasa de acierto alta" como objetivo.** Subir el acierto es trivial (objetivo mas corto que el stop) y no mejora la esperanza; con costes empeora. La alerta muestra R neto medio con su intervalo y el grado; si muestra acierto, muestra al lado el acierto de equilibrio de esa geometria.
2. **Sin etiqueta "fade" por defecto.** El repo de referencia marca LONG tras una caida y SHORT tras una subida, sin stop. Nuestra auditoria encontro que vender por RSI sobrecomprado fue lo peor medido (el precio siguio subiendo). Cada fila es un evento neutro ("baja 6,2 % en 30 min") con las dos celdas (fade y follow) lado a lado. Solo se muestra direccion y niveles cuando una celda esta `promising` o `validated`.
3. **No se porta CONFLUENCIA** (SMA50/200 + RSI + MACD): esta rota en el original (SMA devuelve un dict indexado como lista, SMA200 no cabe en 30 velas, el punto de entrada mezcla precio y volumen) y RSI/MACD/EMA dieron 0 de 66 pruebas sobre el azar.
4. **Por que hoy "no salen senales":** la tarjeta de radar de la extension solo lee `127.0.0.1:47322` (solo existe con el demonio), y ese radar escanea BTCUSDC/ETHUSDC en 15m/1h con 17 celdas silenciadas y stops minimos de 0,3 %. El escaner calcula todo en el navegador.

## Datos sin backend

REST de velas evaluado en cada cierre de 5 minutos; el websocket solo para una columna de precio vivo mientras el panel esta visible (ruta `wss://fstream.binance.com/market/ws/!miniTicker@arr`).
- `GET /fapi/v1/exchangeInfo` cada hora (universo: TRADING, PERPETUAL, USDT o USDC, `underlyingType=COIN`), `GET /fapi/v1/ticker/24hr` por ciclo (peso 40), `GET /fapi/v1/klines?interval=5m&limit=40` por simbolo (peso 1). Con minimo de 20 M de volumen 24h son unos 150-200 simbolos: ~250 de peso cada 5 min.
- Concurrencia 4, timeout 5 s; el ciclo se detiene si `X-MBX-USED-WEIGHT-1M` supera 1200; 429 respeta `Retry-After`; 418 detiene el escaneo y avisa.
- Reloj: hora del servidor (`/fapi/v1/time`), una vela esta cerrada si `closeTime < serverNow - 1000`; la ultima vela abierta se descarta siempre.
- v1: el escaner corre en la pagina del panel (mismo ciclo de vida que el pulso de mercado). v1.1 opcional "vigilar con el panel cerrado" con `chrome.alarms` cada 5 min, eventos en `storage.local['scanner.events']` (maximo 200). Firefox: solo panel si `alarms` no es fiable.
- Permisos: rutas fapi `ticker/24hr*` y `exchangeInfo*`, host `https://trade.swal.network/api/movers-stats*`, `alarms` (sin aviso de instalacion), `notifications` solo opcional. Nada de `tabs`, `scripting`, `offscreen`, `<all_urls>`. Sonido solo desde el panel abierto.
- Fuera de v1: interes abierto (una peticion por simbolo y solo ~30 dias de historia) y liquidaciones (`!forceOrder@arr` sin historia, no medible).

## Especificacion compartida (movers-spec.json (en apps/extension/src/lib/scanner/spec))

```json
{"spec":"swal.movers-spec.v1","version":"2026-10-19.1","bar_minutes":5,"tf_label":"5m",
 "signals":{"move30":{"window_min":30},"move15":{"window_min":15},
            "fast2":{"window_min":2,"bar_minutes":1,"measured":false}},
 "thresholds_pct":[3,5,7],
 "vol_tiers":[{"id":"hi","min_q24":1e8},{"id":"mid","min_q24":2e7},{"id":"lo","min_q24":0}],
 "vol_baseline_bars":24,"atr_period":14,"entry_atr":0.25,"stop_atr":1.5,
 "min_stop_frac":0.003,"max_stop_frac":0.05,"market_wide_breadth":0.30,
 "cooldown_min":480,"max_events_per_bar":10,"cost_round_trip":0.0008}
```

Definiciones sobre velas cerradas consecutivas; `i` es la ultima cerrada y `W = window_min / bar_minutes`:
- `ret_W(i) = close[i] / close[i-W] - 1`; si algun paso de open-time no es la duracion de la vela, null (hueco).
- Disparo (borde): `abs(ret_W(i)) >= T` y `abs(ret_W(i-1)) < T`; un evento por cruce y umbral.
- `q24`: en vivo `quoteVolume` de ticker/24hr; en estudio la suma de `k[7]` de las ultimas 288 velas. Tier: hi >= 100 M, mid >= 20 M, lo el resto.
- `vol_ratio = sum(k[7] ultimas W) / (W * mean(k[7] de las 24 velas previas a la ventana))`.
- `taker_imb = 2 * sum(k[9]) / sum(k[5]) - 1` en la ventana (solo se muestra).
- `atr14 = mean(TR[i-13..i])`, `TR = max(h-l, |h-c_prev|, |l-c_prev|)` (media simple).
- `breadth` = fraccion del universo en la vela `i` con el mismo signo y `abs(ret_W) >= T/2`; `market_wide = breadth >= 0.30`.
- `rel_btc = ret_W(sym) - ret_W(BTC)` (solo se muestra); funding solo se muestra; fast2 "no medido".
- Niveles: cada evento da dos planes, `follow` con `d = sign(ret)` y `fade` con `d = -sign(ret)`: `entry = close[i] + d * 0.25 * atr14`; `s = max(1.5 * atr14, 0.003 * entry)` (se omite si `s / entry > 0.05`); `stop = entry - d * s`; `t1 = entry + d * s`; `t2 = entry + 2 * d * s`. La entrada va mas alla del cierre porque el evaluador solo activa con un cruce real (si no, la mitad serian `missed`).
- Duplicados: clave `(simbolo, senal, subida/bajada)`, enfriamiento 480 min, escalado actualiza la fila; mas de 10 eventos de mercado en una vela se funden en una fila "Movimiento de mercado".
- Avisos: maximo 6 por hora con resumen "+N mas"; horas de silencio callan avisos y sonido, nunca la lista; insignia = no vistos.
- Silenciado: grado `negative` silenciado por defecto ("Silenciadas (n)"); `no_evidence` = "Solo informacion" (niveles solo en el detalle como "geometria de medicion"); `promising` o `validated` muestran el plan. Sin estadisticas o con otra version de la especificacion, todo es "Sin evidencia".

## Contrato del Worker `swal.movers-stats.v1` (movers-stats.js (en workers/public-site/src))

- `POST /ingest/movers-stats` con el token Bearer de ingestion y comparacion en tiempo constante; cuerpo <= 128 KB; claves `movers-stats:study` y `movers-stats:forward`.
- `GET /api/movers-stats?method=study|forward`, `Cache-Control: public, max-age=3600`; vacio: `{schema, cells:[], note:"Aun no hay datos publicados."}`; si el almacen falla, tabla vacia (nunca 500).
- Nivel superior: `schema, method (study|forward), spec_version, period{from,to}, universe{quote,top_n,rank_rule}, bar:"5m", cost_round_trip, evaluator, generated_at, cells[], note`.
- Celda (exactamente estas claves): `signal, mode(fade|follow), direction(long|short), threshold(3|5|7), vol_tier(hi|mid|lo), context(all|market_wide|idio), n, n_clusters, wins_1r, win_rate, ci_low, ci_high, breakeven, mean_net_r, net_r_ci_low, net_r_ci_high, median_stop_pct, events_per_day, grade`.
- Validacion: enums; `0 <= wins_1r <= n`; `n_clusters <= n`; tasas en [0,1]; `ci_low <= win_rate <= ci_high`; `abs(R) <= 10`; <= 500 celdas; coherencia del grado: `validated` exige `n_clusters >= 100`, `ci_low >= breakeven + 0.02` y `net_r_ci_low > 0`; `promising` exige `n_clusters >= 30` y `net_r_ci_low > 0`; cualquier otra cosa se rechaza.
- Dos errores a corregir: el acierto de equilibrio con costes es `(1 + 0.0008 / median_stop_pct) / 2` (el coste se pasa hoy como R); `publish_hit_rates` debe saltarse `source='movers'` (el Worker limita a 200 celdas).

## Espejo en el servidor (Python)

- movers.py (en radar) lee el mismo JSON y es la referencia; la version JS se prueba contra goldens que genera Python.
- Alertas: `source='movers'`, `tf='5m'`, `kind='mv_{mode}_{win}m_t{T}_{tier}'`, `dedupe_key='mv:{sym}:{signal}:{T}:{move}:{mode}'`, `created_at` = cierre de la vela de la senal, `strength=0.5` fijo ("no es una puntuacion"). Columna opcional `meta` JSON.
- movers_source.py (en radar) desde `run_cycle` con `RADAR_MOVERS=1`; maximo `max_events_per_bar` por vela, tier mas alto primero.
- El operador de testnet: `OPERATOR_SOURCES` (por defecto `core`) y lista `OPERATOR_KINDS`; nunca celdas `negative`; lee `SYMBOLS` del archivo del bot y salta lo que el bot descartaria; omite simbolos cuyo precio de testnet difiere >0,5 % de la alerta; enfriamiento por simbolo 4 h; maximo 3 entradas nuevas por hora; omite rafagas de mercado; parada diaria al perder el 2 % del capital; confirma en `/status` que la posicion se abrio, si no anota "descartada por el bot".
- Se mantiene `/control/manual-signal` (un plugin Rust seria una tercera copia de las definiciones y el registro esta vacio). El take profit del bot es 2R mientras el evaluador mide 1R: opcion `take_profit_pct` en el endpoint.

## Criticas del estudio (obligatorias para que un valor por defecto sea valido)

Agrupacion (los movimientos de todo el mercado no son independientes: gradear con `n_clusters` y bootstrap por dia); comparaciones multiples (~324 celdas: solo "promising" si se sostiene en las dos mitades; "validated" solo tras confirmacion hacia adelante); sesgo de supervivencia; desajuste de barra; deslizamiento mayor que 0,08 % en movimientos de 5 % (sensibilidad a 0,15 %).

## Tareas

| id | titulo | depende de |
|---|---|---|
| T0 | Prueba de coste REST contra websocket | - |
| T1 | Especificacion, referencia Python y goldens | - |
| T2 | Port TypeScript | T1 |
| T3 | Contrato del Worker | - |
| T4 | Publicador de estadisticas | T1, T3 |
| T5 | Motor del escaner | T2 |
| T6 | Manifiesto, permisos, docs, ci-local | - |
| T7 | Pestana Escaner (UI) | T5, T6 |
| T8 | Modo en segundo plano | T5, T6 |
| T9 | Fuente de movers en el demonio | T1 |
| T10 | Limites del operador para movers | T1 |
| T11 | `take_profit_pct` en manual-signal (synapse-trading) | - |
