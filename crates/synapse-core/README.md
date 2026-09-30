# synapse-core

Núcleo **puro** de riesgo, dimensionamiento de posición e indicadores técnicos del
asistente de trading **no custodial** de SWAL (Binance Futures, PWA).

Este crate no hace I/O. No hay red, ni reloj, ni base de datos, ni `tokio`, ni
`unsafe`: solo funciones deterministas sobre `f64`. Eso es deliberado, y es lo que
permite que la PWA y el backend privado ejecuten **el mismo binario de reglas** sin
que puedan divergir nunca.

## Por qué un crate aparte

El riesgo y el dimensionamiento son las reglas que decide si una orden se firma. Si
la PWA calculara el tamaño de una posición por un lado y el servidor lo validara por
otro, bastaría una discrepancia de un redondeo para que una orden pasara en un
entorno y fuera rechazada en el otro. Al ser un crate sin dependencias de
plataforma, compilado a WebAssembly en el navegador y a nativo en el servidor, esa
divergencia no es representable: no hay dos implementaciones que mantener
sincronizadas, hay una.

Además, auditar el núcleo crítico de riesgo es leer menos de mil líneas.

## Módulos

| Módulo | Contenido |
|---|---|
| [`indicators`](src/indicators.rs) | `sma`, `ema`, `rsi`, `atr` y `true_range`, con suavizado de Wilder en `rsi` y `atr` |
| [`order_guard`](src/order_guard.rs) | `check_order`: la comprobación previa a firmar que decide si la orden se permite y, si no, explica cada motivo en español |
| [`risk_math`](src/risk_math.rs) | Aritmética de riesgo: R-multiples, riesgo por stop, cola de resultados, apalancamiento dinámico |
| [`risk`](src/risk.rs) | `RiskEngine`: validación de riesgo con estado de sesión y kill switch diario |
| [`sizing`](src/sizing.rs) | `PositionSizer`: plan de sesión con margen por posición, nocional, stop-loss seguro y límite de riesgo por operación |

### Contrato de los indicadores

Los cinco indicadores devuelven `Vec<Option<f64>>` **alineado con la entrada**: la
posición `i` corresponde a la barra `i`, y `None` marca las barras donde el
indicador todavía no es válido. Devolver `None` en lugar de `0.0` o de un vector
desalineado evita que la PWA dibuje una línea desde el origen antes de que exista
dato.

Las convenciones que comparten todas las funciones:

- `period == 0` devuelve un vector de `None` del largo de la entrada, sin tocar un
  solo índice.
- Una entrada vacía devuelve un vector vacío, sin `panic`.
- Un valor no finito (`NaN` o infinito) equivale a dato ausente: la barra se marca
  `None` y el indicador **se vuelve a sembrar** con la ventana siguiente de datos
  válidos. No se "salta" el hueco ni se arrastra un estado corrupto.
- `true_range` y `atr` exigen que `highs`, `lows` y `closes` tengan la misma
  longitud; si no, devuelven todo `None` en lugar de truncar en silencio, porque
  alinear series de distinta longitud inventaría un desplazamiento temporal en el
  ATR.

Ninguna función hace aritmética de índices sin comprobar: los periodos válidos son
siempre `>= 1` y toda resta de índice va precedida de un guard explícito. Esto no es
cosmético: en WASM un `panic` aborta la pestaña entera, no solo el gráfico.

## Uso

```rust
use synapse_core::order_guard::{check_order, AccountState, OrderIntent, RiskLimits, Side};

let order = OrderIntent {
    symbol: "BTCUSDT".to_string(),
    side: Side::Long,
    entry_price: 100.0,
    stop_loss: Some(98.0),
    take_profit: Some(104.0),
    quantity: 0.5,
    leverage: 5.0,
};
let limits = RiskLimits {
    max_risk_per_trade_pct: 1.0,
    max_daily_loss_pct: 3.0,
    max_leverage: 10.0,
    require_stop_loss: true,
    max_open_positions: 3,
};
let account = AccountState {
    equity: 1_000.0,
    realized_pnl_today: 0.0,
    open_positions: 0,
};

assert!(check_order(&order, &limits, &account).is_allowed());
```

## Compilar para la web (WebAssembly)

Objetivo necesario:

```bash
rustup target add wasm32-unknown-unknown
```

Build de la biblioteca `.wasm` con la feature `wasm` activa:

```bash
cargo build -p synapse-core --target wasm32-unknown-unknown --features wasm --release
```

El artefacto queda en
`target/wasm32-unknown-unknown/release/synapse_core.wasm`. Ese `.wasm` es el que
`wasm-bindgen` transforma en un módulo de JavaScript; por eso, para consumirlo desde
la PWA lo normal es usar `wasm-pack` o `wasm-bindgen-cli`, que ya se encargan de
llamar a `wasm-bindgen` por ti:

```bash
# variante recomendada: genera los bindings JS y un paquete npm listo
wasm-pack build --target web --features wasm crates/synapse-core

# o, a pelo, sobre el .wasm ya compilado
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/synapse_core.wasm
```

La feature `wasm` es la que activa las dependencias `wasm-bindgen` y
`serde-wasm-bindgen` y el módulo privado `wasm`, que expone `check_order`,
`size_position`, `sma`, `ema`, `rsi` y `atr` a JavaScript. El contrato con el
frontend es JSON: los `snake_case` de Rust se convierten a `camelCase`, y los
`Option<f64>` de los indicadores llegan como `null`. Un fallo de deserialización se
devuelve como `Err(JsValue)` con el mensaje del error, no como excepción de Rust: el
frontend decide cómo mostrarlo.

## Compilar de forma nativa (backend privado)

Sin features, el crate se compila como `rlib` normal y el backend lo consume como
dependencia git:

```toml
[dependencies]
synapse-core = { git = "https://github.com/iberi22/swal-trade", path = "crates/synapse-core" }
```

Se usa exactamente el mismo código fuente que corre en el navegador, así que una
corrección de riesgo llega a los dos entornos a la vez.

## Desarrollo

```bash
cargo test -p synapse-core                                          # tests
cargo clippy -p synapse-core --all-targets -- -D warnings          # lint
```

## Licencia

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html). La misma licencia
que el resto de SWAL: el núcleo decide sobre el dinero del usuario, y cualquiera que
lo ejecute debe poder leer exactamente qué reglas se aplicaron.
