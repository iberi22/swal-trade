//! Exports `wasm-bindgen` para que la PWA llame al núcleo desde JavaScript.
//!
//! Solo se compila con `--features wasm`. Todos los enlaces reciben y devuelven
//! `JsValue` mediante `serde-wasm-bindgen`, así que el contrato con el
//! frontend es JSON: los campos se **nombran en `camelCase`** en JavaScript y en
//! Rust siguen siendo `snake_case`, y los `Option<f64>` de los indicadores
//! llegan como `null`.
//!
//! Los `rename_all = "camelCase"` viven en los propios structs ([`SizePositionInput`]
//! y los tres de `order_guard`), no aquí, para que la regla se vea en la
//! definición del dato y no dependa de que alguien la aplique desde este
//! módulo. Así el mismo JSON vale para la PWA y para el backend privado que
//! consume el crate en nativo.
//!
//! Un fallo de deserialización se devuelve como `Err(JsValue)` con el mensaje
//! del error, no como excepción de Rust: el frontend decide cómo mostrarlo.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::indicators;
use crate::order_guard::{AccountState, OrderIntent, RiskLimits};
use crate::sizing::{PositionSizer, TradingSessionPlan};

/// Entrada de [`size_position`]: los parámetros del dimensionador más el reloj
/// inyectado. Los campos de override son opcionales y, si faltan, se usan los
/// valores por defecto de la librería.
///
/// `camelCase` porque es un struct que existe **solo** para la frontera con
/// JavaScript: es exactamente el objeto que la PWA construye y pasa a
/// `sizePosition`. Sin el `rename_all`, un objeto con `totalBalance` fallaba al
/// deserializar y la PWA no tenía forma de calcular el plan.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SizePositionInput {
    strategy_name: String,
    is_real: bool,
    leverage: u32,
    stop_loss_pct: f64,
    take_profit_pct: f64,
    total_balance: f64,
    current_open_positions: usize,
    unrealized_pnl: f64,
    used_margin: f64,
    market_volatility: f64,
    #[serde(default)]
    max_margin_per_order_usdt: Option<f64>,
    #[serde(default)]
    paper_max_positions: Option<usize>,
    #[serde(default)]
    real_max_positions: Option<usize>,
    #[serde(default)]
    max_risk_pct: Option<f64>,
    #[serde(default)]
    now_ms: i64,
}

/// Serializa hacia JavaScript con el serializador **JSON compatible** de
/// `serde-wasm-bindgen`.
///
/// Sin esto, `to_value` usa el serializador por defecto, que se comporta de
/// forma distinta a JSON en dos puntos que la PWA nota:
///
/// - los mapas salen como `Map` de JavaScript, no como objetos. El
///   `symbol_configs` del plan aparecería como `Map` y no se podría leer con
///   `config.BTCUSDT.quantity` ni recorrer con `Object.entries`;
/// - los enteros de 64 bits salen como `BigInt` cuando el valor no cabe en un
///   `f64` exacto, y comparar un `BigInt` con un número lanza `TypeError`.
///
/// `json_compatible()` arregla los dos: objetos planos, números como números y
/// `None`/`()` como `null` en vez de `undefined`. El resultado se puede
/// convertir con `JSON.stringify` sin pérdida.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    value
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn series(values: JsValue) -> Result<Vec<f64>, JsValue> {
    from_js(values)
}

/// Verifica una orden contra los límites y el estado de la cuenta.
///
/// Recibe tres objetos (`order`, `limits`, `account`) con los campos en
/// `camelCase` y devuelve `{ decision: "allow" }` o
/// `{ decision: "reject", reasons: [...] }` con los motivos en español.
#[wasm_bindgen]
pub fn check_order(order: JsValue, limits: JsValue, account: JsValue) -> Result<JsValue, JsValue> {
    let order: OrderIntent = from_js(order)?;
    let limits: RiskLimits = from_js(limits)?;
    let account: AccountState = from_js(account)?;
    to_js(&crate::order_guard::check_order(&order, &limits, &account))
}

/// Calcula el plan de sesión de trading (tamaño de posición, nocional, stop
/// loss seguro, riesgos, razonamiento y advertencias).
#[wasm_bindgen]
pub fn size_position(input: JsValue) -> Result<JsValue, JsValue> {
    let input: SizePositionInput = from_js(input)?;

    let mut sizer = PositionSizer::new(
        &input.strategy_name,
        input.is_real,
        input.leverage,
        input.stop_loss_pct,
        input.take_profit_pct,
    )
    .with_max_margin_per_order(input.max_margin_per_order_usdt)
    .with_now_ms(input.now_ms);

    if let Some(slots) = input.paper_max_positions {
        sizer = sizer.with_paper_max_positions(slots);
    }
    if let Some(slots) = input.real_max_positions {
        sizer = sizer.with_real_max_positions(slots);
    }
    if let Some(risk_pct) = input.max_risk_pct {
        sizer = sizer.with_max_risk_pct(risk_pct);
    }

    let plan: TradingSessionPlan = sizer.calculate_session_plan(
        input.total_balance,
        input.current_open_positions,
        input.unrealized_pnl,
        input.used_margin,
        input.market_volatility,
    );
    to_js(&plan)
}

/// Media móvil simple. `period = 0` devuelve una lista de `null` del largo de
/// la entrada.
#[wasm_bindgen]
pub fn sma(values: JsValue, period: u32) -> Result<JsValue, JsValue> {
    to_js(&indicators::sma(&series(values)?, period as usize))
}

/// Media móvil exponencial sembrada con la SMA inicial.
#[wasm_bindgen]
pub fn ema(values: JsValue, period: u32) -> Result<JsValue, JsValue> {
    to_js(&indicators::ema(&series(values)?, period as usize))
}

/// Relative Strength Index de Wilder sobre cierres.
#[wasm_bindgen]
pub fn rsi(values: JsValue, period: u32) -> Result<JsValue, JsValue> {
    to_js(&indicators::rsi(&series(values)?, period as usize))
}

/// Average True Range de Wilder. Requiere `highs`, `lows`, `closes` y `period`.
#[wasm_bindgen]
pub fn atr(
    highs: JsValue,
    lows: JsValue,
    closes: JsValue,
    period: u32,
) -> Result<JsValue, JsValue> {
    let highs = series(highs)?;
    let lows = series(lows)?;
    let closes = series(closes)?;
    to_js(&indicators::atr(&highs, &lows, &closes, period as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_position_input_deserializes_from_camel_case() {
        let json = r#"{
            "strategyName": "test_strat",
            "isReal": true,
            "leverage": 10,
            "stopLossPct": 1.5,
            "takeProfitPct": 3.0,
            "totalBalance": 1000.0,
            "currentOpenPositions": 2,
            "unrealizedPnl": 25.0,
            "usedMargin": 50.0,
            "marketVolatility": 0.02,
            "maxMarginPerOrderUsdt": 100.0,
            "paperMaxPositions": 5,
            "realMaxPositions": 3,
            "maxRiskPct": 2.0,
            "nowMs": 1700000000000
        }"#;
        let parsed: SizePositionInput =
            serde_json::from_str(json).expect("valid camelCase JSON for SizePositionInput");
        assert_eq!(parsed.strategy_name, "test_strat");
        assert!(parsed.is_real);
        assert_eq!(parsed.leverage, 10);
        assert_eq!(parsed.stop_loss_pct, 1.5);
        assert_eq!(parsed.total_balance, 1000.0);
        assert_eq!(parsed.current_open_positions, 2);
        assert_eq!(parsed.max_margin_per_order_usdt, Some(100.0));
        assert_eq!(parsed.now_ms, 1700000000000);
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn to_js_serializes_with_json_compatible() {
        #[derive(Serialize)]
        struct Sample {
            name: String,
            count: u64,
            flag: Option<bool>,
        }
        let sample = Sample {
            name: "test".to_string(),
            count: 42,
            flag: None,
        };
        let js = to_js(&sample);
        assert!(js.is_ok());
    }
}
