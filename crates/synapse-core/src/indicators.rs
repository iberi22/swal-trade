//! Indicadores técnicos sobre series `f64` puras.
//!
//! Todos devuelven un `Vec<Option<f64>>` **alineado con la entrada**: la posición
//! `i` corresponde a la barra `i`, y `None` marca las barras donde el indicador
//! todavía no es válido. Devolver `None` en lugar de `0.0` o de un vector
//! desalineado evita que la PWA dibuje una línea desde el origen antes de que
//! exista dato.
//!
//! Convenciones (idénticas en los cinco indicadores, para que el frontend pueda
//! tratar a todos igual):
//!
//! - `period == 0` devuelve un vector de `None` del largo de la entrada, sin
//!   tocar un solo índice.
//! - Una entrada vacía devuelve un vector vacío, sin `panic`.
//! - Un valor no finito (`NaN` o infinito) equivale a dato ausente: la barra se
//!   marca `None` y el indicador **se vuelve a sembrar** a partir de la ventana
//!   siguiente de datos válidos. No se "salta" el hueco ni se arrastra un
//!   estado corrupto: sembrar de nuevo es lo único que garantiza que la
//!   siguiente salida depende solo de datos que existen.
//! - `true_range` y [`atr`] exigen que `highs`, `lows` y `closes` tengan la
//!   **misma** longitud. Si no, no se puede alinear una serie con otra, así que
//!   devuelven todo `None` en lugar de truncar en silencio.
//!
//! Ninguna función hace aritmética de índices sin comprobar: los periodos
//! válidos son siempre `>= 1` y toda resta de índice va precedida de un guard
//! explícito (`i >= period`, `i > 0`, ...), porque la PWA llama a estos códigos
//! con datos que vienen de la red y un `panic` en WASM aborta la pestaña
//! entera, no solo el gráfico.

/// Media móvil simple de `period` barras.
///
/// `out[i] = media de values[i - period + 1 ..= i]`, y `None` en:
///
/// - las primeras `period - 1` barras, porque la ventana aún está incompleta;
/// - cualquier barra cuya ventana contenga al menos un valor no finito. Una
///   media calculada saltándose el hueco no es una media de la ventana, y
///   dibujar un valor ahí inventa una barra que el mercado no describió.
pub fn sma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    // `period == 0` y `len < period` no tienen ninguna ventana válida: no hay
    // índice al que restarle `period`, y ese es el underflow que rompía la
    // versión anterior.
    if period == 0 || values.len() < period {
        return out;
    }

    let p = period as f64;
    // Suma deslizante + contador de no finitos de la ventana. Se mantiene el
    // contador porque `NaN` no se puede sumar ni restar: se cuenta aparte para
    // no contaminar `sum` con un `NaN` que la envenenaría para siempre.
    let mut sum = 0.0;
    let mut non_finite = 0usize;

    for (i, &v) in values.iter().enumerate() {
        if i >= period {
            // Sale de la ventana el valor `period` posiciones atrás.
            let dropped = values[i - period];
            if dropped.is_finite() {
                sum -= dropped;
            } else {
                non_finite = non_finite.saturating_sub(1);
            }
        }

        if v.is_finite() {
            sum += v;
        } else {
            non_finite += 1;
        }

        if i + 1 >= period && non_finite == 0 {
            let mean = sum / p;
            if mean.is_finite() {
                out[i] = Some(mean);
            }
        }
    }

    out
}

/// Media móvil exponencial de `period` barras.
///
/// Se siembra con la SMA de las primeras `period` barras y después aplica
/// `ema = v * alpha + ema * (1 - alpha)` con `alpha = 2 / (period + 1)`.
///
/// Un valor no finito marca la barra como `None` **y reinicia el contador de
/// siembra**: la siguiente salida definida aparece cuando se hayan acumulado
/// otra vez `period` valores finitos consecutivos, y esa salida es la SMA de
/// esa ventana nueva.
pub fn ema(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    if period == 0 || values.len() < period {
        return out;
    }

    let p = period as f64;
    let alpha = 2.0 / (p + 1.0);

    // `prev` es la última EMA válida; `None` significa "todavía sin sembrar".
    let mut prev: Option<f64> = None;
    // Acumulado de la ventana que va a servir de semilla.
    let mut seed_sum = 0.0;
    let mut seed_count = 0usize;

    for (i, &v) in values.iter().enumerate() {
        if !v.is_finite() {
            prev = None;
            seed_sum = 0.0;
            seed_count = 0;
            continue;
        }

        if let Some(p_prev) = prev {
            let next = alpha * v + (1.0 - alpha) * p_prev;
            if next.is_finite() {
                out[i] = Some(next);
                prev = Some(next);
            } else {
                // Desbordamiento: la EMA dejó de ser utilizable, se vuelve a sembrar.
                prev = None;
            }
            continue;
        }

        seed_sum += v;
        seed_count += 1;
        if seed_count >= period {
            let seed = seed_sum / p;
            if seed.is_finite() {
                out[i] = Some(seed);
                prev = Some(seed);
            }
            // La ventana consumida no se reutiliza: se empieza a acumular la
            // siguiente desde cero.
            seed_sum = 0.0;
            seed_count = 0;
        }
    }

    out
}

/// Relative Strength Index de Wilder sobre precios de cierre.
///
/// El primer valor definido aparece en la barra `period` (índice `period`, no
/// `period - 1`): hacen falta `period` cambios y el primero ocurre entre las
/// barras 0 y 1, así que la ventana completa termina en la barra `period`.
///
/// Las semillas son medias simples de las primeras `period` ganancias y
/// pérdidas; a partir de ahí se aplica el suavizado de Wilder
/// `avg = (avg * (period - 1) + sample) / period`.
///
/// Un cierre no finito marca la barra como `None` y reinicia la siembra: la
/// siguiente salida definida necesita `period` cambios consecutivos calculados
/// sobre cierres finitos.
///
/// El RSI es 100 cuando no hay pérdidas y sí ganancias, 50 cuando no hay ni
/// ganancias ni pérdidas, y 0 cuando no hay ganancias.
pub fn rsi(closes: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; closes.len()];
    // Con `len <= period` no existen `period` cambios: los primeros `period`
    // cambios ocupan las barras 1..=period, así que hace falta una barra más.
    if period == 0 || closes.len() <= period {
        return out;
    }

    let p = period as f64;
    let p_minus_1 = p - 1.0;

    // `Some(_)` = suavizado de Wilder activo; `None` = acumulando semilla.
    let mut avg_gain: Option<f64> = None;
    let mut avg_loss: Option<f64> = None;
    let mut sum_gain = 0.0;
    let mut sum_loss = 0.0;
    let mut count = 0usize;

    // El cambio de la barra `i` es `closes[i] - closes[i-1]`, así que el
    // recorrido empieza en 1: en la barra 0 todavía no hay cambio.
    for i in 1..closes.len() {
        let (prev_close, cur_close) = (closes[i - 1], closes[i]);
        if !prev_close.is_finite() || !cur_close.is_finite() {
            avg_gain = None;
            avg_loss = None;
            sum_gain = 0.0;
            sum_loss = 0.0;
            count = 0;
            continue;
        }

        let delta = cur_close - prev_close;
        let gain = delta.max(0.0);
        let loss = (-delta).max(0.0);

        if let (Some(g), Some(l)) = (avg_gain, avg_loss) {
            let next_gain = (g * p_minus_1 + gain) / p;
            let next_loss = (l * p_minus_1 + loss) / p;
            if let Some(value) = rsi_from_averages(next_gain, next_loss) {
                out[i] = Some(value);
                avg_gain = Some(next_gain);
                avg_loss = Some(next_loss);
            } else {
                avg_gain = None;
                avg_loss = None;
            }
            continue;
        }

        sum_gain += gain;
        sum_loss += loss;
        count += 1;
        if count >= period {
            let (g, l) = (sum_gain / p, sum_loss / p);
            if let Some(value) = rsi_from_averages(g, l) {
                out[i] = Some(value);
                avg_gain = Some(g);
                avg_loss = Some(l);
            }
            sum_gain = 0.0;
            sum_loss = 0.0;
            count = 0;
        }
    }

    out
}

/// Convierte las medias de ganancia y pérdida de Wilder en un RSI.
///
/// Devuelve `None` si las medias no son finitas, para que quien llama pueda
/// tratar ese caso como una siembra inválida en lugar de emitir un NaN.
fn rsi_from_averages(avg_gain: f64, avg_loss: f64) -> Option<f64> {
    if !avg_gain.is_finite() || !avg_loss.is_finite() {
        return None;
    }
    let value = if avg_loss == 0.0 {
        // Sin pérdidas: 100 si hubo alguna ganancia, 50 si la serie es plana.
        if avg_gain > 0.0 {
            100.0
        } else {
            50.0
        }
    } else if avg_gain == 0.0 {
        0.0
    } else {
        100.0 - (100.0 / (1.0 + avg_gain / avg_loss))
    };
    value.is_finite().then_some(value)
}

/// Longitud común de `highs`, `lows` y `closes`, o `None` si no coinciden.
///
/// Alinear tres series de longitudes distintas exige inventar la alineación, y
/// una alineación inventada desplaza el ATR respecto al precio. Por eso
/// [`true_range`] y [`atr`] prefieren devolver `None` en todas las barras.
fn aligned_len(highs: &[f64], lows: &[f64], closes: &[f64]) -> Option<usize> {
    let n = highs.len().min(lows.len()).min(closes.len());
    if highs.len() == n && lows.len() == n && closes.len() == n {
        Some(n)
    } else {
        None
    }
}

/// True Range de cada barra: `max(H - L, |H - C_prev|, |L - C_prev|)`.
///
/// La primera barra usa `H - L` porque no hay cierre previo. Se expone porque
/// es el primer paso del ATR y los tests de [`atr`] la verifican.
///
/// Requiere que las tres series tengan la misma longitud; si no, devuelve todo
/// `None`. Una barra con algún valor no finito (o cuyo cierre previo no lo sea)
/// también queda como `None`.
pub fn true_range(highs: &[f64], lows: &[f64], closes: &[f64]) -> Vec<Option<f64>> {
    let shortest = highs.len().min(lows.len()).min(closes.len());
    let mut out = vec![None; shortest];

    let Some(n) = aligned_len(highs, lows, closes) else {
        return out;
    };

    for i in 0..n {
        let (h, l, c) = (highs[i], lows[i], closes[i]);
        if !h.is_finite() || !l.is_finite() || !c.is_finite() {
            continue;
        }

        let tr = if i == 0 {
            h - l
        } else {
            // `i >= 1` garantiza que `i - 1` no desborda.
            let prev_close = closes[i - 1];
            if !prev_close.is_finite() {
                continue;
            }
            (h - l)
                .max((h - prev_close).abs())
                .max((l - prev_close).abs())
        };

        if tr.is_finite() {
            out[i] = Some(tr);
        }
    }

    out
}

/// Average True Range de Wilder (suavizado exponencial del True Range).
///
/// `out` está alineado con las entradas: el primer ATR aparece en el índice
/// `period - 1`, que es cuando se completa la ventana inicial de `period` True
/// Ranges (media simple de `TR_0..=TR_{period-1}`). El suavizado posterior es
/// `atr = (atr * (period - 1) + tr) / period`.
///
/// Un True Range no finito (o ausente) marca la barra como `None` y reinicia
/// la siembra: la siguiente salida definida es la media de las siguientes
/// `period` barras con True Range válido.
///
/// Si `highs`, `lows` y `closes` no tienen la misma longitud, devuelve todo
/// `None` con la longitud de la serie más corta, sin truncar en silencio.
pub fn atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<Option<f64>> {
    let shortest = highs.len().min(lows.len()).min(closes.len());
    let mut out = vec![None; shortest];

    if period == 0 || shortest < period {
        return out;
    }
    if aligned_len(highs, lows, closes).is_none() {
        return out;
    }

    let tr = true_range(highs, lows, closes);
    let p = period as f64;
    let p_minus_1 = p - 1.0;

    let mut prev: Option<f64> = None;
    let mut seed_sum = 0.0;
    let mut seed_count = 0usize;

    for (i, value) in tr.iter().enumerate() {
        // Un hueco invalida la ventana: ni el promedio acumulado ni la
        // suavización anterior siguen siendo válidos.
        let Some(v) = value else {
            prev = None;
            seed_sum = 0.0;
            seed_count = 0;
            continue;
        };

        if let Some(p_prev) = prev {
            let next = (p_prev * p_minus_1 + v) / p;
            if next.is_finite() {
                out[i] = Some(next);
                prev = Some(next);
            } else {
                prev = None;
            }
            continue;
        }

        seed_sum += v;
        seed_count += 1;
        if seed_count >= period {
            let seed = seed_sum / p;
            if seed.is_finite() {
                out[i] = Some(seed);
                prev = Some(seed);
            }
            seed_sum = 0.0;
            seed_count = 0;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close_to(actual: Option<f64>, expected: f64, tol: f64) {
        match actual {
            // `<=` para que `tol = 0.0` signifique "exacto", que es lo que
            // afirman los casos de RSI sin perdida / sin ganancia.
            Some(v) => assert!(
                (v - expected).abs() <= tol,
                "expected {expected} (±{tol}), got {v}"
            ),
            None => panic!("expected Some({expected}), got None"),
        }
    }

    fn assert_none(actual: Option<f64>) {
        assert!(actual.is_none(), "expected None, got {actual:?}");
    }

    /// Comprueba que las primeras `warmup` barras (el periodo de calentamiento)
    /// son `None`. El resto de las comprobaciones de valores van aparte.
    fn assert_warmup(out: &[Option<f64>], warmup: usize) {
        for slot in out.iter().take(warmup) {
            assert_none(*slot);
        }
    }

    // -----------------------------------------------------------------------
    // SMA
    // -----------------------------------------------------------------------

    #[test]
    fn sma_hand_computed() {
        // [1,2,3,4,5] con period = 3. La ventana de la barra i es
        // values[i-2..=i], o sea que necesita 3 barras completas.
        //   i=0 -> ventana [1]        incompleta -> None
        //   i=1 -> ventana [1,2]      incompleta -> None
        //   i=2 -> ventana [1,2,3]    (1+2+3)/3 = 2
        //   i=3 -> ventana [2,3,4]    (2+3+4)/3 = 3
        //   i=4 -> ventana [3,4,5]    (3+4+5)/3 = 4
        let out = sma(&[1.0, 2.0, 3.0, 4.0, 5.0], 3);
        assert_eq!(out.len(), 5);
        assert_warmup(&out, 2);
        close_to(out[2], 2.0, 1e-12);
        close_to(out[3], 3.0, 1e-12);
        close_to(out[4], 4.0, 1e-12);
    }

    #[test]
    fn sma_period_one_is_identity() {
        // Con period = 1 la ventana es la propia barra: SMA = valor.
        let out = sma(&[10.0, 20.0, 30.0], 1);
        close_to(out[0], 10.0, 0.0);
        close_to(out[1], 20.0, 0.0);
        close_to(out[2], 30.0, 0.0);
    }

    #[test]
    fn sma_non_finite_window_is_none_then_recovers() {
        // [1, NaN, 3] con period = 3: la única ventana completa contiene el
        // NaN, así que la barra 2 es None. Promediar solo los finitos daría
        // 2.0, que es un número que el mercado nunca produjo.
        let out = sma(&[1.0, f64::NAN, 3.0], 3);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(Option::is_none));

        // El hueco sale de la ventana en la barra 4: [3, 4, 5] -> 4.0
        let out = sma(&[1.0, f64::NAN, 3.0, 4.0, 5.0], 3);
        assert_none(out[3]);
        close_to(out[4], 4.0, 1e-12);
    }

    #[test]
    fn sma_infinity_is_treated_as_missing() {
        // Un infinito es dato ausente igual que un NaN.
        let out = sma(&[1.0, f64::INFINITY, 3.0], 3);
        assert!(out.iter().all(Option::is_none));
    }

    #[test]
    fn sma_zero_period_is_all_none() {
        let out = sma(&[1.0, 2.0, 3.0], 0);
        assert_eq!(out, vec![None, None, None]);
    }

    #[test]
    fn sma_shorter_than_period_is_all_none() {
        // Con menos datos que barras no hay ni una ventana completa: esta es
        // la guarda que evita el underflow de `i - period`.
        let out = sma(&[1.0, 2.0], 5);
        assert_eq!(out, vec![None, None]);
    }

    #[test]
    fn sma_empty_input_is_empty_output() {
        assert!(sma(&[], 3).is_empty());
        assert!(sma(&[], 0).is_empty());
    }

    // -----------------------------------------------------------------------
    // EMA
    // -----------------------------------------------------------------------

    #[test]
    fn ema_hand_computed() {
        // [1,2,3,4,5] con period = 3 -> alpha = 2 / (3+1) = 0.5
        //   i=0: solo 1 barra finita, la semilla aún no se completa -> None
        //   i=1: 2 barras finitas, todavía menos que 3            -> None
        //   i=2: 3 barras finitas -> semilla = SMA(1,2,3) = 2.0
        //   i=3: 0.5*4 + 0.5*2.0 = 2.0 + 1.0 = 3.0
        //   i=4: 0.5*5 + 0.5*3.0 = 2.5 + 1.5 = 4.0
        let out = ema(&[1.0, 2.0, 3.0, 4.0, 5.0], 3);
        assert_eq!(out.len(), 5);
        assert_warmup(&out, 2);
        close_to(out[2], 2.0, 1e-12);
        close_to(out[3], 3.0, 1e-12);
        close_to(out[4], 4.0, 1e-12);
    }

    #[test]
    fn ema_seed_equals_sma() {
        // La semilla de la EMA es, por definición, la SMA de la misma ventana.
        let values = [3.0, 6.0, 9.0, 12.0, 15.0];
        let e = ema(&values, 3);
        let s = sma(&values, 3);
        assert_none(e[0]);
        assert_none(e[1]);
        close_to(e[2], 6.0, 1e-12);
        assert_eq!(e[2], s[2]);
    }

    #[test]
    fn ema_reseeds_after_non_finite() {
        // [1, 2, NaN, 4, 5, 6] con period = 3.
        //   i=0: 1 finita   -> None
        //   i=1: 2 finitas  -> None
        //   i=2: NaN        -> None y reinicia la siembra
        //   i=3: 1 finita tras el hueco -> None (aún no hay 3)
        //   i=4: 2 finitas tras el hueco -> None
        //   i=5: 3 finitas -> semilla = SMA(4,5,6) = 15/3 = 5.0
        let out = ema(&[1.0, 2.0, f64::NAN, 4.0, 5.0, 6.0], 3);
        assert_eq!(out.len(), 6);
        assert_none(out[0]);
        assert_none(out[1]);
        assert_none(out[2]);
        assert_none(out[3]);
        assert_none(out[4]);
        close_to(out[5], 5.0, 1e-12);
    }

    #[test]
    fn ema_reseeds_after_infinity() {
        // [1, 2, inf, 4, 5] con period = 2 -> alpha = 2/3
        //   i=0: 1 finita  -> None
        //   i=1: semilla = (1+2)/2 = 1.5
        //   i=2: infinito  -> None y reinicia
        //   i=3: 1 finita tras el hueco -> None
        //   i=4: 2 finitas -> semilla = (4+5)/2 = 4.5
        let out = ema(&[1.0, 2.0, f64::INFINITY, 4.0, 5.0], 2);
        assert_none(out[0]);
        close_to(out[1], 1.5, 1e-12);
        assert_none(out[2]);
        assert_none(out[3]);
        close_to(out[4], 4.5, 1e-12);
    }

    #[test]
    fn ema_smooths_after_reseed() {
        // [1, 2, NaN, 4, 5, 6] con period = 2 -> alpha = 2/3
        //   i=0: None
        //   i=1: semilla = (1+2)/2 = 1.5
        //   i=2: None (NaN)
        //   i=3: None (solo 1 finita tras el hueco)
        //   i=4: semilla = (4+5)/2 = 4.5
        //   i=5: (2/3)*6 + (1/3)*4.5 = 4.0 + 1.5 = 5.5
        let out = ema(&[1.0, 2.0, f64::NAN, 4.0, 5.0, 6.0], 2);
        assert_none(out[3]);
        close_to(out[4], 4.5, 1e-12);
        close_to(out[5], 5.5, 1e-12);
    }

    #[test]
    fn ema_zero_period_is_all_none() {
        assert_eq!(ema(&[1.0, 2.0], 0), vec![None, None]);
    }

    #[test]
    fn ema_empty_input_is_empty_output() {
        assert!(ema(&[], 3).is_empty());
        assert!(ema(&[], 0).is_empty());
    }

    // -----------------------------------------------------------------------
    // RSI (Wilder)
    // -----------------------------------------------------------------------

    #[test]
    fn rsi_wilder_hand_computed() {
        // Cierres [10, 11, 10.5, 11.5, 12, 11, 12.5] con period = 3.
        // Cambios (i >= 1), en fraccionarios exactos:
        //   i=1: +1     -> ganancia 1, perdida 0
        //   i=2: -0.5   -> ganancia 0, perdida 0.5
        //   i=3: +1     -> ganancia 1, perdida 0
        //   i=4: +0.5   -> ganancia 0.5, perdida 0
        //   i=5: -1     -> ganancia 0, perdida 1
        //   i=6: +1.5   -> ganancia 1.5, perdida 0
        //
        // La primera salida llega en la barra 3 (índice = period) con las
        // medias simples de los 3 primeros cambios:
        //   avg_gain = (1 + 0 + 1) / 3     = 2/3
        //   avg_loss = (0 + 0.5 + 0) / 3   = 1/6
        //   RS = (2/3) / (1/6) = 4
        //   RSI = 100 - 100 / (1 + 4) = 100 - 20 = 80
        //
        // Wilder: avg = (avg * (period - 1) + muestra) / period
        //   i=4: avg_gain = ((2/3)*2 + 0.5) / 3 = (11/6) / 3 = 11/18
        //        avg_loss = ((1/6)*2 + 0  ) / 3 = ( 1/3) / 3 = 1/9
        //        RS = (11/18) / (1/9) = 11/2
        //        RSI = 100 - 100 / (13/2) = 100 - 200/13 = 84.6153846...
        //   i=5: avg_gain = ((11/18)*2 + 0) / 3 = (11/9) / 3 = 11/27
        //        avg_loss = ((1/9)*2  + 1) / 3 = (11/9) / 3 = 11/27
        //        RS = 1 -> RSI = 100 - 100/2 = 50
        //   i=6: avg_gain = ((11/27)*2 + 1.5) / 3 = (125/54) / 3 = 125/162
        //        avg_loss = ((11/27)*2 + 0  ) / 3 = (22/27) / 3 = 22/81
        //        RS = (125/162) / (22/81) = 125/44
        //        RSI = 100 - 100 / (169/44) = 100 - 4400/169 = 73.9644970...
        let out = rsi(&[10.0, 11.0, 10.5, 11.5, 12.0, 11.0, 12.5], 3);
        assert_eq!(out.len(), 7);
        assert_warmup(&out, 3);
        close_to(out[3], 80.0, 1e-12);
        close_to(out[4], 84.615_384_615_384_61, 1e-12);
        close_to(out[5], 50.0, 1e-12);
        close_to(out[6], 73.964_497_041_420_12, 1e-12);
    }

    #[test]
    fn rsi_fifteen_closes_period_fourteen() {
        // Vector clásico de Wilder (15 cierres) con period = 14: los 14
        // cambios ocupan las barras 1..=14, así que la única salida es la de la
        // barra 14 y sale de las medias simples (no hay suavizado que aplicar).
        //
        //   barra  delta     ganancia  perdida
        //      1    -0.25      0.00      0.25
        //      2    +0.06      0.06      0.00
        //      3    -0.54      0.00      0.54
        //      4    +0.72      0.72      0.00
        //      5    +0.50      0.50      0.00
        //      6    +0.27      0.27      0.00
        //      7    +0.32      0.32      0.00
        //      8    +0.42      0.42      0.00
        //      9    +0.24      0.24      0.00
        //     10    -0.19      0.00      0.19
        //     11    +0.14      0.14      0.00
        //     12    -0.42      0.00      0.42
        //     13    +0.67      0.67      0.00
        //     14     0.00      0.00      0.00
        //
        //   suma ganancias = 0.06+0.72+0.50+0.27+0.32+0.42+0.24+0.14+0.67 = 3.34
        //   suma perdidas  = 0.25+0.54+0.19+0.42 = 1.40
        //   avg_gain = 3.34 / 14 = 167/700
        //   avg_loss = 1.40 / 14 = 1/10
        //   RS = (167/700) / (1/10) = 167/70
        //   RSI = 100 - 100 / (1 + 167/70) = 100 - 7000/237
        //       = 100 - 29.535864978902996... = 70.464135021097003...
        let closes = [
            44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03,
            45.61, 46.28, 46.28,
        ];
        let out = rsi(&closes, 14);
        assert_eq!(out.len(), 15);
        for slot in out.iter().take(14) {
            assert_none(*slot);
        }
        close_to(out[14], 70.464_135_021_097, 1e-9);
    }

    #[test]
    fn rsi_monotonic_rise_is_100() {
        // Cada cambio es una ganancia, avg_loss se queda en 0 para siempre:
        // no hay pérdida contra la que comparar, luego RSI = 100.
        //   i=0: sin cambio -> None
        //   i=1: 1 cambio    -> None
        //   i=2: 2 cambios  -> None
        //   i=3: 3 cambios -> avg_gain = 1, avg_loss = 0 -> 100
        //   i=4: (1*2 + 1) / 3 = 1, avg_loss = 0 -> 100
        let out = rsi(&[1.0, 2.0, 3.0, 4.0, 5.0], 3);
        assert_warmup(&out, 3);
        close_to(out[3], 100.0, 0.0);
        close_to(out[4], 100.0, 0.0);
    }

    #[test]
    fn rsi_monotonic_fall_is_0() {
        // Simétrico del anterior: toda pérdida, ninguna ganancia -> RSI = 0.
        let out = rsi(&[5.0, 4.0, 3.0, 2.0, 1.0], 3);
        close_to(out[3], 0.0, 0.0);
        close_to(out[4], 0.0, 0.0);
    }

    #[test]
    fn rsi_flat_series_is_50() {
        // Sin cambios no hay ganancia ni perdida: 0/0 no es indefinido para el
        // RSI, es la serie neutra, asi que 50.
        let out = rsi(&[7.0, 7.0, 7.0, 7.0, 7.0], 3);
        assert_warmup(&out, 3);
        close_to(out[3], 50.0, 0.0);
        close_to(out[4], 50.0, 0.0);
    }

    #[test]
    fn rsi_reseeds_after_non_finite() {
        // [10, 11, 10.5, NaN, 12, 13, 14] con period = 2.
        //   i=1: cambio +1   -> ganancia 1, perdida 0; 1 cambio, falta 1 -> None
        //   i=2: cambio -0.5 -> ganancia 0, perdida 0.5
        //        semilla: avg_gain = 1/2, avg_loss = 0.5/2 = 1/4
        //        RS = (1/2) / (1/4) = 2
        //        RSI = 100 - 100 / 3 = 200/3 = 66.6666666...
        //   i=3: NaN                 -> None y reinicia
        //   i=4: cierre previo NaN    -> None y reinicia
        //   i=5: cambio +1 (13 -> 12) -> 1 cambio tras el hueco -> None
        //   i=6: cambio +1 (14 -> 13) -> 2 cambios: avg_gain = 1/2, avg_loss = 0
        //        RSI = 100 (no hay perdida contra la que comparar)
        let out = rsi(&[10.0, 11.0, 10.5, f64::NAN, 12.0, 13.0, 14.0], 2);
        assert_eq!(out.len(), 7);
        assert_none(out[0]);
        assert_none(out[1]);
        close_to(out[2], 200.0 / 3.0, 1e-12);
        assert_none(out[3]);
        assert_none(out[4]);
        assert_none(out[5]);
        close_to(out[6], 100.0, 0.0);
    }

    #[test]
    fn rsi_zero_period_is_all_none() {
        assert_eq!(rsi(&[1.0, 2.0, 3.0], 0), vec![None, None, None]);
    }

    #[test]
    fn rsi_not_enough_closes_for_period_is_all_none() {
        // 3 cierres y period = 3 solo dan 2 cambios: nunca hay 3.
        assert_eq!(rsi(&[1.0, 2.0, 3.0], 3), vec![None, None, None]);
    }

    #[test]
    fn rsi_empty_input_is_empty_output() {
        assert!(rsi(&[], 3).is_empty());
        assert!(rsi(&[], 0).is_empty());
    }

    // -----------------------------------------------------------------------
    // True Range / ATR (Wilder)
    // -----------------------------------------------------------------------

    #[test]
    fn true_range_hand_computed() {
        // TR_0 = H - L porque no hay cierre previo.
        // TR_i = max(H - L, |H - C_prev|, |L - C_prev|)
        let highs = [10.5, 12.0, 11.5, 13.0, 12.5, 12.0, 13.5];
        let lows = [9.5, 10.5, 10.0, 11.5, 10.5, 10.0, 12.0];
        let closes = [10.0, 11.0, 10.5, 12.0, 11.5, 10.5, 13.0];
        //   0: 10.5 - 9.5 = 1.0
        //   1: max(1.5, |12.0-10.0|=2.0, |10.5-10.0|=0.5) = 2.0
        //   2: max(1.5, |11.5-11.0|=0.5, |10.0-11.0|=1.0) = 1.5
        //   3: max(1.5, |13.0-10.5|=2.5, |11.5-10.5|=1.0) = 2.5
        //   4: max(2.0, |12.5-12.0|=0.5, |10.5-12.0|=1.5) = 2.0
        //   5: max(2.0, |12.0-11.5|=0.5, |10.0-11.5|=1.5) = 2.0
        //   6: max(1.5, |13.5-10.5|=3.0, |12.0-10.5|=1.5) = 3.0
        let tr = true_range(&highs, &lows, &closes);
        let expected = [1.0, 2.0, 1.5, 2.5, 2.0, 2.0, 3.0];
        assert_eq!(tr.len(), 7);
        for (i, want) in expected.iter().enumerate() {
            close_to(tr[i], *want, 1e-12);
        }
    }

    #[test]
    fn true_range_mismatched_lengths_is_all_none() {
        // Sin alineación fiable no hay dato: todo None, del largo de la más corta.
        let tr = true_range(&[1.0, 2.0, 3.0], &[1.0], &[1.0, 2.0]);
        assert_eq!(tr, vec![None]);
    }

    #[test]
    fn true_range_empty_input_is_empty_output() {
        assert!(true_range(&[], &[], &[]).is_empty());
    }

    #[test]
    fn atr_hand_computed_small() {
        // highs [10, 11, 12, 14], lows [9, 10, 11, 13], closes [9.5, 10.5, 11.5, 13.5]
        //   TR_0 = 10 - 9 = 1
        //   TR_1 = max(1, |11 - 9.5| = 1.5, |10 - 9.5| = 0.5) = 1.5
        //   TR_2 = max(1, |12 - 10.5| = 1.5, |11 - 10.5| = 0.5) = 1.5
        //   TR_3 = max(1, |14 - 11.5| = 2.5, |13 - 11.5| = 1.5) = 2.5
        //
        // period = 3: la semilla es la media de TR_0..TR_2 (índice period - 1 = 2)
        //   ATR_2 = (1 + 1.5 + 1.5) / 3 = 4/3 = 1.3333333...
        // y luego Wilder: atr = (atr * (period - 1) + tr) / period
        //   ATR_3 = ((4/3) * 2 + 2.5) / 3 = (8/3 + 5/2) / 3 = (31/6) / 3 = 31/18
        //         = 1.7222222...
        let out = atr(
            &[10.0, 11.0, 12.0, 14.0],
            &[9.0, 10.0, 11.0, 13.0],
            &[9.5, 10.5, 11.5, 13.5],
            3,
        );
        assert_eq!(out.len(), 4);
        assert_warmup(&out, 2);
        close_to(out[2], 4.0 / 3.0, 1e-12);
        close_to(out[3], 31.0 / 18.0, 1e-12);
    }

    #[test]
    fn atr_hand_computed_wilder() {
        // highs [10.5, 12, 11.5, 13, 12.5, 12, 13.5]
        // lows  [9.5, 10.5, 10, 11.5, 10.5, 10, 12]
        // closes [10, 11, 10.5, 12, 11.5, 10.5, 13]
        // True Range: [1, 2, 1.5, 2.5, 2, 2, 3]
        // period = 3:
        //   i=0,1: calentamiento
        //   i=2: semilla = (1 + 2 + 1.5) / 3 = 1.5
        //   i=3: (1.5 * 2 + 2.5) / 3 = 1.8333333...
        //   i=4: (1.8333 * 2 + 2) / 3 = 1.8888888...
        //   i=5: (1.8888 * 2 + 2) / 3 = 1.9259259...
        //   i=6: (1.9259 * 2 + 3) / 3 = 2.2839506...
        let out = atr(
            &[10.5, 12.0, 11.5, 13.0, 12.5, 12.0, 13.5],
            &[9.5, 10.5, 10.0, 11.5, 10.5, 10.0, 12.0],
            &[10.0, 11.0, 10.5, 12.0, 11.5, 10.5, 13.0],
            3,
        );
        assert_eq!(out.len(), 7);
        assert_warmup(&out, 2);
        close_to(out[2], 1.5, 1e-12);
        close_to(out[3], 1.833_333_333_333_333_5, 1e-12);
        close_to(out[4], 1.888_888_888_888_888_8, 1e-12);
        close_to(out[5], 1.925_925_925_925_925_9, 1e-12);
        close_to(out[6], 2.283_950_617_283_950_5, 1e-12);
    }

    #[test]
    fn atr_seed_is_mean_of_first_window() {
        // highs [2,3,4,5], lows [1,2,3,4], closes [1.5,2.5,3.5,4.5]
        //   TR_0 = 2 - 1 = 1
        //   TR_1 = max(1, |3-1.5| = 1.5, |2-1.5| = 0.5) = 1.5
        //   TR_2 = max(1, |4-2.5| = 1.5, |3-2.5| = 0.5) = 1.5
        //   TR_3 = max(1, |5-3.5| = 1.5, |4-3.5| = 0.5) = 1.5
        // period = 2:
        //   ATR_1 = (1 + 1.5) / 2 = 1.25
        //   ATR_2 = (1.25 + 1.5) / 2 = 1.375
        //   ATR_3 = (1.375 + 1.5) / 2 = 1.4375
        let out = atr(
            &[2.0, 3.0, 4.0, 5.0],
            &[1.0, 2.0, 3.0, 4.0],
            &[1.5, 2.5, 3.5, 4.5],
            2,
        );
        assert_none(out[0]);
        close_to(out[1], 1.25, 1e-12);
        close_to(out[2], 1.375, 1e-12);
        close_to(out[3], 1.4375, 1e-12);
    }

    #[test]
    fn atr_reseeds_after_non_finite() {
        // highs [2, 3, NaN, 5, 6], lows [1, 2, 3, 4, 5], closes [1.5, 2.5, 3.5, 4.5, 5.5]
        //   TR_0 = 1
        //   TR_1 = max(1, |3-1.5| = 1.5, |2-1.5| = 0.5) = 1.5
        //   TR_2 = None (maximo no finito)
        //   TR_3 = max(1, |5-3.5| = 1.5, |4-3.5| = 0.5) = 1.5
        //   TR_4 = max(1, |6-4.5| = 1.5, |5-4.5| = 0.5) = 1.5
        // period = 2:
        //   i=0: 1 TR valido, falta 1 -> None
        //   i=1: semilla = (1 + 1.5) / 2 = 1.25
        //   i=2: hueco    -> None y reinicia la ventana
        //   i=3: 1 TR valido tras el hueco -> None (aun no hay 2)
        //   i=4: 2 TR validos -> semilla = (1.5 + 1.5) / 2 = 1.5
        let out = atr(
            &[2.0, 3.0, f64::NAN, 5.0, 6.0],
            &[1.0, 2.0, 3.0, 4.0, 5.0],
            &[1.5, 2.5, 3.5, 4.5, 5.5],
            2,
        );
        assert_eq!(out.len(), 5);
        assert_none(out[0]);
        close_to(out[1], 1.25, 1e-12);
        assert_none(out[2]);
        assert_none(out[3]);
        close_to(out[4], 1.5, 1e-12);
    }

    #[test]
    fn atr_mismatched_lengths_is_all_none() {
        // Sin longitudes iguales no hay forma de saber que fila es la misma
        // barra: se devuelve todo None, del largo de la serie mas corta, en vez
        // de truncar y devolver un ATR desplazado en el tiempo.
        let out = atr(&[2.0, 3.0, 4.0], &[1.0, 2.0], &[1.5, 2.5], 1);
        assert_eq!(out, vec![None, None]);

        let out = atr(&[2.0, 3.0], &[1.0, 2.0], &[1.5], 1);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn atr_zero_period_is_all_none() {
        let out = atr(&[2.0, 3.0], &[1.0, 2.0], &[1.5, 2.5], 0);
        assert_eq!(out, vec![None, None]);
    }

    #[test]
    fn atr_shorter_than_period_is_all_none() {
        let out = atr(&[2.0, 3.0], &[1.0, 2.0], &[1.5, 2.5], 5);
        assert_eq!(out, vec![None, None]);
    }

    #[test]
    fn atr_empty_input_is_empty_output() {
        assert!(atr(&[], &[], &[], 3).is_empty());
        assert!(atr(&[], &[], &[], 0).is_empty());
    }

    // -----------------------------------------------------------------------
    // Alineacion entre indicadores
    // -----------------------------------------------------------------------

    #[test]
    fn all_indicators_stay_aligned_with_input_length() {
        // El contrato con la PWA es que el vector devuelto tiene exactamente
        // una posicion por barra, pase lo que pase con los datos.
        let highs = [10.0, 11.0, 12.0, f64::NAN, 14.0, 15.0, 16.0];
        let lows = [9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0];
        let closes = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5];

        assert_eq!(sma(&closes, 3).len(), 7);
        assert_eq!(ema(&closes, 3).len(), 7);
        assert_eq!(rsi(&closes, 3).len(), 7);
        assert_eq!(true_range(&highs, &lows, &closes).len(), 7);
        assert_eq!(atr(&highs, &lows, &closes, 3).len(), 7);
    }
}
