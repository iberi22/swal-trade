//! Verificación de órdenes antes de firmarlas.
//!
//! Es la última barrera de la PWA: nada llega al exchange sin pasar por
//! [`check_order`]. La función es **pura** — sin red, sin reloj, sin estado
//! compartido — para que el backend privado pueda ejecutarla como segunda
//! verificación con exactamente las mismas reglas.
//!
//! Los motivos del rechazo están en español porque son los que ve la persona
//! usuaria en la PWA antes de confirmar.

use serde::{Deserialize, Serialize};

/// Lado de la orden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// Compra / posición larga.
    Long,
    /// Venta / posición corta.
    Short,
}

impl Side {
    /// `true` si el lado es [`Side::Long`].
    pub fn is_long(self) -> bool {
        matches!(self, Side::Long)
    }
}

/// Intención de orden tal como la formula la PWA antes de firmarla.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderIntent {
    /// Símtodo del mercado, p. ej. `BTCUSDT`.
    pub symbol: String,
    /// Lado de la orden.
    pub side: Side,
    /// Precio de entrada previsto.
    pub entry_price: f64,
    /// Stop loss; `None` significa "sin stop loss".
    pub stop_loss: Option<f64>,
    /// Take profit; `None` significa "sin take profit".
    pub take_profit: Option<f64>,
    /// Cantidad en unidades del activo base.
    pub quantity: f64,
    /// Apalancamiento solicitado.
    pub leverage: f64,
}

impl OrderIntent {
    /// Distancia absoluta entre la entrada y el stop loss, si lo hay.
    pub fn stop_distance(&self) -> Option<f64> {
        self.stop_loss.map(|sl| (self.entry_price - sl).abs())
    }

    /// Pérdida estimada en moneda de cotización si se toca el stop.
    ///
    /// `None` si no hay stop loss o si algún valor no es finito.
    pub fn risk_usdt(&self) -> Option<f64> {
        self.stop_distance().map(|dist| dist * self.quantity)
    }
}

/// Límites de riesgo configurados por la persona usuaria.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskLimits {
    /// Riesgo máximo por operación, como porcentaje del equity.
    pub max_risk_per_trade_pct: f64,
    /// Pérdida diaria máxima antes de cortar la sesión, como porcentaje del
    /// equity.
    pub max_daily_loss_pct: f64,
    /// Apalancamiento máximo permitido.
    pub max_leverage: f64,
    /// Si es `true`, toda orden necesita stop loss.
    pub require_stop_loss: bool,
    /// Número máximo de posiciones abiertas simultáneas.
    pub max_open_positions: usize,
}

/// Estado de la cuenta en el momento de la verificación.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountState {
    /// Equity actual (balance + PnL no realizado).
    pub equity: f64,
    /// PnL realizado acumulado hoy (negativo si va perdiendo).
    pub realized_pnl_today: f64,
    /// Posiciones abiertas actualmente.
    pub open_positions: usize,
}

/// Resultado de la verificación previa a firmar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "camelCase")]
pub enum GuardDecision {
    /// La orden cumple todos los límites.
    Allow,
    /// La orden se rechaza; `reasons` explica cada regla incumplida.
    Reject {
        /// Motivos del rechazo, en español y en orden de evaluación.
        reasons: Vec<String>,
    },
}

impl GuardDecision {
    /// `true` si la orden puede firmarse.
    pub fn is_allowed(&self) -> bool {
        matches!(self, GuardDecision::Allow)
    }

    /// Motivos del rechazo; vacío si la orden está permitida.
    pub fn reasons(&self) -> &[String] {
        match self {
            GuardDecision::Allow => &[],
            GuardDecision::Reject { reasons } => reasons,
        }
    }
}

/// Verifica una orden contra los límites y el estado de la cuenta.
///
/// Evalúa **todas** las reglas y acumula los motivos, en vez de cortar en la
/// primera: así la PWA puede mostrarle a la persona todos los ajustes que
/// necesita hacer de una vez.
///
/// Reglas, en orden:
///
/// 1. Entrada y cantidad deben ser positivas y finitas.
/// 2. Stop loss obligatorio si [`RiskLimits::require_stop_loss`] lo exige.
/// 3. El stop loss debe estar del lado correcto de la entrada: por debajo en
///    largo, por encima en corto.
/// 4. `|entrada - stop| * cantidad` no puede superar
///    `equity * max_risk_per_trade_pct / 100`.
/// 5. El apalancamiento no puede superar [`RiskLimits::max_leverage`].
/// 6. **Kill switch diario:** si `realized_pnl_today <= -equity *
///    max_daily_loss_pct / 100` se rechazan todas las órdenes nuevas.
/// 7. `open_positions` debe ser menor que [`RiskLimits::max_open_positions`].
pub fn check_order(
    order: &OrderIntent,
    limits: &RiskLimits,
    account: &AccountState,
) -> GuardDecision {
    let mut reasons: Vec<String> = Vec::new();

    // 0. Sanidad de los números de entrada: sin esto las reglas siguientes
    // compararían contra NaN y pasarían sin avisar.
    if !(order.entry_price.is_finite() && order.entry_price > 0.0) {
        reasons.push("Precio de entrada inválido: debe ser un número positivo.".to_string());
    }
    if !(order.quantity.is_finite() && order.quantity > 0.0) {
        reasons.push("Cantidad inválida: debe ser un número positivo.".to_string());
    }
    if !account.equity.is_finite() || account.equity <= 0.0 {
        reasons.push("Equity de la cuenta inválido: debe ser un número positivo.".to_string());
    }

    // 1. Stop loss obligatorio.
    if limits.require_stop_loss && order.stop_loss.is_none() {
        reasons.push(
            "Stop loss obligatorio: esta cuenta exige un stop loss en cada orden.".to_string(),
        );
    }

    // 2. Lado correcto del stop loss. Solo aplica si hay stop.
    if let Some(sl) = order.stop_loss {
        let sl_finite = sl.is_finite() && sl > 0.0;
        if !sl_finite {
            reasons.push("Stop loss inválido: debe ser un número positivo.".to_string());
        } else if order.side.is_long() && sl >= order.entry_price {
            reasons.push(format!(
                "Stop loss en el lado equivocado: en largo debe estar por debajo de la entrada {:.8} (recibido {:.8}).",
                order.entry_price, sl
            ));
        } else if !order.side.is_long() && sl <= order.entry_price {
            reasons.push(format!(
                "Stop loss en el lado equivocado: en corto debe estar por encima de la entrada {:.8} (recibido {:.8}).",
                order.entry_price, sl
            ));
        }
    }

    // 3. Riesgo por operación dentro del tope. Solo es evaluable con stop loss.
    if let Some(risk) = order.risk_usdt() {
        let max_risk = account.equity * (limits.max_risk_per_trade_pct / 100.0);
        if risk.is_finite() && max_risk.is_finite() && risk > max_risk {
            reasons.push(format!(
                "Riesgo por operación demasiado alto: {:.2} USDT supera el máximo de {:.2} USDT ({:.2}% de {:.2} de equity).",
                risk, max_risk, limits.max_risk_per_trade_pct, account.equity
            ));
        }
    }

    // 4. Apalancamiento.
    if order.leverage.is_finite() && limits.max_leverage.is_finite() {
        if order.leverage > limits.max_leverage {
            reasons.push(format!(
                "Apalancamiento demasiado alto: {:.2}x supera el máximo de {:.2}x.",
                order.leverage, limits.max_leverage
            ));
        }
    } else {
        reasons.push("Apalancamiento inválido: debe ser un número.".to_string());
    }

    // 5. Kill switch diario. Bloquea todo, sea cual sea el resto.
    let max_daily_loss = account.equity * (limits.max_daily_loss_pct / 100.0);
    if max_daily_loss.is_finite() && account.realized_pnl_today <= -max_daily_loss {
        reasons.push(format!(
            "Kill switch diario activado: {:.2} USDT de pérdida realizada iguala o supera el límite de {:.2} USDT ({:.2}% de {:.2} de equity). No se permiten órdenes nuevas hoy.",
            account.realized_pnl_today, max_daily_loss, limits.max_daily_loss_pct, account.equity
        ));
    }

    // 6. Slots de posición abierta.
    if account.open_positions >= limits.max_open_positions {
        reasons.push(format!(
            "Límite de posiciones abiertas alcanzado: {}/{}.",
            account.open_positions, limits.max_open_positions
        ));
    }

    if reasons.is_empty() {
        GuardDecision::Allow
    } else {
        GuardDecision::Reject { reasons }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> RiskLimits {
        RiskLimits {
            max_risk_per_trade_pct: 2.0,
            max_daily_loss_pct: 5.0,
            max_leverage: 10.0,
            require_stop_loss: true,
            max_open_positions: 3,
        }
    }

    fn account() -> AccountState {
        AccountState {
            equity: 1000.0,
            realized_pnl_today: 0.0,
            open_positions: 0,
        }
    }

    /// Largo base: entrada 100, stop 95 (5 USD de distancia), qty 1 => riesgo 5
    /// USDT = 0,5% de un equity de 1000. Cumple todos los límites.
    fn long_order() -> OrderIntent {
        OrderIntent {
            symbol: "BTCUSDT".to_string(),
            side: Side::Long,
            entry_price: 100.0,
            stop_loss: Some(95.0),
            take_profit: Some(110.0),
            quantity: 1.0,
            leverage: 5.0,
        }
    }

    fn assert_allowed(order: &OrderIntent, limits: &RiskLimits, account: &AccountState) {
        let d = check_order(order, limits, account);
        assert_eq!(d, GuardDecision::Allow, "motivos: {:?}", d.reasons());
    }

    fn assert_rejected_containing(
        order: &OrderIntent,
        limits: &RiskLimits,
        account: &AccountState,
        needle: &str,
    ) {
        let d = check_order(order, limits, account);
        let reasons = d.reasons();
        assert!(!reasons.is_empty(), "se esperaba rechazo, hubo Allow");
        assert!(
            reasons.iter().any(|r| r.contains(needle)),
            "esperaba un motivo que contenga {needle:?}, reasons = {reasons:?}"
        );
    }

    #[test]
    fn allows_a_compliant_long_order() {
        assert_allowed(&long_order(), &limits(), &account());
    }

    #[test]
    fn allows_a_compliant_short_order() {
        let order = OrderIntent {
            side: Side::Short,
            stop_loss: Some(105.0),
            ..long_order()
        };
        assert_allowed(&order, &limits(), &account());
    }

    #[test]
    fn rejects_missing_stop_loss_when_required() {
        let mut order = long_order();
        order.stop_loss = None;
        assert_rejected_containing(&order, &limits(), &account(), "Stop loss obligatorio");
    }

    #[test]
    fn allows_missing_stop_loss_when_not_required() {
        let mut limits = limits();
        limits.require_stop_loss = false;
        let mut order = long_order();
        order.stop_loss = None;
        assert_allowed(&order, &limits, &account());
    }

    #[test]
    fn rejects_long_with_stop_above_entry() {
        let mut order = long_order();
        order.stop_loss = Some(105.0);
        assert_rejected_containing(&order, &limits(), &account(), "lado equivocado");
    }

    #[test]
    fn rejects_long_with_stop_equal_to_entry() {
        // El límite es estricto: un stop en la entrada no limita nada.
        let mut order = long_order();
        order.stop_loss = Some(100.0);
        assert_rejected_containing(&order, &limits(), &account(), "lado equivocado");
    }

    #[test]
    fn rejects_short_with_stop_below_entry() {
        let mut order = long_order();
        order.side = Side::Short;
        order.stop_loss = Some(95.0);
        assert_rejected_containing(&order, &limits(), &account(), "lado equivocado");
    }

    #[test]
    fn accepts_stop_just_below_entry_on_long() {
        // Frontera: 1 centavo por debajo sigue siendo un stop válido.
        let mut order = long_order();
        order.stop_loss = Some(99.99);
        order.quantity = 0.5;
        assert_allowed(&order, &limits(), &account());
    }

    #[test]
    fn rejects_risk_above_max_per_trade() {
        // 2% de 1000 = 20 USDT. Distancia 5 x qty 10 = 50 USDT de riesgo.
        let mut order = long_order();
        order.quantity = 10.0;
        assert_rejected_containing(
            &order,
            &limits(),
            &account(),
            "Riesgo por operación demasiado alto",
        );
    }

    #[test]
    fn accepts_risk_exactly_at_max_per_trade() {
        // Frontera exacta: 2% de 1000 = 20 USDT = distancia 5 x qty 4.
        let mut order = long_order();
        order.quantity = 4.0;
        assert_allowed(&order, &limits(), &account());
    }

    #[test]
    fn rejects_leverage_above_max() {
        let mut order = long_order();
        order.leverage = 25.0;
        assert_rejected_containing(
            &order,
            &limits(),
            &account(),
            "Apalancamiento demasiado alto",
        );
    }

    #[test]
    fn accepts_leverage_exactly_at_max() {
        let mut order = long_order();
        order.leverage = 10.0;
        assert_allowed(&order, &limits(), &account());
    }

    #[test]
    fn daily_kill_switch_blocks_new_orders() {
        // 5% de 1000 = 50 USDT. Alcanzado exactamente: se bloquea.
        let mut account = account();
        account.realized_pnl_today = -50.0;
        assert_rejected_containing(
            &long_order(),
            &limits(),
            &account,
            "Kill switch diario activado",
        );
    }

    #[test]
    fn daily_kill_switch_not_tripped_just_above_limit() {
        let mut account = account();
        account.realized_pnl_today = -49.99;
        assert_allowed(&long_order(), &limits(), &account);
    }

    #[test]
    fn daily_kill_switch_tolerates_a_profitable_day() {
        let mut account = account();
        account.realized_pnl_today = 25.0;
        assert_allowed(&long_order(), &limits(), &account);
    }

    #[test]
    fn rejects_when_open_positions_reach_limit() {
        let mut account = account();
        account.open_positions = 3;
        assert_rejected_containing(
            &long_order(),
            &limits(),
            &account,
            "Límite de posiciones abiertas alcanzado",
        );
    }

    #[test]
    fn accepts_one_slot_below_the_limit() {
        let mut account = account();
        account.open_positions = 2;
        assert_allowed(&long_order(), &limits(), &account);
    }

    #[test]
    fn accumulates_every_broken_rule() {
        let order = OrderIntent {
            symbol: "BTCUSDT".to_string(),
            side: Side::Long,
            entry_price: 100.0,
            stop_loss: Some(101.0), // lado equivocado
            take_profit: None,
            quantity: 100.0, // riesgo 500 USDT
            leverage: 50.0,  // apalancamiento
        };
        let mut account = account();
        account.realized_pnl_today = -80.0; // kill switch
        account.open_positions = 5; // sin slots

        let d = check_order(&order, &limits(), &account);
        let reasons = d.reasons();
        assert_eq!(reasons.len(), 5, "motivos: {reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("lado equivocado")));
        assert!(reasons.iter().any(|r| r.contains("Riesgo por operación")));
        assert!(reasons.iter().any(|r| r.contains("Apalancamiento")));
        assert!(reasons.iter().any(|r| r.contains("Kill switch")));
        assert!(reasons.iter().any(|r| r.contains("posiciones abiertas")));
    }

    #[test]
    fn rejects_non_positive_entry_price() {
        let mut order = long_order();
        order.entry_price = 0.0;
        assert_rejected_containing(&order, &limits(), &account(), "Precio de entrada inválido");
    }

    #[test]
    fn rejects_zero_quantity() {
        let mut order = long_order();
        order.quantity = 0.0;
        assert_rejected_containing(&order, &limits(), &account(), "Cantidad inválida");
    }

    #[test]
    fn rejects_non_positive_equity() {
        let mut account = account();
        account.equity = 0.0;
        assert_rejected_containing(
            &long_order(),
            &limits(),
            &account,
            "Equity de la cuenta inválido",
        );
    }

    #[test]
    fn order_risk_helper_matches_manual_math() {
        let order = long_order();
        assert_eq!(order.stop_distance(), Some(5.0));
        assert_eq!(order.risk_usdt(), Some(5.0));

        let mut no_stop = order.clone();
        no_stop.stop_loss = None;
        assert_eq!(no_stop.stop_distance(), None);
        assert_eq!(no_stop.risk_usdt(), None);
    }

    #[test]
    fn side_is_long_reports_correctly() {
        assert!(Side::Long.is_long());
        assert!(!Side::Short.is_long());
    }
}
