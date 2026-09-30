//! # synapse-core
//!
//! Nucleo puro de riesgo, dimensionamiento de posiciones e indicadores tecnicos del
//! asistente de trading **no custodial** de SWAL (Binance Futures, PWA).
//!
//! Todo lo que hay aqui es una funcion pura sobre `f64`: sin I/O, sin red, sin reloj,
//! sin `tokio` y sin `unsafe`. Eso permite tres cosas:
//!
//! - compilarlo a `wasm32-unknown-unknown` y ejecutarlo en el navegador, donde las
//!   claves API nunca salen del dispositivo;
//! - reutilizar exactamente la misma logica en el backend privado, que lo consume
//!   como dependencia git para que PWA y servidor no diverjan nunca en las reglas de
//!   riesgo;
//! - auditar el nucleo critico de riesgo leyendo menos de mil lineas.
//!
//! ## Modulos
//!
//! - [`indicators`]: `sma`, `ema`, `rsi` y `atr` (suavizado de Wilder).
//! - [`order_guard`]: [`order_guard::check_order`], la comprobacion previa a la firma
//!   que decide si una orden se permite y, si no, explica cada motivo en español.
//! - [`risk_math`]: matematica de riesgo (R-multiples, riesgo por stop, cola de
//!   resultados, apalancamiento dinamico).
//! - [`risk`]: [`risk::RiskEngine`], validacion de riesgo con estado de sesion.
//! - [`sizing`]: [`sizing::PositionSizer`], plan de sesion con margen por posicion,
//!   nocional, stop-loss seguro y limite de riesgo por operacion.
//!
//! ## Ejemplo
//!
//! ```
//! use synapse_core::order_guard::{check_order, AccountState, OrderIntent, RiskLimits, Side};
//!
//! let order = OrderIntent {
//!     symbol: "BTCUSDT".to_string(),
//!     side: Side::Long,
//!     entry_price: 100.0,
//!     stop_loss: Some(98.0),
//!     take_profit: Some(104.0),
//!     quantity: 0.5,
//!     leverage: 5.0,
//! };
//! let limits = RiskLimits {
//!     max_risk_per_trade_pct: 1.0,
//!     max_daily_loss_pct: 3.0,
//!     max_leverage: 10.0,
//!     require_stop_loss: true,
//!     max_open_positions: 3,
//! };
//! // Riesgo = |100 - 98| * 0.5 = 1 USDT, por debajo del 1 % de 1000.
//! let account = AccountState { equity: 1000.0, realized_pnl_today: 0.0, open_positions: 0 };
//!
//! assert!(check_order(&order, &limits, &account).is_allowed());
//! ```
//!
//! ## WebAssembly
//!
//! Con la feature `wasm` el crate exporta ademas el modulo privado `wasm`, con
//! funciones `#[wasm_bindgen]`, para que JavaScript llame a la misma logica:
//!
//! ```bash
//! wasm-pack build --target web --features wasm crates/synapse-core
//! ```

pub mod indicators;
pub mod order_guard;
pub mod risk;
pub mod risk_math;
pub mod sizing;

#[cfg(feature = "wasm")]
mod wasm;

pub use indicators::{atr, ema, rsi, sma, true_range};
pub use order_guard::{check_order, AccountState, GuardDecision, OrderIntent, RiskLimits, Side};
pub use risk::RiskEngine;
pub use sizing::{can_execute_trade, PositionSizer, TradingSessionPlan};

/// Version del crate, expuesta para la UI y para confirmar que el WASM cargado
/// corresponde a esta version del repositorio.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
