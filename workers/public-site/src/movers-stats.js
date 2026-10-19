/**
 * Contrato swal.movers-stats.v1: estadisticas agregadas por celda (senal x modo x umbral x ...).
 * Solo agregados: nunca datos por evento ni por operacion.
 */

const STR_REGEX = /^[A-Za-z0-9_ .:-]+$/;
const SPEC_REGEX = /^[A-Za-z0-9._-]+$/;
const SIGNAL_REGEX = /^[a-z0-9_]{1,24}$/;
const GRADES = ['no_evidence', 'negative', 'promising', 'validated'];
const EPS = 1e-9;

export const MOVERS_STATS_MAX_CELLS = 500;

const TOP_KEYS = ['schema', 'method', 'spec_version', 'period', 'universe', 'bar', 'cost_round_trip', 'evaluator', 'generated_at', 'cells', 'note'];
const REQUIRED_TOP_KEYS = TOP_KEYS.filter((k) => k !== 'generated_at' && k !== 'note');
const CELL_KEYS = [
  'signal', 'mode', 'direction', 'threshold', 'vol_tier', 'context', 'n', 'n_clusters', 'wins_1r',
  'win_rate', 'ci_low', 'ci_high', 'breakeven', 'mean_net_r', 'net_r_ci_low', 'net_r_ci_high',
  'median_stop_pct', 'events_per_day', 'grade',
];

function isObj(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function checkStr(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && STR_REGEX.test(s);
}
function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}
function isUnit(x) {
  return isNum(x) && x >= 0 && x <= 1;
}
function isInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}
function sameKeys(obj, allowed, required) {
  const keys = Object.keys(obj);
  return keys.every((k) => allowed.includes(k)) && required.every((k) => keys.includes(k));
}

function validateCell(cell) {
  if (!isObj(cell)) return 'Invalid cell';
  const keys = Object.keys(cell);
  if (keys.length !== CELL_KEYS.length || !keys.every((k) => CELL_KEYS.includes(k))) return 'Invalid cell keys';

  if (typeof cell.signal !== 'string' || !SIGNAL_REGEX.test(cell.signal)) return 'Invalid signal';
  if (cell.mode !== 'fade' && cell.mode !== 'follow') return 'Invalid mode';
  if (cell.direction !== 'long' && cell.direction !== 'short') return 'Invalid direction';
  if (![3, 5, 7].includes(cell.threshold)) return 'Invalid threshold';
  if (!['hi', 'mid', 'lo'].includes(cell.vol_tier)) return 'Invalid vol_tier';
  if (!['all', 'market_wide', 'idio'].includes(cell.context)) return 'Invalid context';

  if (!isInt(cell.n) || cell.n < 0) return 'Invalid n';
  if (!isInt(cell.n_clusters) || cell.n_clusters < 0 || cell.n_clusters > cell.n) return 'Invalid n_clusters';
  if (!isInt(cell.wins_1r) || cell.wins_1r < 0 || cell.wins_1r > cell.n) return 'Invalid wins_1r';

  for (const k of ['win_rate', 'ci_low', 'ci_high', 'breakeven']) {
    if (!isUnit(cell[k])) return `Invalid ${k}`;
  }
  if (cell.ci_low > cell.win_rate || cell.win_rate > cell.ci_high) return 'Invalid confidence interval';

  for (const k of ['mean_net_r', 'net_r_ci_low', 'net_r_ci_high']) {
    if (!isNum(cell[k]) || Math.abs(cell[k]) > 10) return `Invalid ${k}`;
  }
  if (cell.net_r_ci_low > cell.mean_net_r || cell.mean_net_r > cell.net_r_ci_high) return 'Invalid net_r interval';

  if (!isNum(cell.median_stop_pct) || cell.median_stop_pct < 0 || cell.median_stop_pct > 0.2) return 'Invalid median_stop_pct';
  if (!isNum(cell.events_per_day) || cell.events_per_day < 0) return 'Invalid events_per_day';

  if (!GRADES.includes(cell.grade)) return 'Invalid grade';
  if (cell.grade === 'validated') {
    if (cell.n_clusters < 100 || cell.ci_low < cell.breakeven + 0.02 - EPS || !(cell.net_r_ci_low > 0)) {
      return 'Grade validated not supported by evidence';
    }
  } else if (cell.grade === 'promising') {
    if (cell.n_clusters < 30 || !(cell.net_r_ci_low > 0)) return 'Grade promising not supported by evidence';
  } else if (cell.grade === 'negative') {
    if (cell.n_clusters < 30 || !(cell.net_r_ci_high < 0)) return 'Grade negative not supported by evidence';
  }
  return null;
}

/**
 * Valida de forma estricta un payload swal.movers-stats.v1 y devuelve una copia saneada.
 * @param {any} body
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function validateMoversStats(body) {
  if (!isObj(body)) return { ok: false, error: 'Expected JSON object' };
  if (!sameKeys(body, TOP_KEYS, REQUIRED_TOP_KEYS)) return { ok: false, error: 'Invalid keys' };
  if (body.schema !== 'swal.movers-stats.v1') return { ok: false, error: 'Invalid schema' };
  if (body.method !== 'study' && body.method !== 'forward') return { ok: false, error: 'Invalid method' };
  if (typeof body.spec_version !== 'string' || body.spec_version.length === 0 || body.spec_version.length > 40
      || !SPEC_REGEX.test(body.spec_version)) {
    return { ok: false, error: 'Invalid spec_version' };
  }

  if (!isObj(body.period) || !sameKeys(body.period, ['from', 'to'], ['from', 'to'])
      || !checkStr(body.period.from, 64) || !checkStr(body.period.to, 64)) {
    return { ok: false, error: 'Invalid period' };
  }

  const u = body.universe;
  if (!isObj(u) || !sameKeys(u, ['quote', 'top_n', 'rank_rule'], ['quote', 'top_n', 'rank_rule'])
      || (u.quote !== 'USDT' && u.quote !== 'USDC')
      || !isInt(u.top_n) || u.top_n < 1 || u.top_n > 1000
      || !checkStr(u.rank_rule, 64)) {
    return { ok: false, error: 'Invalid universe' };
  }

  if (body.bar !== '5m') return { ok: false, error: 'Invalid bar' };
  if (!isNum(body.cost_round_trip) || body.cost_round_trip < 0 || body.cost_round_trip > 0.05) {
    return { ok: false, error: 'Invalid cost_round_trip' };
  }
  if (!checkStr(body.evaluator, 64)) return { ok: false, error: 'Invalid evaluator' };

  if (!Array.isArray(body.cells)) return { ok: false, error: 'cells must be an array' };
  if (body.cells.length > MOVERS_STATS_MAX_CELLS) return { ok: false, error: 'cells array too large' };

  const res = {
    schema: 'swal.movers-stats.v1',
    method: body.method,
    spec_version: body.spec_version,
    period: { from: body.period.from, to: body.period.to },
    universe: { quote: u.quote, top_n: u.top_n, rank_rule: u.rank_rule },
    bar: '5m',
    cost_round_trip: body.cost_round_trip,
    evaluator: body.evaluator,
  };
  if (body.generated_at !== undefined && body.generated_at !== null) {
    if (typeof body.generated_at !== 'string' || body.generated_at.length > 64 || isNaN(Date.parse(body.generated_at))) {
      return { ok: false, error: 'Invalid generated_at' };
    }
    res.generated_at = body.generated_at;
  }

  res.cells = [];
  for (const cell of body.cells) {
    const err = validateCell(cell);
    if (err) return { ok: false, error: err };
    const copy = {};
    for (const k of CELL_KEYS) copy[k] = cell[k];
    res.cells.push(copy);
  }

  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 300) return { ok: false, error: 'Invalid note' };
    res.note = body.note;
  }
  return { ok: true, value: res };
}
