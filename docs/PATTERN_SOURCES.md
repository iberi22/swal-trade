# Fuentes de patrones para el núcleo determinista

Encuesta del 2026-10-09 para `workers/public-site/static/analisis/analysis-core.js` (repo público AGPL-3.0). El núcleo no copia código de terceros: reimplementa reglas publicadas. `strength` mide calidad geométrica del patrón, no una probabilidad.

Compatibilidad con AGPL-3.0, según el encargo: MIT, BSD, Apache-2.0, GPL-3.0 y AGPL-3.0 permiten reutilizar la idea y, si hiciera falta, el código (GPL-3 se puede combinar con AGPL-3; la cláusula de red de la AGPL cubre el conjunto). Licencia no comercial, propietaria, MPL o ausencia de licencia: solo se reimplementa a partir de la definición pública, nunca se copia código.

## Qué entra en el núcleo

| Detector | Por qué | Regla que usamos |
| --- | --- | --- |
| FVG sin rellenar | Desequilibrio de 3 velas, umbral objetivo, fácil de invalidar | Máximo de hace dos velas bajo el mínimo actual si la vela intermedia es alcista, y el caso bajista. Altura mínima 0.72 ATR. Se descarta si el precio cruza el lado lejano |
| BOS / CHoCH | Separa continuidad y giro. El quiebre es por cierre, no por mecha | BOS a favor del último swing roto; CHoCH en contra. Se invalida si el cierre recupera el swing opuesto |
| Order block | Zona de la última vela de color opuesto antes del impulso que rompe estructura | Sigue vigente mientras el cierre no atraviese el bloque |
| Barrido de liquidez | Stops en máximos o mínimos iguales | Dos swings dentro de 0.25 ATR y una mecha que los perfora con cierre de vuelta |
| Hombro-cabeza-hombro e inverso | Giro clásico con cuello medible | Tres swings, cabeza destacada (≥ 1 ATR), hombros parecidos, cuello entre los dos huecos |
| Cuña ascendente / descendente | Compresión con sesgo contrario a la pendiente | Las dos líneas van en la misma dirección y convergen. No sustituye al triángulo de lado plano |
| Bandera alcista / bajista | Continuación después de un impulso | Mástil ≥ 2.5 ATR y eficiencia ≥ 0.65; el retroceso queda entre 15 % y 62 % |
| Envolvente, martillo, estrella fugaz, estrella de la mañana/tarde, doji | Subconjunto CDL con definición estable | Solo si caen en un swing o en una zona de soporte/resistencia. La envolvente exige cuerpo ≥ 0.8 ATR. En cripto no se exige el hueco de apertura de las estrellas |

Cada hallazgo lleva en `levels` un precio `confirm` y un precio `invalidate` para que un backtest puntúe el desenlace sin reinterpretar el texto.

## Qué no entra

- Las ~60 funciones CDL de TA-Lib que no están en la lista. La literatura (Marshall, Young y Rose, 2006; el resumen de Lo, Mamaysky y Wang, 2000) no justifica tratarlas como señal suelta.
- Estrategias de freqtrade y de Jesse. Son cruces de indicadores ajustados por hyperopt, no geometría de patrón.
- Copa con asa. La copa es una base larga y redondeada; en la ventana de este núcleo (unas 120 velas, pensada también para 1m–4h) el asa ya queda cubierta por la bandera. Queda para un pase en temporalidad diaria.
- Grid y market making de Hummingbot. Es lógica de ejecución (spread, inventario), no detección de estructura.
- Scripts Pine, aunque sean “open source” en TradingView. La licencia por defecto de la casa y varios SMC públicos son MPL-2.0; LuxAlgo es marca cerrada. No se pega Pine.

## Fichas

### TA-Lib — definiciones CDL*

- URL: https://github.com/TA-Lib/ta-lib y el wrapper https://github.com/TA-Lib/ta-lib-python
- Documentación de umbrales: https://ta-lib.org/api/candle-settings/
- Licencia: BSD-3-Clause en la librería C; BSD-2-Clause en el wrapper Python. Compatible.
- Detecta: 61 patrones de vela (`CDLDOJI`, `CDLENGULFING`, `CDLHAMMER`, `CDLSHOOTINGSTAR`, `CDLMORNINGSTAR`, `CDLEVENINGSTAR`, y el resto del grupo).
- Calidad: las reglas son explícitas (cuerpo largo = 1× el cuerpo medio de 10 velas, doji = 0.1 del rango, sombra larga = 1× el cuerpo). Son la referencia estable. Como señal aislada, la mayoría no tiene ventaja fuera de muestra; por eso el núcleo se queda con cinco familias y exige contexto (swing o zona).
- Uso: reimplementar las definiciones. Hecho para envolvente, martillo, estrella fugaz, estrellas de tres velas y doji.

### pandas-ta

- URL del proyecto: https://www.pandas-ta.dev/ (el repo histórico `twopirllc/pandas-ta` respondió 404 en la API de GitHub el 2026-10-09). Fork público con LICENSE MIT: https://github.com/sanurielf/pandas-ta
- Licencia: MIT, declarada en el sitio y en los forks. Compatible.
- Detecta: más de 150 indicadores. Las velas (lista `cdl_*`, incluida `engulfing`, `hammer`, `morningstar`, `doji`) solo aparecen si TA-Lib está instalado: no hay un detector propio.
- Calidad: buen envoltorio de indicadores; no aporta geometría nueva. No vale la pena portar el catálogo al núcleo de patrones.
- Uso: no se copia. La fuente de las velas sigue siendo TA-Lib.

### ta (bukosabino)

- URL: https://github.com/bukosabino/ta
- Licencia: MIT. Compatible.
- Detecta: 43 indicadores (tendencia, momentum, volatilidad, volumen). No hay patrones de vela ni de gráfico.
- Calidad: implementaciones cortas en pandas/numpy, útiles como features, irrelevantes para FVG, estructura o figuras.
- Uso: no entra en este núcleo.

### freqtrade y freqtrade-strategies

- URL: https://github.com/freqtrade/freqtrade y https://github.com/freqtrade/freqtrade-strategies
- Licencia: GPL-3.0. Compatible con AGPL-3.0 (la GPL-3 permite combinarse con la AGPL-3).
- Detecta: no es un motor de patrones. Las estrategias del repo oficial son ejemplos de compra/venta con ROI, stop y cruces (RSI, EMA, Bollinger), muchas salidas de hyperopt.
- Calidad: sirven para aprender el ciclo backtest → parámetros. Portar una estrategia concreta traería umbrales sobreajustados, no una figura auditable. Colecciones de terceros (`werkkrew/freqtrade-strategies`) ni siquiera declaran licencia: no se tocan.
- Uso: no se porta ninguna estrategia. La idea que ya está en el núcleo es otra: contexto, confirmación e invalidación explícitas.

### Jesse

- URL: https://github.com/jesse-ai/jesse
- Licencia: MIT. Compatible.
- Detecta: marco de estrategias e indicadores (EMA, RSI, Ichimoku, etc.), reescritos en Rust y sin dependencia de TA-Lib desde 2025. No hay módulo de figuras ni de SMC.
- Calidad: la API de indicadores es clara y el backtest es serio. No describe hombro-cabeza-hombro, FVG ni order blocks.
- Uso: no se porta. El catálogo de ejemplo https://github.com/jesse-ai/awesome-jesse tampoco es una librería de patrones.

### smart-money-concepts (joshyattridge)

- URL: https://github.com/joshyattridge/smart-money-concepts
- Licencia: MIT (el archivo LICENSE arrastra una línea “Copyright (c) 2020 NeuralNine”; la licencia declarada en el repo es MIT). Compatible.
- Detecta, según el README:
  - FVG: el máximo previo queda por debajo del mínimo siguiente si la vela actual es alcista, o el mínimo previo por encima del máximo siguiente si es bajista. Devuelve techo, suelo e índice de mitigación.
  - Swing high/low con `swing_length` velas a cada lado.
  - BOS y CHoCH sobre esos swings. `close_break=True` exige cierre, no mecha.
  - Order block asociado al swing, con mitigación por cierre o por mecha.
  - Liquidez: varios máximos o mínimos dentro de `range_percent` (por defecto 0.01) y el índice de la vela que los barre.
- Calidad: es la descripción abierta más usable de SMC. Los fallos conocidos son de parámetro, no de concepto: `swing_length=50` es lento para 1m; un 1% fijo junta swings que no son “iguales” en cripto; el order block es heurístico (última vela opuesta, no un libro de órdenes). El código mezcla numba y un aviso de crédito al importar: no hace falta copiarlo.
- Uso: reimplementado en este núcleo con pivote fractal de 3 velas, quiebre por cierre, FVG solo si sigue sin rellenar, y liquidez igualada a 0.25 ATR en lugar del 1 %.

### Detectores de figuras (Python / JS)

| Repo | Licencia | Qué detecta | Calidad | ¿Copiar? |
| --- | --- | --- | --- | --- |
| https://github.com/BennyThadikaran/stock-pattern | GPL-3.0 | Doble techo/suelo, HCH, triángulos, armónicos, VCP. Los marca antes de la ruptura | Algoritmo documentado en el wiki; pensado para acciones diarias. Los armónicos dependen de ratios de Fibonacci y fallan con ruido | No hace falta copiar: la geometría clásica basta y ya tenemos dobles y triángulos. GPL-3 sería compatible, pero el código no entra |
| https://github.com/white07S/TradingPatternScanner | CC BY-NC-SA 4.0 | HCH e inverso, con filtro Savitzky-Golay | El filtro suaviza de más y la licencia prohíbe uso comercial | No. Solo la idea pública de “tres extremos y una cabeza más alta” |
| https://github.com/keithorange/PatternPy | CC BY-NC-SA 4.0 (el texto de licencia cita a Preetam Sharma, el mismo autor) | HCH, soportes y menciones de cuñas | Envoltorio del scanner anterior. Misma restricción | No |
| https://github.com/zeta-zetra/chart_patterns | Sin archivo LICENSE en la raíz (2026-10-09) | Dobles, bandera, HCH, triángulos, banderín | Funciones separadas por figura, pero sin licencia no hay permiso de copia | No. La bandera se reimplementa como mástil + retroceso |
| https://github.com/srdeotarse/Linear-Regression-for-Stock-Chart-Pattern-Recognition | MIT | Triángulo y HCH por regresión lineal | Notebook corto, pocos commits. La regresión de swings ya está en nuestros triángulos | No se copia el notebook. La técnica (pendiente de máximos y de mínimos) ya vive en `triangles()` y ahora en `wedges()` |
| https://github.com/tysoncung/crypto-chart-patterns | MIT | HCH, doble techo/suelo, triángulos, cuñas, banderas, sobre velas de Binance | Extremos locales + reglas matemáticas. El README promete más de lo que un repo pequeño suele sostener; sirve como lista de figuras, no como oracle | No se copia. Misma lista, reglas propias y tests sintéticos |
| https://github.com/niall-oc/pyharmonics | MIT | Armónicos XABCD (Gartley, Bat, etc.) al estilo de Scott Carney | Ratios estrictos, muchos falsos en cripto intradía. Otra familia, no figuras clásicas | Fuera de este incremento |

No apareció un detector JS maduro, con licencia permisiva y tests, que supere a estas descripciones. `bennycode/trading-signals` (MIT) es una librería de indicadores, no de figuras.

### Hummingbot

- URL: https://github.com/hummingbot/hummingbot y la estrategia https://github.com/hummingbot/hummingbot/tree/master/hummingbot/strategy/pure_market_making
- Licencia: Apache-2.0. Compatible.
- Detecta: nada de estructura de mercado. Pure Market Making cotiza bid/ask a un spread del medio, refresca órdenes y sesga el tamaño con el inventario. El executor de grid (V2) reparte órdenes en niveles fijos.
- Calidad: buen software de ejecución. Meterlo en el núcleo de patrones mezclaría una señal con un algoritmo de órdenes.
- Uso: no se reimplementa aquí.

### Pine en TradingView

- House rules de TradingView: un script “open source” se puede leer, pero republicarlo está condicionado. Eso no es MIT/BSD/Apache.
- https://github.com/CedInvest/sm-radar-pine — MPL-2.0. FVG, order blocks, liquidez, BOS/CHoCH. La MPL obliga a publicar los cambios del archivo. No está en la lista de licencias que este encargo acepta copiar. El README además pide contacto para uso comercial.
- https://github.com/castletrade/pine-script-smc-indicators — MIT en GitHub (order blocks, FVG, barridos por sesión). Aun así no se traduce el Pine: el núcleo ya tiene una sola implementación en JS, testeable, sin sesiones ni webhooks.
- Indicadores “LuxAlgo Smart Money Concepts” republicados en TradingView: la marca es cerrada. No son una fuente limpia.
- https://www.tradingview.com/script/nxjGgTLJ-Smart-Money-Concepts-Engine-Quantum-Algo/ — script abierto bajo las reglas de TradingView. Describe el mismo ciclo (BOS, bloque, FVG, barrido, premium/discount) y un score de confluencia. El score mezcla cinco condiciones en un 0–100: eso es otra cosa que nuestra `strength` geométrica, y no se copia.

## Adaptaciones conscientes

- Estrella de la mañana y del anochecer: TA-Lib pide un hueco. En un mercado de 24 horas ese hueco casi no existe, así que se exige cuerpo pequeño intermedio y cierre de la tercera vela más allá del punto medio de la primera, más el contexto de swing o zona.
- Liquidez “igual”: 0.25 ATR en lugar de `range_percent=0.01`, para que el mismo código sirva en un fixture de precio 100 y en BTC.
- Order block: última vela de color opuesto en las 25 velas anteriores al quiebre. Se tira solo si un cierre posterior atraviesa el bloque, no por un simple toque de mecha. Sigue publicado hasta 8 ATR de distancia: el impulso que lo crea lo deja atrás y el nivel sigue siendo la invalidación.
- FVG: altura mínima 0.72 ATR. Por debajo de eso un zigzag de mechas cortas fabrica huecos que no son un desequilibrio.
- Envolvente: el cuerpo que envuelve mide al menos 0.8 ATR. Un cuerpo menor en un swing no entra.
- Las velas sueltas tienen techo de fuerza 0.68 y no entran en el grupo que el ranking coloca primero. El primer puesto de `top` sigue siendo para figuras y estructura (`CHART_KINDS`) con fuerza ≥ 0.4, como máximo dos hallazgos por tipo. Una estructura con más de 30 velas no lidera ese grupo: queda en `findings` y compite por cercanía con el resto.

## Metodología

Lectura directa de README, LICENSE y, cuando hizo falta, del listado de archivos en la API de GitHub (TA-Lib, smart-money-concepts, freqtrade, Jesse, Hummingbot, stock-pattern, PatternPy, TradingPatternScanner, chart_patterns, pandas-ta.dev, Pine citados). Las fuentes están en inglés porque el código y las licencias lo están. No se ejecutó el código de esos repos y no se copió ningún archivo.