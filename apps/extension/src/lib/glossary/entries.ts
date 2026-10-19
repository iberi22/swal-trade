/**
 * Estructura del glosario. SIN prosa: los textos viven en glossary.es.json
 * (claves planas `glossary.<id>.<campo>`) para poder traducirlos.
 * Las cifras que ve el usuario salen solo de stats.json, nunca de la prosa.
 * Ver README.md de esta carpeta.
 */

export type GlossaryCategory =
  | 'niveles'
  | 'patrones'
  | 'sentimiento'
  | 'cierres'
  | 'flujo'
  | 'riesgo'
  | 'escaner';

export interface GlossaryStatRef {
  type: 'level' | 'pattern';
  /** Exactamente el LevelKind de levels.ts o el `kind` del núcleo de análisis. */
  id: string;
  direction?: 'long' | 'short';
}

export interface GlossaryEntry {
  id: string;
  category: GlossaryCategory;
  /** Textos exactos que muestra la UI para el término. La búsqueda ignora mayúsculas y tildes. */
  aliases: readonly string[];
  statRef?: GlossaryStatRef;
  /** Ids de otras entradas. */
  related: readonly string[];
  role?: 'resistance' | 'support' | 'neutral' | 'context';
}

/** Campos de prosa que cada entrada debe tener en glossary.es.json. */
export const PROSE_FIELDS = ['title', 'short', 'what', 'read', 'up', 'down', 'range', 'watch'] as const;

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: 'dayOpen',
    category: 'niveles',
    aliases: ['Apertura día'],
    related: ['weekOpen', 'monthOpen', 'prevDayHigh'],
    statRef: { type: 'level', id: 'dayOpen' },
    role: 'neutral',
  },
  {
    id: 'prevDayHigh',
    category: 'niveles',
    aliases: ['PDH', 'Máximo de ayer'],
    related: ['prevDayLow', 'prevWeekHigh', 'liquidity_sweep_bearish', 'resistance'],
    statRef: { type: 'level', id: 'prevDayHigh' },
    role: 'resistance',
  },
  {
    id: 'prevDayLow',
    category: 'niveles',
    aliases: ['PDL', 'Mínimo de ayer'],
    related: ['prevDayHigh', 'prevWeekLow', 'liquidity_sweep_bullish', 'support'],
    statRef: { type: 'level', id: 'prevDayLow' },
    role: 'support',
  },
  {
    id: 'weekOpen',
    category: 'niveles',
    aliases: ['Apertura sem.', 'Apertura de la semana'],
    related: ['monthOpen', 'dayOpen', 'prevWeekHigh'],
    statRef: { type: 'level', id: 'weekOpen' },
    role: 'neutral',
  },
  {
    id: 'prevWeekHigh',
    category: 'niveles',
    aliases: ['PWH', 'Máximo semana pasada'],
    related: ['prevWeekLow', 'prevDayHigh', 'resistance'],
    statRef: { type: 'level', id: 'prevWeekHigh' },
    role: 'resistance',
  },
  {
    id: 'prevWeekLow',
    category: 'niveles',
    aliases: ['PWL', 'Mínimo semana pasada'],
    related: ['prevWeekHigh', 'prevDayLow', 'support'],
    statRef: { type: 'level', id: 'prevWeekLow' },
    role: 'support',
  },
  {
    id: 'monthOpen',
    category: 'niveles',
    aliases: ['Apertura mes', 'Apertura del mes'],
    related: ['weekOpen', 'dayOpen', 'close_monthly'],
    statRef: { type: 'level', id: 'monthOpen' },
    role: 'neutral',
  },
  {
    id: 'ema20_1h',
    category: 'niveles',
    aliases: ['EMA20 1h'],
    related: ['ema50_1h', 'ema50_4h', 'bbUpper'],
    statRef: { type: 'level', id: 'ema20_1h' },
    role: 'neutral',
  },
  {
    id: 'ema50_1h',
    category: 'niveles',
    aliases: ['EMA50 1h'],
    related: ['ema20_1h', 'ema50_4h'],
    statRef: { type: 'level', id: 'ema50_1h' },
    role: 'neutral',
  },
  {
    id: 'ema50_4h',
    category: 'niveles',
    aliases: ['EMA50 4h'],
    related: ['ema50_1h', 'ema20_1h', 'close_4h'],
    statRef: { type: 'level', id: 'ema50_4h' },
    role: 'neutral',
  },
  {
    id: 'bbUpper',
    category: 'niveles',
    aliases: ['BB sup 1h', 'Banda de Bollinger superior'],
    related: ['bbLower', 'ema20_1h', 'atr'],
    statRef: { type: 'level', id: 'bbUpper' },
    role: 'resistance',
  },
  {
    id: 'bbLower',
    category: 'niveles',
    aliases: ['BB inf 1h', 'Banda de Bollinger inferior'],
    related: ['bbUpper', 'ema20_1h', 'atr'],
    statRef: { type: 'level', id: 'bbLower' },
    role: 'support',
  },
  {
    id: 'pivot',
    category: 'niveles',
    aliases: ['Pivote', 'Pivote clásico'],
    related: ['r1', 's1', 'prevDayHigh'],
    statRef: { type: 'level', id: 'pivot' },
    role: 'neutral',
  },
  {
    id: 'r1',
    category: 'niveles',
    aliases: ['R1'],
    related: ['pivot', 's1', 'resistance'],
    statRef: { type: 'level', id: 'r1' },
    role: 'resistance',
  },
  {
    id: 's1',
    category: 'niveles',
    aliases: ['S1'],
    related: ['pivot', 'r1', 'support'],
    statRef: { type: 'level', id: 's1' },
    role: 'support',
  },
  {
    id: 'round',
    category: 'niveles',
    aliases: ['Redondo', 'Número redondo'],
    related: ['prevDayHigh', 'prevDayLow', 'atr'],
    statRef: { type: 'level', id: 'round' },
    role: 'neutral',
  },
  {
    id: 'confirm',
    category: 'niveles',
    aliases: ['Confirma', 'Confirmación'],
    related: ['invalidate', 'range_breakout', 'double_top'],
    statRef: { type: 'level', id: 'confirm' },
    role: 'neutral',
  },
  {
    id: 'invalidate',
    category: 'niveles',
    aliases: ['Invalida', 'Invalidación'],
    related: ['confirm', 'stop_loss', 'loss_at_stop'],
    statRef: { type: 'level', id: 'invalidate' },
    role: 'neutral',
  },
  {
    id: 'support',
    category: 'niveles',
    aliases: ['Soporte'],
    related: ['resistance', 'sr_zone', 'prevDayLow'],
    statRef: { type: 'pattern', id: 'sr_zone' },
    role: 'support',
  },
  {
    id: 'resistance',
    category: 'niveles',
    aliases: ['Resistencia'],
    related: ['support', 'sr_zone', 'prevDayHigh'],
    statRef: { type: 'pattern', id: 'sr_zone' },
    role: 'resistance',
  },
  {
    id: 'atr',
    category: 'niveles',
    aliases: ['ATR', 'ATR14', 'ATR 14'],
    related: ['expected_range', 'stop_distance', 'bbUpper'],
    role: 'context',
  },
  {
    id: 'expected_range',
    category: 'niveles',
    aliases: ['rango típico (1 ATR)', 'Rango típico'],
    related: ['atr', 'stop_distance'],
    role: 'context',
  },
  {
    id: 'neckline',
    category: 'niveles',
    aliases: ['Cuello', 'Línea del cuello'],
    related: ['double_top', 'head_shoulders', 'confirm'],
    role: 'neutral',
  },
  {
    id: 'pivot_swing',
    category: 'patrones',
    aliases: ['Máximo local', 'Mínimo local'],
    related: ['sr_zone', 'bos_bullish', 'rsi_divergence_bullish'],
    statRef: { type: 'pattern', id: 'pivot' },
    role: 'neutral',
  },
  {
    id: 'sr_zone',
    category: 'patrones',
    aliases: ['Zona de soporte', 'Zona de resistencia', 'zona S/R', 'Zona S/R'],
    related: ['support', 'resistance', 'pivot_swing', 'prevDayHigh'],
    statRef: { type: 'pattern', id: 'sr_zone' },
    role: 'neutral',
  },
  {
    id: 'double_top',
    category: 'patrones',
    aliases: ['Doble techo'],
    related: ['double_bottom', 'neckline', 'head_shoulders'],
    statRef: { type: 'pattern', id: 'double_top', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'double_bottom',
    category: 'patrones',
    aliases: ['Doble suelo'],
    related: ['double_top', 'neckline', 'inverse_head_shoulders'],
    statRef: { type: 'pattern', id: 'double_bottom', direction: 'long' },
    role: 'support',
  },
  {
    id: 'ascending_triangle',
    category: 'patrones',
    aliases: ['Triángulo ascendente', 'triángulo asc.'],
    related: ['descending_triangle', 'symmetric_triangle', 'range_breakout'],
    statRef: { type: 'pattern', id: 'ascending_triangle', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'descending_triangle',
    category: 'patrones',
    aliases: ['Triángulo descendente', 'triángulo desc.'],
    related: ['ascending_triangle', 'symmetric_triangle', 'range_breakout'],
    statRef: { type: 'pattern', id: 'descending_triangle', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'symmetric_triangle',
    category: 'patrones',
    aliases: ['Triángulo simétrico', 'triángulo sim.'],
    related: ['ascending_triangle', 'descending_triangle', 'range_breakout'],
    statRef: { type: 'pattern', id: 'symmetric_triangle' },
    role: 'neutral',
  },
  {
    id: 'range_breakout',
    category: 'patrones',
    aliases: ['Ruptura de rango', 'Rango comprimido'],
    related: ['support', 'resistance', 'confirm', 'atr'],
    statRef: { type: 'pattern', id: 'range_breakout' },
    role: 'neutral',
  },
  {
    id: 'shock',
    category: 'patrones',
    aliases: ['Vela de choque', 'vela de choque'],
    related: ['volume_shock_buy', 'climax', 'atr'],
    statRef: { type: 'pattern', id: 'shock' },
    role: 'neutral',
  },
  {
    id: 'volume_profile',
    category: 'patrones',
    aliases: ['Perfil de volumen', 'Perfil de volumen (POC)'],
    related: ['poc', 'value_area', 'atr'],
    statRef: { type: 'pattern', id: 'volume_profile' },
    role: 'neutral',
  },
  {
    id: 'volume_shock_buy',
    category: 'patrones',
    aliases: ['Compra agresiva'],
    related: ['volume_shock_sell', 'taker', 'cvd'],
    statRef: { type: 'pattern', id: 'volume_shock_buy', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'volume_shock_sell',
    category: 'patrones',
    aliases: ['Venta agresiva'],
    related: ['volume_shock_buy', 'taker', 'cvd'],
    statRef: { type: 'pattern', id: 'volume_shock_sell', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'delta_divergence_bullish',
    category: 'patrones',
    aliases: ['Divergencia de delta alcista'],
    related: ['delta_divergence_bearish', 'cvd', 'rsi_divergence_bullish'],
    statRef: { type: 'pattern', id: 'delta_divergence_bullish', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'delta_divergence_bearish',
    category: 'patrones',
    aliases: ['Divergencia de delta bajista'],
    related: ['delta_divergence_bullish', 'cvd', 'rsi_divergence_bearish'],
    statRef: { type: 'pattern', id: 'delta_divergence_bearish', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'absorption',
    category: 'patrones',
    aliases: ['Absorción', 'Absorción compradora', 'Absorción vendedora'],
    related: ['climax', 'volume_shock_buy', 'support'],
    statRef: { type: 'pattern', id: 'absorption' },
    role: 'neutral',
  },
  {
    id: 'climax',
    category: 'patrones',
    aliases: ['Clímax de volumen', 'Clímax de compra', 'Clímax de venta'],
    related: ['absorption', 'shock', 'cvd'],
    statRef: { type: 'pattern', id: 'climax' },
    role: 'neutral',
  },
  {
    id: 'rsi_divergence_bullish',
    category: 'patrones',
    aliases: ['Divergencia alcista RSI', 'divergencia RSI alcista'],
    related: ['rsi_divergence_bearish', 'rsi', 'delta_divergence_bullish'],
    statRef: { type: 'pattern', id: 'rsi_divergence_bullish', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'rsi_divergence_bearish',
    category: 'patrones',
    aliases: ['Divergencia bajista RSI', 'divergencia RSI bajista'],
    related: ['rsi_divergence_bullish', 'rsi', 'delta_divergence_bearish'],
    statRef: { type: 'pattern', id: 'rsi_divergence_bearish', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'fvg_bullish',
    category: 'patrones',
    aliases: ['FVG alcista', 'Hueco de valor alcista'],
    related: ['fvg_bearish', 'fvg', 'order_block_bullish'],
    statRef: { type: 'pattern', id: 'fvg_bullish', direction: 'long' },
    role: 'support',
  },
  {
    id: 'fvg_bearish',
    category: 'patrones',
    aliases: ['FVG bajista', 'Hueco de valor bajista'],
    related: ['fvg_bullish', 'fvg', 'order_block_bearish'],
    statRef: { type: 'pattern', id: 'fvg_bearish', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'bos_bullish',
    category: 'patrones',
    aliases: ['BOS alcista', 'Ruptura de estructura alcista'],
    related: ['bos_bearish', 'bos', 'choch_bullish'],
    statRef: { type: 'pattern', id: 'bos_bullish', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'bos_bearish',
    category: 'patrones',
    aliases: ['BOS bajista', 'Ruptura de estructura bajista'],
    related: ['bos_bullish', 'bos', 'choch_bearish'],
    statRef: { type: 'pattern', id: 'bos_bearish', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'choch_bullish',
    category: 'patrones',
    aliases: ['CHoCH alcista', 'Cambio de carácter alcista'],
    related: ['choch_bearish', 'choch', 'bos_bullish'],
    statRef: { type: 'pattern', id: 'choch_bullish', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'choch_bearish',
    category: 'patrones',
    aliases: ['CHoCH bajista', 'Cambio de carácter bajista'],
    related: ['choch_bullish', 'choch', 'bos_bearish'],
    statRef: { type: 'pattern', id: 'choch_bearish', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'order_block_bullish',
    category: 'patrones',
    aliases: ['Order block alcista', 'OB alcista'],
    related: ['order_block_bearish', 'order_block', 'fvg_bullish'],
    statRef: { type: 'pattern', id: 'order_block_bullish', direction: 'long' },
    role: 'support',
  },
  {
    id: 'order_block_bearish',
    category: 'patrones',
    aliases: ['Order block bajista', 'OB bajista'],
    related: ['order_block_bullish', 'order_block', 'fvg_bearish'],
    statRef: { type: 'pattern', id: 'order_block_bearish', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'liquidity_sweep_bullish',
    category: 'patrones',
    aliases: ['Barrido de liquidez alcista', 'barrido de mínimos'],
    related: ['liquidity_sweep_bearish', 'liquidity_sweep', 'prevDayLow'],
    statRef: { type: 'pattern', id: 'liquidity_sweep_bullish', direction: 'long' },
    role: 'support',
  },
  {
    id: 'liquidity_sweep_bearish',
    category: 'patrones',
    aliases: ['Barrido de liquidez bajista', 'barrido de máximos'],
    related: ['liquidity_sweep_bullish', 'liquidity_sweep', 'prevDayHigh'],
    statRef: { type: 'pattern', id: 'liquidity_sweep_bearish', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'head_shoulders',
    category: 'patrones',
    aliases: ['Hombro-cabeza-hombro'],
    related: ['inverse_head_shoulders', 'neckline', 'double_top'],
    statRef: { type: 'pattern', id: 'head_shoulders', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'inverse_head_shoulders',
    category: 'patrones',
    aliases: ['Hombro-cabeza-hombro invertido'],
    related: ['head_shoulders', 'neckline', 'double_bottom'],
    statRef: { type: 'pattern', id: 'inverse_head_shoulders', direction: 'long' },
    role: 'support',
  },
  {
    id: 'rising_wedge',
    category: 'patrones',
    aliases: ['Cuña ascendente', 'cuña alcista'],
    related: ['falling_wedge', 'ascending_triangle', 'neckline'],
    statRef: { type: 'pattern', id: 'rising_wedge', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'falling_wedge',
    category: 'patrones',
    aliases: ['Cuña descendente', 'cuña bajista'],
    related: ['rising_wedge', 'descending_triangle', 'neckline'],
    statRef: { type: 'pattern', id: 'falling_wedge', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'bull_flag',
    category: 'patrones',
    aliases: ['Bandera alcista'],
    related: ['bear_flag', 'range_breakout', 'atr'],
    statRef: { type: 'pattern', id: 'bull_flag', direction: 'long' },
    role: 'neutral',
  },
  {
    id: 'bear_flag',
    category: 'patrones',
    aliases: ['Bandera bajista'],
    related: ['bull_flag', 'range_breakout', 'atr'],
    statRef: { type: 'pattern', id: 'bear_flag', direction: 'short' },
    role: 'neutral',
  },
  {
    id: 'candle_engulfing_bullish',
    category: 'patrones',
    aliases: ['Envolvente alcista'],
    related: ['candle_engulfing_bearish', 'candle_hammer', 'support'],
    statRef: { type: 'pattern', id: 'candle_engulfing_bullish', direction: 'long' },
    role: 'support',
  },
  {
    id: 'candle_engulfing_bearish',
    category: 'patrones',
    aliases: ['Envolvente bajista'],
    related: ['candle_engulfing_bullish', 'candle_shooting_star', 'resistance'],
    statRef: { type: 'pattern', id: 'candle_engulfing_bearish', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'candle_hammer',
    category: 'patrones',
    aliases: ['Martillo'],
    related: ['candle_shooting_star', 'candle_morning_star', 'support'],
    statRef: { type: 'pattern', id: 'candle_hammer', direction: 'long' },
    role: 'support',
  },
  {
    id: 'candle_shooting_star',
    category: 'patrones',
    aliases: ['Estrella fugaz'],
    related: ['candle_hammer', 'candle_evening_star', 'resistance'],
    statRef: { type: 'pattern', id: 'candle_shooting_star', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'candle_doji',
    category: 'patrones',
    aliases: ['Doji en nivel', 'Doji'],
    related: ['support', 'resistance', 'candle_hammer'],
    statRef: { type: 'pattern', id: 'candle_doji' },
    role: 'neutral',
  },
  {
    id: 'candle_morning_star',
    category: 'patrones',
    aliases: ['Estrella de la mañana'],
    related: ['candle_evening_star', 'candle_hammer', 'support'],
    statRef: { type: 'pattern', id: 'candle_morning_star', direction: 'long' },
    role: 'support',
  },
  {
    id: 'candle_evening_star',
    category: 'patrones',
    aliases: ['Estrella del anochecer', 'Estrella de la tarde'],
    related: ['candle_morning_star', 'candle_shooting_star', 'resistance'],
    statRef: { type: 'pattern', id: 'candle_evening_star', direction: 'short' },
    role: 'resistance',
  },
  {
    id: 'fvg',
    category: 'patrones',
    aliases: ['FVG', 'Fair value gap', 'Hueco de valor'],
    related: ['fvg_bullish', 'fvg_bearish'],
    role: 'neutral',
  },
  {
    id: 'bos',
    category: 'patrones',
    aliases: ['BOS', 'Break of structure'],
    related: ['bos_bullish', 'bos_bearish', 'choch'],
    role: 'neutral',
  },
  {
    id: 'choch',
    category: 'patrones',
    aliases: ['CHoCH', 'Change of character'],
    related: ['choch_bullish', 'choch_bearish', 'bos'],
    role: 'neutral',
  },
  {
    id: 'order_block',
    category: 'patrones',
    aliases: ['Order block', 'OB'],
    related: ['order_block_bullish', 'order_block_bearish', 'fvg'],
    role: 'neutral',
  },
  {
    id: 'liquidity_sweep',
    category: 'patrones',
    aliases: ['Barrido de liquidez', 'Barrido', 'Liquidity sweep'],
    related: ['liquidity_sweep_bullish', 'liquidity_sweep_bearish'],
    role: 'neutral',
  },
  {
    id: 'rsi',
    category: 'patrones',
    aliases: ['RSI', 'RSI14', 'RSI 14'],
    related: ['rsi_divergence_bullish', 'rsi_divergence_bearish', 'atr'],
    role: 'context',
  },
  {
    id: 'strength',
    category: 'patrones',
    aliases: ['Fuerza del patrón', 'Fuerza'],
    related: ['confirm', 'invalidate'],
    role: 'context',
  },
  {
    id: 'fear_greed',
    category: 'sentimiento',
    aliases: ['Miedo/Codicia', 'Miedo y codicia', 'Miedo extremo', 'Codicia extrema', 'Miedo', 'Codicia'],
    related: ['funding', 'news', 'change_24h'],
    role: 'context',
  },
  {
    id: 'funding',
    category: 'sentimiento',
    aliases: ['Funding', 'Funding 8h', 'Tasa de financiación'],
    related: ['basis', 'mark_index', 'fear_greed', 'close_1h'],
    role: 'context',
  },
  {
    id: 'basis',
    category: 'sentimiento',
    aliases: ['Basis'],
    related: ['funding', 'mark_index'],
    role: 'context',
  },
  {
    id: 'mark_index',
    category: 'sentimiento',
    aliases: ['Precio mark', 'Precio índice', 'Mark price'],
    related: ['basis', 'funding', 'liquidation'],
    role: 'context',
  },
  {
    id: 'change_24h',
    category: 'sentimiento',
    aliases: ['24h', 'Cambio 24h'],
    related: ['atr', 'move30', 'fear_greed'],
    role: 'context',
  },
  {
    id: 'news',
    category: 'sentimiento',
    aliases: ['Titulares', 'Noticias'],
    related: ['fear_greed', 'change_24h'],
    role: 'context',
  },
  {
    id: 'regime',
    category: 'sentimiento',
    aliases: ['Régimen', 'Tendencia', 'Régimen por temporalidad'],
    related: ['ema50_4h', 'pivot_swing', 'bos'],
    role: 'context',
  },
  {
    id: 'close_15m',
    category: 'cierres',
    aliases: ['Vela 15m'],
    related: ['close_1h', 'utc'],
    role: 'context',
  },
  {
    id: 'close_1h',
    category: 'cierres',
    aliases: ['Cierre 1h'],
    related: ['close_4h', 'funding'],
    role: 'context',
  },
  {
    id: 'close_4h',
    category: 'cierres',
    aliases: ['Cierre 4h'],
    related: ['close_1h', 'close_daily', 'ema50_4h'],
    role: 'context',
  },
  {
    id: 'close_daily',
    category: 'cierres',
    aliases: ['Cierre diario'],
    related: ['dayOpen', 'prevDayHigh', 'close_weekly'],
    role: 'context',
  },
  {
    id: 'close_weekly',
    category: 'cierres',
    aliases: ['Cierre semanal'],
    related: ['close_daily', 'close_monthly', 'weekOpen'],
    role: 'context',
  },
  {
    id: 'close_monthly',
    category: 'cierres',
    aliases: ['Cierre mensual'],
    related: ['close_weekly', 'monthOpen'],
    role: 'context',
  },
  {
    id: 'session_asia',
    category: 'cierres',
    aliases: ['Apertura Asia'],
    related: ['session_europe', 'session_us', 'utc'],
    role: 'context',
  },
  {
    id: 'session_europe',
    category: 'cierres',
    aliases: ['Apertura Europa'],
    related: ['session_asia', 'session_us', 'utc'],
    role: 'context',
  },
  {
    id: 'session_us',
    category: 'cierres',
    aliases: ['Apertura EE.UU.', 'Apertura EEUU'],
    related: ['session_europe', 'session_asia', 'utc'],
    role: 'context',
  },
  {
    id: 'utc',
    category: 'cierres',
    aliases: ['UTC'],
    related: ['close_daily', 'session_asia'],
    role: 'context',
  },
  {
    id: 'cvd',
    category: 'flujo',
    aliases: ['CVD'],
    related: ['delta', 'taker', 'delta_divergence_bullish'],
    role: 'context',
  },
  {
    id: 'delta',
    category: 'flujo',
    aliases: ['Delta', 'Delta de volumen'],
    related: ['cvd', 'taker'],
    role: 'context',
  },
  {
    id: 'taker',
    category: 'flujo',
    aliases: ['Volumen taker', 'Taker'],
    related: ['cvd', 'delta', 'volume_shock_buy'],
    role: 'context',
  },
  {
    id: 'order_book_walls',
    category: 'flujo',
    aliases: ['Muros del libro', 'Muros'],
    related: ['spread', 'liquidations'],
    role: 'context',
  },
  {
    id: 'spread',
    category: 'flujo',
    aliases: ['Spread', 'Precio medio'],
    related: ['order_book_walls'],
    role: 'context',
  },
  {
    id: 'liquidations',
    category: 'flujo',
    aliases: ['Liquidaciones recientes', 'Liquidaciones', 'Liquidación forzosa'],
    related: ['liquidation', 'order_book_walls', 'climax'],
    role: 'context',
  },
  {
    id: 'volume_ratio',
    category: 'flujo',
    aliases: ['Volumen relativo', 'vol ×'],
    related: ['shock', 'volume_shock_buy', 'taker'],
    role: 'context',
  },
  {
    id: 'poc',
    category: 'flujo',
    aliases: ['POC', 'Punto de control'],
    related: ['volume_profile', 'value_area'],
    role: 'neutral',
  },
  {
    id: 'value_area',
    category: 'flujo',
    aliases: ['Área de valor', 'VAH', 'VAL'],
    related: ['poc', 'volume_profile'],
    role: 'neutral',
  },
  {
    id: 'stop_loss',
    category: 'riesgo',
    aliases: ['Stop loss', 'Stop', 'SIN STOP', 'Sin stop'],
    related: ['invalidate', 'loss_at_stop', 'stop_distance', 'liquidation'],
    role: 'context',
  },
  {
    id: 'r_multiple',
    category: 'riesgo',
    aliases: ['R múltiple', 'R nominal medio', 'R neto medio', 'R neto', 'R nominal'],
    related: ['stop_loss', 'loss_at_stop', 'expectancy', 'target_r'],
    role: 'context',
  },
  {
    id: 'leverage',
    category: 'riesgo',
    aliases: ['Apalancamiento'],
    related: ['liquidation', 'notional', 'margin'],
    role: 'context',
  },
  {
    id: 'notional',
    category: 'riesgo',
    aliases: ['Nocional', 'Valor nocional'],
    related: ['leverage', 'position_size', 'fees'],
    role: 'context',
  },
  {
    id: 'stop_distance',
    category: 'riesgo',
    aliases: ['Distancia al stop', 'Distancia stop'],
    related: ['stop_loss', 'atr', 'position_size'],
    role: 'context',
  },
  {
    id: 'loss_at_stop',
    category: 'riesgo',
    aliases: ['Pérdida en stop', 'Pérdida al stop', 'Si el stop salta', 'Riesgo máximo'],
    related: ['stop_loss', 'risk_pct', 'fees'],
    role: 'context',
  },
  {
    id: 'fees',
    category: 'riesgo',
    aliases: ['Comisiones', 'comisiones aprox.', 'Comisión taker'],
    related: ['notional', 'break_even', 'funding'],
    role: 'context',
  },
  {
    id: 'scale_in',
    category: 'riesgo',
    aliases: ['Escalonar en 3 tramos', 'Escalonar'],
    related: ['position_size', 'break_even', 'averaging_down'],
    role: 'context',
  },
  {
    id: 'risk_pct',
    category: 'riesgo',
    aliases: ['Riesgo por operación', 'Riesgo %', 'Riesgo'],
    related: ['loss_at_stop', 'daily_loss', 'position_size'],
    role: 'context',
  },
  {
    id: 'daily_loss',
    category: 'riesgo',
    aliases: ['Pérdida diaria', 'Límite diario', 'Límite de pérdida diaria'],
    related: ['risk_pct', 'revenge'],
    role: 'context',
  },
  {
    id: 'revenge',
    category: 'riesgo',
    aliases: ['Revancha', 'Revenge trade', 'Operación de revancha'],
    related: ['daily_loss', 'averaging_down', 'risk_pct'],
    role: 'context',
  },
  {
    id: 'break_even',
    category: 'riesgo',
    aliases: ['Punto de equilibrio', 'Break-even', 'Breakeven', 'Equilibrio con comisión'],
    related: ['fees', 'scale_in'],
    role: 'context',
  },
  {
    id: 'liquidation',
    category: 'riesgo',
    aliases: ['Liquidación', 'Precio de liquidación'],
    related: ['leverage', 'mark_index', 'liquidations', 'stop_loss'],
    role: 'context',
  },
  {
    id: 'margin',
    category: 'riesgo',
    aliases: ['Margen', 'Margen aportado'],
    related: ['leverage', 'liquidation', 'notional'],
    role: 'context',
  },
  {
    id: 'pnl',
    category: 'riesgo',
    aliases: ['uPnL', 'PnL', 'PnL no realizado'],
    related: ['r_multiple', 'fees'],
    role: 'context',
  },
  {
    id: 'position_size',
    category: 'riesgo',
    aliases: ['Tamaño de la posición', 'Cantidad'],
    related: ['risk_pct', 'stop_distance', 'notional'],
    role: 'context',
  },
  {
    id: 'position_side',
    category: 'riesgo',
    aliases: ['Largo', 'Corto', 'Long', 'Short'],
    related: ['stop_loss', 'funding'],
    role: 'context',
  },
  {
    id: 'expectancy',
    category: 'riesgo',
    aliases: ['Esperanza por operación', 'Esperanza', 'Expectativa'],
    related: ['r_multiple', 'profit_factor'],
    role: 'context',
  },
  {
    id: 'profit_factor',
    category: 'riesgo',
    aliases: ['Factor de beneficio'],
    related: ['expectancy', 'drawdown'],
    role: 'context',
  },
  {
    id: 'drawdown',
    category: 'riesgo',
    aliases: ['Caída máxima', 'Drawdown'],
    related: ['profit_factor', 'daily_loss'],
    role: 'context',
  },
  {
    id: 'averaging_down',
    category: 'riesgo',
    aliases: ['Promediar a la baja', 'Promediar en contra'],
    related: ['revenge', 'scale_in'],
    role: 'context',
  },
  {
    id: 'target_r',
    category: 'riesgo',
    aliases: ['Obj 1R', 'Objetivo 1R', 'Objetivos'],
    related: ['r_multiple', 'stop_loss'],
    role: 'context',
  },
  {
    id: 'move30',
    category: 'escaner',
    aliases: ['Movimiento 30m', 'Movimiento en 30 min', 'move30'],
    related: ['threshold', 'move15', 'follow', 'fade'],
    role: 'context',
  },
  {
    id: 'move15',
    category: 'escaner',
    aliases: ['Movimiento 15m', 'Movimiento en 15 min', 'move15'],
    related: ['move30', 'threshold'],
    role: 'context',
  },
  {
    id: 'follow',
    category: 'escaner',
    aliases: ['FOLLOW · seguir', 'Seguir', 'Follow'],
    related: ['fade', 'hold_1h', 'move30'],
    role: 'context',
  },
  {
    id: 'fade',
    category: 'escaner',
    aliases: ['FADE · contra', 'Contra', 'Revertir', 'Fade'],
    related: ['follow', 'hold_1h', 'move30'],
    role: 'context',
  },
  {
    id: 'hold_1h',
    category: 'escaner',
    aliases: ['Mantener 1h', 'move30_hold1h', 'Mantener 1 hora'],
    related: ['follow', 'fade', 'move30'],
    role: 'context',
  },
  {
    id: 'cooldown',
    category: 'escaner',
    aliases: ['Cooldown', 'Enfriamiento'],
    related: ['threshold', 'move30'],
    role: 'context',
  },
  {
    id: 'threshold',
    category: 'escaner',
    aliases: ['Umbral'],
    related: ['move30', 'cooldown'],
    role: 'context',
  },
  {
    id: 'market_breadth',
    category: 'escaner',
    aliases: ['Amplitud de mercado', 'Movimiento de mercado', 'Movimiento de todo el mercado', 'Pares moviéndose a la vez'],
    related: ['move30', 'relative_strength_btc'],
    role: 'context',
  },
  {
    id: 'relative_strength_btc',
    category: 'escaner',
    aliases: ['Fuerza relativa frente a BTC', 'Fuerza relativa'],
    related: ['market_breadth', 'move30'],
    role: 'context',
  },
  {
    id: 'taker_imbalance',
    category: 'escaner',
    aliases: ['Desequilibrio taker'],
    related: ['taker', 'cvd'],
    role: 'context',
  },
  {
    id: 'grade_no_evidence',
    category: 'escaner',
    aliases: ['Sin evidencia'],
    related: ['grade_promising', 'grade_negative', 'grade_validated', 'sample_size'],
    role: 'context',
  },
  {
    id: 'grade_promising',
    category: 'escaner',
    aliases: ['Prometedora, falta validar', 'Prometedor', 'Prometedora'],
    related: ['grade_validated', 'grade_no_evidence', 'sample_size'],
    role: 'context',
  },
  {
    id: 'grade_negative',
    category: 'escaner',
    aliases: ['Resultado negativo'],
    related: ['grade_no_evidence', 'sample_size'],
    role: 'context',
  },
  {
    id: 'grade_validated',
    category: 'escaner',
    aliases: ['Validada', 'Validado'],
    related: ['grade_promising', 'sample_size'],
    role: 'context',
  },
  {
    id: 'win_rate_ci',
    category: 'escaner',
    aliases: ['Acierto [intervalo]', 'Acierto', 'Ganó 1R', 'Ganó 2R', 'Intervalo de Wilson', 'Intervalo de confianza'],
    related: ['sample_size', 'breakeven_rate', 'grade_promising'],
    role: 'context',
  },
  {
    id: 'breakeven_rate',
    category: 'escaner',
    aliases: ['Equilibrio'],
    related: ['win_rate_ci', 'fees'],
    role: 'context',
  },
  {
    id: 'sample_size',
    category: 'escaner',
    aliases: ['Tamaño de muestra', 'Operaciones (n)', 'Muestra'],
    related: ['win_rate_ci', 'grade_no_evidence'],
    role: 'context',
  },
  {
    id: 'study_in_sample',
    category: 'escaner',
    aliases: ['Estudio en muestra (90 d)', 'Estudio en muestra'],
    related: ['sample_size', 'grade_validated'],
    role: 'context',
  },
  {
    id: 'muted',
    category: 'escaner',
    aliases: ['Silenciadas', 'Silenciadas (celdas negativas)'],
    related: ['grade_negative'],
    role: 'context',
  },
  {
    id: 'volume_tier',
    category: 'escaner',
    aliases: ['Volumen 24h', 'Nivel de volumen'],
    related: ['volume_ratio', 'move30'],
    role: 'context',
  },
  {
    id: 'plan',
    category: 'escaner',
    aliases: ['Plan de medición', 'Geometría de medición'],
    related: ['follow', 'fade', 'target_r'],
    role: 'context',
  },
  {
    id: 'radar',
    category: 'escaner',
    aliases: ['Radar', 'Radar local', 'Alertas activas'],
    related: ['plan', 'target_r'],
    role: 'context',
  },
];

export interface TermMatch {
  id: string;
  /** Texto original coincidente. */
  text: string;
  start: number;
  end: number;
}

const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Minúsculas, sin tildes (NFD), sin espacios ni puntuación en los extremos. */
export function normalizeTerm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(EDGE_PUNCT, '')
    .replace(/\s+/g, ' ');
}

const BY_ID: ReadonlyMap<string, GlossaryEntry> = new Map(GLOSSARY.map((entry) => [entry.id, entry]));

const BY_ALIAS: ReadonlyMap<string, GlossaryEntry> = (() => {
  const map = new Map<string, GlossaryEntry>();
  for (const entry of GLOSSARY) {
    for (const alias of entry.aliases) {
      const key = normalizeTerm(alias);
      if (key && !map.has(key)) map.set(key, entry);
    }
  }
  return map;
})();

/** Alias normalizados, del más largo al más corto, para buscar sin solapes. */
const ALIASES_LONGEST_FIRST: ReadonlyArray<{ key: string; entry: GlossaryEntry }> = [...BY_ALIAS]
  .map(([key, entry]) => ({ key, entry }))
  .sort((a, b) => b.key.length - a.key.length || a.key.localeCompare(b.key));

export function entryById(id: string): GlossaryEntry | undefined {
  return BY_ID.get(id);
}

/** Entrada cuyo alias coincide con el texto completo (normalizado). */
export function entryForText(text: string): GlossaryEntry | undefined {
  if (typeof text !== 'string') return undefined;
  const key = normalizeTerm(text);
  return key ? BY_ALIAS.get(key) : undefined;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * Términos dentro de un texto libre: coincidencias sin solape, primero los alias
 * más largos, con límites de palabra. Los offsets son del texto original.
 */
export function termsInText(text: string): TermMatch[] {
  if (typeof text !== 'string' || !text) return [];
  // Texto normalizado carácter a carácter con mapa a los offsets originales.
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const unit of piece) {
      norm += unit;
      for (let i = 0; i < unit.length; i += 1) {
        starts.push(index);
        ends.push(index + ch.length);
      }
    }
    index += ch.length;
  }
  const taken: Array<[number, number]> = [];
  const found: TermMatch[] = [];
  for (const { key, entry } of ALIASES_LONGEST_FIRST) {
    let from = 0;
    for (;;) {
      const at = norm.indexOf(key, from);
      if (at < 0) break;
      from = at + 1;
      const last = at + key.length - 1;
      if (isWordChar(norm[at - 1]) || isWordChar(norm[last + 1])) continue;
      const start = starts[at];
      const end = ends[last];
      if (start === undefined || end === undefined) continue;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      found.push({ id: entry.id, text: text.slice(start, end), start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
