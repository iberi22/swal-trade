//! Validación de riesgo previa a la orden.
//!
//! Puerto *puro* de `backend/src/domain/risk.rs`. A diferencia del original,
//! esta versión no lleva `#![allow(dead_code)]`: todo lo que se exporta está
//! usado por la PWA, por el backend o por los tests del crate.

use serde::{Deserialize, Serialize};

/// Límites de riesgo configurables de la cuenta.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    /// Tope de tamaño de posición absoluto (en moneda de cotización).
    pub max_position_size: f64,
    /// Pérdida diaria máxima permitida (negativa, p. ej. `-250.0`).
    pub max_daily_loss: f64,
    /// Tope de órdenes abiertas simultáneas.
    pub max_open_orders: u32,
    /// Apalancamiento máximo permitido.
    pub max_leverage: u8,
    /// Exposición total máxima como porcentaje de la cuenta (`0.0`–`1.0`).
    pub max_total_exposure_pct: f64,
    /// Tope de posiciones abiertas concurrentes.
    pub max_concurrent_positions: u32,
    /// Límite de pérdida por operación como porcentaje (`0.0`–`1.0`).
    pub per_trade_loss_limit_pct: f64,
}

/// Motor de riesgo previo a la orden.
///
/// Acumula posición y PnL diario en memoria; el llamador decide cuándo
/// reiniciar el día con [`RiskEngine::reset_daily`].
#[derive(Debug, Clone)]
pub struct RiskEngine {
    config: RiskConfig,
    current_position: f64,
    daily_pnl: f64,
    open_orders: u32,
}

impl RiskEngine {
    /// Crea un motor con contadores a cero.
    pub fn new(config: RiskConfig) -> Self {
        Self {
            config,
            current_position: 0.0,
            daily_pnl: 0.0,
            open_orders: 0,
        }
    }

    /// Comprueba si una operación está permitida por las reglas de riesgo.
    pub fn check_trade(&self, quantity: f64, price: f64) -> Result<(), String> {
        let trade_value = quantity * price;

        if self.current_position + trade_value > self.config.max_position_size {
            return Err(format!(
                "Trade would exceed max position size: {} > {}",
                self.current_position + trade_value,
                self.config.max_position_size
            ));
        }

        if self.daily_pnl < -self.config.max_daily_loss {
            return Err(format!(
                "Daily loss limit reached: {} < -{}",
                self.daily_pnl, self.config.max_daily_loss
            ));
        }

        if self.open_orders >= self.config.max_open_orders {
            return Err(format!(
                "Max open orders reached: {}",
                self.config.max_open_orders
            ));
        }

        Ok(())
    }

    /// Comprueba si el apalancamiento solicitado está dentro de los límites.
    pub fn check_leverage(&self, requested_leverage: u32) -> Result<(), String> {
        if requested_leverage > self.config.max_leverage as u32 {
            return Err(format!(
                "Requested leverage {} exceeds max leverage {}",
                requested_leverage, self.config.max_leverage
            ));
        }
        if requested_leverage == 0 {
            return Err("Leverage cannot be zero".to_string());
        }
        Ok(())
    }

    /// Cortocircuito: decide si se debe pausar el trading por condiciones extremas.
    pub fn check_circuit_breaker(
        &self,
        concurrent_positions: u32,
        daily_loss_pct: f64,
    ) -> Result<(), String> {
        if concurrent_positions >= self.config.max_concurrent_positions {
            return Err(format!(
                "Circuit breaker: Max concurrent positions reached ({} >= {})",
                concurrent_positions, self.config.max_concurrent_positions
            ));
        }

        // El cortocircuito se dispara al alcanzar la mitad de la pérdida diaria máxima.
        let circuit_breaker_threshold = self.config.max_daily_loss * 0.5;
        if daily_loss_pct >= circuit_breaker_threshold {
            return Err(format!(
                "Circuit breaker: Daily loss {:.2}% exceeds threshold {:.2}%",
                daily_loss_pct, circuit_breaker_threshold
            ));
        }

        Ok(())
    }

    /// Aplica el cambio de posición tras una operación.
    pub fn update_position(&mut self, delta: f64) {
        self.current_position += delta;
    }

    /// Ajusta el conteo de órdenes abiertas (altas y cancelaciones).
    pub fn update_open_orders(&mut self, delta: i64) {
        let next = self.open_orders as i64 + delta;
        self.open_orders = next.max(0) as u32;
    }

    /// Acumula el PnL diario.
    pub fn update_pnl(&mut self, pnl: f64) {
        self.daily_pnl += pnl;
    }

    /// Reinicia las estadísticas diarias (llamar al inicio de cada día).
    pub fn reset_daily(&mut self) {
        self.daily_pnl = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RiskConfig {
        RiskConfig {
            max_position_size: 1_000.0,
            max_daily_loss: 250.0,
            max_open_orders: 3,
            max_leverage: 10,
            max_total_exposure_pct: 0.5,
            max_concurrent_positions: 2,
            per_trade_loss_limit_pct: 0.02,
        }
    }

    #[test]
    fn allows_trade_within_limits() {
        let engine = RiskEngine::new(config());
        assert!(engine.check_trade(1.0, 100.0).is_ok());
    }

    #[test]
    fn rejects_trade_above_max_position_size() {
        let engine = RiskEngine::new(config());
        let err = engine.check_trade(100.0, 100.0).unwrap_err();
        assert!(err.contains("max position size"), "{err}");
    }

    #[test]
    fn rejects_trade_after_daily_loss_limit() {
        let mut engine = RiskEngine::new(config());
        engine.update_pnl(-300.0);
        let err = engine.check_trade(1.0, 100.0).unwrap_err();
        assert!(err.contains("Daily loss limit reached"), "{err}");
    }

    #[test]
    fn rejects_when_max_open_orders_reached() {
        let mut engine = RiskEngine::new(config());
        // El tope es 3 órdenes abiertas.
        engine.update_open_orders(3);
        let err = engine.check_trade(1.0, 10.0).unwrap_err();
        assert!(err.contains("Max open orders reached"), "{err}");
    }

    #[test]
    fn open_orders_never_go_negative() {
        let mut engine = RiskEngine::new(config());
        engine.update_open_orders(-5);
        assert!(engine.check_trade(1.0, 10.0).is_ok());
    }

    #[test]
    fn leverage_zero_is_rejected() {
        let engine = RiskEngine::new(config());
        let err = engine.check_leverage(0).unwrap_err();
        assert_eq!(err, "Leverage cannot be zero");
    }

    #[test]
    fn leverage_above_max_is_rejected() {
        let engine = RiskEngine::new(config());
        let err = engine.check_leverage(11).unwrap_err();
        assert!(err.contains("exceeds max leverage"), "{err}");
    }

    #[test]
    fn leverage_at_max_is_allowed() {
        let engine = RiskEngine::new(config());
        assert!(engine.check_leverage(10).is_ok());
    }

    #[test]
    fn circuit_breaker_trips_on_positions() {
        let engine = RiskEngine::new(config());
        let err = engine.check_circuit_breaker(2, 0.0).unwrap_err();
        assert!(err.contains("Max concurrent positions"), "{err}");
    }

    #[test]
    fn circuit_breaker_trips_on_daily_loss() {
        let engine = RiskEngine::new(config());
        // Umbral = 250 * 0.5 = 125
        let err = engine.check_circuit_breaker(0, 125.0).unwrap_err();
        assert!(err.contains("Circuit breaker"), "{err}");
    }

    #[test]
    fn circuit_breaker_passes_when_healthy() {
        let engine = RiskEngine::new(config());
        assert!(engine.check_circuit_breaker(1, 10.0).is_ok());
    }

    #[test]
    fn reset_daily_clears_pnl() {
        let mut engine = RiskEngine::new(config());
        engine.update_pnl(-300.0);
        assert!(engine.check_trade(1.0, 100.0).is_err());
        engine.reset_daily();
        assert!(engine.check_trade(1.0, 100.0).is_ok());
    }

    #[test]
    fn position_accumulates() {
        let mut engine = RiskEngine::new(config());
        engine.update_position(900.0);
        // 900 + 100*1 = 1000 <= 1000: sigue pasando.
        assert!(engine.check_trade(1.0, 100.0).is_ok());
        // Y ahora supera el tope.
        assert!(engine.check_trade(1.0, 200.0).is_err());
    }
}
