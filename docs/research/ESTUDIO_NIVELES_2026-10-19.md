# Estudio de reaccion de los niveles del mapa (2026-10-19)

> Medicion **en muestra** de 90 dias de velas de 5 m en 5 perpetuos (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT). Mide con que frecuencia el precio **reacciona** a cada nivel frente a **romperlo**, comparado con un azar empirico de la misma serie. **No es evidencia hacia adelante, no es una probabilidad de que el nivel "aguante" y no es una recomendacion.** Reproducir: `python3 -m radar.level_study SALIDA.md salida.json`.

## Resumen

- **31537 eventos** de toque en 5 simbolos, 90 dias, 32 celdas (tipo x lado).
- **1** celdas `promising`, **0** `negative`, 31 `no_evidence`. Ninguna se declara validada: es en muestra, 90 dias y los niveles estan correlacionados.
- Rango de lifts (n >= 30): de -3.5 pp (dayOpen/resistance) a +6.8 pp (prevWeekHigh/support).
- Control de ruido (paseo aleatorio sin niveles con significado): 1 celdas salen `promising` y 2 `negative` de 32, con lifts de -6.4 a +9.1 pp.
- Promising: round/support (+3.7 pp, n=2081).

## Metodo (pre-registrado antes de ver los numeros)

**Datos.** BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT perpetuos, velas de 5 m. Se descargan 120 dias para tener
historia suficiente de 1h/4h/diario/semanal y para que EMA50 4h y la apertura mensual esten calientes;
los eventos solo se cuentan en los ultimos 90 dias. Todo se agrega desde las velas de 5 m en
rejillas UTC (semanas desde el lunes 00:00, meses desde el dia 1 00:00). Sin costes y sin P&L: solo se
mide la frecuencia de reaccion.

**Niveles.** Se recalculan en cada vela de 5 m solo con velas **cerradas antes de que ella abra**,
con las definiciones de `apps/extension/src/lib/context/levels.ts`: PDH/PDL, pivote clasico y R1/S1 del
dia anterior; apertura del dia; apertura de la semana y PWH/PWL de la semana anterior; apertura del
mes (solo si el dia 1 esta en la historia); EMA20 y EMA50 de 1h, EMA50 de 4h y bandas de
Bollinger(20,2) de 1h; y los dos numeros redondos adyacentes al ultimo cierre (paso segun la magnitud:
82.000 -> 1.000, 3.000 -> 100, 150 -> 10). Diferencia con la extension: esta alimenta las medias con el
cierre de la vela en curso; aqui no se usa nada de la vela evaluada (ni posterior), para no mirar el
futuro. No se replica la fusion de niveles a menos del 0,1 %: cada tipo se mide por separado (si PDH y
R1 coinciden son dos eventos, y esa correlacion se advierte abajo).

**Toque.** Para la vela i y el nivel L: *resistencia* si el cierre previo < L <= maximo de la vela;
*soporte* si el cierre previo > L >= minimo. Los toques del mismo (simbolo, tipo, lado) a menos de 12
velas se fusionan con el primero; un **cambio del valor del nivel** (nivel discreto que rota de dia o
de semana, media que se ha desplazado) empieza un evento nuevo.

**Unidad.** A = ATR14 de Wilder sobre velas de 1h ya cerradas en el momento del toque.

**Resultado.** 48 velas (4 h) despues de la vela del toque. **REACCIONA** si el precio llega a 1,0 A
del nivel (abajo para resistencia, arriba para soporte) antes de que un **cierre** de 5 m supere el
nivel en 0,5 A; **ROMPE** si ese cierre llega primero; **SIN RESOLVER** en el resto. Si las dos cosas
caen en la misma vela cuenta como ROMPE (conservador). Solo se cuentan eventos con ventana completa
de 48 velas. Tasa = reacciona / (reacciona + rompe).

**Azar.** (a) Referencia analitica de paseo aleatorio sin deriva: 0,5 / 1,5 = 33,3 % (solo como
comprobacion de cordura). (b) **Azar empirico**: cada vela de 5 m evaluada del mismo simbolo es un
"instante al azar" y se aplica la misma regla como si el precio estuviera EN un nivel ahi (L = cierre
de esa vela, A = ATR de esa vela, lado al azar). El valor esperado por evento bajo sorteo uniforme se
calcula exacto; 1000 permutaciones (mismo numero de eventos por simbolo) dan la banda del azar agregado
(percentiles 2,5 y 97,5). El *lift* es la tasa del nivel menos la tasa de azar, en puntos porcentuales.
Columna de robustez: el mismo calculo con el lado del azar igual al del evento (`lift pareado`), que
controla la deriva de la ventana.

**Cortes.** (1) Tendencia de 4h con EMAs de velas cerradas (EMA20 4h frente a EMA50 4h): el rebote
(arriba en soporte, abajo en resistencia) va *con la tendencia* o *contra la tendencia*. (2) Primera
mitad (dias 1-45) frente a segunda mitad. (3) Consistencia por simbolo: cuantos de los
5 simbolos tienen el mismo signo de lift que el conjunto.

**Incertidumbre.** Wilson 95 % para la tasa y bootstrap por dia (1000 remuestreos de dias completos)
para el lift. Se reportan n de eventos y n de dias.

**Grado.** `no_evidence` si n < 30 o el IC95 del lift contiene el 0; `promising` si el IC95 del lift
esta por encima de 0 **y** las dos mitades tienen lift > 0 **y** al menos 4 de 5 simbolos coinciden;
`negative` si el IC95 del lift esta por debajo de 0. Nunca se usa la etiqueta `validated`: es en
muestra, 90 dias, y los niveles estan correlacionados entre si (PDH y R1 suelen caer a la vez).

**Patrones del radar.** Si hay ficheros de auditoria ya calculados (`/tmp/tn/audit/*.jsonl`) se
re-emiten por (patron, direccion): n, acierto 1R con Wilson, R neto con IC95 bootstrap, azar del
`meta` del fichero y grado con la misma regla (mas R neto positivo en las dos mitades). No se
recalcula nada: son P&L con costes y se leen como en `docs/research/AUDIT_PATRONES_2026-10-18.md`.

## Advertencias (leer antes de usar un numero)

1. **En muestra, una sola ventana.** Son 90 dias y 32 pruebas (tipo x lado): algun positivo
   es esperable por azar (el control de ruido de abajo mide cuantos). Nada aqui es evidencia hacia
   adelante.
2. **Reaccion no es beneficio.** Una tasa alta de reaccion no paga el coste ni dice como entrar,
   donde poner el stop o cuanto arriesgar. No hay P&L en este estudio a proposito, y por eso tampoco
   hay costes.
3. **Los niveles estan correlacionados.** PDH, R1, EMA y redondo caen a menudo a pocos puntos del
   mismo precio: los eventos no son independientes y el conjunto de pruebas esta inflado. Los
   intervalos por dia no corrigen la dependencia entre niveles ni entre simbolos (BTC, ETH, SOL, BNB
   y XRP se mueven juntos).
4. **El azar tambien es en muestra** y usa las mismas series: mide geometria y volatilidad, no una
   estrategia alternativa. Y hay una asimetria conocida: un evento real empieza en el cierre de la
   vela del toque, que puede estar a cierta distancia del nivel, mientras que el azar empieza
   exactamente en el nivel (la mediana medida esta en Datos). Esa asimetria empuja el lift hacia
   abajo (hacia ROMPE) y el control de ruido la incluye, asi que no se corrige a mano: se compara
   contra el. La columna `lift pareado` controla el lado, no la distancia de entrada.
5. **Cinco mayores y 90 dias.** No generaliza a otros pares ni a otros regimenes; la deriva de la
   ventana por simbolo esta en Datos.
6. **El resultado depende del umbral.** 1,0 ATR de reaccion y 0,5 ATR de ruptura en 4 h son parte del
   pre-registro, no del nivel: con otros umbrales el numero cambia. No se ajustaron tras ver los datos.
7. **Muestra pequena por celda** en niveles poco tocados (apertura de mes, semanales): n < 30 se
   etiqueta `no_evidence` sin mirar el signo.
8. **La fusion de 12 velas no actua igual en todos los tipos.** Un nivel discreto (PDH, apertura,
   redondo) repite valor y por tanto se fusiona; una media que se mueve cambia de valor en cada vela
   y cada toque cuenta como evento nuevo. Por eso EMA20/EMA50 tienen muchos mas eventos solapados
   que PDH, y su n no es comparable entre tipos.
9. **Una ventana con tendencia favorece al lado de la tendencia.** El azar se mide en toda la
   ventana, no en el mismo dia que el evento: si la ventana sube, las celdas de soporte (rebote
   alcista) recogen esa subida y las de resistencia no. Por eso el signo de los lifts se lee junto a
   la deriva por simbolo (Datos) y al `lift pareado`.

## Resultados por nivel y lado

32 celdas (tipo de nivel x lado) con al menos un evento. `reacciona` es reacciona/(reacciona+rompe) con IC95 de Wilson; `azar` es la tasa empirica de la celda con la banda de sus 1000 permutaciones; `lift` son puntos porcentuales sobre ese azar con su IC95 por dia; `lift pareado` repite el calculo con el lado del azar igual al del evento.

| nivel | lado | n | dias | reacciona (IC95) | rompe | sin resolver | azar (banda) | lift pp | IC95 lift | lift pareado pp | grado |
|---|---|---|---|---|---|---|---|---|---|---|---|
| prevDayHigh | resistance | 649 | 62 | 34.7% (31%-39%) | 375 | 12% | 36.8% (33%-41%) | -2.1 | -7.3..+4.5 | -0.8 | no_evidence |
| prevDayHigh | support | 554 | 58 | 39.4% (35%-44%) | 304 | 9% | 36.8% (33%-41%) | +2.6 | -3.6..+8.8 | +1.3 | no_evidence |
| prevDayLow | resistance | 440 | 52 | 38.1% (34%-43%) | 250 | 8% | 36.8% (32%-42%) | +1.4 | -5.1..+8.7 | +2.5 | no_evidence |
| prevDayLow | support | 544 | 57 | 36.7% (33%-41%) | 316 | 8% | 36.8% (32%-41%) | -0.1 | -5.3..+5.9 | -1.2 | no_evidence |
| prevWeekHigh | resistance | 188 | 39 | 33.9% (27%-41%) | 115 | 7% | 36.7% (29%-45%) | -2.8 | -10.5..+6.8 | -1.3 | no_evidence |
| prevWeekHigh | support | 191 | 39 | 43.5% (36%-51%) | 96 | 11% | 36.7% (29%-44%) | +6.8 | -3.2..+17.4 | +5.3 | no_evidence |
| prevWeekLow | resistance | 235 | 35 | 37.0% (30%-44%) | 121 | 18% | 36.8% (30%-44%) | +0.2 | -8.0..+8.3 | +1.2 | no_evidence |
| prevWeekLow | support | 231 | 38 | 39.1% (33%-46%) | 123 | 13% | 36.8% (30%-44%) | +2.3 | -5.7..+11.9 | +1.2 | no_evidence |
| dayOpen | resistance | 1816 | 90 | 33.3% (31%-36%) | 1035 | 15% | 36.8% (35%-39%) | -3.5 | -7.6..+0.8 | -2.3 | no_evidence |
| dayOpen | support | 1818 | 90 | 36.9% (35%-39%) | 948 | 17% | 36.8% (34%-39%) | +0.1 | -3.8..+3.9 | -1.2 | no_evidence |
| weekOpen | resistance | 569 | 66 | 36.8% (33%-41%) | 323 | 10% | 36.8% (32%-41%) | -0.0 | -6.5..+6.3 | +1.4 | no_evidence |
| weekOpen | support | 562 | 65 | 38.1% (34%-43%) | 302 | 13% | 36.8% (32%-41%) | +1.3 | -4.4..+7.8 | -0.1 | no_evidence |
| monthOpen | resistance | 326 | 43 | 34.6% (29%-40%) | 191 | 10% | 36.8% (31%-43%) | -2.2 | -9.7..+5.7 | -1.1 | no_evidence |
| monthOpen | support | 347 | 47 | 40.9% (35%-46%) | 178 | 13% | 36.8% (31%-43%) | +4.0 | -3.2..+12.0 | +2.9 | no_evidence |
| pivot | resistance | 1268 | 85 | 36.8% (34%-40%) | 679 | 15% | 36.8% (34%-40%) | +0.0 | -4.6..+4.6 | +1.3 | no_evidence |
| pivot | support | 1267 | 86 | 36.1% (33%-39%) | 675 | 17% | 36.8% (34%-40%) | -0.7 | -4.5..+3.5 | -2.0 | no_evidence |
| r1 | resistance | 562 | 62 | 39.1% (35%-43%) | 309 | 10% | 36.8% (33%-41%) | +2.2 | -3.6..+9.4 | +3.5 | no_evidence |
| r1 | support | 458 | 53 | 40.1% (36%-45%) | 260 | 5% | 36.8% (32%-42%) | +3.3 | -2.6..+9.2 | +2.0 | no_evidence |
| s1 | resistance | 391 | 50 | 39.0% (34%-44%) | 216 | 9% | 36.7% (32%-42%) | +2.2 | -5.7..+9.7 | +3.3 | no_evidence |
| s1 | support | 486 | 56 | 35.0% (31%-40%) | 282 | 11% | 36.8% (32%-42%) | -1.7 | -7.1..+5.0 | -2.8 | no_evidence |
| ema20_1h | resistance | 2364 | 88 | 33.9% (32%-36%) | 1333 | 15% | 36.8% (35%-39%) | -2.9 | -7.0..+1.5 | -1.6 | no_evidence |
| ema20_1h | support | 2393 | 89 | 38.0% (36%-40%) | 1225 | 17% | 36.8% (35%-39%) | +1.2 | -3.0..+5.3 | -0.1 | no_evidence |
| ema50_1h | resistance | 1701 | 85 | 38.4% (36%-41%) | 871 | 17% | 36.8% (34%-39%) | +1.5 | -3.4..+6.2 | +2.8 | no_evidence |
| ema50_1h | support | 1690 | 85 | 37.4% (35%-40%) | 901 | 15% | 36.8% (34%-39%) | +0.6 | -4.1..+5.3 | -0.7 | no_evidence |
| ema50_4h | resistance | 688 | 67 | 34.1% (30%-38%) | 389 | 14% | 36.8% (33%-41%) | -2.7 | -9.1..+3.7 | -1.5 | no_evidence |
| ema50_4h | support | 642 | 67 | 36.7% (33%-41%) | 354 | 13% | 36.8% (33%-41%) | -0.1 | -5.4..+5.7 | -1.4 | no_evidence |
| bbUpper | resistance | 1489 | 86 | 37.2% (35%-40%) | 843 | 10% | 36.8% (34%-39%) | +0.4 | -4.2..+5.6 | +1.7 | no_evidence |
| bbUpper | support | 1114 | 82 | 42.3% (39%-45%) | 586 | 9% | 36.8% (34%-40%) | +5.5 | -0.4..+10.8 | +4.2 | no_evidence |
| bbLower | resistance | 1043 | 74 | 41.6% (39%-45%) | 555 | 9% | 36.8% (34%-40%) | +4.9 | -0.3..+10.0 | +6.0 | no_evidence |
| bbLower | support | 1355 | 77 | 37.5% (35%-40%) | 747 | 12% | 36.8% (34%-40%) | +0.7 | -3.9..+5.8 | -0.4 | no_evidence |
| round | resistance | 2075 | 90 | 35.3% (33%-37%) | 1179 | 12% | 36.8% (35%-39%) | -1.5 | -4.2..+1.4 | -0.2 | no_evidence |
| round | support | 2081 | 90 | 40.5% (38%-43%) | 1070 | 14% | 36.8% (35%-39%) | +3.7 | +0.5..+6.9 | +2.4 | promising |

## Cortes: tendencia, mitades y simbolos

`con tend.` y `contra tend.` dan n y tasa de reaccion dentro de cada contexto (tendencia de 4h medida con EMAs de velas cerradas). El lift de cada mitad y el numero de simbolos con el mismo signo que el conjunto son las condiciones del grado.

| nivel | lado | con tend. (n, tasa) | contra tend. (n, tasa) | lift 1a mitad pp | lift 2a mitad pp | simbolos de acuerdo |
|---|---|---|---|---|---|---|
| prevDayHigh | resistance | 271, 31% | 378, 37% | -4.9 | +0.9 | 5/5 |
| prevDayHigh | support | 330, 39% | 224, 41% | +6.0 | -1.0 | 3/5 |
| prevDayLow | resistance | 203, 40% | 237, 36% | -3.8 | +5.8 | 3/5 |
| prevDayLow | support | 308, 40% | 236, 32% | +2.8 | -2.7 | 4/5 |
| prevWeekHigh | resistance | 5, 40% | 183, 34% | +4.7 | -9.5 | 3/5 |
| prevWeekHigh | support | 187, 43% | 4, 50% | +2.8 | +10.5 | 5/5 |
| prevWeekLow | resistance | 207, 40% | 28, 15% | -1.5 | +2.1 | 2/5 |
| prevWeekLow | support | 34, 57% | 197, 36% | +6.6 | -1.1 | 3/5 |
| dayOpen | resistance | 671, 31% | 1145, 35% | -4.1 | -3.0 | 4/5 |
| dayOpen | support | 1141, 36% | 677, 39% | +2.2 | -2.1 | 3/5 |
| weekOpen | resistance | 170, 33% | 399, 39% | -0.8 | +0.8 | 3/5 |
| weekOpen | support | 407, 35% | 155, 47% | +6.5 | -4.8 | 3/5 |
| monthOpen | resistance | 155, 35% | 171, 34% | +3.0 | -5.5 | 4/5 |
| monthOpen | support | 189, 42% | 158, 39% | +2.6 | +4.9 | 3/5 |
| pivot | resistance | 491, 34% | 777, 38% | -3.1 | +3.5 | 3/5 |
| pivot | support | 792, 37% | 475, 34% | +2.2 | -3.8 | 3/5 |
| r1 | resistance | 235, 34% | 327, 42% | +0.6 | +4.3 | 4/5 |
| r1 | support | 279, 41% | 179, 39% | +2.0 | +4.8 | 4/5 |
| s1 | resistance | 186, 39% | 205, 39% | +1.0 | +3.1 | 3/5 |
| s1 | support | 264, 35% | 222, 35% | -1.8 | -1.7 | 3/5 |
| ema20_1h | resistance | 938, 33% | 1426, 35% | -2.8 | -3.0 | 5/5 |
| ema20_1h | support | 1450, 37% | 943, 40% | +3.4 | -1.2 | 4/5 |
| ema50_1h | resistance | 689, 37% | 1012, 39% | +0.6 | +2.5 | 3/5 |
| ema50_1h | support | 1023, 37% | 667, 38% | +0.8 | +0.4 | 3/5 |
| ema50_4h | resistance | 290, 35% | 398, 33% | +2.6 | -9.0 | 4/5 |
| ema50_4h | support | 396, 38% | 246, 35% | -4.1 | +3.8 | 3/5 |
| bbUpper | resistance | 532, 40% | 957, 36% | +1.1 | -0.3 | 2/5 |
| bbUpper | support | 744, 45% | 370, 36% | +4.4 | +6.6 | 5/5 |
| bbLower | resistance | 463, 42% | 580, 41% | +2.2 | +7.3 | 4/5 |
| bbLower | support | 753, 37% | 602, 38% | +2.9 | -1.2 | 3/5 |
| round | resistance | 733, 36% | 1342, 35% | -2.7 | -0.2 | 3/5 |
| round | support | 1337, 41% | 744, 39% | +4.4 | +3.0 | 5/5 |

## Lift por simbolo (puntos porcentuales)

| nivel | lado | BTCUSDT | ETHUSDT | SOLUSDT | BNBUSDT | XRPUSDT |
|---|---|---|---|---|---|---|
| prevDayHigh | resistance | -6.2 | -0.4 | -0.8 | -1.1 | -1.3 |
| prevDayHigh | support | +2.1 | -0.4 | -1.4 | +0.9 | +12.9 |
| prevDayLow | resistance | +4.7 | -10.2 | +8.9 | -9.5 | +9.1 |
| prevDayLow | support | -1.3 | +9.2 | -1.0 | -1.3 | -2.7 |
| prevWeekHigh | resistance | +5.2 | +0.6 | -10.6 | -4.5 | -6.1 |
| prevWeekHigh | support | +3.8 | +9.6 | +26.7 | +2.4 | +13.4 |
| prevWeekLow | resistance | -2.5 | -16.6 | +5.3 | -13.8 | +11.0 |
| prevWeekLow | support | +9.4 | +12.7 | -9.3 | +6.4 | -2.0 |
| dayOpen | resistance | -5.8 | -4.3 | -6.5 | -3.8 | +2.4 |
| dayOpen | support | +0.7 | +0.6 | -0.8 | +0.2 | -0.0 |
| weekOpen | resistance | -1.0 | +4.5 | -8.1 | -3.9 | +12.1 |
| weekOpen | support | -4.8 | -0.2 | +3.3 | +0.8 | +8.4 |
| monthOpen | resistance | +1.1 | -6.8 | -1.3 | -2.2 | -2.7 |
| monthOpen | support | -3.9 | +12.0 | +3.6 | -7.9 | +10.9 |
| pivot | resistance | -2.0 | -3.3 | +1.5 | +1.8 | +2.0 |
| pivot | support | -2.3 | +2.9 | -2.8 | +2.0 | -4.3 |
| r1 | resistance | +2.0 | +6.6 | -3.6 | +0.2 | +5.5 |
| r1 | support | -3.8 | +4.7 | +10.1 | +3.5 | +2.4 |
| s1 | resistance | +13.9 | +8.2 | +0.6 | -3.6 | -3.6 |
| s1 | support | +3.5 | +6.4 | -7.7 | -7.7 | -1.5 |
| ema20_1h | resistance | -1.5 | -5.9 | -3.6 | -1.9 | -1.4 |
| ema20_1h | support | +1.1 | +3.1 | +1.6 | +1.2 | -1.1 |
| ema50_1h | resistance | -2.1 | -1.4 | +2.0 | +1.1 | +7.7 |
| ema50_1h | support | +5.5 | -2.1 | +3.6 | +0.8 | -3.1 |
| ema50_4h | resistance | -0.7 | +0.1 | -7.4 | -3.7 | -0.8 |
| ema50_4h | support | -3.4 | +6.9 | -0.9 | +4.5 | -8.1 |
| bbUpper | resistance | +2.4 | +4.1 | -2.6 | -1.8 | -1.2 |
| bbUpper | support | +4.1 | +3.1 | +8.9 | +4.4 | +7.3 |
| bbLower | resistance | +6.8 | +2.5 | -4.8 | +11.3 | +8.3 |
| bbLower | support | +1.0 | +3.1 | +3.6 | -2.1 | -1.7 |
| round | resistance | -3.3 | -6.2 | +3.0 | -2.9 | +1.0 |
| round | support | +4.7 | +2.6 | +0.3 | +4.6 | +6.9 |

## Patrones del radar (auditoria ya calculada, solo se re-emite)

28 combinaciones patron+direccion de BTCUSDC_15m.jsonl, BTCUSDC_1h.jsonl, ETHUSDC_15m.jsonl, ETHUSDC_1h.jsonl (replay ya existente; el azar es el del `meta` de cada fichero, bruto y sin costes; `R neto` incluye costes). El grado exige ademas R neto positivo en las dos mitades.

| patron | dir | n | acierto 1R (IC95) | R neto | IC95 R | azar | grado |
|---|---|---|---|---|---|---|---|
| double_bottom | long | 569 | 58% (54%-62%) | +0.02 | -0.06..+0.11 | 42% | no_evidence |
| double_top | short | 567 | 41% (37%-45%) | -0.34 | -0.42..-0.26 | 41% | negative |
| candle_hammer | long | 545 | 53% (49%-58%) | -0.32 | -0.41..-0.22 | 29% | negative |
| candle_shooting_star | short | 541 | 48% (44%-52%) | -0.47 | -0.56..-0.37 | 29% | negative |
| order_block_bearish | short | 505 | 46% (42%-51%) | -0.43 | -0.52..-0.34 | 30% | negative |
| order_block_bullish | long | 504 | 54% (50%-58%) | -0.27 | -0.37..-0.18 | 31% | negative |
| liquidity_sweep_bearish | short | 495 | 48% (44%-53%) | -0.53 | -0.63..-0.43 | 26% | negative |
| liquidity_sweep_bullish | long | 405 | 55% (50%-60%) | -0.40 | -0.51..-0.28 | 25% | negative |
| candle_engulfing_bullish | long | 343 | 53% (47%-58%) | -0.14 | -0.25..-0.03 | 39% | negative |
| range_breakout | long | 332 | 58% (52%-63%) | +0.07 | -0.03..+0.17 | 45% | no_evidence |
| candle_engulfing_bearish | short | 296 | 48% (42%-53%) | -0.27 | -0.38..-0.14 | 39% | negative |
| bull_flag | long | 290 | 53% (48%-59%) | -0.10 | -0.21..+0.02 | 42% | no_evidence |
| fvg_bullish | long | 270 | 47% (41%-53%) | -0.38 | -0.50..-0.26 | 34% | negative |
| fvg_bearish | short | 252 | 53% (47%-59%) | -0.20 | -0.34..-0.07 | 37% | negative |
| range_breakout | short | 247 | 53% (46%-59%) | -0.03 | -0.16..+0.09 | 45% | no_evidence |
| candle_morning_star | long | 204 | 48% (41%-55%) | -0.25 | -0.39..-0.11 | 38% | negative |
| bear_flag | short | 201 | 49% (42%-56%) | -0.15 | -0.30..-0.01 | 43% | negative |
| candle_evening_star | short | 200 | 48% (42%-55%) | -0.25 | -0.39..-0.10 | 37% | negative |
| ascending_triangle | long | 130 | 52% (43%-60%) | -0.24 | -0.42..-0.06 | 37% | negative |
| rising_wedge | short | 111 | 45% (36%-54%) | -0.28 | -0.46..-0.10 | 40% | negative |
| descending_triangle | short | 101 | 48% (38%-57%) | -0.31 | -0.51..-0.10 | 37% | negative |
| falling_wedge | long | 95 | 49% (40%-59%) | -0.18 | -0.38..+0.02 | 41% | no_evidence |
| candle_doji | short | 82 | 60% (49%-70%) | -0.21 | -0.44..+0.04 | 31% | no_evidence |
| candle_doji | long | 69 | 62% (51%-73%) | -0.08 | -0.34..+0.17 | 33% | no_evidence |
| inverse_head_shoulders | long | 49 | 47% (34%-61%) | -0.15 | -0.44..+0.13 | 44% | no_evidence |
| head_shoulders | short | 45 | 56% (41%-69%) | +0.01 | -0.27..+0.29 | 45% | no_evidence |
| rsi_divergence_bearish | short | 15 | 60% (36%-80%) | +0.13 | -0.40..+0.66 | 45% | no_evidence |
| rsi_divergence_bullish | long | 3 | 0% (0%-56%) | -1.06 | -1.09..-1.04 | 45% | no_evidence |

## Control de ruido (paseo aleatorio puro)

En un paseo aleatorio sin deriva los niveles existen (PDH, EMAs, redondos se calculan igual) pero no significan nada: cualquier lift medido sobre el es sesgo o ruido de esta cadena, no una propiedad del nivel. Se ejecuto la misma cadena completa sobre 5 series sinteticas independientes (seed 11, sin deriva; deriva realizada en la ventana: +0 %, -11 %, -9 %, -10 %, +0 %; 32638 eventos, 32 celdas con n >= 30). Los lifts van de -6.4 a +9.1 pp con media -0.7 pp y desviacion 2.7 pp. Con el mismo grado, **1 celdas salen `promising` y 2 `negative` solo por azar**. Ese es el tamano del ruido y la tasa de falsos positivos del filtro (1/32 celdas). Por lado, el lift medio del control es -1.2 pp en soporte y -0.2 pp en resistencia: sin tendencia no hay asimetria por lado, asi que la que aparezca en los datos reales viene de la deriva de la ventana, no del nivel.

## Conclusion honesta

**La ventana no es neutra.** Los 5 pares subieron entre +17 % y +34 % en los 90 dias. El lift medio de las celdas de soporte es +1.8 pp y el de resistencia -0.3 pp: esa asimetria es lo que produce una tendencia alcista cuando el azar se mide en toda la ventana, y no dice nada del nivel. Por eso el signo de los lifts se lee junto al `lift pareado` (que mete la deriva en los dos lados) y al control de ruido; el grado se calcula, como estaba pre-registrado, sobre el azar de lado aleatorio.

Superan el filtro `promising`: round/support. Siguen siendo en muestra: la unica lectura permitida es "vigilar hacia adelante", no publicar un porcentaje de acierto. El control de ruido da 1 de 32 celdas `promising` sin niveles con significado, asi que con tantas pruebas alguno puede ser casualidad.

La tasa de reaccion observada se puede mostrar en el tooltip **solo como historial en muestra** ("en estos 90 dias, en 5 pares, el precio reacciono N % de las veces que toco el nivel; el azar da M %"), nunca como probabilidad de que el nivel aguante.

El control de ruido fija la escala: en series sin niveles con significado el lift medio es -0.7 pp con desviacion 2.7 pp (de -6.4 a +9.1 pp). Cualquier lift dentro de esa banda, incluidos los `negative` cercanos a 0, no se distingue del sesgo de la propia cadena.

Los patrones del radar re-emitidos (28 celdas) son P&L con costes y se leen como en `docs/research/AUDIT_PATRONES_2026-10-18.md`. Que un nivel "reaccione" mas que el azar no implica que se pueda operar con beneficio.

## Datos

- BTCUSDT: 34786 velas de 5m (121 dias, 0 velas ausentes), 6384 toques, 7681 fusiones, 6384 eventos con ventana completa, 25920 instantes de azar, deriva de la ventana +25.8 %
- ETHUSDT: 34786 velas de 5m (121 dias, 0 velas ausentes), 6203 toques, 7760 fusiones, 6203 eventos con ventana completa, 25920 instantes de azar, deriva de la ventana +26.6 %
- SOLUSDT: 34786 velas de 5m (121 dias, 0 velas ausentes), 6395 toques, 8513 fusiones, 6395 eventos con ventana completa, 25920 instantes de azar, deriva de la ventana +33.6 %
- BNBUSDT: 34786 velas de 5m (121 dias, 0 velas ausentes), 6440 toques, 7894 fusiones, 6440 eventos con ventana completa, 25920 instantes de azar, deriva de la ventana +26.6 %
- XRPUSDT: 34786 velas de 5m (121 dias, 0 velas ausentes), 6115 toques, 8077 fusiones, 6115 eventos con ventana completa, 25920 instantes de azar, deriva de la ventana +17.4 %

Eventos por tipo (y fraccion sin resolver): ema20_1h=4757 (16% sin resolver) round=4156 (13% sin resolver) dayOpen=3634 (16% sin resolver) ema50_1h=3391 (16% sin resolver) bbUpper=2603 (9% sin resolver) pivot=2535 (16% sin resolver) bbLower=2398 (10% sin resolver) ema50_4h=1330 (14% sin resolver) prevDayHigh=1203 (11% sin resolver) weekOpen=1131 (12% sin resolver) r1=1020 (8% sin resolver) prevDayLow=984 (8% sin resolver) s1=877 (10% sin resolver) monthOpen=673 (12% sin resolver) prevWeekLow=466 (15% sin resolver) prevWeekHigh=379 (9% sin resolver). En total 39925 toques se fusionaron con el toque anterior del mismo tipo y lado.

Diagnostico del inicio del evento: en 48% de los toques la vela del toque cierra del lado de la reaccion (por debajo de una resistencia / por encima de un soporte); mediana de (cierre - nivel) en ATR hacia el lado de la reaccion: -0.01; en 2.6% de los toques la propia vela del toque ya cierra mas de 0,5 ATR al otro lado (esa vela no entra en la ventana de 48, que empieza en la siguiente). El azar empieza siempre en distancia 0: esa asimetria se acota con el control de ruido (la columna `lift pareado` controla el lado, no la distancia de entrada).

Descarga: 90 dias evaluados, 120 dias descargados por simbolo, 5 simbolos secuenciales con pausa de 0.35 s entre peticiones (cache en `~/.cache/swal-trade/klines`). Tiempo de datos y calculo de eventos en esta ejecucion: 12 s (con la cache tibia es mucho menos que la primera descarga); control de ruido: 14 s.
