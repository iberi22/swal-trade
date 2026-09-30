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

/// Devuelve `v` si es finito, y `0.0` si no.
///
/// Para los campos que el plan **muestra** (no los que usa para decidir). Un
/// `NaN` en un campo de salida acaba en la PWA como un hueco silencioso, y un
/// `inf` como un número imposible; el motivo del bloqueo ya está en `warnings`.
fn finite_or_zero(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
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

    /// Problemas de la configuración del dimensionador, en texto.
    ///
    /// Cada uno de estos números es un multiplicador o un divisor del cálculo
    /// de riesgo, así que un valor roto no produce un plan "sin tope": produce
    /// un plan cuyo riesgo no se puede conocer. Se devuelven como motivos
    /// legible en vez de como `Result` para que la PWA los muestre junto al
    /// resto de advertencias del plan.
    fn config_problems(&self) -> Vec<String> {
        let mut problems = Vec::new();

        // 0x no abre posición y hace que `100.0 / leverage` sea infinito, lo
        // que dejaría el stop loss "seguro" en infinito y el riesgo en 0.
        if self.leverage == 0 {
            problems.push("leverage = 0 (the minimum is 1)".to_string());
        }
        for (name, value) in [
            ("max_risk_pct", self.max_risk_pct),
            ("stop_loss_pct", self.stop_loss_pct),
            ("take_profit_pct", self.take_profit_pct),
        ] {
            if !(value.is_finite() && value > 0.0) {
                problems.push(format!("{name} = {value} is not a finite positive number"));
            }
        }
        if let Some(cap) = self.max_margin_per_order_usdt {
            if !(cap.is_finite() && cap > 0.0) {
                problems.push(format!(
                    "max_margin_per_order_usdt = {cap} is not a finite positive number"
                ));
            }
        }
        problems
    }

    /// Calcula el plan de sesión a partir del balance actual.
    ///
    /// # Fail closed
    ///
    /// Si algún número de entrada o de la configuración no es utilizable —no
    /// finito, negativo, o `0` en `leverage`— el plan sale **inactivo y con
    /// tamaño 0**, con el motivo en `warnings`. No se "interpreta" el dato ni
    /// se asume que vale cero: comparar contra `NaN` devuelve `false` en Rust,
    /// así que saltarse la validación devolvería un plan con tamaños plausibles
    /// y riesgo real desconocido.
    ///
    /// # Guardia de volatilidad
    ///
    /// Con `market_volatility` por encima de [`VOLATILITY_THRESHOLD`] el tamaño
    /// se reduce progresivamente; en [`VOLATILITY_MAX`] o más, se bloquea todo.
    /// Una volatilidad no finita o negativa es "volatilidad desconocida", que
    /// es el peor caso: se trata como [`VOLATILITY_MAX`].
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

        // 0. Números de entrada y configuración no utilizables: el plan se
        // bloquea entero. Se comprueba antes de la aritmética para que ningún
        // `NaN` llegue ni al rationale ni a los campos del plan.
        let config_problems = self.config_problems();
        let input_problems = [
            ("total_balance", total_balance, total_balance >= 0.0),
            ("unrealized_pnl", unrealized_pnl, true),
            ("used_margin", used_margin, used_margin >= 0.0),
        ]
        .into_iter()
        .filter(|(_, v, sign_ok)| !(v.is_finite() && *sign_ok))
        .map(|(name, v, _)| format!("{name} = {v} is not a usable number"))
        .collect::<Vec<String>>();

        let mut invalid_inputs = config_problems;
        invalid_inputs.extend(input_problems);
        let hard_block = !invalid_inputs.is_empty();
        for problem in &invalid_inputs {
            warnings.push(format!("⛔ INVALID INPUT: {problem} - plan blocked"));
            rationale.push(format!("Blocked: {problem}"));
        }

        // 0b. Guardia de volatilidad. Un valor no finito o negativo no es
        // "volatilidad baja": es volatilidad desconocida, y se trata como el
        // extremo. Antes `NaN >= 1.0` y `NaN > 0.5` eran `false`, así que el
        // NaN caía en la rama de "volatilidad segura" y devolvía el tamaño
        // completo: fail open con el feed roto.
        //
        // El multiplicador se anula también si la entrada o la configuración no
        // eran utilizables: con `max_risk_pct` en `NaN` la comparación del paso
        // 6 (`riesgo > NaN`) es `false`, así que el topado de riesgo no se
        // aplicaría y el plan saldría con el tamaño sin topar.
        let volatility_usable = market_volatility.is_finite() && market_volatility >= 0.0;
        let volatility_multiplier = if hard_block {
            // Ya avisado en el paso 0, no hace falta un segundo motivo aquí.
            0.0
        } else if !volatility_usable {
            warnings.push(format!(
                "⛔ INVALID VOLATILITY: market_volatility = {market_volatility} is not a usable number: all positions BLOCKED"
            ));
            rationale.push(format!(
                "Volatility {market_volatility} is not a usable number: treated as the extreme case, position size set to 0"
            ));
            0.0
        } else if market_volatility >= VOLATILITY_MAX {
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

        // 4b. Guardia de volatilidad sobre el tamaño. Con la volatilidad no
        // utilizable o con el plan ya bloqueado por la entrada, el motivo
        // está en el paso 0, así que aquí no se repite con un `NaN` dentro
        // del texto.
        if volatility_multiplier < 1.0 {
            let original_size = base_position_size;
            base_position_size *= volatility_multiplier;
            if volatility_usable && !hard_block {
                warnings.push(format!(
                    "⚠️ VOLATILITY GUARD: Position size reduced from ${:.2} -> ${:.2} (volatility: {:.1}%)",
                    original_size, base_position_size, market_volatility * 100.0
                ));
            }
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
        //
        // `max_risk_usdt` se calcula una vez y se reutiliza en el paso 7: es el
        // presupuesto de riesgo real (nocional x SL%) que la operación puede
        // consumir, en USDT.
        let max_risk_usdt = (equity * (self.max_risk_pct / 100.0)).max(0.0);
        let position_size_usdt = if risk_per_trade_pct > self.max_risk_pct {
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
            adjusted_size
        } else {
            base_position_size
        };

        // 7. Tamaño mínimo.
        //
        // El exchange no acepta órdenes por debajo de MIN_POSITION_SIZE_USDT,
        // así que hay que subir hasta ahí… pero SOLO si subir no rompe ninguna
        // de las tres cosas que el tamaño tiene que respetar: el tope de
        // riesgo, el tope de margen por orden y el balance disponible. Subir a
        // ciegas convertía un topado de $0,40 en una orden de $1,00 que
        // arriesga 2,5 veces lo permitido: el dimensionador dejaba de ser
        // conservador para fabricar una orden inenviable.
        //
        // Cuando la subida no cabe, no se sube: el plan sale con tamaño 0 y el
        // motivo en `warnings`. Preferimos no operar a operar con más riesgo
        // del que la persona usuaria autorizó, y el caso real es una cuenta
        // tan pequeña que ni la orden mínima le sale rentable.
        let final_position_size = if position_size_usdt >= MIN_POSITION_SIZE_USDT {
            position_size_usdt
        } else if position_size_usdt <= 0.0 {
            // No hay nada que subir: o no hay slots, o no hay balance, o la
            // volatilidad ya lo dejó a cero.
            0.0
        } else {
            // Riesgo real (nocional x SL%) que arrastraría la orden mínima.
            let min_risk_usdt =
                MIN_POSITION_SIZE_USDT * self.leverage as f64 * (self.stop_loss_pct / 100.0);
            let margin_cap = self.max_margin_per_order_usdt.unwrap_or(f64::INFINITY);

            let blocked_by = if min_risk_usdt > max_risk_usdt {
                Some(format!(
                    "el tamaño mínimo del exchange supera el riesgo permitido (${:.2} de margen arriesgarían ${:.2} y el tope es ${:.2})",
                    MIN_POSITION_SIZE_USDT, min_risk_usdt, max_risk_usdt
                ))
            } else if MIN_POSITION_SIZE_USDT > margin_cap {
                Some(format!(
                    "el tamaño mínimo del exchange supera el tope de margen por orden (${:.2} > ${:.2})",
                    MIN_POSITION_SIZE_USDT, margin_cap
                ))
            } else if MIN_POSITION_SIZE_USDT > available_balance {
                Some(format!(
                    "el tamaño mínimo del exchange supera el balance disponible (${:.2} > ${:.2})",
                    MIN_POSITION_SIZE_USDT, available_balance
                ))
            } else {
                None
            };

            match blocked_by {
                Some(reason) => {
                    warnings.push(format!(
                        "⛔ MINIMUM ORDER NOT TRADABLE: {reason}: position blocked at $0.00"
                    ));
                    warnings.push(format!(
                        "Position size ${:.2} below minimum ${:.2}",
                        position_size_usdt, MIN_POSITION_SIZE_USDT
                    ));
                    // El motivo concreto (riesgo, margen o balance), no siempre el riesgo.
                    rationale.push(format!(
                        "Minimum order not tradable ({reason}): position size set to 0"
                    ));
                    0.0
                }
                None => {
                    warnings.push(format!(
                        "Position size ${:.2} below minimum ${:.2}",
                        position_size_usdt, MIN_POSITION_SIZE_USDT
                    ));
                    MIN_POSITION_SIZE_USDT
                }
            }
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
        //
        // Se calcula sobre el tamaño FINAL, después de la subida al mínimo del
        // exchange, y el porcentaje se deriva de aquí. Antes el
        // `risk_per_trade_pct` venía del paso 6, es decir, de antes de esa
        // subida: el plan podía reportar 0,4% de riesgo y llevar una posición
        // que arriesgaba el triple. Un plan bloqueado reporta 0 y 0.
        let final_risk_usdt =
            final_position_size * self.leverage as f64 * (max_stop_loss_pct / 100.0);
        let risk_per_trade_pct = if equity > 0.0 {
            (final_risk_usdt / equity) * 100.0
        } else {
            0.0
        };
        rationale.push(format!(
            "Risk per trade: ${:.2} ({:.2}% of equity)",
            final_risk_usdt, risk_per_trade_pct
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
            // Se devuelven solo si son finitos: con una entrada corrupta el
            // plan va bloqueado (tamaño 0, inactivo) y estos dos campos son
            // los que la PWA pinta como "saldo" y "reserva". Un `NaN` ahí se
            // vería como "—" sin explicación, y un `inf` rompería el cálculo
            // del siguiente plan.
            total_balance: finite_or_zero(total_balance),
            reserved_balance: finite_or_zero(reserved_balance),
            available_balance,
            max_positions,
            current_positions: current_open_positions,
            remaining_slots,
            position_size_usdt: final_position_size,
            position_notional,
            leverage: self.leverage,
            max_stop_loss_pct,
            risk_per_trade_usdt: final_risk_usdt,
            risk_per_trade_pct,
            symbol_configs: HashMap::new(),
            rationale,
            warnings,
            is_active: remaining_slots > 0 && final_position_size >= MIN_POSITION_SIZE_USDT,
        }
    }

    /// Calcula la configuración de posición de un símbolo concreto.
    ///
    /// # Errores
    ///
    /// Falla si `current_price` no es un precio utilizable. Antes dividía
    /// directamente, y con `0` daba `inf`, con `NaN` daba `NaN` y con un
    /// precio negativo daba una cantidad negativa: los tres llegaban a la PWA
    /// como una configuración de posición aparentemente válida. Aquí el
    /// `Err` es explícito para que quien llame no pueda ignorarlo.
    pub fn calculate_symbol_config(
        &self,
        plan: &TradingSessionPlan,
        symbol: &str,
        current_price: f64,
    ) -> Result<SymbolPositionConfig, String> {
        if !(current_price.is_finite() && current_price > 0.0) {
            return Err(format!(
                "Invalid current_price for {symbol}: {current_price} (expected a finite positive price)"
            ));
        }
        // El nocional del plan también tiene que ser utilizable: un plan con
        // `NaN` no se puede convertir en cantidad.
        if !plan.position_notional.is_finite() {
            return Err(format!(
                "Invalid plan position_notional: {} (expected a finite USDT amount)",
                plan.position_notional
            ));
        }

        let quantity = plan.position_notional / current_price;

        let sl_distance = current_price * (plan.max_stop_loss_pct / 100.0);
        let tp_distance = current_price * (self.take_profit_pct / 100.0);

        Ok(SymbolPositionConfig {
            symbol: symbol.to_string(),
            current_price,
            quantity,
            stop_loss_price_long: current_price - sl_distance,
            stop_loss_price_short: current_price + sl_distance,
            take_profit_price_long: current_price + tp_distance,
            take_profit_price_short: current_price - tp_distance,
            max_loss_usdt: plan.risk_per_trade_usdt,
        })
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
        let config = sizer
            .calculate_symbol_config(&plan, "BTCUSDT", 95000.0)
            .expect("precio válido");

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

    // -----------------------------------------------------------------------
    // Fail closed: la volatilidad no utilizable no es "volatilidad baja".
    // -----------------------------------------------------------------------

    #[test]
    fn non_finite_volatility_blocks_the_plan() {
        // Antes `NaN >= 1.0` y `NaN > 0.5` eran `false`: el NaN caía en la
        // rama de "volatilidad segura" y devolvía el tamaño completo.
        let sizer = PositionSizer::new("Feed", false, 10, 2.0, 4.0);
        let healthy = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.10);

        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1] {
            let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, bad);
            assert_eq!(
                plan.position_size_usdt, 0.0,
                "volatility {bad} must block the plan, got {}",
                plan.position_size_usdt
            );
            assert_eq!(plan.position_notional, 0.0, "volatility {bad}");
            assert!(
                !plan.is_active,
                "volatility {bad} must leave the plan inactive"
            );
            assert!(
                plan.warnings
                    .iter()
                    .any(|w| w.contains("INVALID VOLATILITY")),
                "volatility {bad}: {:?}",
                plan.warnings
            );
            // Todos los números que la PWA usa para decidir tienen que ser
            // finitos y cero: el bloqueo es total, no parcial.
            assert_eq!(plan.position_size_usdt, 0.0, "volatility {bad}");
            assert_eq!(plan.position_notional, 0.0, "volatility {bad}");
            assert_eq!(plan.risk_per_trade_usdt, 0.0, "volatility {bad}");
            assert_eq!(plan.risk_per_trade_pct, 0.0, "volatility {bad}");
            assert!(plan.max_stop_loss_pct.is_finite(), "volatility {bad}");
            let (can, _reason) = can_execute_trade(&plan, 0);
            assert!(!can, "volatility {bad} must not allow trading");
        }

        // Y el plan sano sigue igual que antes del cambio.
        assert!(healthy.position_size_usdt > 0.0);
        assert!(healthy.is_active);
    }

    #[test]
    fn zero_volatility_is_still_the_healthy_case() {
        // Frontera: 0% de volatilidad es un dato válido y medible.
        let sizer = PositionSizer::new("Calm", false, 10, 2.0, 4.0);
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);
        assert!(plan.position_size_usdt > 0.0);
        assert!(plan.is_active);
        assert!(!plan.warnings.iter().any(|w| w.contains("INVALID")));
    }

    #[test]
    fn invalid_configuration_blocks_the_plan() {
        // Mismo criterio para la configuración: `max_risk_pct` en `NaN` hace
        // que el topado de riesgo no se aplique, así que el plan tiene que
        // salir bloqueado, no "sin tope".
        let cases: Vec<(PositionSizer, &str)> = vec![
            (
                PositionSizer::new("ZeroLev", false, 0, 2.0, 4.0),
                "leverage = 0",
            ),
            (
                PositionSizer::new("NaNRisk", false, 10, 2.0, 4.0).with_max_risk_pct(f64::NAN),
                "max_risk_pct",
            ),
            (
                PositionSizer::new("NegRisk", false, 10, 2.0, 4.0).with_max_risk_pct(-1.0),
                "max_risk_pct",
            ),
            (
                PositionSizer::new("NaNSl", false, 10, f64::NAN, 4.0),
                "stop_loss_pct",
            ),
            (
                PositionSizer::new("NaNTp", false, 10, 2.0, f64::NAN),
                "take_profit_pct",
            ),
            (
                PositionSizer::new("NaNCap", false, 10, 2.0, 4.0)
                    .with_max_margin_per_order(Some(f64::NAN)),
                "max_margin_per_order_usdt",
            ),
        ];

        for (sizer, needle) in cases {
            let plan = sizer.calculate_session_plan(10_000.0, 0, 0.0, 0.0, 0.0);
            assert_eq!(
                plan.position_size_usdt, 0.0,
                "{needle}: got {}",
                plan.position_size_usdt
            );
            assert!(!plan.is_active, "{needle}");
            assert!(
                plan.warnings
                    .iter()
                    .any(|w| w.contains("INVALID INPUT") && w.contains(needle)),
                "{needle}: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn invalid_account_input_blocks_the_plan() {
        let sizer = PositionSizer::new("Acct", false, 10, 2.0, 4.0);

        for (balance, pnl, margin, needle) in [
            (f64::NAN, 0.0, 0.0, "total_balance"),
            (-100.0, 0.0, 0.0, "total_balance"),
            (1000.0, f64::NAN, 0.0, "unrealized_pnl"),
            (1000.0, f64::INFINITY, 0.0, "unrealized_pnl"),
            (1000.0, 0.0, f64::NAN, "used_margin"),
            (1000.0, 0.0, -5.0, "used_margin"),
        ] {
            let plan = sizer.calculate_session_plan(balance, 0, pnl, margin, 0.0);
            assert_eq!(plan.position_size_usdt, 0.0, "{needle}");
            assert!(!plan.is_active, "{needle}");
            // Los saldos que la PWA pinta no pueden ser NaN ni inf.
            assert!(plan.total_balance.is_finite(), "{needle}");
            assert!(plan.reserved_balance.is_finite(), "{needle}");
            assert!(plan.available_balance.is_finite(), "{needle}");
            assert!(plan.risk_per_trade_usdt.is_finite(), "{needle}");
            assert!(plan.risk_per_trade_pct.is_finite(), "{needle}");
            assert!(
                plan.warnings
                    .iter()
                    .any(|w| w.contains("INVALID INPUT") && w.contains(needle)),
                "{needle}: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn blocked_plan_reports_zero_risk() {
        // Un plan bloqueado tiene que reportar 0 de riesgo en las dos unidades,
        // no el riesgo del tamaño que NO se va a abrir.
        let sizer = PositionSizer::new("NaNRisk", false, 10, 2.0, 4.0).with_max_risk_pct(f64::NAN);
        let plan = sizer.calculate_session_plan(10_000.0, 0, 0.0, 0.0, 0.0);
        assert_eq!(plan.risk_per_trade_usdt, 0.0);
        assert_eq!(plan.risk_per_trade_pct, 0.0);
        assert_eq!(plan.position_notional, 0.0);
    }

    // -----------------------------------------------------------------------
    // La subida al mínimo del exchange no puede romper ningún tope.
    // -----------------------------------------------------------------------

    #[test]
    fn minimum_bump_is_refused_when_it_exceeds_the_risk_cap() {
        // Equity 10, tope 2% => $0,20 de riesgo. Con 20x y SL del 2%, el
        // mínimo del exchange ($1 de margen) arriesgaría $0,40: el doble de
        // lo permitido. Antes se subía a $1 y se perdía el topado.
        let sizer = PositionSizer::new("Micro", true, 20, 2.0, 4.0).with_real_max_positions(3);
        let plan = sizer.calculate_session_plan(10.0, 0, 0.0, 0.0, 0.0);

        assert_eq!(plan.position_size_usdt, 0.0);
        assert_eq!(plan.position_notional, 0.0);
        assert_eq!(plan.risk_per_trade_usdt, 0.0);
        assert_eq!(plan.risk_per_trade_pct, 0.0);
        assert!(!plan.is_active);
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.contains("el tamaño mínimo del exchange supera el riesgo permitido")),
            "{:?}",
            plan.warnings
        );
        let (can, reason) = can_execute_trade(&plan, 0);
        assert!(!can, "un plan bloqueado no se puede ejecutar");
        assert!(reason.contains("not active"), "{reason}");
    }

    #[test]
    fn minimum_bump_is_refused_when_it_exceeds_the_margin_cap() {
        // Con tope de margen de $0,50 no hay forma de llegar al mínimo de $1.
        let sizer = PositionSizer::new("Capped", false, 5, 1.0, 2.0)
            .with_paper_max_positions(20)
            .with_max_margin_per_order(Some(0.5));
        let plan = sizer.calculate_session_plan(1000.0, 0, 0.0, 0.0, 0.0);

        assert_eq!(plan.position_size_usdt, 0.0);
        assert!(!plan.is_active);
        assert!(
            plan.warnings
                .iter()
                .any(|w| w
                    .contains("el tamaño mínimo del exchange supera el tope de margen por orden")),
            "{:?}",
            plan.warnings
        );
    }

    #[test]
    fn minimum_bump_is_refused_when_it_exceeds_the_available_balance() {
        // Cuenta micro: equity 1,01 (< 50) con 5% de reserva deja $0,9595
        // disponibles, por debajo del mínimo de $1 del exchange. Con 1x y SL
        // del 2% el presupuesto de riesgo ($0,0202) sí alcanza para el mínimo
        // ($0,02), así que el tope de riesgo NO es lo que bloquea: es que no
        // hay balance para llegar al mínimo. Por eso el apalancamiento es 1x.
        let sizer = PositionSizer::new("Micro", false, 1, 2.0, 4.0).with_paper_max_positions(1);
        let plan = sizer.calculate_session_plan(1.01, 0, 0.0, 0.0, 0.0);

        assert!(
            plan.available_balance > 0.0,
            "el reparto tiene que ser positivo"
        );
        assert!(
            plan.available_balance < MIN_POSITION_SIZE_USDT,
            "el caso tiene que ser real: available = {}",
            plan.available_balance
        );
        assert_eq!(plan.position_size_usdt, 0.0);
        assert!(!plan.is_active);
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.contains("el tamaño mínimo del exchange supera el balance disponible")),
            "{:?}",
            plan.warnings
        );
    }

    #[test]
    fn minimum_bump_is_applied_when_every_tope_allows_it() {
        // El camino bueno: el reparto sale por debajo del mínimo, pero subir a
        // $1 cabe en el balance y en el tope de riesgo (10x x SL 1% = $0,10 de
        // riesgo con $1 de margen, contra un presupuesto de $0,40).
        let sizer = PositionSizer::new("Small", false, 10, 1.0, 2.0).with_paper_max_positions(20);
        let plan = sizer.calculate_session_plan(20.0, 0, 0.0, 0.0, 0.0);

        assert_eq!(plan.position_size_usdt, MIN_POSITION_SIZE_USDT);
        assert_eq!(plan.position_notional, 10.0);
        assert!(plan.is_active);
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.contains("below minimum") && !w.contains("NOT TRADABLE")),
            "{:?}",
            plan.warnings
        );
        // El riesgo reportado es el del tamaño SUBIDO, no el del reparto.
        // $1 de margen x 10x x 1% = $0,10 sobre $20 de equity = 0,5%.
        assert!(
            (plan.risk_per_trade_usdt - 0.10).abs() < 1e-9,
            "got {}",
            plan.risk_per_trade_usdt
        );
        assert!(
            (plan.risk_per_trade_pct - 0.5).abs() < 1e-9,
            "got {}",
            plan.risk_per_trade_pct
        );
    }

    #[test]
    fn reported_risk_matches_the_final_size_in_the_normal_case() {
        // Sin subida al mínimo, el porcentaje reportado tiene que seguir siendo
        // el del tamaño planificado: el cambio del paso 10 no puede alterar el
        // caso normal.
        let sizer = PositionSizer::new("Normal", true, 10, 2.0, 4.0);
        let plan = sizer.calculate_session_plan(5000.0, 0, 0.0, 0.0, 0.0);

        let expected_pct = (plan.risk_per_trade_usdt / (plan.total_balance + 0.0)) * 100.0;
        assert!(
            (plan.risk_per_trade_pct - expected_pct).abs() < 1e-9,
            "{} vs {}",
            plan.risk_per_trade_pct,
            expected_pct
        );
        assert!(plan.risk_per_trade_pct <= MAX_RISK_PER_TRADE_PCT);
    }

    // -----------------------------------------------------------------------
    // `calculate_symbol_config` no divide por un precio no utilizable.
    // -----------------------------------------------------------------------

    #[test]
    fn symbol_config_rejects_invalid_price() {
        let sizer = PositionSizer::new("Px", true, 10, 2.0, 4.0);
        let plan = sizer.calculate_session_plan(5000.0, 0, 0.0, 0.0, 0.0);

        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -95000.0] {
            let err = sizer
                .calculate_symbol_config(&plan, "BTCUSDT", bad)
                .unwrap_err();
            assert!(err.contains("Invalid current_price"), "price {bad}: {err}");
            assert!(
                err.contains("BTCUSDT"),
                "el motivo debe nombrar el símbolo: {err}"
            );
        }
    }

    #[test]
    fn symbol_config_handles_the_smallest_valid_price() {
        // 1e-300 es un precio absurdity pequeño pero finito y positivo: la
        // cantidad será enorme, pero no inválida.
        let sizer = PositionSizer::new("Px", true, 10, 2.0, 4.0);
        let plan = sizer.calculate_session_plan(5000.0, 0, 0.0, 0.0, 0.0);
        let config = sizer
            .calculate_symbol_config(&plan, "BTCUSDT", 1e-300)
            .expect("1e-300 es un precio válido");
        assert!(config.quantity.is_finite());
        assert!(config.stop_loss_price_long.is_finite());
    }

    #[test]
    fn symbol_config_rejects_a_corrupt_plan_notional() {
        // Aunque el precio sea bueno, un nocional corrupto no se puede
        // convertir en cantidad.
        let sizer = PositionSizer::new("Px", true, 10, 2.0, 4.0);
        let mut plan = sizer.calculate_session_plan(5000.0, 0, 0.0, 0.0, 0.0);
        plan.position_notional = f64::NAN;
        let err = sizer
            .calculate_symbol_config(&plan, "BTCUSDT", 95000.0)
            .unwrap_err();
        assert!(err.contains("position_notional"), "{err}");
    }
}
