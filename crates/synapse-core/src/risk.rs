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
    /// Pérdida diaria máxima permitida, como **cantidad positiva en USDT**
    /// (p. ej. `250.0` significa "250 USDT perdidos en el día", no `-250.0`).
    ///
    /// El signo va en la comparación, no en el límite: [`RiskEngine::check_trade`]
    /// bloquea cuando `daily_pnl < -max_daily_loss`. Guardar el límite ya en
    /// negativo obligaba a negar dos veces y hacía fácil comparar `-(-250)`,
    /// que con un `NaN` de por medio no da el mismo resultado.
    ///
    /// Tiene que ser finito y mayor que 0. Un límite no utilizable (cero,
    /// negativo o no finito) no significa "sin límite": bloquea **todas** las
    /// operaciones, porque no hay forma de saber cuánto se puede perder.
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

    /// Devuelve `max_daily_loss` en USDT si es utilizable, o el motivo por el
    /// que no lo es.
    ///
    /// Se valida **al comprobar**, no al construir, a propósito:
    /// [`RiskEngine::new`] devuelve `Self` y la configuración viene del
    /// llamador (entorno, base de datos, HTTP), así que puede llegar corrupta
    /// en cualquier momento. Un `NaN` o un cero se compararían bien contra
    /// cualquier cosa (`daily_pnl < -NaN` es `false`) y dejarían la sesión
    /// abierta sin tope, que es justo el fallo que se quiere evitar.
    fn max_daily_loss_usdt(&self) -> Result<f64, String> {
        let limit = self.config.max_daily_loss;
        if !(limit.is_finite() && limit > 0.0) {
            return Err(format!(
                "Invalid risk config: max_daily_loss must be a finite positive USDT amount, got {limit}"
            ));
        }
        Ok(limit)
    }

    /// Igual que [`RiskEngine::max_daily_loss_usdt`] para el tope de posición.
    fn max_position_size_usdt(&self) -> Result<f64, String> {
        let limit = self.config.max_position_size;
        if !(limit.is_finite() && limit > 0.0) {
            return Err(format!(
                "Invalid risk config: max_position_size must be a finite positive USDT amount, got {limit}"
            ));
        }
        Ok(limit)
    }

    /// `true` si el estado acumulado sigue siendo utilizable.
    ///
    /// `update_position` y `update_pnl` suman el `delta` que les llegue sin
    /// filtrarlo. Un solo `NaN` envenena el acumulador para siempre, y desde
    /// ahí todas las comparaciones son `false`: el motor aceptaría operaciones
    /// sin tope. Se comprueba en cada `check_*` en vez de en los
    /// `update_*` para no cambiar su firma ni perder el error.
    fn state_is_finite(&self) -> Result<(), String> {
        if !self.current_position.is_finite() {
            return Err(format!(
                "Corrupt risk state: current_position is not finite ({})",
                self.current_position
            ));
        }
        if !self.daily_pnl.is_finite() {
            return Err(format!(
                "Corrupt risk state: daily_pnl is not finite ({})",
                self.daily_pnl
            ));
        }
        Ok(())
    }

    /// Comprueba si una operación está permitida por las reglas de riesgo.
    ///
    /// `quantity` y `price` tienen que ser finitos y positivos: una cantidad o
    /// un precio no finito produce un `trade_value` no finito, y las
    /// comparaciones contra el tope se volverían `false`.
    pub fn check_trade(&self, quantity: f64, price: f64) -> Result<(), String> {
        if !(quantity.is_finite() && quantity > 0.0) {
            return Err(format!(
                "Invalid quantity: {quantity} (expected a finite positive number)"
            ));
        }
        if !(price.is_finite() && price > 0.0) {
            return Err(format!(
                "Invalid price: {price} (expected a finite positive number)"
            ));
        }
        self.state_is_finite()?;
        let max_position_size = self.max_position_size_usdt()?;
        let max_daily_loss = self.max_daily_loss_usdt()?;

        let trade_value = quantity * price;

        if self.current_position + trade_value > max_position_size {
            return Err(format!(
                "Trade would exceed max position size: {} > {}",
                self.current_position + trade_value,
                max_position_size
            ));
        }

        if self.daily_pnl < -max_daily_loss {
            return Err(format!(
                "Daily loss limit reached: {} < -{}",
                self.daily_pnl, max_daily_loss
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
    ///
    /// # UNIDADES
    ///
    /// `daily_loss_usdt` está en **USDT**, la misma unidad que
    /// [`RiskConfig::max_daily_loss`] y que el `daily_pnl` que acumula
    /// [`RiskEngine::update_pnl`]. Todo el motor razona en dinero absoluto
    /// porque [`RiskEngine`] no conoce el equity: no puede convertir un límite
    /// en USDT a un porcentaje, ni al revés.
    ///
    /// Antes este parámetro se llamaba `daily_loss_pct` y el mensaje lo
    /// imprimía con `{:.2}%`, mientras se comparaba contra
    /// `max_daily_loss * 0.5` en USDT. El mismo número se leía como dos
    /// cosas distintas: con `max_daily_loss = 250`, un `daily_loss_pct` de
    /// `1.5` (es decir, un 1,5 %) disparaba el cortocircuito cuando en USDT
    /// eran 1,50 USDT contra un umbral de 125. Desde aquí el nombre, el
    /// mensaje y la comparación son la misma magnitud.
    ///
    /// El cortocircuito se dispara al alcanzar la mitad de la pérdida diaria
    /// máxima, antes que el kill switch de [`RiskEngine::check_trade`], para
    /// poder pausar la sesión con margen.
    pub fn check_circuit_breaker(
        &self,
        concurrent_positions: u32,
        daily_loss_usdt: f64,
    ) -> Result<(), String> {
        self.state_is_finite()?;
        let max_daily_loss = self.max_daily_loss_usdt()?;

        if !(daily_loss_usdt.is_finite() && daily_loss_usdt >= 0.0) {
            return Err(format!(
                "Invalid daily loss: {daily_loss_usdt} (expected a finite non-negative USDT amount)"
            ));
        }

        if concurrent_positions >= self.config.max_concurrent_positions {
            return Err(format!(
                "Circuit breaker: Max concurrent positions reached ({} >= {})",
                concurrent_positions, self.config.max_concurrent_positions
            ));
        }

        // El cortocircuito se dispara al alcanzar la mitad de la pérdida diaria máxima.
        // Las dos magnitudes están en USDT.
        let circuit_breaker_threshold = max_daily_loss * 0.5;
        if daily_loss_usdt >= circuit_breaker_threshold {
            return Err(format!(
                "Circuit breaker: Daily loss {:.2} USDT reaches the threshold of {:.2} USDT (50% of the {:.2} USDT daily limit)",
                daily_loss_usdt, circuit_breaker_threshold, max_daily_loss
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

    // -----------------------------------------------------------------------
    // `max_daily_loss` es un importe POSITIVO en USDT.
    // -----------------------------------------------------------------------

    #[test]
    fn max_daily_loss_is_a_positive_usdt_amount() {
        // 250 USDT de tope. El PnL se acumula en USDT con el mismo signo, así
        // que el corte es al llegar a -250, no a -(-250).
        let mut engine = RiskEngine::new(config());

        // Justo por encima del tope: bloquea.
        engine.update_pnl(-250.01);
        let err = engine.check_trade(1.0, 100.0).unwrap_err();
        assert!(err.contains("Daily loss limit reached"), "{err}");

        // Justo en el tope: la comparación es estricta, así que aún pasa.
        engine.reset_daily();
        engine.update_pnl(-250.0);
        assert!(
            engine.check_trade(1.0, 100.0).is_ok(),
            "el tope exacto todavía no bloquea"
        );
    }

    #[test]
    fn invalid_max_daily_loss_rejects_every_trade() {
        // Un límite no utilizable no es "sin límite": es un tope roto, así que
        // se bloquea todo. Antes, `daily_pnl < -NaN` era `false` y el motor
        // aceptaba cualquier operación.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            let mut config = config();
            config.max_daily_loss = bad;
            let engine = RiskEngine::new(config);

            // Incluso sin pérdidas accumuladas y con una operación diminuta.
            let err = engine.check_trade(0.001, 1.0).unwrap_err();
            assert!(
                err.contains("max_daily_loss must be a finite positive USDT amount"),
                "max_daily_loss = {bad}: {err}"
            );
        }
    }

    #[test]
    fn invalid_max_daily_loss_is_also_reported_by_the_circuit_breaker() {
        let mut config = config();
        config.max_daily_loss = 0.0;
        let engine = RiskEngine::new(config);
        let err = engine.check_circuit_breaker(0, 0.0).unwrap_err();
        assert!(err.contains("max_daily_loss"), "{err}");
    }

    // -----------------------------------------------------------------------
    // `check_trade` rechaza cantidad y precio no utilizables.
    // -----------------------------------------------------------------------

    #[test]
    fn check_trade_rejects_invalid_quantity() {
        let engine = RiskEngine::new(config());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            let err = engine.check_trade(bad, 100.0).unwrap_err();
            assert!(err.contains("Invalid quantity"), "quantity = {bad}: {err}");
        }
    }

    #[test]
    fn check_trade_rejects_invalid_price() {
        let engine = RiskEngine::new(config());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            let err = engine.check_trade(1.0, bad).unwrap_err();
            assert!(err.contains("Invalid price"), "price = {bad}: {err}");
        }
    }

    #[test]
    fn check_trade_accepts_the_smallest_valid_trade() {
        // Frontera: ni 0 ni negativos, pero un valor diminuto y finito es legal.
        let engine = RiskEngine::new(config());
        assert!(engine
            .check_trade(f64::MIN_POSITIVE, f64::MIN_POSITIVE)
            .is_ok());
    }

    #[test]
    fn invalid_max_position_size_rejects_every_trade() {
        // Mismo motivo que `max_daily_loss`: un tope de posición no finito hace
        // que `current_position + trade_value > NaN` sea `false`.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            let mut config = config();
            config.max_position_size = bad;
            let engine = RiskEngine::new(config);
            let err = engine.check_trade(1.0, 100.0).unwrap_err();
            assert!(
                err.contains("max_position_size must be a finite positive USDT amount"),
                "max_position_size = {bad}: {err}"
            );
        }
    }

    #[test]
    fn non_finite_accumulated_state_rejects_every_trade() {
        // Un solo delta corrupto envenena el acumulador: desde ahí toda
        // comparación es `false`. Se rechaza en vez de seguir aceptando.
        let mut engine = RiskEngine::new(config());
        engine.update_position(f64::NAN);
        let err = engine.check_trade(1.0, 100.0).unwrap_err();
        assert!(err.contains("Corrupt risk state"), "{err}");

        let mut engine = RiskEngine::new(config());
        engine.update_pnl(f64::NAN);
        let err = engine.check_trade(1.0, 100.0).unwrap_err();
        assert!(err.contains("Corrupt risk state"), "{err}");

        // Y el cortocircuito tampoco se fía de ese estado.
        let err = engine.check_circuit_breaker(0, 0.0).unwrap_err();
        assert!(err.contains("Corrupt risk state"), "{err}");
    }

    #[test]
    fn non_finite_state_is_reported_before_the_daily_loss_check() {
        // Orden de los mensajes: primero el estado corrupto, porque un PnL no
        // finito no se puede comparar con ningún tope.
        let mut engine = RiskEngine::new(config());
        engine.update_pnl(f64::INFINITY);
        let err = engine.check_trade(1.0, 100.0).unwrap_err();
        assert!(err.starts_with("Corrupt risk state"), "{err}");
    }

    // -----------------------------------------------------------------------
    // El cortocircuito razona en USDT, igual que el resto del motor.
    // -----------------------------------------------------------------------

    #[test]
    fn circuit_breaker_compares_usdt_against_usdt() {
        let engine = RiskEngine::new(config());
        // Umbral = 250 * 0.5 = 125 USDT.
        assert!(engine.check_circuit_breaker(0, 124.99).is_ok());
        let err = engine.check_circuit_breaker(0, 125.0).unwrap_err();
        assert!(err.contains("125.00 USDT"), "{err}");
        // La pérdida ya no se anuncia como porcentaje: la magnitud que se
        // compara está en USDT, y el mensaje lo dice. El único `%` que queda
        // es la fracción del límite, que sí es un porcentaje.
        assert!(
            !err.contains("Daily loss 125.00%"),
            "la pérdida no debe anunciarse como porcentaje: {err}"
        );
    }

    #[test]
    fn circuit_breaker_rejects_invalid_daily_loss() {
        let engine = RiskEngine::new(config());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
            let err = engine.check_circuit_breaker(0, bad).unwrap_err();
            assert!(
                err.contains("Invalid daily loss"),
                "daily_loss = {bad}: {err}"
            );
        }
    }

    #[test]
    fn circuit_breaker_and_kill_switch_agree_on_the_same_day() {
        // Las dos reglas hablan USDT: el cortocircuito salta a la mitad del
        // límite diario y el kill switch en el límite completo.
        let mut config = config();
        config.max_open_orders = 99;
        let mut engine = RiskEngine::new(config);

        engine.update_pnl(-125.0); // mitad del límite
        assert!(
            engine.check_circuit_breaker(0, 125.0).is_err(),
            "el cortocircuito debe saltar a la mitad"
        );
        assert!(
            engine.check_trade(1.0, 100.0).is_ok(),
            "a la mitad del límite todavía se puede operar"
        );

        engine.update_pnl(-125.01); // completes el límite
        assert!(engine.check_circuit_breaker(0, 250.01).is_err());
        assert!(
            engine.check_trade(1.0, 100.0).is_err(),
            "al completar el límite el kill switch corta"
        );
    }
}
