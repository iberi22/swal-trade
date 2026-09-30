//! Dimensionamiento de posición y plan de sesión.
//!
//! Puerto *puro* de `backend/src/application/services/position_sizer.rs`.
//!
//! Dos diferencias deliberadas respecto al original, ambas obligadas por el
//! destino (`wasm32-unknown-unknown`, sin I/O):
//!
//! 1. **Sin variables de entorno.** El original resolvía límites con
//!    `std::env::var`, que no existe en WASM ni es testeable. Aquí los valores
//!    entran por constructor o por los métodos `with_*`; el backend privado
//!    sigue leyendo el entorno y lo pasa explícitamente. Los nombres de las
//!    variables se conservan como constantes para que el mapeo sea visible.
//! 2. **Sin reloj.** `Utc::now()` se reemplaza por `now_ms` (milisegundos
//!    Unix), que el llamador inyecta. Así el mismo plan se produce en el
//!    navegador y en el backend, y los tests son deterministas.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Máximo de posiciones concurrentes en cuentas reales en modo de preparación
/// al lanzamiento (por defecto: exactamente 3).
pub const DEFAULT_REAL_MAX_POSITIONS: usize = 3;

/// Cota superior heredada para cuentas reales.
pub const MAX_REAL_POSITIONS: usize = 10;

/// Máximo de posiciones concurrentes en cuentas paper.
pub const MAX_PAPER_POSITIONS: usize = 20;

/// Porcentaje de balance reservado como margen de seguridad.
pub const BALANCE_RESERVE_PCT: f64 = 20.0;

/// Porcentaje de reserva para cuentas micro (`equity < 50`).
pub const MICRO_ACCOUNT_RESERVE_PCT: f64 = 5.0;

/// Equity por debajo del cual se aplica la reserva reducida.
pub const MICRO_ACCOUNT_EQUITY_THRESHOLD: f64 = 50.0;

/// Riesgo mínimo recomendado por operación (porcentaje del equity).
pub const MIN_RISK_PER_TRADE_PCT: f64 = 1.0;

/// Riesgo máximo recomendado por operación (porcentaje del equity).
pub const MAX_RISK_PER_TRADE_PCT: f64 = 2.0;

/// Tamaño mínimo de posición en USDT.
pub const MIN_POSITION_SIZE_USDT: f64 = 1.0;

/// Umbral de volatilidad por encima del cual se reduce el tamaño (0.50 = 50%).
pub const VOLATILITY_THRESHOLD: f64 = 0.50;

/// Volatilidad máxima antes de bloquear toda posición (1.0 = 100%).
pub const VOLATILITY_MAX: f64 = 1.0;

/// Fracción del tamaño que se puede recortar como máximo en el extremo de
/// volatilidad (deja un 20% del tamaño nominal).
pub const MAX_VOLATILITY_REDUCTION: f64 = 0.8;

/// Fracción de la distancia a liquidación usada como stop loss seguro.
pub const SAFE_SL_LIQUIDATION_FACTOR: f64 = 0.8;

/// Porcentaje de riesgo de cartera a partir del cual se avisa al operador.
pub const PORTFOLIO_RISK_WARN_PCT: f64 = 20.0;

/// Nombres de las variables de entorno que el backend privado resuelve y pasa
/// como parámetros a este núcleo. Se conservan aquí para que el mapeo sea
/// explícito y auditable; esta crate no las lee.
pub const MAX_MARGIN_PER_ORDER_ENV: &str = "MAX_MARGIN_PER_ORDER_USDT";
/// Ver [`MAX_MARGIN_PER_ORDER_ENV`].
pub const PAPER_MAX_POSITIONS_ENV: &str = "PAPER_MAX_POSITIONS";
/// Ver [`MAX_MARGIN_PER_ORDER_ENV`].
pub const REAL_MAX_POSITIONS_ENV: &str = "REAL_MAX_POSITIONS";
/// Ver [`MAX_MARGIN_PER_ORDER_ENV`].
pub const RISK_PER_TRADE_PCT_ENV: &str = "RISK_PER_TRADE_PCT";

/// Plan de trading calculado al inicio de la sesión.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingSessionPlan {
    /// Identificador único de la sesión.
    pub session_id: String,
    /// Momento de creación del plan, en milisegundos Unix (UTC), inyectado por
    /// el llamador.
    pub created_at_ms: i64,
    /// Tipo de cuenta (`Paper`/`Real`).
    pub account_type: String,
    /// Nombre de la estrategia a la que pertenece este plan.
    pub strategy_name: String,

    // Instantánea de balance
    /// Balance total al crear el plan.
    pub total_balance: f64,
    /// Balance reservado como margen de seguridad.
    pub reserved_balance: f64,
    /// Balance disponible para operar.
    pub available_balance: f64,

    // Dimensionamiento
    /// Máximo de posiciones permitidas.
    pub max_positions: usize,
    /// Posiciones abiertas actualmente.
    pub current_positions: usize,
    /// Slots de posición restantes.
    pub remaining_slots: usize,
    /// Tamaño estándar de posición en USDT (por posición).
    pub position_size_usdt: f64,
    /// Tamaño de posición con apalancamiento (valor nocional).
    pub position_notional: f64,

    // Parámetros de riesgo
    /// Apalancamiento por defecto de la sesión.
    pub leverage: u32,
    /// Stop loss máximo (porcentaje).
    pub max_stop_loss_pct: f64,
    /// Riesgo por operación en USDT.
    pub risk_per_trade_usdt: f64,
    /// Riesgo por operación como porcentaje del balance.
    pub risk_per_trade_pct: f64,

    // SL/TP precalculados
    /// Configuraciones de posición por símbolo, si las hay.
    pub symbol_configs: HashMap<String, SymbolPositionConfig>,

    // Auditoría
    /// Justificación de los cálculos.
    pub rationale: Vec<String>,
    /// Advertencias o alertas.
    pub warnings: Vec<String>,
    /// ¿Está el plan activo?
    pub is_active: bool,
}

/// Configuración de posición para un símbolo concreto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolPositionConfig {
    /// Símbolo configurado.
    pub symbol: String,
    /// Precio de referencia usado en el cálculo.
    pub current_price: f64,
    /// Cantidad resultante.
    pub quantity: f64,
    /// Precio de stop loss para posición larga.
    pub stop_loss_price_long: f64,
    /// Precio de stop loss para posición corta.
    pub stop_loss_price_short: f64,
    /// Precio de take profit para posición larga.
    pub take_profit_price_long: f64,
    /// Precio de take profit para posición corta.
    pub take_profit_price_short: f64,
    /// Pérdida máxima en USDT.
    pub max_loss_usdt: f64,
}

/// Calculadora de tamaño de posición.
#[derive(Debug, Clone)]
pub struct PositionSizer {
    /// ¿Es una cuenta real?
    pub is_real: bool,
    /// Nombre de la estrategia.
    pub strategy_name: String,
    /// Apalancamiento por defecto.
    pub leverage: u32,
    /// Stop loss de la estrategia, en porcentaje.
    pub stop_loss_pct: f64,
    /// Take profit de la estrategia, en porcentaje.
    pub take_profit_pct: f64,
    /// Tope duro de margen por orden en USDT (`None` = sin tope).
    pub max_margin_per_order_usdt: Option<f64>,
    /// Slots concurrentes para cuentas paper.
    pub paper_max_positions: usize,
    /// Slots concurrentes para cuentas reales.
    pub real_max_positions: usize,
    /// Riesgo máximo por operación como porcentaje del equity.
    pub max_risk_pct: f64,
    /// Reloj inyectado en milisegundos Unix (UTC). `0` por defecto: el núcleo
    /// no consulta el reloj del sistema.
    pub now_ms: i64,
}

impl PositionSizer {
    /// Crea una calculadora con los valores por defecto de la librería.
    ///
    /// Usa [`DEFAULT_REAL_MAX_POSITIONS`], [`MAX_PAPER_POSITIONS`] y
    /// [`MAX_RISK_PER_TRADE_PCT`]. Los overrides se aplican con los métodos
    /// `with_*`.
    pub fn new(
        strategy_name: &str,
        is_real: bool,
        leverage: u32,
        sl_pct: f64,
        tp_pct: f64,
    ) -> Self {
        Self {
            is_real,
            strategy_name: strategy_name.to_string(),
            leverage,
            stop_loss_pct: sl_pct,
            take_profit_pct: tp_pct,
            max_margin_per_order_usdt: None,
            paper_max_positions: MAX_PAPER_POSITIONS,
            real_max_positions: DEFAULT_REAL_MAX_POSITIONS,
            max_risk_pct: MAX_RISK_PER_TRADE_PCT,
            now_ms: 0,
        }
    }

    /// Fija el tope de margen por orden.
    pub fn with_max_margin_per_order(mut self, cap: Option<f64>) -> Self {
        self.max_margin_per_order_usdt = cap;
        self
    }

    /// Fija el número de slots para cuentas paper.
    pub fn with_paper_max_positions(mut self, slots: usize) -> Self {
        self.paper_max_positions = slots;
        self
    }

    /// Fija el número de slots para cuentas reales.
    pub fn with_real_max_positions(mut self, slots: usize) -> Self {
        self.real_max_positions = slots;
        self
    }

    /// Fija el riesgo máximo por operación (porcentaje del equity).
    pub fn with_max_risk_pct(mut self, risk_pct: f64) -> Self {
        self.max_risk_pct = risk_pct;
        self
    }

    /// Fija el reloj usado para `session_id` y `created_at_ms`.
    pub fn with_now_ms(mut self, now_ms: i64) -> Self {
        self.now_ms = now_ms;
        self
    }

    /// Calcula el plan de sesión a partir del balance actual.
    ///
    /// # Guardia de volatilidad
    ///
    /// Con `market_volatility` por encima de [`VOLATILITY_THRESHOLD`] el tamaño
    /// se reduce progresivamente; en [`VOLATILITY_MAX`] o más, se bloquea todo.
    pub fn calculate_session_plan(
        &self,
        total_balance: f64,
        current_open_positions: usize,
        unrealized_pnl: f64,
        used_margin: f64,
        market_volatility: f64,
    ) -> TradingSessionPlan {
        let mut rationale = Vec::new();
        let mut warnings = Vec::new();

        // 0. Guardia de volatilidad.
        let volatility_multiplier = if market_volatility >= VOLATILITY_MAX {
            warnings.push("⛔ EXTREME VOLATILITY: All positions BLOCKED".to_string());
            rationale.push(format!(
                "Volatility {:.1}% >= {:.0}%: Position size set to 0",
                market_volatility * 100.0,
                VOLATILITY_MAX * 100.0
            ));
            0.0
        } else if market_volatility > VOLATILITY_THRESHOLD {
            // Escalado progresivo: 50% de volatilidad = 50% del tamaño,
            // 100% de volatilidad = 0%.
            let reduction = (market_volatility - VOLATILITY_THRESHOLD)
                / (VOLATILITY_MAX - VOLATILITY_THRESHOLD);
            let mult = 1.0 - (reduction * MAX_VOLATILITY_REDUCTION);
            warnings.push(format!(
                "⚠️ HIGH VOLATILITY {:.1}% detected: Position size reduced to {:.0}%",
                market_volatility * 100.0,
                mult * 100.0
            ));
            rationale.push(format!(
                "Volatility {:.1}% > {:.0}% threshold: Position size multiplied by {:.2}",
                market_volatility * 100.0,
                VOLATILITY_THRESHOLD * 100.0,
                mult
            ));
            mult
        } else {
            rationale.push(format!(
                "Volatility {:.1}% within safe range (threshold: {:.0}%)",
                market_volatility * 100.0,
                VOLATILITY_THRESHOLD * 100.0
            ));
            1.0
        };

        // 1. Máximo de posiciones según el tipo de cuenta.
        let max_positions = if self.is_real {
            self.real_max_positions
        } else {
            self.paper_max_positions
        };
        rationale.push(format!(
            "Max positions: {} ({})",
            max_positions,
            if self.is_real { "Real" } else { "Paper" }
        ));

        // 2. Balance disponible.
        let equity = total_balance + unrealized_pnl;

        // Reserva adaptativa: las cuentas micro (< 50 USD) pueden usar más de
        // su balance.
        let reserve_pct = if equity < MICRO_ACCOUNT_EQUITY_THRESHOLD {
            MICRO_ACCOUNT_RESERVE_PCT
        } else {
            BALANCE_RESERVE_PCT
        };

        let reserved_balance = equity * (reserve_pct / 100.0);

        // El margen ya usado se resta del equity antes de dividir por slots.
        let available_balance = (equity - reserved_balance - used_margin).max(0.0);

        rationale.push(format!(
            "Equity: ${:.2}, Reserved: ${:.2} ({:.0}%), Used Margin: ${:.2}, Available: ${:.2}",
            equity, reserved_balance, reserve_pct, used_margin, available_balance
        ));

        // 3. Slots restantes.
        let remaining_slots = max_positions.saturating_sub(current_open_positions);
        if remaining_slots == 0 {
            warnings.push("No position slots available".to_string());
        }

        // 4. Tamaño de posición por slot.
        let mut base_position_size = if remaining_slots > 0 {
            available_balance / remaining_slots as f64
        } else {
            0.0
        };

        // 4b. Guardia de volatilidad sobre el tamaño.
        if volatility_multiplier < 1.0 {
            let original_size = base_position_size;
            base_position_size *= volatility_multiplier;
            warnings.push(format!(
                "⚠️ VOLATILITY GUARD: Position size reduced from ${:.2} -> ${:.2} (volatility: {:.1}%)",
                original_size, base_position_size, market_volatility * 100.0
            ));
        }

        // 4c. Tope de margen por orden. Solo puede reducir.
        if let Some(cap) = self.max_margin_per_order_usdt {
            if base_position_size > cap {
                warnings.push(format!(
                    "💵 Margin cap: ${:.2} -> ${:.2} per order ({}={})",
                    base_position_size, cap, MAX_MARGIN_PER_ORDER_ENV, cap
                ));
                rationale.push(format!(
                    "Margin per order capped at ${:.2} (env {}); balance/slot split would have been ${:.2}",
                    cap, MAX_MARGIN_PER_ORDER_ENV, base_position_size
                ));
                base_position_size = cap;
            }
        }

        // 5. Riesgo por operación sobre el nocional real.
        //
        // Un stop del `stop_loss_pct` % del precio pierde ese porcentaje del
        // NOCIONAL (margen x apalancamiento), no del margen. La fórmula
        // anterior (`margen x sl%`) subestimaba el riesgo real por un factor
        // igual al apalancamiento.
        let risk_per_trade_usdt =
            base_position_size * self.leverage as f64 * (self.stop_loss_pct / 100.0);
        let risk_per_trade_pct = if equity > 0.0 {
            (risk_per_trade_usdt / equity) * 100.0
        } else {
            0.0
        };

        // 6. Ajuste al tope de riesgo.
        let (position_size_usdt, adjusted_risk_pct) = if risk_per_trade_pct > self.max_risk_pct {
            let max_risk_usdt = equity * (self.max_risk_pct / 100.0);
            let adjusted_size =
                max_risk_usdt / (self.leverage as f64 * (self.stop_loss_pct / 100.0));
            warnings.push(format!(
                "Position scaled down: ${:.2} -> ${:.2} to meet {:.1}% risk limit",
                base_position_size, adjusted_size, self.max_risk_pct
            ));
            rationale.push(format!(
                "Risk capped at {:.1}% per trade (${:.2})",
                self.max_risk_pct, max_risk_usdt
            ));
            (adjusted_size, self.max_risk_pct)
        } else {
            (base_position_size, risk_per_trade_pct)
        };

        // 7. Tamaño mínimo.
        let final_position_size =
            if position_size_usdt < MIN_POSITION_SIZE_USDT && position_size_usdt > 0.0 {
                warnings.push(format!(
                    "Position size ${:.2} below minimum ${:.2}",
                    position_size_usdt, MIN_POSITION_SIZE_USDT
                ));
                MIN_POSITION_SIZE_USDT
            } else {
                position_size_usdt
            };

        // 8. Nocional con apalancamiento.
        let position_notional = final_position_size * self.leverage as f64;
        rationale.push(format!(
            "Position: ${:.2} margin × {}x leverage = ${:.2} notional",
            final_position_size, self.leverage, position_notional
        ));

        // 9. Stop loss máximo que evita la liquidación.
        let liquidation_pct = 100.0 / self.leverage as f64;
        let safe_sl_pct = liquidation_pct * SAFE_SL_LIQUIDATION_FACTOR;

        let max_stop_loss_pct = self.stop_loss_pct.min(safe_sl_pct);
        if self.stop_loss_pct > safe_sl_pct {
            warnings.push(format!(
                "Strategy SL {:.2}% exceeds safe limit {:.2}% - capped to avoid liquidation",
                self.stop_loss_pct, safe_sl_pct
            ));
        }
        rationale.push(format!(
            "Safe SL: {:.2}% (liquidation at {:.2}%)",
            max_stop_loss_pct, liquidation_pct
        ));

        // 10. Riesgo final (riesgo nocional real: margen x apalancamiento x SL%).
        let final_risk_usdt =
            final_position_size * self.leverage as f64 * (max_stop_loss_pct / 100.0);
        rationale.push(format!(
            "Risk per trade: ${:.2} ({:.2}% of equity)",
            final_risk_usdt, adjusted_risk_pct
        ));

        // 11. Riesgo total de cartera.
        let total_portfolio_risk = final_risk_usdt * max_positions as f64;
        let portfolio_risk_pct = if equity > 0.0 {
            (total_portfolio_risk / equity) * 100.0
        } else {
            0.0
        };
        rationale.push(format!(
            "Max portfolio risk: ${:.2} ({:.1}% if all {} positions hit SL)",
            total_portfolio_risk, portfolio_risk_pct, max_positions
        ));

        if portfolio_risk_pct > PORTFOLIO_RISK_WARN_PCT {
            warnings.push(format!(
                "⚠️ High portfolio risk: {:.1}% - consider reducing positions or leverage",
                portfolio_risk_pct
            ));
        }

        TradingSessionPlan {
            session_id: format!(
                "{}-{}-{}",
                self.strategy_name,
                if self.is_real { "real" } else { "paper" },
                self.now_ms
            ),
            created_at_ms: self.now_ms,
            account_type: if self.is_real {
                "Real".to_string()
            } else {
                "Paper".to_string()
            },
            strategy_name: self.strategy_name.clone(),
            total_balance,
            reserved_balance,
            available_balance,
            max_positions,
            current_positions: current_open_positions,
            remaining_slots,
            position_size_usdt: final_position_size,
            position_notional,
            leverage: self.leverage,
            max_stop_loss_pct,
            risk_per_trade_usdt: final_risk_usdt,
            risk_per_trade_pct: adjusted_risk_pct,
            symbol_configs: HashMap::new(),
            rationale,
            warnings,
            is_active: remaining_slots > 0 && final_position_size >= MIN_POSITION_SIZE_USDT,
        }
    }

    /// Calcula la configuración de posición de un símbolo concreto.
    pub fn calculate_symbol_config(
        &self,
        plan: &TradingSessionPlan,
        symbol: &str,
        current_price: f64,
    ) -> SymbolPositionConfig {
        let quantity = plan.position_notional / current_price;

        let sl_distance = current_price * (plan.max_stop_loss_pct / 100.0);
        let tp_distance = current_price * (self.take_profit_pct / 100.0);

        SymbolPositionConfig {
            symbol: symbol.to_string(),
            current_price,
            quantity,
            stop_loss_price_long: current_price - sl_distance,
            stop_loss_price_short: current_price + sl_distance,
            take_profit_price_long: current_price + tp_distance,
            take_profit_price_short: current_price - tp_distance,
            max_loss_usdt: plan.risk_per_trade_usdt,
        }
    }
}

/// Indica si se puede ejecutar una operación según el plan de sesión.
pub fn can_execute_trade(plan: &TradingSessionPlan, current_positions: usize) -> (bool, String) {
    if current_positions >= plan.max_positions {
        return (
            false,
            format!(
                "Max positions reached: {}/{}",
                current_positions, plan.max_positions
            ),
        );
    }

    if !plan.is_active {
        return (false, "Session plan is not active".to_string());
    }

    if plan.position_size_usdt < MIN_POSITION_SIZE_USDT {
        return (
            false,
            format!(
                "Position size ${:.2} below minimum ${:.2}",
                plan.position_size_usdt, MIN_POSITION_SIZE_USDT
            ),
        );
    }

    (true, "Trade allowed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_plan_real_account() {
        let sizer = PositionSizer::new("Aggressive", true, 20, 2.0, 4.0)
            .with_real_max_positions(MAX_REAL_POSITIONS);
        let plan = sizer.calculate_session_plan(5000.0, 2, 50.0, 1000.0, 0.0);

        assert_eq!(plan.max_positions, MAX_REAL_POSITIONS);
        // Equity 5050. Res 1010. Used 1000. Avail 3040. Remaining 8. Size 380.
        assert!(plan.position_size_usdt > 0.0);
        assert!(plan.risk_per_trade_pct <= MAX_RISK_PER_TRADE_PCT);
        assert_eq!(plan.current_positions, 2);
        assert_eq!(plan.remaining_slots, 8);

        println!("Plan: {plan:?}");
        println!("Rationale: {:?}", plan.rationale);
    }

    #[test]
    fn test_live_prep_default_3_positions_and_1_to_2_pct_risk() {
        // Las cuentas reales por defecto en preparación al lanzamiento deben
        // quedar en 3 posiciones.
        let sizer_default = PositionSizer::new("LivePrep", true, 10, 2.0, 4.0);
        assert_eq!(sizer_default.real_max_positions, 3);
        assert!((sizer_default.max_risk_pct - 2.0).abs() < 1e-6);

        // Con tope de riesgo del 1%.
        let sizer_1pct = PositionSizer::new("LivePrep1Pct", true, 10, 2.0, 4.0)
            .with_real_max_positions(3)
            .with_max_risk_pct(1.0);

        let plan = sizer_1pct.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);
        assert_eq!(plan.max_positions, 3);
        assert_eq!(plan.remaining_slots, 3);
        assert!(plan.risk_per_trade_pct <= 1.0);
        // 1% de $1000 de equity = $10 de riesgo máximo.
        assert!(plan.risk_per_trade_usdt <= 10.0 + 1e-6);

        // Con tope de riesgo del 2%.
        let sizer_2pct = PositionSizer::new("LivePrep2Pct", true, 10, 2.0, 4.0)
            .with_real_max_positions(3)
            .with_max_risk_pct(2.0);

        let plan_2 = sizer_2pct.calculate_session_plan(1000.0, 2, 0.0, 0.0, 0.0);
        assert_eq!(plan_2.max_positions, 3);
        assert_eq!(plan_2.remaining_slots, 1);
        assert!(plan_2.risk_per_trade_pct <= 2.0);
        // 2% de $1000 de equity = $20 de riesgo máximo.
        assert!(plan_2.risk_per_trade_usdt <= 20.0 + 1e-6);

        // Con 3 posiciones ya abiertas no quedan slots y se bloquea el trading.
        let plan_full = sizer_2pct.calculate_session_plan(1000.0, 3, 0.0, 0.0, 0.0);
        assert_eq!(plan_full.remaining_slots, 0);
        let (can, reason) = can_execute_trade(&plan_full, 3);
        assert!(!can);
        assert!(reason.contains("Max positions reached"));
    }

    #[test]
    fn test_session_plan_paper_account() {
        let sizer = PositionSizer::new("Conservative", false, 5, 1.5, 3.0);
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);

        assert_eq!(plan.max_positions, MAX_PAPER_POSITIONS);
        assert!(plan.remaining_slots == MAX_PAPER_POSITIONS);
    }

    #[test]
    fn test_symbol_config() {
        let sizer = PositionSizer::new("Moderate", true, 10, 2.0, 4.0);
        let plan = sizer.calculate_session_plan(5000.0, 0, 0.0, 0.0, 0.0);
        let config = sizer.calculate_symbol_config(&plan, "BTCUSDT", 95000.0);

        println!("Symbol config: {config:?}");
        assert!(config.quantity > 0.0);
        assert!(config.stop_loss_price_long < config.current_price);
        assert!(config.take_profit_price_long > config.current_price);
    }

    #[test]
    fn test_high_leverage_sl_cap() {
        // Con 50x de apalancamiento la liquidación está en el 2%, así que el
        // stop loss debe quedar topado.
        let sizer = PositionSizer::new("HighLev", true, 50, 5.0, 10.0);
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);

        // SL seguro ~1.6% (80% del 2%).
        assert!(plan.max_stop_loss_pct < 2.0);
        assert!(!plan.warnings.is_empty());
        println!("High lev warnings: {:?}", plan.warnings);
    }

    #[test]
    fn test_can_execute_trade() {
        let sizer = PositionSizer::new("Test", true, 10, 2.0, 4.0).with_real_max_positions(10);
        // Equity 5000. Reserva 1000. Used 3500. Available 500.
        let plan = sizer.calculate_session_plan(5000.0, 9, 0.0, 3500.0, 0.0);

        let (can, _reason) = can_execute_trade(&plan, 9);
        assert!(can);

        let (can, reason) = can_execute_trade(&plan, 10);
        assert!(!can);
        assert!(reason.contains("Max positions"));
    }

    #[test]
    fn test_low_margin_scenario() {
        let sizer = PositionSizer::new("RiskTest", true, 10, 2.0, 4.0);

        let total_balance = 1000.0;
        let unrealized_pnl = 0.0;
        let used_margin = 900.0; // 90% usado

        // Equity = 1000. Reserva = 200 (20%). Used = 900.
        // Available = 1000 - 200 - 900 = -100 -> 0.
        let plan = sizer.calculate_session_plan(total_balance, 1, unrealized_pnl, used_margin, 0.0);

        println!("Low Margin Plan: {plan:?}");
        assert_eq!(plan.available_balance, 0.0);
        assert_eq!(plan.position_size_usdt, 0.0);

        let (can, reason) = can_execute_trade(&plan, 1);
        assert!(!can);
        assert!(reason.contains("not active") || reason.contains("below minimum"));
    }

    #[test]
    fn test_volatility_guard_reduces_position() {
        let sizer = PositionSizer::new("Test", false, 10, 2.0, 4.0);

        // Volatilidad normal (10%): tamaño completo.
        let plan_normal = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.10);
        let normal_size = plan_normal.position_size_usdt;

        // Volatilidad alta (75%): tamaño reducido.
        let plan_high = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.75);
        let high_size = plan_high.position_size_usdt;

        assert!(
            high_size < normal_size,
            "High volatility should reduce position size"
        );
        assert!(
            high_size < normal_size * 0.7,
            "High volatility should reduce by at least 30%"
        );
        assert!(
            !plan_high.warnings.is_empty(),
            "High volatility should trigger warning"
        );

        println!(
            "Normal vol (10%): ${:.2}, High vol (75%): ${:.2}",
            normal_size, high_size
        );
        println!("High vol warnings: {:?}", plan_high.warnings);
    }

    #[test]
    fn test_volatility_guard_blocks_extreme() {
        let sizer = PositionSizer::new("Test", false, 10, 2.0, 4.0);

        // Volatilidad extrema (100%): se bloquea toda posición.
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 1.0);

        assert_eq!(
            plan.position_size_usdt, 0.0,
            "Extreme volatility should block position"
        );
        assert!(
            !plan.is_active,
            "Plan should be inactive with extreme volatility"
        );

        let has_extreme_warning = plan
            .warnings
            .iter()
            .any(|w| w.contains("EXTREME") || w.contains("BLOCKED"));
        assert!(
            has_extreme_warning,
            "Should have extreme volatility warning"
        );

        println!("Extreme vol plan warnings: {:?}", plan.warnings);
    }

    #[test]
    fn test_margin_per_order_cap_5_to_10_usdt() {
        // Objetivo del ciclo paper 20x: margen de 5-10 USDT por orden.
        // Sin tope, el plan reparte el balance disponible entre los 20 slots de
        // paper y con $50 deja ~$2,4 por orden.
        let uncapped = PositionSizer::new("Scalp", false, 20, 0.8, 6.0)
            .with_paper_max_positions(20)
            .with_max_margin_per_order(None);
        let plan_uncapped = uncapped.calculate_session_plan(50.0, 0, 0.0, 0.0, 0.0);
        assert!(
            plan_uncapped.position_size_usdt < 5.0,
            "without the cap the split across 20 slots must stay small, got {}",
            plan_uncapped.position_size_usdt
        );

        // Con 3 slots y tope de $10 el margen por orden queda en la banda
        // pedida, recortado además por el tope de riesgo real (2% del equity).
        let capped = PositionSizer::new("Scalp", false, 20, 0.8, 6.0)
            .with_paper_max_positions(3)
            .with_max_margin_per_order(Some(10.0));
        let plan = capped.calculate_session_plan(50.0, 0, 0.0, 0.0, 0.0);

        assert_eq!(plan.max_positions, 3);
        assert!(
            (5.0..=10.0).contains(&plan.position_size_usdt),
            "margin per order must land in 5-10 USDT, got {}",
            plan.position_size_usdt
        );
        // Riesgo real del stop: margen x 20x x 0,8%. $10 darían $1,60 (3,2% del
        // equity) y superarían el tope del 2% ($1,00), así que el plan escala
        // a $6,25: 20x sobre $6,25 = $125 de nocional, riesgo $1,00 (2,0%).
        assert!(
            (plan.position_size_usdt - 6.25).abs() < 1e-9,
            "risk gate must scale $10 -> $6.25 at 20x/0.8% SL, got {}",
            plan.position_size_usdt
        );
        assert!((plan.position_notional - 125.0).abs() < 1e-9);
        // `risk_per_trade_usdt` es el riesgo REAL (x apalancamiento), así que el
        // tope MAX_RISK_PER_TRADE_PCT sí puede dispararse.
        let true_risk = plan.position_notional * (plan.max_stop_loss_pct / 100.0);
        assert!(
            (plan.risk_per_trade_usdt - true_risk).abs() < 1e-6,
            "plan risk must equal true notional risk, got {} vs {}",
            plan.risk_per_trade_usdt,
            true_risk
        );
        assert!(
            (plan.risk_per_trade_usdt - 1.0).abs() < 1e-6,
            "stop must risk 2% of equity ($1.00), got {}",
            plan.risk_per_trade_usdt
        );
        assert!(
            plan.warnings.iter().any(|w| w.contains("Margin cap")),
            "the cap must be visible in the plan warnings: {:?}",
            plan.warnings
        );
        assert!(
            plan.warnings.iter().any(|w| w.contains("scaled down")),
            "the risk gate must be visible in the plan warnings: {:?}",
            plan.warnings
        );
    }

    #[test]
    fn test_margin_cap_never_increases_size() {
        // El tope es un techo: con poco capital disponible no debe inflar la
        // posición.
        let sizer = PositionSizer::new("Scalp", false, 20, 0.8, 6.0)
            .with_paper_max_positions(3)
            .with_max_margin_per_order(Some(10.0));

        let plan = sizer.calculate_session_plan(8.0, 0, 0.0, 0.0, 0.0);
        assert!(
            plan.position_size_usdt <= 8.0,
            "cap must not push size above the available balance, got {}",
            plan.position_size_usdt
        );
    }

    #[test]
    fn injected_clock_drives_session_id_and_timestamp() {
        let sizer =
            PositionSizer::new("Clocked", false, 5, 1.0, 2.0).with_now_ms(1_700_000_000_000);
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);
        assert_eq!(plan.created_at_ms, 1_700_000_000_000);
        assert_eq!(plan.session_id, "Clocked-paper-1700000000000");
    }
}
