# Auditoria de patrones, indicadores y contexto de mercado (2026-10-18)

> Medicion **en muestra** sobre 90 dias de velas de BTCUSDC y ETHUSDC (15m y 1h). No es evidencia hacia adelante, no es una recomendacion y no promete rentabilidad. Reproducir: `python3 -m radar.audit_collect SIMBOLO TF 90 salida.jsonl` (cuatro combinaciones), luego `python3 -m radar.audit_report salida.md *.jsonl` y `python3 -m radar.indicator_edge salida.md BTCUSDC ETHUSDC`.

## Resumen para decidir

1. **Ningun patron muestra una ventaja positiva** una vez descontado el coste de 0,08 % ida y vuelta. El acierto a 1R ronda 51 %, igual que una entrada aleatoria con la misma geometria (50 %), y el R neto medio es **-0,26**.
2. **17 de 28 combinaciones patron+direccion pierden en las dos mitades del tiempo** (n >= 100, IC95 por debajo de 0). Las que se eligieron solo con el primer 60 % del tiempo siguen en **-0,31R** en el 40 % final: la clasificacion se sostiene fuera de muestra. El radar las silencia por defecto (`RADAR_EXCLUDE_CELLS`, vacio para desactivar).
3. **El coste manda**: con stops menores al 0,15 % del precio el R neto es -0,78; entre 0,15 y 0,3 %, -0,30. El radar descarta ahora stops menores al 0,3 % (`RADAR_MIN_RISK_PCT`). Con stops mayores al 1,2 % el R neto es +0,05 (IC95 -0,03 a +0,12): indistinguible de cero.
4. **Con ambos filtros** (celdas negativas definidas solo con la primera parte del tiempo + stop >= 0,3 %) el tramo de prueba pasa de -0,23R a **-0,03R** (IC95 -0,09 a +0,05). Se eliminan las perdidas, no aparece una ventaja.
5. **El sentimiento y las variables de contexto no dan una ventaja estable.** El orden de rendimiento entre valores cambia entre la primera y la segunda parte del tiempo (funding neutral: +0,00 en la primera, -0,20 en la segunda; funding con la masa de nuestro lado: +0,04 y +0,23). Fear and Greed esta confundido con el tiempo: en el tramo de prueba no hubo ningun dia de miedo. No se usan como filtros.
6. **Ningun indicador clasico supera al azar** (RSI, MACD, cruces de EMA, seguimiento de tendencia): 0 de 66 pruebas pasan el percentil 97,5. RSI sobrecomprado como senal de venta es el peor (el precio sigue subiendo), no lo contrario operable.

## Limitaciones

- En muestra, una sola ventana de 90 dias; cada celda es una prueba entre ~28, asi que hay falsos positivos esperados. Por eso ninguna celda se declara "ventaja" y las positivas del cuadro solo se vigilan hacia adelante.
- Los acierto-vs-azar usan un control de entradas aleatorias con la misma geometria y **sin costes** (bruto), porque el acierto del patron cuenta el toque de 1R antes de costes. Un control con costes es mas bajo (30-45 %) y favorecia a los patrones; el publicador `radar.publish_hit_rates` usaba ese control y ya esta corregido.
- Las alertas repetidas se separan 6 velas por patron y direccion. El relleno asume el cierre de la vela que cruza la entrada, sin deslizamiento adicional.

## Patrones (replay)

Replay sobre velas historicas, evaluado con el mismo evaluador del radar en vivo. Es **en muestra**: no es evidencia hacia adelante. Se descartan alertas ya superadas y se separan las repetidas (min. 6 velas por patron y direccion).

Simbolos: BTCUSDC, ETHUSDC. Operaciones resueltas: **7466**.

## Global

| n | acierto 1R (IC95) | R neto medio | IC95 bootstrap |
|---|---|---|---|
| 7466 | 51% (50%-52%) | -0.26 | -0.29..-0.24 |

## Por patron y direccion (BTC+ETH, 15m+1h)

| patron | dir | n | acierto 1R (IC95) | R neto | IC95 R | R 1ra mitad / 2da | azar (bruto) | veredicto |
|---|---|---|---|---|---|---|---|---|
| double_bottom | long | 569 | 58% (54%-62%) | +0.02 | -0.06..+0.10 | +0.04 / +0.00 | 51% | no distinguible de cero |
| double_top | short | 567 | 41% (37%-45%) | -0.34 | -0.42..-0.26 | -0.43 / -0.25 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| candle_hammer | long | 545 | 53% (49%-58%) | -0.32 | -0.40..-0.23 | -0.26 / -0.37 | 48% | NEGATIVA ROBUSTA (ambas mitades) |
| candle_shooting_star | short | 541 | 48% (44%-52%) | -0.47 | -0.57..-0.38 | -0.50 / -0.45 | 48% | NEGATIVA ROBUSTA (ambas mitades) |
| order_block_bearish | short | 505 | 46% (42%-51%) | -0.43 | -0.52..-0.34 | -0.57 / -0.29 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| order_block_bullish | long | 504 | 54% (50%-58%) | -0.27 | -0.37..-0.18 | -0.32 / -0.23 | 48% | NEGATIVA ROBUSTA (ambas mitades) |
| liquidity_sweep_bearish | short | 495 | 48% (44%-53%) | -0.53 | -0.62..-0.43 | -0.59 / -0.47 | 47% | NEGATIVA ROBUSTA (ambas mitades) |
| liquidity_sweep_bullish | long | 405 | 55% (50%-60%) | -0.40 | -0.51..-0.29 | -0.36 / -0.43 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| candle_engulfing_bullish | long | 343 | 53% (47%-58%) | -0.14 | -0.24..-0.03 | -0.13 / -0.15 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| range_breakout | long | 332 | 58% (52%-63%) | +0.07 | -0.04..+0.17 | +0.17 / -0.03 | 49% | no distinguible de cero |
| candle_engulfing_bearish | short | 296 | 48% (42%-53%) | -0.27 | -0.38..-0.15 | -0.36 / -0.17 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| bull_flag | long | 290 | 53% (48%-59%) | -0.10 | -0.22..+0.03 | -0.06 / -0.13 | 48% | no distinguible de cero |
| fvg_bullish | long | 270 | 47% (41%-53%) | -0.38 | -0.50..-0.26 | -0.39 / -0.38 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| fvg_bearish | short | 252 | 53% (47%-59%) | -0.20 | -0.33..-0.08 | -0.29 / -0.11 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| range_breakout | short | 247 | 53% (46%-59%) | -0.03 | -0.16..+0.09 | -0.13 / +0.06 | 50% | no distinguible de cero |
| candle_morning_star | long | 204 | 48% (41%-55%) | -0.25 | -0.38..-0.10 | -0.22 / -0.28 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| bear_flag | short | 201 | 49% (42%-56%) | -0.15 | -0.30..-0.00 | -0.25 / -0.05 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| candle_evening_star | short | 200 | 48% (42%-55%) | -0.25 | -0.39..-0.10 | -0.28 / -0.22 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| ascending_triangle | long | 130 | 52% (43%-60%) | -0.24 | -0.43..-0.06 | -0.22 / -0.27 | 50% | NEGATIVA ROBUSTA (ambas mitades) |
| rising_wedge | short | 111 | 45% (36%-54%) | -0.28 | -0.44..-0.08 | -0.13 / -0.42 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| descending_triangle | short | 101 | 48% (38%-57%) | -0.31 | -0.51..-0.09 | -0.56 / -0.06 | 49% | NEGATIVA ROBUSTA (ambas mitades) |
| falling_wedge | long | 95 | 49% (40%-59%) | -0.18 | -0.38..+0.02 | -0.11 / -0.24 | 50% | no distinguible de cero |
| candle_doji | short | 82 | 60% (49%-70%) | -0.21 | -0.45..+0.04 | -0.28 / -0.13 | 49% | no distinguible de cero |
| candle_doji | long | 69 | 62% (51%-73%) | -0.08 | -0.33..+0.16 | -0.04 / -0.13 | 50% | no distinguible de cero |
| inverse_head_shoulders | long | 49 | 47% (34%-61%) | -0.15 | -0.43..+0.13 | +0.18 / -0.47 | 49% | no distinguible de cero |
| head_shoulders | short | 45 | 56% (41%-69%) | +0.01 | -0.26..+0.30 | -0.04 / +0.07 | 48% | no distinguible de cero |
| rsi_divergence_bearish | short | 15 | 60% (36%-80%) | +0.13 | -0.41..+0.65 | +0.34 / -0.06 | 49% | sin evidencia (n<30) |
| rsi_divergence_bullish | long | 3 | 0% (0%-56%) | -1.06 | n/d | -1.06 / -1.06 | 50% | sin evidencia (n<30) |

## Costes: el tamano del stop manda

| stop (% del precio) | n | acierto 1R (IC95) | R neto | IC95 R |
|---|---|---|---|---|
| <0.15% | 1195 | 51% (48%-54%) | -0.78 | -0.85..-0.72 |
| 0.15-0.3% | 1758 | 51% (49%-54%) | -0.30 | -0.34..-0.25 |
| 0.3-0.6% | 2154 | 51% (49%-53%) | -0.14 | -0.18..-0.10 |
| 0.6-1.2% | 1631 | 48% (45%-50%) | -0.14 | -0.18..-0.09 |
| >1.2% | 728 | 54% (51%-58%) | +0.05 | -0.03..+0.12 |

## Dependencia del contexto de mercado (todos los patrones juntos)

Tendencia, volatilidad, sesion, funding y miedo/codicia conocidos en el momento de la alerta.

| variable | valor | n | acierto 1R (IC95) | R neto | IC95 R |
|---|---|---|---|---|---|
| trend_4h | against | 3518 | 48% (47%-50%) | -0.32 | -0.35..-0.28 |
| trend_4h | with | 3635 | 53% (51%-55%) | -0.21 | -0.25..-0.18 |
| trend_1h | against | 3718 | 52% (51%-54%) | -0.23 | -0.26..-0.19 |
| trend_1h | with | 3748 | 49% (48%-51%) | -0.30 | -0.33..-0.26 |
| vol | high | 2189 | 49% (47%-51%) | -0.18 | -0.22..-0.14 |
| vol | low | 2790 | 53% (51%-54%) | -0.36 | -0.41..-0.32 |
| vol | mid | 2487 | 51% (49%-52%) | -0.22 | -0.26..-0.18 |
| session | asia | 2632 | 50% (48%-52%) | -0.28 | -0.32..-0.24 |
| session | eu | 2647 | 53% (51%-55%) | -0.21 | -0.25..-0.17 |
| session | us | 2187 | 49% (47%-51%) | -0.30 | -0.35..-0.25 |
| funding | crowded_against | 2925 | 47% (45%-49%) | -0.33 | -0.36..-0.29 |
| funding | crowded_with | 1828 | 56% (54%-58%) | -0.10 | -0.15..-0.05 |
| funding | neutral | 2713 | 51% (49%-53%) | -0.30 | -0.34..-0.26 |
| fng | fear | 2170 | 50% (48%-52%) | -0.38 | -0.42..-0.33 |
| fng | greed | 4395 | 51% (49%-52%) | -0.22 | -0.25..-0.19 |
| fng | neutral | 901 | 54% (51%-57%) | -0.17 | -0.23..-0.10 |

Valores con n>=100 cuyo IC95 no incluye 0: trend_4h=against (-0.32R), trend_4h=with (-0.21R), trend_1h=against (-0.23R), trend_1h=with (-0.30R), vol=high (-0.18R), vol=low (-0.36R), vol=mid (-0.22R), session=asia (-0.28R), session=eu (-0.21R), session=us (-0.30R), funding=crowded_against (-0.33R), funding=crowded_with (-0.10R), funding=neutral (-0.30R), fng=fear (-0.38R), fng=greed (-0.22R), fng=neutral (-0.17R).

## Prueba de seleccion fuera de muestra (sin trampas)

Se eligen las combinaciones patron+direccion con mejor R neto en el primer 60% del tiempo (n>=20) y se miden en el 40% final.

Elegidas: range_breakout/long, inverse_head_shoulders/long, double_bottom/long, head_shoulders/short, candle_doji/long

| conjunto | n | acierto 1R (IC95) | R neto | IC95 R |
|---|---|---|---|---|
| elegidas, tramo de prueba | 449 | 58% (54%-63%) | +0.03 | -0.06..+0.12 |
| todos, tramo de prueba | 2987 | 51% (49%-52%) | -0.23 | -0.27..-0.19 |


## Indicadores clasicos

Retorno hacia adelante a H velas, ajustado por direccion, menos 0.08% de coste ida y vuelta. Referencia: el mismo estadistico en instantes aleatorios (misma cantidad de senales, 1000 permutaciones). Una senal solo aporta si su media supera el percentil 97.5 del azar.

| activo | tf | senal | H | n | media neta | azar p2.5..p97.5 | percentil |
|---|---|---|---|---|---|---|---|
| BTCUSDC | 15m | rsi_oversold_long | 4 | 133 | -0.056% | -0.131..+0.000% | 68% |
| BTCUSDC | 15m | rsi_oversold_long | 12 | 76 | -0.038% | -0.180..+0.103% | 56% |
| BTCUSDC | 15m | rsi_overbought_short | 4 | 173 | -0.158% | -0.149..-0.034% | 1% |
| BTCUSDC | 15m | rsi_overbought_short | 12 | 96 | -0.240% | -0.265..+0.001% | 4% |
| BTCUSDC | 15m | rsi_trend_long(>60) | 4 | 330 | -0.092% | -0.105..-0.027% | 12% |
| BTCUSDC | 15m | rsi_trend_long(>60) | 12 | 221 | -0.045% | -0.128..+0.039% | 53% |
| BTCUSDC | 15m | rsi_trend_short(<40) | 4 | 293 | -0.097% | -0.137..-0.049% | 41% |
| BTCUSDC | 15m | rsi_trend_short(<40) | 12 | 204 | -0.123% | -0.200..-0.028% | 41% |
| BTCUSDC | 15m | macd_cross_up_long | 4 | 334 | -0.075% | -0.108..-0.027% | 37% |
| BTCUSDC | 15m | macd_cross_up_long | 12 | 285 | -0.032% | -0.118..+0.028% | 65% |
| BTCUSDC | 15m | macd_cross_down_short | 4 | 339 | -0.090% | -0.128..-0.055% | 55% |
| BTCUSDC | 15m | macd_cross_down_short | 12 | 279 | -0.115% | -0.195..-0.037% | 47% |
| BTCUSDC | 15m | ema_cross_up_long | 4 | 89 | -0.088% | -0.144..+0.018% | 30% |
| BTCUSDC | 15m | ema_cross_up_long | 12 | 86 | -0.090% | -0.184..+0.091% | 28% |
| BTCUSDC | 15m | ema_cross_down_short | 4 | 87 | -0.113% | -0.172..-0.013% | 27% |
| BTCUSDC | 15m | ema_cross_down_short | 12 | 84 | -0.120% | -0.258..+0.020% | 46% |
| BTCUSDC | 15m | trend_follow_long(e20>e50) | 4 | 1187 | -0.065% | -0.090..-0.047% | 63% |
| BTCUSDC | 15m | trend_follow_long(e20>e50) | 12 | 426 | -0.025% | -0.102..+0.008% | 78% |
| BTCUSDC | 15m | trend_follow_short(e20<e50) | 4 | 1052 | -0.086% | -0.113..-0.070% | 71% |
| BTCUSDC | 15m | trend_follow_short(e20<e50) | 12 | 379 | -0.111% | -0.178..-0.052% | 51% |
| BTCUSDC | 1h | rsi_overbought_short | 4 | 51 | -0.435% | -0.343..+0.055% | 0% |
| BTCUSDC | 1h | rsi_trend_long(>60) | 4 | 77 | -0.047% | -0.195..+0.145% | 47% |
| BTCUSDC | 1h | rsi_trend_long(>60) | 12 | 54 | -0.043% | -0.291..+0.414% | 33% |
| BTCUSDC | 1h | rsi_trend_short(<40) | 4 | 66 | -0.186% | -0.291..+0.039% | 26% |
| BTCUSDC | 1h | rsi_trend_short(<40) | 12 | 49 | -0.033% | -0.576..+0.143% | 84% |
| BTCUSDC | 1h | macd_cross_up_long | 4 | 78 | +0.003% | -0.195..+0.147% | 70% |
| BTCUSDC | 1h | macd_cross_up_long | 12 | 66 | +0.038% | -0.236..+0.405% | 48% |
| BTCUSDC | 1h | macd_cross_down_short | 4 | 76 | -0.100% | -0.306..+0.045% | 59% |
| BTCUSDC | 1h | macd_cross_down_short | 12 | 67 | -0.259% | -0.560..+0.101% | 39% |
| BTCUSDC | 1h | trend_follow_long(e20>e50) | 4 | 275 | -0.029% | -0.120..+0.057% | 57% |
| BTCUSDC | 1h | trend_follow_long(e20>e50) | 12 | 99 | +0.027% | -0.204..+0.314% | 44% |
| BTCUSDC | 1h | trend_follow_short(e20<e50) | 4 | 271 | -0.119% | -0.209..-0.039% | 55% |
| BTCUSDC | 1h | trend_follow_short(e20<e50) | 12 | 96 | -0.178% | -0.490..+0.057% | 59% |
| ETHUSDC | 15m | rsi_oversold_long | 4 | 130 | -0.105% | -0.155..+0.017% | 20% |
| ETHUSDC | 15m | rsi_oversold_long | 12 | 74 | -0.146% | -0.251..+0.162% | 16% |
| ETHUSDC | 15m | rsi_overbought_short | 4 | 167 | -0.139% | -0.173..-0.017% | 11% |
| ETHUSDC | 15m | rsi_overbought_short | 12 | 92 | -0.203% | -0.320..+0.054% | 19% |
| ETHUSDC | 15m | rsi_trend_long(>60) | 4 | 336 | -0.113% | -0.119..-0.009% | 4% |
| ETHUSDC | 15m | rsi_trend_long(>60) | 12 | 243 | -0.092% | -0.147..+0.073% | 20% |
| ETHUSDC | 15m | rsi_trend_short(<40) | 4 | 280 | -0.090% | -0.154..-0.033% | 54% |
| ETHUSDC | 15m | rsi_trend_short(<40) | 12 | 196 | -0.115% | -0.248..+0.006% | 53% |
| ETHUSDC | 15m | macd_cross_up_long | 4 | 343 | -0.050% | -0.118..-0.008% | 73% |
| ETHUSDC | 15m | macd_cross_up_long | 12 | 294 | -0.020% | -0.142..+0.062% | 69% |
| ETHUSDC | 15m | macd_cross_down_short | 4 | 336 | -0.088% | -0.147..-0.039% | 56% |
| ETHUSDC | 15m | macd_cross_down_short | 12 | 283 | -0.144% | -0.224..-0.015% | 31% |
| ETHUSDC | 15m | ema_cross_up_long | 4 | 97 | -0.109% | -0.162..+0.036% | 21% |
| ETHUSDC | 15m | ema_cross_up_long | 12 | 90 | -0.096% | -0.218..+0.150% | 28% |
| ETHUSDC | 15m | ema_cross_down_short | 4 | 98 | -0.180% | -0.195..+0.007% | 5% |
| ETHUSDC | 15m | ema_cross_down_short | 12 | 94 | -0.164% | -0.313..+0.055% | 29% |
| ETHUSDC | 15m | trend_follow_long(e20>e50) | 4 | 1195 | -0.071% | -0.096..-0.038% | 39% |
| ETHUSDC | 15m | trend_follow_long(e20>e50) | 12 | 433 | -0.046% | -0.129..+0.044% | 50% |
| ETHUSDC | 15m | trend_follow_short(e20<e50) | 4 | 1043 | -0.099% | -0.123..-0.062% | 34% |
| ETHUSDC | 15m | trend_follow_short(e20<e50) | 12 | 378 | -0.118% | -0.208..-0.029% | 46% |
| ETHUSDC | 1h | rsi_overbought_short | 4 | 50 | -0.397% | -0.428..+0.161% | 4% |
| ETHUSDC | 1h | rsi_trend_long(>60) | 4 | 70 | -0.053% | -0.260..+0.219% | 44% |
| ETHUSDC | 1h | rsi_trend_long(>60) | 12 | 51 | +0.185% | -0.393..+0.622% | 70% |
| ETHUSDC | 1h | rsi_trend_short(<40) | 4 | 57 | -0.035% | -0.406..+0.147% | 75% |
| ETHUSDC | 1h | rsi_trend_short(<40) | 12 | 44 | -0.136% | -0.812..+0.273% | 60% |
| ETHUSDC | 1h | macd_cross_up_long | 4 | 80 | +0.030% | -0.254..+0.220% | 71% |
| ETHUSDC | 1h | macd_cross_up_long | 12 | 70 | +0.028% | -0.330..+0.587% | 46% |
| ETHUSDC | 1h | macd_cross_down_short | 4 | 82 | -0.165% | -0.360..+0.108% | 37% |
| ETHUSDC | 1h | macd_cross_down_short | 12 | 73 | -0.322% | -0.717..+0.192% | 30% |
| ETHUSDC | 1h | trend_follow_long(e20>e50) | 4 | 281 | -0.105% | -0.165..+0.092% | 14% |
| ETHUSDC | 1h | trend_follow_long(e20>e50) | 12 | 101 | -0.111% | -0.285..+0.442% | 17% |
| ETHUSDC | 1h | trend_follow_short(e20<e50) | 4 | 270 | -0.169% | -0.249..+0.001% | 24% |
| ETHUSDC | 1h | trend_follow_short(e20<e50) | 12 | 97 | -0.269% | -0.640..+0.144% | 38% |

Senales por encima del percentil 97.5 del azar: ninguna. Con ~80 pruebas se esperan 2 falsos positivos por casualidad.
