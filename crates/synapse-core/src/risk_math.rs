//! Utilidades de aritmética de riesgo.
//!
//! Puerto *puro* de `backend/src/application/services/risk_math.rs`. No hay
//! I/O, no hay estado global, no hay dependencias de la crate privada: solo
//! `f64` y `Option<f64>` para representar los casos no definidos.

/// Distancia entre entrada y stop-loss.
#[inline]
pub fn stop_distance(entry: f64, stop_loss: f64) -> f64 {
    (entry - stop_loss).abs()
}

/// Calcula la cantidad de posición a partir de un presupuesto de riesgo y la
/// distancia al stop.
///
/// - `balance`: equity actual
/// - `risk_pct`: porcentaje del equity que se acepta perder si se toca el stop
/// - `entry`: precio de entrada
/// - `stop_loss`: precio del stop-loss
/// - `fee_slip_buffer`: distancia extra de precio para buffer de comisiones y
///   slippage (mismas unidades que el precio)
///
/// Devuelve `None` si algún valor no es finito, si el balance o el riesgo no
/// son positivos, o si la distancia efectiva es cero.
pub fn qty_from_stop_risk(
    balance: f64,
    risk_pct: f64,
    entry: f64,
    stop_loss: f64,
    fee_slip_buffer: f64,
) -> Option<f64> {
    if !(balance.is_finite() && risk_pct.is_finite() && entry.is_finite() && stop_loss.is_finite())
    {
        return None;
    }
    if balance <= 0.0 || risk_pct <= 0.0 || entry <= 0.0 {
        return None;
    }

    let dist = stop_distance(entry, stop_loss);
    let denom = dist + fee_slip_buffer.max(0.0);
    if denom <= 0.0 {
        return None;
    }

    let risk_usd = balance * (risk_pct / 100.0);
    if risk_usd <= 0.0 {
        return None;
    }

    Some(risk_usd / denom)
}

/// Limita la cantidad por un límite de nocional.
pub fn cap_qty_by_max_notional(qty: f64, entry: f64, max_notional: f64) -> f64 {
    if !(qty.is_finite() && entry.is_finite() && max_notional.is_finite()) {
        return 0.0;
    }
    if qty <= 0.0 || entry <= 0.0 || max_notional <= 0.0 {
        return 0.0;
    }

    let notional = qty * entry;
    if notional <= max_notional {
        qty
    } else {
        max_notional / entry
    }
}

/// Garantiza que la cantidad alcance un nocional mínimo (p. ej. los 5 USD de
/// Binance).
///
/// Si `qty * entry < min_notional` y `balance >= min_notional`, devuelve una
/// cantidad ajustada al mínimo. Si el balance no alcanza, devuelve `None`. Si ya
/// cumple, devuelve la cantidad original.
pub fn ensure_min_notional(qty: f64, entry: f64, min_notional: f64, balance: f64) -> Option<f64> {
    if !(qty.is_finite() && entry.is_finite() && min_notional.is_finite() && balance.is_finite()) {
        return None;
    }
    if qty <= 0.0 || entry <= 0.0 {
        return None;
    }

    let current_notional = qty * entry;

    if current_notional >= min_notional {
        return Some(qty);
    }

    if balance < min_notional {
        return None;
    }

    Some(min_notional / entry)
}

/// R-múltiple: PnL realizado dividido por el riesgo inicial del stop.
pub fn r_multiple(
    pnl: f64,
    entry: f64,
    stop_loss: f64,
    qty: f64,
    fee_slip_buffer: f64,
) -> Option<f64> {
    if !(pnl.is_finite() && entry.is_finite() && stop_loss.is_finite() && qty.is_finite()) {
        return None;
    }
    if qty <= 0.0 || entry <= 0.0 {
        return None;
    }
    let dist = stop_distance(entry, stop_loss);
    let risk = (dist + fee_slip_buffer.max(0.0)) * qty;
    if risk <= 0.0 {
        return None;
    }
    Some(pnl / risk)
}

/// Media posterior de un modelo Beta-Binomial con prior Beta(alpha, beta).
pub fn beta_posterior_mean(alpha: f64, beta: f64, wins: u32, losses: u32) -> Option<f64> {
    if !(alpha.is_finite() && beta.is_finite()) {
        return None;
    }
    if alpha <= 0.0 || beta <= 0.0 {
        return None;
    }
    let a = alpha + wins as f64;
    let b = beta + losses as f64;
    Some(a / (a + b))
}

/// Valor esperado en unidades R.
///
/// - `p_win`: probabilidad de acierto
/// - `avg_win_r`: R positivo medio
/// - `avg_loss_r`: R negativo absoluto medio (número positivo, suele ser ~1.0)
pub fn expected_r(p_win: f64, avg_win_r: f64, avg_loss_r: f64) -> Option<f64> {
    if !(p_win.is_finite() && avg_win_r.is_finite() && avg_loss_r.is_finite()) {
        return None;
    }
    if !(0.0..=1.0).contains(&p_win) {
        return None;
    }
    if avg_win_r < 0.0 || avg_loss_r < 0.0 {
        return None;
    }
    Some(p_win * avg_win_r - (1.0 - p_win) * avg_loss_r)
}

/// Estimación robusta y pequeña del riesgo de cola a partir de R-múltiples
/// recientes: la media de la fracción `tail_frac` más mala de la muestra.
pub fn tail_mean_r(recent_r: &[f64], tail_frac: f64) -> Option<f64> {
    if recent_r.is_empty() {
        return None;
    }
    if !(tail_frac.is_finite()) || tail_frac <= 0.0 || tail_frac > 1.0 {
        return None;
    }
    let mut vals: Vec<f64> = recent_r.iter().copied().filter(|v| v.is_finite()).collect();
    if vals.is_empty() {
        return None;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let k = ((vals.len() as f64) * tail_frac).ceil() as usize;
    let k = k.max(1).min(vals.len());
    let slice = &vals[..k];
    Some(slice.iter().sum::<f64>() / slice.len() as f64)
}

/// Objetivo de volatilidad diaria para el ajuste dinámico de apalancamiento.
const TARGET_VOL: f64 = 0.02;

/// Ajuste dinámico de apalancamiento según la volatilidad del mercado.
///
/// Reduce el apalancamiento en alta volatilidad y lo sube en baja volatilidad,
/// apuntando a una volatilidad diaria constante del 2%.
///
/// - `atr_pct`: ATR como fracción del precio (p. ej. `0.02` = 2%)
/// - `base_leverage`: apalancamiento base configurado
/// - `max_leverage`: apalancamiento máximo permitido
/// - `min_leverage`: apalancamiento mínimo permitido
///
/// Fórmula: `(base_leverage * 0.02 / atr_pct).clamp(min_leverage, max_leverage)`
///
/// # Configuración inválida
///
/// Cualquier entrada no finita, o un `atr_pct`/`base_leverage` no positivo,
/// devuelve `min_leverage`: es el mismo suelo que se aplica cuando no se puede
/// calcular el valor, y es el lado conservador porque nunca devuelve más
/// apalancamiento del pedido en un mercado que no se puede medir.
///
/// Los límites invertidos (`min_leverage > max_leverage`) también devuelven
/// `min_leverage`. `f64::clamp` entra en pánico si `min > max`, así que la
/// función **no puede** delegar el recorte en él sin comprobarlo antes. Sin ese
/// chequeo, un par de límites mal configurado (por ejemplo `min = 10`,
/// `max = 1`) abortaba el hilo: en WASM, la pestaña entera.
#[inline]
pub fn calc_dynamic_leverage(
    atr_pct: f64,
    base_leverage: f64,
    max_leverage: f64,
    min_leverage: f64,
) -> f64 {
    if !(atr_pct.is_finite()
        && base_leverage.is_finite()
        && max_leverage.is_finite()
        && min_leverage.is_finite())
    {
        return min_leverage;
    }
    if atr_pct <= 0.0 || base_leverage <= 0.0 {
        return min_leverage;
    }
    // `f64::clamp` hace `assert!(min <= max)`: con los límites al revés el
    // pánico es inmediato. Se decide aquí, antes de recortar.
    if min_leverage > max_leverage {
        return min_leverage;
    }

    let raw = base_leverage * TARGET_VOL / atr_pct;
    raw.clamp(min_leverage, max_leverage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qty_from_stop_risk_basic() {
        // balance=1000, risk=1% => 10 USD risk
        // stop dist=10 => qty ~ 1
        let qty = qty_from_stop_risk(1000.0, 1.0, 100.0, 90.0, 0.0).unwrap();
        assert!((qty - 1.0).abs() < 1e-9);
    }

    #[test]
    fn cap_qty_by_notional() {
        // max notional 1000, entry 100 => max qty 10
        let capped = cap_qty_by_max_notional(100.0, 100.0, 1000.0);
        assert!((capped - 10.0).abs() < 1e-9);
    }

    #[test]
    fn r_multiple_basic() {
        // entry 100, stop 90, qty 1 => risk 10
        // pnl 5 => R=0.5
        let r = r_multiple(5.0, 100.0, 90.0, 1.0, 0.0).unwrap();
        assert!((r - 0.5).abs() < 1e-9);
    }

    #[test]
    fn beta_mean() {
        let p = beta_posterior_mean(2.0, 2.0, 3, 1).unwrap();
        // (2+3)/(2+2+3+1)=5/8
        assert!((p - 0.625).abs() < 1e-12);
    }

    #[test]
    fn expected_r_math() {
        let ev = expected_r(0.55, 1.2, 1.0).unwrap();
        assert!((ev - (0.55 * 1.2 - 0.45 * 1.0)).abs() < 1e-12);
    }

    #[test]
    fn tail_mean_r_worst_quintile() {
        let r = vec![1.0, 0.5, -1.0, -0.5, 2.0];
        let tm = tail_mean_r(&r, 0.2).unwrap();
        // worst 20% => 1 value => -1.0
        assert!((tm + 1.0).abs() < 1e-12);
    }

    // -----------------------------------------------------------------------
    // calc_dynamic_leverage
    // -----------------------------------------------------------------------

    #[test]
    fn normal_volatility() {
        // atr=2%, base=3x => 3 * 0.02 / 0.02 = 3
        let lev = calc_dynamic_leverage(0.02, 3.0, 10.0, 1.0);
        assert!((lev - 3.0).abs() < 1e-12, "expected 3.0, got {lev}");
    }

    #[test]
    fn high_volatility() {
        // atr=4%, base=3x => 3 * 0.02 / 0.04 = 1.5
        let lev = calc_dynamic_leverage(0.04, 3.0, 10.0, 1.0);
        assert!((lev - 1.5).abs() < 1e-12, "expected 1.5, got {lev}");
    }

    #[test]
    fn low_volatility() {
        // atr=1%, base=3x => 3 * 0.02 / 0.01 = 6, max=10 => 6
        let lev = calc_dynamic_leverage(0.01, 3.0, 10.0, 1.0);
        assert!((lev - 6.0).abs() < 1e-12, "expected 6.0, got {lev}");
    }

    #[test]
    fn low_volatility_clamp_to_max() {
        // atr=0.5%, base=3x => 3 * 0.02 / 0.005 = 12, max=10 => 10
        let lev = calc_dynamic_leverage(0.005, 3.0, 10.0, 1.0);
        assert!((lev - 10.0).abs() < 1e-12, "expected 10.0, got {lev}");
    }

    #[test]
    fn zero_atr_returns_min() {
        let lev = calc_dynamic_leverage(0.0, 3.0, 10.0, 1.0);
        assert!((lev - 1.0).abs() < 1e-12, "expected 1.0, got {lev}");
    }

    #[test]
    fn negative_atr_returns_min() {
        let lev = calc_dynamic_leverage(-0.01, 3.0, 10.0, 1.0);
        assert!((lev - 1.0).abs() < 1e-12, "expected 1.0, got {lev}");
    }

    #[test]
    fn non_finite_atr_returns_min() {
        let lev = calc_dynamic_leverage(f64::NAN, 3.0, 10.0, 1.0);
        assert!((lev - 1.0).abs() < 1e-12, "expected 1.0, got {lev}");
    }

    #[test]
    fn zero_base_leverage_returns_min() {
        let lev = calc_dynamic_leverage(0.02, 0.0, 10.0, 1.0);
        assert!((lev - 1.0).abs() < 1e-12, "expected 1.0, got {lev}");
    }

    #[test]
    fn clamp_to_min_when_raw_below_min() {
        // atr=10%, base=3x => 3 * 0.02 / 0.10 = 0.6, min=1.0 => 1.0
        let lev = calc_dynamic_leverage(0.10, 3.0, 10.0, 1.0);
        assert!((lev - 1.0).abs() < 1e-12, "expected 1.0, got {lev}");
    }

    #[test]
    fn preserves_fractional_result() {
        // atr=2.5%, base=5x => 5 * 0.02 / 0.025 = 4.0
        let lev = calc_dynamic_leverage(0.025, 5.0, 10.0, 1.0);
        assert!((lev - 4.0).abs() < 1e-12, "expected 4.0, got {lev}");
    }

    #[test]
    fn inverted_bounds_do_not_panic_and_return_min() {
        // `f64::clamp` hace `assert!(min <= max)`: con min > max entraba en
        // pánico y abortaba el hilo (en WASM, la pestaña entera).
        let lev = calc_dynamic_leverage(0.02, 3.0, 1.0, 10.0);
        assert!(
            (lev - 10.0).abs() < 1e-12,
            "expected min_leverage 10.0, got {lev}"
        );
    }

    #[test]
    fn inverted_bounds_are_safe_on_every_atr() {
        // El mismo par de límites invertidos con cualquier volatilidad: tiene
        // que devolver siempre el suelo, nunca entrar en pánico.
        for atr in [0.001, 0.005, 0.02, 0.1, 0.5, 1.0, 10.0, 1000.0] {
            let lev = calc_dynamic_leverage(atr, 5.0, 1.0, 10.0);
            assert!(
                (lev - 10.0).abs() < 1e-12,
                "atr {atr}: expected 10.0, got {lev}"
            );
        }
    }

    #[test]
    fn equal_bounds_do_not_panic() {
        // min == max es legal para `clamp` y deja un único valor posible.
        let lev = calc_dynamic_leverage(0.02, 3.0, 4.0, 4.0);
        assert!((lev - 4.0).abs() < 1e-12, "expected 4.0, got {lev}");
    }

    #[test]
    fn inverted_bounds_with_non_finite_atr_still_return_min() {
        // El chequeo de límites invertidos no puede alterar la salida de las
        // rutas ya tratadas: NaN sigue devolviendo min_leverage.
        let lev = calc_dynamic_leverage(f64::NAN, 3.0, 1.0, 10.0);
        assert!((lev - 10.0).abs() < 1e-12, "expected 10.0, got {lev}");
    }
}
