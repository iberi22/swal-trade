import json
import os
import sqlite3
import time
import math
import secrets
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

DEFAULT_DB_PATH = os.path.expanduser('~/.local/share/swal-trade/radar.db')
DEFAULT_TOKEN_FILE = os.path.expanduser('~/.config/swal-trade/radar-token')
Z95 = 1.959963984540054


DEDUPE_BARS = 96
TF_SECONDS = {'1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400}

def wilson_interval(hits: int, n: int, z: float = Z95) -> Dict[str, Optional[float]]:
    if not n or hits is None or n <= 0:
        return {'rate': None, 'low': None, 'high': None}
    p = hits / n
    z2 = z * z
    denom = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    margin = (z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
    return {
        'rate': round(p, 4),
        'low': round(max(0.0, center - margin), 4),
        'high': round(min(1.0, center + margin), 4),
    }

def format_ts(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return None

def get_or_create_token(token_file: Optional[str] = None) -> str:
    env_token = os.environ.get('RADAR_TOKEN')
    if env_token:
        return env_token.strip()

    path = token_file or os.environ.get('RADAR_TOKEN_FILE') or DEFAULT_TOKEN_FILE
    path = os.path.abspath(os.path.expanduser(path))

    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            token = f.read().strip()
            if token:
                return token

    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    token = secrets.token_hex(24)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(token + '\n')
    return token

class RadarStore:
    def __init__(self, db_path: Optional[str] = None):
        raw_path = db_path or os.environ.get('RADAR_DB') or DEFAULT_DB_PATH
        self.db_path = os.path.abspath(os.path.expanduser(raw_path))
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode = WAL;')
        conn.execute('PRAGMA busy_timeout = 5000;')
        conn.execute('PRAGMA foreign_keys = ON;')
        return conn

    def _init_db(self):
        with self.get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS schema_version (
                    version INTEGER PRIMARY KEY
                );
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL DEFAULT 'core',
                    symbol TEXT NOT NULL,
                    tf TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    entry REAL NOT NULL,
                    stop REAL NOT NULL,
                    target_1r REAL NOT NULL,
                    target_2r REAL NOT NULL,
                    strength REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at REAL NOT NULL,
                    triggered_at REAL,
                    resolved_at REAL,
                    outcome_r REAL,
                    mfe_r REAL NOT NULL DEFAULT 0.0,
                    mae_r REAL NOT NULL DEFAULT 0.0,
                    net_r REAL,
                    minutes_to_trigger INTEGER,
                    minutes_to_outcome INTEGER,
                    taken_by_user INTEGER NOT NULL DEFAULT 0,
                    user_entry REAL,
                    user_pnl REAL,
                    user_note TEXT,
                    dedupe_key TEXT NOT NULL
                );
            """)
            conn.execute('CREATE INDEX IF NOT EXISTS idx_alerts_symbol_tf ON alerts (symbol, tf);')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts (dedupe_key);')

            conn.execute("""
                CREATE TABLE IF NOT EXISTS user_trades (
                    id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    order_id TEXT,
                    side TEXT NOT NULL,
                    price REAL NOT NULL,
                    qty REAL NOT NULL,
                    time REAL NOT NULL,
                    alert_id INTEGER,
                    realized_pnl REAL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY(alert_id) REFERENCES alerts(id)
                );
            """)
            conn.execute('CREATE INDEX IF NOT EXISTS idx_user_trades_symbol ON user_trades (symbol);')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_user_trades_alert ON user_trades (alert_id);')

            cols = [r['name'] for r in conn.execute('PRAGMA table_info(alerts);').fetchall()]
            if 'meta' not in cols:
                conn.execute('ALTER TABLE alerts ADD COLUMN meta TEXT;')

            cur = conn.execute('SELECT version FROM schema_version;')
            row = cur.fetchone()
            if not row:
                conn.execute('INSERT INTO schema_version (version) VALUES (1);')

    def create_alert(self, alert: Dict[str, Any]) -> Optional[int]:
        dedupe_key = alert['dedupe_key']
        now = alert.get('created_at') or time.time()
        # The same setup must not come back as a new alert once it resolved: dedupe over
        # its whole lifetime window (96 bars of its timeframe), whatever its status.
        window = DEDUPE_BARS * TF_SECONDS.get(str(alert.get('tf', '15m')).lower(), 900)
        with self.get_connection() as conn:
            cur = conn.execute(
                'SELECT id FROM alerts WHERE dedupe_key = ? AND created_at > ?;',
                (dedupe_key, now - window)
            )
            if cur.fetchone():
                return None

            cur = conn.execute("""
                INSERT INTO alerts (
                    source, symbol, tf, kind, title, direction,
                    entry, stop, target_1r, target_2r, strength,
                    status, created_at, mfe_r, mae_r, dedupe_key, meta
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, 0.0, ?, ?);
            """, (
                alert.get('source', 'core'),
                alert['symbol'],
                alert['tf'],
                alert['kind'],
                alert['title'],
                alert['direction'],
                float(alert['entry']),
                float(alert['stop']),
                float(alert['target_1r']),
                float(alert['target_2r']),
                float(alert.get('strength', 0.5)),
                alert.get('status', 'pending'),
                float(now),
                dedupe_key,
                json.dumps(alert['meta'], separators=(',', ':'), sort_keys=True) if alert.get('meta') else None
            ))
            return cur.lastrowid

    def get_alert(self, alert_id: int) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            cur = conn.execute('SELECT * FROM alerts WHERE id = ?;', (alert_id,))
            row = cur.fetchone()
            if not row:
                return None
            d = dict(row)
            raw = d.pop('meta', None)
            if raw:
                try:
                    d['meta'] = json.loads(raw)
                except ValueError:
                    pass
            return d

    def update_alert(self, alert_id: int, updates: Dict[str, Any]) -> bool:
        if not updates:
            return False
        fields = []
        vals = []
        for k, v in updates.items():
            fields.append(f'{k} = ?')
            vals.append(v)
        vals.append(alert_id)
        sql = f'UPDATE alerts SET {", ".join(fields)} WHERE id = ?;'
        with self.get_connection() as conn:
            cur = conn.execute(sql, vals)
            return cur.rowcount > 0

    def get_active_alerts(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM alerts WHERE status IN ('pending', 'triggered')"
        args = []
        if symbol:
            sql += ' AND symbol = ?'
            args.append(symbol)
        sql += ' ORDER BY id ASC;'
        with self.get_connection() as conn:
            cur = conn.execute(sql, args)
            return [dict(r) for r in cur.fetchall()]

    def list_alerts(self, status: str = 'all', limit: int = 50, min_grade: Optional[str] = None, sort: Optional[str] = None) -> List[Dict[str, Any]]:
        sql = 'SELECT * FROM alerts'
        args = []
        status = (status or 'all').lower()
        if status == 'active':
            sql += " WHERE status IN ('pending', 'triggered')"
        elif status == 'resolved':
            sql += " WHERE status IN ('win_1r', 'win_2r', 'loss', 'expired')"

        # Fetch all matching alerts first, no limit or order yet
        with self.get_connection() as conn:
            cur = conn.execute(sql, args)
            rows = [dict(r) for r in cur.fetchall()]

        out = []
        for r in rows:
            out.append({
                'id': r['id'],
                'source': r['source'],
                'symbol': r['symbol'],
                'tf': r['tf'],
                'kind': r['kind'],
                'title': r['title'],
                'direction': r['direction'],
                'entry': r['entry'],
                'stop': r['stop'],
                'target_1r': r['target_1r'],
                'target_2r': r['target_2r'],
                'strength': r['strength'],
                'status': r['status'],
                'created_at': format_ts(r['created_at']),
                'triggered_at': format_ts(r['triggered_at']),
                'resolved_at': format_ts(r['resolved_at']),
                'outcome_r': r['outcome_r'],
                'mfe_r': r['mfe_r'],
                'mae_r': r['mae_r'],
                'taken_by_user': bool(r['taken_by_user']),
                'user_entry': r['user_entry'],
                'user_pnl': r['user_pnl'],
            })
            if r.get('meta'):
                try:
                    out[-1]['meta'] = json.loads(r['meta'])
                except ValueError:
                    pass

        # Apply cell grading and map to results
        stats = self.get_stats()
        cell_map = {}
        for row in stats.get('by_kind', []):
            k = (row.get('source', 'core'), row.get('kind', ''), row.get('tf', ''), row.get('direction', ''))
            cell_map[k] = {'grade': row.get('grade', 'no_evidence'), 'n': row.get('n_resolved', 0)}

        for a in out:
            k = (a.get('source', 'core'), a.get('kind', ''), a.get('tf', ''), a.get('direction', ''))
            info = cell_map.get(k, {'grade': 'no_evidence', 'n': 0})
            a['cell_grade'] = info['grade']
            a['cell_n'] = info['n']

        if min_grade:
            weights = {'negative': 0, 'no_evidence': 1, 'promising': 2, 'validated': 3}
            min_weight = weights.get(min_grade, -1)
            out = [a for a in out if weights.get(a.get('cell_grade', 'no_evidence'), -1) >= min_weight]

        if sort == 'grade':
            weights = {'negative': 0, 'no_evidence': 1, 'promising': 2, 'validated': 3}
            out.sort(key=lambda x: (weights.get(x.get('cell_grade', 'no_evidence'), -1), x.get('id', 0)), reverse=True)
        else:
            out.sort(key=lambda x: x.get('id', 0), reverse=True)

        capped_limit = max(1, min(limit, 500))
        return out[:capped_limit]

    def link_user_trade(self, trade: Dict[str, Any]) -> Optional[int]:
        trade_id = str(trade['id'])
        symbol = trade['symbol']
        order_id = str(trade.get('orderId', ''))
        side = trade['side'].upper()
        price = float(trade['price'])
        qty = float(trade['qty'])
        trade_time = float(trade['time'])
        if trade_time > 1e11:
            trade_time /= 1000.0
        realized_pnl = float(trade.get('realizedPnl', 0.0))

        direction = 'long' if side == 'BUY' else 'short'

        with self.get_connection() as conn:
            cur = conn.execute('SELECT id, alert_id FROM user_trades WHERE id = ?;', (trade_id,))
            existing = cur.fetchone()
            if existing:
                return existing['alert_id']

            cur = conn.execute("""
                SELECT id, entry, created_at, triggered_at FROM alerts
                WHERE symbol = ? AND direction = ?
                  AND created_at <= ?
                  AND (triggered_at IS NULL OR ? <= (triggered_at + 900))
                ORDER BY ABS(? - COALESCE(triggered_at, created_at)) ASC
                LIMIT 1;
            """, (symbol, direction, trade_time + 60, trade_time, trade_time))
            match = cur.fetchone()
            alert_id = match['id'] if match else None

            conn.execute("""
                INSERT INTO user_trades (id, symbol, order_id, side, price, qty, time, alert_id, realized_pnl, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """, (trade_id, symbol, order_id, side, price, qty, trade_time, alert_id, realized_pnl, time.time()))

            if alert_id:
                conn.execute("""
                    UPDATE alerts SET taken_by_user = 1, user_entry = ?
                    WHERE id = ? AND (user_entry IS NULL OR user_entry = 0);
                """, (price, alert_id))
            return alert_id

    def update_user_pnl(self, symbol: str, realized_pnl: float):
        with self.get_connection() as conn:
            cur = conn.execute("""
                SELECT id FROM alerts
                WHERE symbol = ? AND taken_by_user = 1
                ORDER BY id DESC LIMIT 1;
            """, (symbol,))
            row = cur.fetchone()
            if row:
                conn.execute('UPDATE alerts SET user_pnl = ? WHERE id = ?;', (realized_pnl, row['id']))

    def get_stats(self) -> Dict[str, Any]:
        with self.get_connection() as conn:
            cur = conn.execute('SELECT * FROM alerts;')
            all_alerts = [dict(r) for r in cur.fetchall()]

        from radar.grading import grade_cell

        def calc_group(group: List[Dict[str, Any]]) -> Dict[str, Any]:
            # Only real trades count: alerts that triggered and then resolved. An alert
            # that expired untriggered or whose entry was passed before it existed
            # ('missed') never was a trade.
            resolved = [a for a in group if a['status'] in ('win_1r', 'win_2r', 'loss')
                        or (a['status'] == 'expired' and a.get('triggered_at') is not None)]
            n = len(resolved)
            total = len(group)
            triggered = sum(1 for a in group if a['triggered_at'] is not None or a['status'] in ('triggered', 'win_1r', 'win_2r', 'loss'))
            trig_rate = round(triggered / total, 4) if total > 0 else 0.0

            hits_1r = sum(1 for a in resolved if a['status'] in ('win_1r', 'win_2r'))
            hits_2r = sum(1 for a in resolved if a['status'] == 'win_2r')

            win_rate_1r = round(hits_1r / n, 4) if n > 0 else 0.0
            win_rate_2r = round(hits_2r / n, 4) if n > 0 else 0.0

            ci_1r = wilson_interval(hits_1r, n)
            ci_2r = wilson_interval(hits_2r, n)

            net_rs = [a['net_r'] for a in resolved if a.get('net_r') is not None]
            avg_net_r = round(sum(net_rs) / len(net_rs), 4) if net_rs else 0.0

            label = ('sin evidencia (n<30)' if n < 30 else
                     ('R neto medio positivo, falta validar' if avg_net_r > 0 else 'R neto medio negativo'))
                     
            g = grade_cell(n, hits_1r, net_rs)

            return {
                'n_resolved': n,
                'triggered_rate': trig_rate,
                'win_rate_1r': win_rate_1r,
                'ci_1r': ci_1r,
                'win_rate_2r': win_rate_2r,
                'ci_2r': ci_2r,
                'avg_net_r': avg_net_r,
                'label': label,
                'grade': g['grade'],
                'reasons': g['reasons'],
                'wilson_low': g['wilson_low'],
                'wilson_high': g['wilson_high'],
                'breakeven': g['breakeven'],
                'mean_net_r_ci': g['mean_net_r_ci'],
            }

        overall = calc_group(all_alerts)
        taken_group = [a for a in all_alerts if a.get('taken_by_user') == 1]
        taken = calc_group(taken_group)

        kinds = {}
        for a in all_alerts:
            key = (a.get('source', 'core'), a.get('kind', ''), a.get('tf', ''), a.get('direction', ''))
            kinds.setdefault(key, []).append(a)

        by_kind = []
        for (src, kind, tf, direction), grp in sorted(kinds.items()):
            cg = calc_group(grp)
            by_kind.append({
                'source': src,
                'kind': kind,
                'tf': tf,
                'direction': direction,
                **cg
            })

        note = 'Un alerta es un experimento, nunca una promesa; nuestro backtest no halló evidencia de superar el azar (sin evidencia). Estadísticas muestran intervalos Wilson 95%. Una calificación es una medición de alertas pasadas, no una recomendación. Para la etiqueta \'validated\' se requiere n >= 100.'
        return {
            'overall': overall,
            'by_kind': by_kind,
            'taken': taken,
            'note': note,
        }
