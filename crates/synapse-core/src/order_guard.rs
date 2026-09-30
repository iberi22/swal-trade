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
///
/// Se serializa en `camelCase` porque es uno de los structs que la PWA manda
/// desde JavaScript: el nombre del campo en Rust sigue siendo `snake_case`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
///
/// Se serializa en `camelCase` porque es uno de los structs que la PWA manda
/// desde JavaScript: el nombre del campo en Rust sigue siendo `snake_case`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
///
/// Se serializa en `camelCase` porque es uno de los structs que la PWA manda
/// desde JavaScript: el nombre del campo en Rust sigue siendo `snake_case`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Describe un `f64` para un mensaje de rechazo.
///
/// Los no finitos salen nombrados (`NaN`, `inf`, `-inf`) en vez de como un
/// `NaN` suelto en mitad del texto: quien lee el motivo en la PWA tiene que
/// poder distinguir "vino un NaN del feed" de "el número es 0".
fn fmt_num(v: f64) -> String {
    if v.is_nan() {
        "NaN".to_string()
    } else if v == f64::INFINITY {
        "inf".to_string()
    } else if v == f64::NEG_INFINITY {
        "-inf".to_string()
    } else {
        format!("{v}")
    }
}

/// Motivos por los que la **orden** no es un objeto de negocio coherente.
///
/// Todo no finito, negativo o por debajo del mínimo se rechaza aquí, nombrando
/// el campo. Es la regla 0 porque sin ella las comparaciones de las reglas
/// siguientes se harían contra `NaN`, y toda comparación con `NaN` es `false`:
/// la orden passaría sin avisar.
fn check_order_numbers(order: &OrderIntent) -> Vec<String> {
    let mut reasons = Vec::new();

    if !(order.entry_price.is_finite() && order.entry_price > 0.0) {
        reasons.push(format!(
            "Precio de entrada inválido: entry_price = {} no es un número finito mayor que 0.",
            fmt_num(order.entry_price)
        ));
    }
    if !(order.quantity.is_finite() && order.quantity > 0.0) {
        reasons.push(format!(
            "Cantidad inválida: quantity = {} no es un número finito mayor que 0.",
            fmt_num(order.quantity)
        ));
    }
    // 1x es el mínimo del exchange: por debajo no se puede abrir ni cerrar
    // posición, así que un apalancamiento de 0 o negativo es un error de
    // entrada, no un valor extreme que dejarlo pasar.
    if !(order.leverage.is_finite() && order.leverage >= 1.0) {
        reasons.push(format!(
            "Apalancamiento inválido: leverage = {} no es un número finito mayor o igual a 1.",
            fmt_num(order.leverage)
        ));
    }
    if let Some(sl) = order.stop_loss {
        if !(sl.is_finite() && sl > 0.0) {
            reasons.push(format!(
                "Stop loss inválido: stop_loss = {} no es un número finito mayor que 0.",
                fmt_num(sl)
            ));
        }
    }
    if let Some(tp) = order.take_profit {
        if !(tp.is_finite() && tp > 0.0) {
            reasons.push(format!(
                "Take profit inválido: take_profit = {} no es un número finito mayor que 0.",
                fmt_num(tp)
            ));
        }
    }

    reasons
}

/// Motivos por los que los **límites** no son utilizables.
///
/// Si un límite está corrupto, las reglas que lo consumen no se pueden
/// evaluar con sentido, así que la orden se rechaza en vez de firmarse "sin
/// tope": un `max_risk_per_trade_pct` en `NaN` significa que nadie ha fijado
/// cuánto se puede perder, y eso no es permiso para arriesgar.
fn check_limits(limits: &RiskLimits) -> Vec<String> {
    let mut reasons = Vec::new();

    if !(limits.max_risk_per_trade_pct.is_finite() && limits.max_risk_per_trade_pct > 0.0) {
        reasons.push(format!(
            "Límite de riesgo por operación inválido: max_risk_per_trade_pct = {} no es un número finito mayor que 0.",
            fmt_num(limits.max_risk_per_trade_pct)
        ));
    }
    if !(limits.max_daily_loss_pct.is_finite() && limits.max_daily_loss_pct > 0.0) {
        reasons.push(format!(
            "Límite de pérdida diaria inválido: max_daily_loss_pct = {} no es un número finito mayor que 0.",
            fmt_num(limits.max_daily_loss_pct)
        ));
    }
    if !(limits.max_leverage.is_finite() && limits.max_leverage > 0.0) {
        reasons.push(format!(
            "Apalancamiento máximo inválido: max_leverage = {} no es un número finito mayor que 0.",
            fmt_num(limits.max_leverage)
        ));
    }
    // 0 slots significa "no se puede abrir ninguna posición". Es un valor
    // coherente (cerrar todas las cuentas), pero no como configuración de
    // trading, así que se rechaza con su propio motivo en vez de colarse por
    // la regla de slots abiertos.
    if limits.max_open_positions == 0 {
        reasons.push(
            "Límite de posiciones abiertas inválido: max_open_positions = 0 no permite ninguna posición."
                .to_string(),
        );
    }

    reasons
}

/// Motivos por los que el **estado de la cuenta** no es utilizable.
fn check_account(account: &AccountState) -> Vec<String> {
    let mut reasons = Vec::new();

    if !(account.equity.is_finite() && account.equity > 0.0) {
        reasons.push(format!(
            "Equity de la cuenta inválido: equity = {} no es un número finito mayor que 0.",
            fmt_num(account.equity)
        ));
    }
    // El PnL realizado solo puede ser negativo o positivo, pero nunca no
    // finito: un `NaN` aquí haría que la comparación del kill switch fuese
    // `false` y la sesión seguiría abierta sin saber cuánto se ha perdido.
    if !account.realized_pnl_today.is_finite() {
        reasons.push(format!(
            "PnL realizado de hoy inválido: realized_pnl_today = {} no es un número finito.",
            fmt_num(account.realized_pnl_today)
        ));
    }

    reasons
}

/// Verifica una orden contra los límites y el estado de la cuenta.
///
/// Evalúa **todas** las reglas y acumula los motivos, en vez de cortar en la
/// primera: así la PWA puede mostrarle a la persona todos los ajustes que
/// necesita hacer de una vez.
///
/// Principio **fail closed**: todo número no finito (`NaN`, `inf`), negativo o
/// por debajo del mínimo permitido se rechaza, en la orden, en los límites y en
/// el estado de la cuenta. Nunca se "interpreta" un dato corrupto ni se asume
/// que vale cero: la comparación con `NaN` es `false` en Rust, así que saltarse
/// la validación dejaría pasar órdenes que no deberían firmarse.
///
/// Reglas, en orden:
///
/// 0. **Sanidad de los números:** cada campo de [`OrderIntent`],
///    [`RiskLimits`] y [`AccountState`] debe ser finito y estar dentro de
///    rango. Ver [`check_order_numbers`], [`check_limits`] y
///    [`check_account`].
/// 1. Stop loss obligatorio si [`RiskLimits::require_stop_loss`] lo exige.
/// 2. El stop loss debe estar del lado correcto de la entrada: por debajo en
///    largo, por encima en corto.
/// 3. `|entrada - stop| * cantidad` no puede superar
///    `equity * max_risk_per_trade_pct / 100`.
/// 4. El apalancamiento no puede superar [`RiskLimits::max_leverage`] (su
///    validez ya la garantiza la regla 0).
/// 5. **Kill switch diario:** si `realized_pnl_today <= -equity *
///    max_daily_loss_pct / 100` se rechazan todas las órdenes nuevas.
/// 6. `open_positions` debe ser menor que [`RiskLimits::max_open_positions`].
pub fn check_order(
    order: &OrderIntent,
    limits: &RiskLimits,
    account: &AccountState,
) -> GuardDecision {
    // 0. Sanidad de los números, en los tres objetos. Sin esto las reglas
    // siguientes compararían contra NaN y pasarían sin avisar.
    let mut reasons: Vec<String> = check_order_numbers(order);
    reasons.extend(check_limits(limits));
    reasons.extend(check_account(account));

    // 1. Stop loss obligatorio.
    if limits.require_stop_loss && order.stop_loss.is_none() {
        reasons.push(
            "Stop loss obligatorio: esta cuenta exige un stop loss en cada orden.".to_string(),
        );
    }

    // 2. Lado correcto del stop loss. Solo aplica si hay stop y si el stop ya
    // pasó la regla 0: un stop corrupto ya tiene su motivo y compararlo contra
    // una entrada no finita solo añadiría ruido.
    if let Some(sl) = order.stop_loss {
        if sl.is_finite() && sl > 0.0 && order.entry_price.is_finite() {
            if order.side.is_long() && sl >= order.entry_price {
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
    }

    // 3. Riesgo por operación dentro del tope. Solo es evaluable con stop loss.
    // Las dos magnitudes están en USDT: `equity * max_risk_per_trade_pct / 100`.
    // Si el tope no fuese utilizable la comparación se saltaría, pero en ese
    // caso la regla 0 ya ha rechazado la orden.
    if let Some(risk) = order.risk_usdt() {
        let max_risk = account.equity * (limits.max_risk_per_trade_pct / 100.0);
        if risk.is_finite() && max_risk.is_finite() && risk > max_risk {
            reasons.push(format!(
                "Riesgo por operación demasiado alto: {:.2} USDT supera el máximo de {:.2} USDT ({:.2}% de {:.2} de equity).",
                risk, max_risk, limits.max_risk_per_trade_pct, account.equity
            ));
        }
    }

    // 4. Apalancamiento. Que sea finito y >= 1 ya lo garantiza la regla 0, así
    // que aquí solo se compara contra el tope. Si el tope no es utilizable, el
    // motivo ya está en `reasons` y no se añade un segundo por la misma causa.
    if order.leverage.is_finite()
        && limits.max_leverage.is_finite()
        && order.leverage > limits.max_leverage
    {
        reasons.push(format!(
            "Apalancamiento demasiado alto: {:.2}x supera el máximo de {:.2}x.",
            order.leverage, limits.max_leverage
        ));
    }

    // 5. Kill switch diario. Bloquea todo, sea cual sea el resto.
    // UNIDADES: `max_daily_loss` y `realized_pnl_today` están los dos en USDT.
    // El porcentaje de la configuración se convierte una sola vez, aquí, a
    // USDT multiplicándolo por el equity; el motivo del rechazo nombra las dos
    // magnitudes en USDT y el porcentaje entre paréntesis, para que nadie
    // tenga que adivinar si está comparando dinero con porcentaje.
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

    // -----------------------------------------------------------------------
    // Regla 0: fail closed ante números no finitos o fuera de rango.
    //
    // Cada test de aquí pone UN campo corrupto sobre una orden que por lo
    // demás cumple todo, y comprueba que el motivo nombra ese campo. Si
    // cualquiera de ellos pasara, la orden se firmaría sin tope real.
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_nan_max_risk_per_trade_pct() {
        let mut limits = limits();
        limits.max_risk_per_trade_pct = f64::NAN;
        assert_rejected_containing(
            &long_order(),
            &limits,
            &account(),
            "max_risk_per_trade_pct = NaN",
        );
    }

    #[test]
    fn rejects_infinite_max_leverage() {
        let mut limits = limits();
        limits.max_leverage = f64::INFINITY;
        assert_rejected_containing(&long_order(), &limits, &account(), "max_leverage = inf");
    }

    #[test]
    fn rejects_nan_realized_pnl_today() {
        // El kill switch compara `pnl <= -tope`; contra NaN eso es `false`, así
        // que sin la regla 0 la sesión seguiría abierta con el PnL corrupto.
        let mut account = account();
        account.realized_pnl_today = f64::NAN;
        assert_rejected_containing(
            &long_order(),
            &limits(),
            &account,
            "realized_pnl_today = NaN",
        );
    }

    #[test]
    fn rejects_nan_stop_loss() {
        let mut order = long_order();
        order.stop_loss = Some(f64::NAN);
        assert_rejected_containing(&order, &limits(), &account(), "stop_loss = NaN");
    }

    #[test]
    fn rejects_nan_take_profit() {
        let mut order = long_order();
        order.take_profit = Some(f64::NAN);
        assert_rejected_containing(&order, &limits(), &account(), "take_profit = NaN");
    }

    #[test]
    fn rejects_nan_leverage_on_the_order() {
        let mut order = long_order();
        order.leverage = f64::NAN;
        assert_rejected_containing(&order, &limits(), &account(), "leverage = NaN");
    }

    #[test]
    fn rejects_leverage_below_one_x() {
        // 0x no abre posición en ningún exchange; 0.5x tampoco existe.
        let mut order = long_order();
        order.leverage = 0.5;
        assert_rejected_containing(&order, &limits(), &account(), "leverage = 0.5");
    }

    #[test]
    fn accepts_leverage_exactly_one_x() {
        // Frontera: 1x es el mínimo válido.
        let mut order = long_order();
        order.leverage = 1.0;
        assert_allowed(&order, &limits(), &account());
    }

    #[test]
    fn rejects_nan_equity() {
        let mut account = account();
        account.equity = f64::NAN;
        assert_rejected_containing(&long_order(), &limits(), &account, "equity = NaN");
    }

    #[test]
    fn rejects_non_positive_limit_percentages() {
        // 0 o negativo en un límite de riesgo no es "sin límite": es un tope
        // roto, y aceptarlo dejaría la orden sin la protección que la persona
        // usuaria cree haber configurado.
        for bad in [0.0, -1.0, f64::NEG_INFINITY] {
            let mut l = limits();
            l.max_risk_per_trade_pct = bad;
            assert_rejected_containing(&long_order(), &l, &account(), "max_risk_per_trade_pct");

            let mut l = limits();
            l.max_daily_loss_pct = bad;
            assert_rejected_containing(&long_order(), &l, &account(), "max_daily_loss_pct");

            let mut l = limits();
            l.max_leverage = bad;
            assert_rejected_containing(&long_order(), &l, &account(), "max_leverage");
        }
    }

    #[test]
    fn rejects_zero_max_open_positions() {
        let mut limits = limits();
        limits.max_open_positions = 0;
        assert_rejected_containing(&long_order(), &limits, &account(), "max_open_positions = 0");
    }

    #[test]
    fn invalid_limits_do_not_hide_the_other_reasons() {
        // La configuración corrupta no debe enmascarar el resto de reglas: la
        // persona tiene que ver los dos problemas de una vez.
        let mut limits = limits();
        limits.max_daily_loss_pct = f64::NAN;
        let mut order = long_order();
        order.leverage = 50.0;

        let reasons = check_order(&order, &limits, &account()).reasons().to_vec();
        assert!(reasons.iter().any(|r| r.contains("max_daily_loss_pct")));
        assert!(reasons
            .iter()
            .any(|r| r.contains("Apalancamiento demasiado alto")));
    }

    #[test]
    fn non_finite_values_never_produce_an_allow() {
        // Barrido de los once campos del contrato, uno por uno, con un objeto
        // por defecto que sí cumple. Es la versión "no me fío de un solo test"
        // del fail closed: si alguien relaja una validación, este test salta.

        // Campos f64, en el orden en que los asigna `corrupt`.
        const F64_FIELDS: usize = 10;

        // Devuelve un orden, sus límites y su cuenta con el campo `field`
        // (0..F64_FIELDS) puesto a `value`; el 10 es `max_open_positions`.
        let corrupt = |field: usize, value: f64| -> (OrderIntent, RiskLimits, AccountState) {
            let mut order = long_order();
            let mut limits = limits();
            let mut account = account();
            match field {
                0 => order.entry_price = value,
                1 => order.quantity = value,
                2 => order.leverage = value,
                3 => order.stop_loss = Some(value),
                4 => order.take_profit = Some(value),
                5 => limits.max_risk_per_trade_pct = value,
                6 => limits.max_daily_loss_pct = value,
                7 => limits.max_leverage = value,
                8 => account.equity = value,
                9 => account.realized_pnl_today = value,
                10 => limits.max_open_positions = value as usize,
                _ => unreachable!("campo fuera de rango"),
            }
            (order, limits, account)
        };

        // `NaN` e infinitos no son un número en ningún campo.
        for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for field in 0..F64_FIELDS {
                let (order, limits, account) = corrupt(field, v);
                assert!(
                    !check_order(&order, &limits, &account).is_allowed(),
                    "campo {field} con valor {v} pasó el filtro: {:?}",
                    check_order(&order, &limits, &account).reasons()
                );
            }
        }

        // Negativo y cero: válidos en ningún campo salvo en
        // `realized_pnl_today`, donde un PnL negativo es precisamente un día
        // en pérdidas y no un dato corrupto (lo cubre el kill switch, que sí
        // lo bloquea cuando supera el tope).
        for v in [-1.0, 0.0] {
            for field in 0..F64_FIELDS - 1 {
                let (order, limits, account) = corrupt(field, v);
                assert!(
                    !check_order(&order, &limits, &account).is_allowed(),
                    "campo {field} con valor {v} pasó el filtro: {:?}",
                    check_order(&order, &limits, &account).reasons()
                );
            }
        }

        // `max_open_positions` es el único entero: 0 slots es inválido.
        let (order, limits, account) = corrupt(10, 0.0);
        assert!(!check_order(&order, &limits, &account).is_allowed());
    }

    // -----------------------------------------------------------------------
    // Contrato con JavaScript: los campos se reciben en camelCase.
    // -----------------------------------------------------------------------

    #[test]
    fn deserializes_order_from_camel_case_json() {
        // Es lo que llega de la PWA a través de `check_order` en wasm.rs.
        let order: OrderIntent = serde_json::from_str(
            r#"{
                "symbol": "BTCUSDT",
                "side": "long",
                "entryPrice": 100.0,
                "stopLoss": 95.0,
                "takeProfit": 110.0,
                "quantity": 1.0,
                "leverage": 5.0
            }"#,
        )
        .expect("OrderIntent debe aceptar camelCase");

        assert_eq!(order.entry_price, 100.0);
        assert_eq!(order.stop_loss, Some(95.0));
        assert_eq!(order.take_profit, Some(110.0));
        assert_eq!(order.leverage, 5.0);
        assert_eq!(order.side, Side::Long);
    }

    #[test]
    fn deserializes_limits_and_account_from_camel_case_json() {
        let limits: RiskLimits = serde_json::from_str(
            r#"{
                "maxRiskPerTradePct": 2.0,
                "maxDailyLossPct": 5.0,
                "maxLeverage": 10.0,
                "requireStopLoss": true,
                "maxOpenPositions": 3
            }"#,
        )
        .expect("RiskLimits debe aceptar camelCase");
        assert_eq!(limits.max_risk_per_trade_pct, 2.0);
        assert_eq!(limits.max_daily_loss_pct, 5.0);
        assert_eq!(limits.max_leverage, 10.0);
        assert!(limits.require_stop_loss);
        assert_eq!(limits.max_open_positions, 3);

        let account: AccountState = serde_json::from_str(
            r#"{
                "equity": 1000.0,
                "realizedPnlToday": -12.5,
                "openPositions": 1
            }"#,
        )
        .expect("AccountState debe aceptar camelCase");
        assert_eq!(account.equity, 1000.0);
        assert_eq!(account.realized_pnl_today, -12.5);
        assert_eq!(account.open_positions, 1);
    }

    #[test]
    fn serializes_to_camel_case_for_javascript() {
        // La respuesta de `check_order` viaja por el mismo contrato, así que la
        // salida también es camelCase.
        let json = serde_json::to_value(long_order()).expect("OrderIntent serializa");
        assert!(json.get("entryPrice").is_some(), "{json}");
        assert!(json.get("stopLoss").is_some(), "{json}");
        assert!(json.get("takeProfit").is_some(), "{json}");
        assert!(json.get("entry_price").is_none(), "{json}");
    }

    #[test]
    fn a_camel_case_order_passes_the_same_rules() {
        // El camino real de la PWA termina en check_order: el mismo veredicto.
        let order: OrderIntent = serde_json::from_str(
            r#"{
                "symbol": "BTCUSDT",
                "side": "long",
                "entryPrice": 100.0,
                "stopLoss": 95.0,
                "takeProfit": 110.0,
                "quantity": 1.0,
                "leverage": 5.0
            }"#,
        )
        .expect("OrderIntent debe aceptar camelCase");
        assert_allowed(&order, &limits(), &account());
    }
}
