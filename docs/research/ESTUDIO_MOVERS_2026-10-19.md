# Estudio de senales de movimiento en 144 pares (2026-10-19)

> Medicion **en muestra** de 90 dias (velas de 5 m, 144 pares perpetuos USDT con mas volumen). No es evidencia hacia adelante ni una recomendacion. Reproducir: descargar velas de 5 m y ejecutar `python3 -m radar.movers_study CARPETA_VELAS universo.json SALIDA.md movers-stats.json`.

## Resumen

1. **Seguir** un movimiento de 30 min de 3 %, 5 % o 7 % pierde: el retorno medio neto a 1 h es de -0,19 % a -0,24 % (IC95 por dia: excluye 0 con 3 % y 5 %), estable en las dos mitades. Las ventas tras una subida (corto) pierden en todas las salidas medidas.
2. **Comprar el rebote** tras una caida (largo "fade") tiene un retorno medio neto a 1 h de +0,30 % (3 %), +0,51 % (5 %) y +0,81 % (7 %) sin stop, con IC95 por dia por encima de 0 y positivo en las dos mitades. **Pero** la cola izquierda es enorme (percentil 1 de -15 % a -27 % a 1 h) y el efecto casi desaparece con stop: con stop de desastre de 4-12 % queda en +0,10 % a +0,32 % por operacion con IC que incluye 0 y primera mitad cercana a 0.
3. La ventana fue alcista (BTC +25,8 %): comprar caidas rinde en una subida. No hay prueba de que funcione en una bajada.
4. Con stop de 1,5 ATR y objetivo 1R todas las celdas dan R neto entre -0,02 y -0,11 (ninguna promising).
5. Veredicto del producto: **ninguna celda es "promising"**. El rebote tras caida queda como candidato a medir hacia adelante (operador de testnet), no como senal. El acierto aparente es alto (55 % de rebotes a 1 h) pero la perdida media de los que fallan supera la ganancia media de los que aciertan (-4,8 % frente a +4,1 % a 5 %).

## Tablas

145 pares perpetuos USDT (los de mayor volumen), 90 dias de velas de 5m, 55645 eventos. Entrada en la apertura de la vela siguiente, stop de 1,5 ATR (minimo 0,3 % del precio), objetivo 1R, salida por tiempo a 4 h, coste 0,08 % ida y vuelta. Intervalos: bootstrap por dia. **No es evidencia hacia adelante.** Sesgo de supervivencia: solo pares listados hoy.

## Por senal, direccion y volumen

| ventana | umbral | modo | volumen 24h | n | pares | acierto 1R (IC95) | R neto | IC95 R | 1a/2a mitad | ret 1h neto | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10m | 2% | fade | alto | 5113 | 35 | 47% (46%-49%) | -0.07 | -0.11..-0.04 | -0.07 / -0.08 | -0.04% | negative |
| 10m | 2% | fade | bajo | 15429 | 107 | 50% (49%-50%) | -0.04 | -0.06..-0.01 | -0.06 / -0.01 | +0.00% | negative |
| 10m | 2% | fade | todos | 20542 | 142 | 49% (48%-50%) | -0.05 | -0.07..-0.02 | -0.07 / -0.03 | -0.01% | negative |
| 10m | 2% | follow | alto | 5113 | 35 | 49% (48%-51%) | -0.04 | -0.07..+0.00 | -0.04 / -0.03 | -0.12% | no_evidence |
| 10m | 2% | follow | bajo | 15429 | 107 | 48% (47%-49%) | -0.07 | -0.10..-0.04 | -0.04 / -0.10 | -0.16% | negative |
| 10m | 2% | follow | todos | 20542 | 142 | 48% (48%-49%) | -0.06 | -0.09..-0.03 | -0.04 / -0.09 | -0.15% | negative |
| 10m | 3% | fade | alto | 2416 | 34 | 46% (44%-48%) | -0.09 | -0.14..-0.04 | -0.06 / -0.11 | +0.02% | negative |
| 10m | 3% | fade | bajo | 6512 | 107 | 49% (48%-50%) | -0.03 | -0.08..+0.01 | -0.05 / -0.01 | -0.05% | no_evidence |
| 10m | 3% | fade | todos | 8928 | 141 | 48% (47%-49%) | -0.04 | -0.09..-0.00 | -0.06 / -0.03 | -0.03% | negative |
| 10m | 3% | follow | alto | 2416 | 34 | 49% (47%-51%) | -0.02 | -0.08..+0.03 | -0.04 / -0.01 | -0.18% | no_evidence |
| 10m | 3% | follow | bajo | 6512 | 107 | 47% (46%-48%) | -0.07 | -0.12..-0.02 | -0.04 / -0.10 | -0.11% | negative |
| 10m | 3% | follow | todos | 8928 | 141 | 48% (47%-49%) | -0.06 | -0.10..-0.01 | -0.03 / -0.08 | -0.13% | negative |
| 30m | 3% | fade | alto | 4334 | 35 | 48% (46%-49%) | -0.06 | -0.11..-0.02 | -0.03 / -0.10 | +0.02% | negative |
| 30m | 3% | fade | bajo | 13190 | 107 | 50% (49%-51%) | -0.03 | -0.06..-0.00 | -0.04 / -0.02 | +0.03% | negative |
| 30m | 3% | fade | todos | 17524 | 142 | 49% (49%-50%) | -0.04 | -0.07..-0.01 | -0.04 / -0.03 | +0.03% | negative |
| 30m | 3% | follow | alto | 4334 | 35 | 48% (47%-50%) | -0.05 | -0.10..-0.01 | -0.09 / -0.02 | -0.18% | negative |
| 30m | 3% | follow | bajo | 13190 | 107 | 48% (47%-48%) | -0.08 | -0.11..-0.05 | -0.06 / -0.09 | -0.19% | negative |
| 30m | 3% | follow | todos | 17524 | 142 | 48% (47%-48%) | -0.07 | -0.10..-0.04 | -0.06 / -0.08 | -0.19% | negative |
| 30m | 5% | fade | alto | 1623 | 33 | 46% (44%-48%) | -0.07 | -0.12..-0.03 | -0.04 / -0.10 | +0.10% | negative |
| 30m | 5% | fade | bajo | 4236 | 107 | 48% (47%-50%) | -0.04 | -0.08..+0.00 | -0.03 / -0.05 | +0.07% | no_evidence |
| 30m | 5% | fade | todos | 5859 | 140 | 48% (46%-49%) | -0.05 | -0.08..-0.02 | -0.03 / -0.06 | +0.08% | negative |
| 30m | 5% | follow | alto | 1623 | 33 | 48% (46%-51%) | -0.03 | -0.08..+0.01 | -0.06 / -0.01 | -0.26% | no_evidence |
| 30m | 5% | follow | bajo | 4236 | 107 | 47% (46%-49%) | -0.05 | -0.09..-0.01 | -0.06 / -0.05 | -0.23% | negative |
| 30m | 5% | follow | todos | 5859 | 140 | 48% (46%-49%) | -0.05 | -0.08..-0.01 | -0.05 / -0.04 | -0.24% | negative |
| 30m | 7% | fade | alto | 847 | 33 | 46% (42%-49%) | -0.07 | -0.12..-0.01 | -0.08 / -0.06 | +0.19% | negative |
| 30m | 7% | fade | bajo | 1945 | 103 | 47% (44%-49%) | -0.05 | -0.09..-0.00 | -0.10 / +0.00 | -0.00% | negative |
| 30m | 7% | fade | todos | 2792 | 136 | 46% (44%-48%) | -0.06 | -0.09..-0.02 | -0.10 / -0.01 | +0.05% | negative |
| 30m | 7% | follow | alto | 847 | 33 | 47% (44%-51%) | -0.04 | -0.10..+0.01 | -0.02 / -0.06 | -0.35% | no_evidence |
| 30m | 7% | follow | bajo | 1945 | 103 | 47% (45%-49%) | -0.04 | -0.08..+0.00 | +0.02 / -0.10 | -0.16% | no_evidence |
| 30m | 7% | follow | todos | 2792 | 136 | 47% (45%-49%) | -0.04 | -0.08..-0.00 | +0.01 / -0.09 | -0.21% | negative |

## Contexto (30m, umbral 5 %): movimiento de todo el mercado contra movimiento propio

| modo | contexto | n | acierto 1R | R neto | IC95 R |
|---|---|---|---|---|---|
| follow | propio (BTC se mueve < 1/3) | 5705 | 48% | -0.04 | -0.07..-0.01 |
| follow | de mercado (BTC se mueve >= 1/3) | 154 | 36% | -0.17 | -0.61..+0.09 |
| follow | con pico de volumen (>3x) | 2709 | 47% | -0.06 | -0.12..-0.00 |
| follow | sin pico de volumen (<=3x) | 3150 | 48% | -0.04 | -0.06..-0.01 |
| fade | propio (BTC se mueve < 1/3) | 5705 | 47% | -0.05 | -0.08..-0.02 |
| fade | de mercado (BTC se mueve >= 1/3) | 154 | 51% | +0.10 | -0.15..+0.54 |
| fade | con pico de volumen (>3x) | 2709 | 47% | -0.06 | -0.12..-0.00 |
| fade | sin pico de volumen (<=3x) | 3150 | 48% | -0.03 | -0.06..-0.00 |

## Por direccion de la operacion (contrato swal.movers-stats.v1)

Salida `move30`: primer toque de 1R con stop de 1,5 ATR. Salida `move30_hold1h`: 1 h con stop de desastre del 8 %; el R es relativo a ese stop. Contexto `all`. Intervalos: bootstrap por dia; n_clusters = franjas de 30 min distintas.

| salida | modo | direccion | umbral | volumen | n | n_clusters | acierto | R neto | IC95 R | 1a/2a mitad | grado |
|---|---|---|---|---|---|---|---|---|---|---|---|
| move30 | fade | long | 3% | hi | 1946 | 1325 | 48% | -0.048 | -0.109..+0.013 | -0.018 / -0.078 | no_evidence |
| move30 | fade | long | 3% | lo | 3536 | 1992 | 50% | -0.017 | -0.069..+0.036 | -0.033 / -0.000 | no_evidence |
| move30 | fade | long | 3% | mid | 2608 | 1568 | 49% | -0.037 | -0.100..+0.028 | -0.060 / -0.014 | no_evidence |
| move30 | fade | long | 5% | hi | 729 | 610 | 47% | -0.025 | -0.097..+0.048 | -0.014 / -0.036 | no_evidence |
| move30 | fade | long | 5% | lo | 1124 | 855 | 48% | -0.028 | -0.119..+0.055 | -0.047 / -0.010 | no_evidence |
| move30 | fade | long | 5% | mid | 828 | 648 | 46% | -0.050 | -0.144..+0.044 | -0.022 / -0.078 | no_evidence |
| move30 | fade | long | 7% | hi | 393 | 348 | 46% | -0.023 | -0.103..+0.068 | -0.067 / +0.020 | no_evidence |
| move30 | fade | long | 7% | lo | 475 | 395 | 46% | -0.045 | -0.134..+0.056 | -0.149 / +0.059 | no_evidence |
| move30 | fade | long | 7% | mid | 393 | 346 | 45% | -0.038 | -0.132..+0.073 | -0.072 / -0.003 | no_evidence |
| move30 | fade | short | 3% | hi | 2388 | 1677 | 48% | -0.074 | -0.124..-0.020 | -0.035 / -0.113 | negative |
| move30 | fade | short | 3% | lo | 4078 | 2403 | 50% | -0.041 | -0.069..-0.012 | -0.060 / -0.023 | negative |
| move30 | fade | short | 3% | mid | 2968 | 1905 | 51% | -0.024 | -0.065..+0.018 | -0.021 / -0.028 | no_evidence |
| move30 | fade | short | 5% | hi | 894 | 781 | 45% | -0.109 | -0.169..-0.036 | -0.063 / -0.155 | negative |
| move30 | fade | short | 5% | lo | 1283 | 1061 | 49% | -0.037 | -0.084..+0.016 | -0.028 / -0.046 | no_evidence |
| move30 | fade | short | 5% | mid | 1001 | 883 | 49% | -0.036 | -0.089..+0.019 | -0.037 / -0.034 | no_evidence |
| move30 | fade | short | 7% | hi | 454 | 423 | 45% | -0.109 | -0.191..-0.023 | -0.086 / -0.133 | negative |
| move30 | fade | short | 7% | lo | 588 | 535 | 47% | -0.069 | -0.143..-0.000 | -0.077 / -0.061 | negative |
| move30 | fade | short | 7% | mid | 489 | 459 | 47% | -0.040 | -0.113..+0.048 | -0.112 / +0.032 | no_evidence |
| move30 | follow | long | 3% | hi | 2388 | 1677 | 49% | -0.053 | -0.104..-0.002 | -0.096 / -0.011 | negative |
| move30 | follow | long | 3% | lo | 4078 | 2403 | 48% | -0.076 | -0.104..-0.046 | -0.053 / -0.098 | negative |
| move30 | follow | long | 3% | mid | 2968 | 1905 | 47% | -0.092 | -0.137..-0.048 | -0.094 / -0.090 | negative |
| move30 | follow | long | 5% | hi | 894 | 781 | 50% | -0.011 | -0.085..+0.052 | -0.056 / +0.034 | no_evidence |
| move30 | follow | long | 5% | lo | 1283 | 1061 | 48% | -0.068 | -0.123..-0.017 | -0.069 / -0.067 | negative |
| move30 | follow | long | 5% | mid | 1001 | 883 | 48% | -0.063 | -0.121..-0.006 | -0.052 / -0.073 | negative |
| move30 | follow | long | 7% | hi | 454 | 423 | 49% | -0.025 | -0.109..+0.055 | -0.037 / -0.012 | no_evidence |
| move30 | follow | long | 7% | lo | 588 | 535 | 49% | -0.044 | -0.123..+0.028 | -0.017 / -0.070 | no_evidence |
| move30 | follow | long | 7% | mid | 489 | 459 | 47% | -0.054 | -0.134..+0.027 | +0.032 / -0.139 | no_evidence |
| move30 | follow | short | 3% | hi | 1946 | 1325 | 48% | -0.054 | -0.121..+0.007 | -0.072 / -0.036 | no_evidence |
| move30 | follow | short | 3% | lo | 3536 | 1992 | 47% | -0.083 | -0.134..-0.029 | -0.058 / -0.108 | negative |
| move30 | follow | short | 3% | mid | 2608 | 1568 | 48% | -0.060 | -0.126..+0.005 | -0.030 / -0.090 | no_evidence |
| move30 | follow | short | 5% | hi | 729 | 610 | 46% | -0.057 | -0.132..+0.011 | -0.060 / -0.054 | no_evidence |
| move30 | follow | short | 5% | lo | 1124 | 855 | 47% | -0.045 | -0.130..+0.045 | -0.024 / -0.066 | no_evidence |
| move30 | follow | short | 5% | mid | 828 | 648 | 47% | -0.022 | -0.129..+0.073 | -0.042 / -0.001 | no_evidence |
| move30 | follow | short | 7% | hi | 393 | 348 | 45% | -0.063 | -0.153..+0.024 | -0.017 / -0.109 | no_evidence |
| move30 | follow | short | 7% | lo | 475 | 395 | 47% | -0.015 | -0.097..+0.079 | +0.089 / -0.118 | no_evidence |
| move30 | follow | short | 7% | mid | 393 | 346 | 45% | -0.036 | -0.151..+0.064 | -0.009 / -0.063 | no_evidence |
| move30_hold1h | fade | long | 3% | hi | 1946 | 1325 | 55% | +0.014 | -0.018..+0.043 | +0.006 / +0.022 | no_evidence |
| move30_hold1h | fade | long | 3% | lo | 3536 | 1992 | 54% | +0.022 | -0.006..+0.050 | +0.007 / +0.038 | no_evidence |
| move30_hold1h | fade | long | 3% | mid | 2608 | 1568 | 55% | +0.015 | -0.020..+0.048 | +0.005 / +0.025 | no_evidence |
| move30_hold1h | fade | long | 5% | hi | 729 | 610 | 52% | +0.026 | -0.037..+0.088 | +0.002 / +0.050 | no_evidence |
| move30_hold1h | fade | long | 5% | lo | 1124 | 855 | 54% | +0.026 | -0.026..+0.070 | +0.012 / +0.040 | no_evidence |
| move30_hold1h | fade | long | 5% | mid | 828 | 648 | 51% | +0.004 | -0.066..+0.068 | -0.038 / +0.047 | no_evidence |
| move30_hold1h | fade | long | 7% | hi | 393 | 348 | 54% | +0.070 | -0.027..+0.176 | +0.052 / +0.087 | no_evidence |
| move30_hold1h | fade | long | 7% | lo | 475 | 395 | 52% | -0.005 | -0.081..+0.077 | -0.070 / +0.060 | no_evidence |
| move30_hold1h | fade | long | 7% | mid | 393 | 346 | 52% | +0.044 | -0.055..+0.169 | -0.004 / +0.092 | no_evidence |
| move30_hold1h | fade | short | 3% | hi | 2388 | 1677 | 51% | -0.034 | -0.055..-0.014 | -0.030 / -0.039 | negative |
| move30_hold1h | fade | short | 3% | lo | 4078 | 2403 | 54% | -0.015 | -0.031..+0.001 | -0.022 / -0.008 | no_evidence |
| move30_hold1h | fade | short | 3% | mid | 2968 | 1905 | 53% | -0.022 | -0.044..-0.000 | -0.011 / -0.032 | negative |
| move30_hold1h | fade | short | 5% | hi | 894 | 781 | 49% | -0.046 | -0.090..-0.002 | -0.030 / -0.062 | negative |
| move30_hold1h | fade | short | 5% | lo | 1283 | 1061 | 54% | -0.009 | -0.040..+0.025 | -0.007 / -0.011 | no_evidence |
| move30_hold1h | fade | short | 5% | mid | 1001 | 883 | 50% | -0.053 | -0.102..+0.006 | -0.057 / -0.048 | no_evidence |
| move30_hold1h | fade | short | 7% | hi | 454 | 423 | 46% | -0.071 | -0.145..+0.008 | -0.076 / -0.066 | no_evidence |
| move30_hold1h | fade | short | 7% | lo | 588 | 535 | 51% | -0.034 | -0.089..+0.031 | -0.015 / -0.054 | no_evidence |
| move30_hold1h | fade | short | 7% | mid | 489 | 459 | 45% | -0.098 | -0.176..-0.023 | -0.167 / -0.031 | negative |
| move30_hold1h | follow | long | 3% | hi | 2388 | 1677 | 45% | -0.001 | -0.028..+0.025 | -0.011 / +0.010 | no_evidence |
| move30_hold1h | follow | long | 3% | lo | 4078 | 2403 | 43% | -0.003 | -0.024..+0.016 | +0.001 / -0.008 | no_evidence |
| move30_hold1h | follow | long | 3% | mid | 2968 | 1905 | 43% | -0.001 | -0.028..+0.026 | +0.004 / -0.006 | no_evidence |
| move30_hold1h | follow | long | 5% | hi | 894 | 781 | 45% | +0.019 | -0.037..+0.083 | +0.003 / +0.035 | no_evidence |
| move30_hold1h | follow | long | 5% | lo | 1283 | 1061 | 42% | -0.007 | -0.047..+0.034 | -0.024 / +0.009 | no_evidence |
| move30_hold1h | follow | long | 5% | mid | 1001 | 883 | 43% | +0.028 | -0.039..+0.107 | +0.055 / +0.000 | no_evidence |
| move30_hold1h | follow | long | 7% | hi | 454 | 423 | 45% | +0.036 | -0.078..+0.164 | +0.023 / +0.050 | no_evidence |
| move30_hold1h | follow | long | 7% | lo | 588 | 535 | 44% | +0.012 | -0.060..+0.089 | -0.001 / +0.026 | no_evidence |
| move30_hold1h | follow | long | 7% | mid | 489 | 459 | 46% | +0.089 | -0.027..+0.257 | +0.187 / -0.009 | no_evidence |
| move30_hold1h | follow | short | 3% | hi | 1946 | 1325 | 40% | -0.061 | -0.087..-0.037 | -0.069 / -0.053 | negative |
| move30_hold1h | follow | short | 3% | lo | 3536 | 1992 | 42% | -0.042 | -0.061..-0.024 | -0.032 / -0.052 | negative |
| move30_hold1h | follow | short | 3% | mid | 2608 | 1568 | 41% | -0.052 | -0.076..-0.028 | -0.064 / -0.041 | negative |
| move30_hold1h | follow | short | 5% | hi | 729 | 610 | 42% | -0.086 | -0.135..-0.035 | -0.099 / -0.072 | negative |
| move30_hold1h | follow | short | 5% | lo | 1124 | 855 | 42% | -0.058 | -0.096..-0.023 | -0.051 / -0.065 | negative |
| move30_hold1h | follow | short | 5% | mid | 828 | 648 | 41% | -0.070 | -0.125..-0.016 | -0.079 / -0.062 | negative |
| move30_hold1h | follow | short | 7% | hi | 393 | 348 | 38% | -0.100 | -0.177..-0.015 | -0.153 / -0.048 | negative |
| move30_hold1h | follow | short | 7% | lo | 475 | 395 | 43% | -0.032 | -0.089..+0.034 | +0.010 / -0.072 | no_evidence |
| move30_hold1h | follow | short | 7% | mid | 393 | 346 | 36% | -0.139 | -0.224..-0.061 | -0.178 / -0.101 | negative |
