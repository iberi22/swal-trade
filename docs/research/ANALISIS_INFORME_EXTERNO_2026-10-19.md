# Analisis del informe externo "Arquitectura y prompt maestro" (2026-10-19)

Fuente: `swal_trade_arquitectura_y_prompt_maestro.md`, entregado por un agente con el que opera Bel. Se contrasto cada afirmacion con el codigo y con nuestras mediciones. Resultado: la mitad de la ingenieria que propone ya existe, una parte es util y una parte afirma lo contrario de lo que miden nuestros datos.

## Afirmaciones verificadas

| Afirmacion del informe | Veredicto | Evidencia |
|---|---|---|
| Brecha de ejecucion atomica: la entrada puede quedar sin stop y sin normalizar `tickSize`/`stepSize` | **Falso para nuestro codigo** | `place_order` del MCP ya coloca el STOP_MARKET por el Algo Service (`closePosition`, `MARK_PRICE`, `priceProtect`), reintenta y, si falla, cierra con MARKET `reduceOnly` y devuelve el error (`packages/mcp/src/place.ts`, `STOP_ATTEMPTS`). Redondea cantidad a `stepSize`, precio a `tickSize` y valida `MIN_NOTIONAL`. El bot Rust hace lo mismo ("Fail-closed protective stop" con cierre de emergencia, `binance_rest.rs`). Diferencias reales y pequenas: 2 intentos en vez de 3 y sin comprobacion previa de distancia minima al precio de marca. |
| El stop "automatico" fallo hoy en HBARUSDC | **No comprobable, improbable** | La posicion la abrio Bel a mano en la web de Binance; no pasa por el MCP ni por el bot. |
| 0 de 92 patrones superan al azar | **Correcto** (y la auditoria posterior lo amplia: 17 de 28 celdas patron+direccion pierden en las dos mitades) | `docs/research/AUDIT_PATRONES_2026-10-18.md` |
| /analisis/ presenta hallazgos como senales y contradice /evidencia/ | **Parcialmente desactualizado** | Cada hallazgo ya lleva "no supero al azar en nuestra medicion" y la nota dice que no es una probabilidad; faltaba el enlace a /evidencia/ (anadido). |
| Una puntuacion de confluencia de 0 a 100 (30/30/25/15 puntos: estructura, CVD, funding+OI, espacio) autoriza entradas con S >= 65 | **No respaldado** | Los pesos y umbrales son inventados y no se midieron. Nuestras mediciones: OB, FVG y barridos de liquidez dan R neto negativo robusto; funding y miedo/codicia no dieron ventaja estable (el orden cambia entre mitades); el interes abierto solo tiene ~30 dias de historia, no se puede medir en 90. |
| El Scale-In en 3 tramos "convierte zonas de liquidez en una estrategia con asimetria matematica positiva" | **Falso (medido)** | Ver abajo. |
| La matematica de tamano es correcta: `Q = R_max / |SL - P_medio|` con pesos 25/35/40 acota la perdida a R_max | **Correcto** | Es aritmetica; sirve como herramienta de tamano, no como ventaja. |
| Maquina de estados: stop faltante, mover a break-even, descarga parcial | **Util y en parte hecha** | El bot ya adopta posiciones con stop propio y la extension avisa NO_STOP; el guardian avisa sin stop. Falta una descarga automatica; solo debe actuar en testnet o con ENFORCE activado por Bel. |
| Modelo abierto/privado y plan Partner de 10 USDT | **Coincide con lo decidido** | Todo libre y gratis en la fase de prueba hasta 2026-12-31; el motor privado sigue en `synapse-trading`. |

## Medicion: ¿el escalonado cambia la esperanza?

Se simulo el plan del informe (tramos 25/35/40 % a 0, 40 y 80 % de la distancia al stop) contra una entrada unica con el mismo R_max, sobre los 2.681 eventos de "comprar la caida" del estudio de 144 pares (`radar.scale_in_study`, coste 0,08 % en toda cantidad llenada, relleno de limites optimista y sin seleccion adversa):

| stop | variante | R neto medio por ciclo (R_max) | IC95 por dia | acierto |
|---|---|---|---|---|
| 4 % | entrada unica | +0,033 | -0,031 a +0,104 | 46 % |
| 4 % | escalonado 3 tramos | +0,019 | -0,040 a +0,081 | 52 % |
| 8 % | entrada unica | +0,019 | -0,023 a +0,062 | 52 % |
| 8 % | escalonado 3 tramos | +0,014 | -0,022 a +0,049 | 60 % |

**Escalonar sube el acierto (46 a 52 %, 52 a 60 %) y deja la esperanza igual (cero dentro del ruido; incluso algo menor).** Es la ilusion de "tasa de acierto alta": se cambia la forma de la distribucion (mas ganancias pequenas, perdidas completas ocasionales), no la media. Con seleccion adversa real (los tramos profundos se llenan cuando el precio va en contra) seria peor. Conclusion: el escalonado es una forma de dimensionar y acotar el riesgo, no una fuente de ventaja.

## Que se adopta

1. **Herramienta de tamano escalonado en la extension** (deterministica, con el aviso anterior): tres tramos, perdida maxima exacta R_max, precio medio, precio de equilibrio, "si se llenan los tres y toca el stop pierdes X". Es lo que habria acotado la perdida de HBAR (entrada del 100 % de una vez).
2. **Enlace /analisis/ a /evidencia/** (hecho en este cambio).
3. **Guardia contra promediar a la baja** en posiciones perdedoras: ya existe la regla AVERAGING_DOWN en la extension.
4. **Comprobacion previa de distancia minima del stop y tercer intento** en `place_order` y en el bot: mejora pequena, tarea abierta.
5. **Gestion automatica de posiciones (stop faltante, break-even, descarga)**: solo en testnet o bajo ENFORCE explicito de Bel; la cuenta real no se toca sin su permiso.

## Que no se adopta (hasta medirlo)

- La puntuacion de confluencia S_regime con sus pesos. Si se quiere, se pre-registra como hipotesis y pasa el mismo estudio con costes (n_clusters, mitades, intervalos) antes de mostrarse. CVD y toma de agresivos de velas necesitan volumen de agresor por vela (indices 9 y 10 de las velas), que el estudio de 144 pares no descargo.
- "Asimetria matematica positiva": no esta medida.
