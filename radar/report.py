import argparse
import json
import os
import sqlite3
from typing import Dict, Any, List, Optional

from radar.grading import grade_cell, wilson_bounds

from radar.store import RadarStore

def get_forward_cells(db_path: str) -> List[Dict[str, Any]]:
    """
    Reads forward cells from the database using a read-only connection.
    Groups resolved alerts by kind, tf, and direction, and grades them.
    """
    if not os.path.exists(db_path):
        return []

    # Bypass RadarStore's init to avoid creating the DB/tables if it doesn't exist
    store = RadarStore.__new__(RadarStore)
    store.db_path = os.path.abspath(os.path.expanduser(db_path))

    # Overwrite get_connection to enforce read-only
    def _get_ro_connection() -> sqlite3.Connection:
        db_uri = f"file:{store.db_path}?mode=ro"
        conn = sqlite3.connect(db_uri, uri=True, timeout=10.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    store.get_connection = _get_ro_connection

    # We need the raw alerts to correctly compute grade_cell (we need the array of net_rs)
    # store.get_stats() aggregates them and doesn't return `net_rs`. We use list_alerts('all')
    # and filter for resolved ones.
    alerts = store.list_alerts('resolved')

    groups = {}
    for a in alerts:
        # Replicate the logic in get_stats for what is a "resolved" trade
        if not (a['status'] in ('win_1r', 'win_2r', 'loss') or (a['status'] == 'expired' and a.get('triggered_at') is not None)):
            continue

        key = (a.get('kind', ''), a.get('tf', ''), a.get('direction', ''))
        if key not in groups:
            groups[key] = {'n': 0, 'wins': 0, 'net_rs': []}
        groups[key]['n'] += 1
        if a['status'] in ('win_1r', 'win_2r'):
            groups[key]['wins'] += 1
        if a.get('net_r') is not None:
            groups[key]['net_rs'].append(a['net_r'])
        elif a.get('outcome_r') is not None:
            groups[key]['net_rs'].append(a['outcome_r'])

    cells = []
    for (kind, tf, direction), data in groups.items():
        n = data['n']
        wins = data['wins']
        net_rs = data['net_rs']
        grade_info = grade_cell(n, wins, net_rs)
        cells.append({
            'kind': kind,
            'tf': tf,
            'direction': direction,
            'n': n,
            'wins_1r': wins,
            'mean_net_r': grade_info['mean_net_r'],
            'wilson_low': grade_info['wilson_low'],
            'wilson_high': grade_info['wilson_high'],
            'breakeven': grade_info['breakeven'],
            'grade': grade_info['grade']
        })
    return cells

def escape_pipe(text: str) -> str:
    return str(text).replace('|', '&#124;')

def build_report(forward_cells: List[Dict[str, Any]], replay_summary: Optional[Dict[str, Any]] = None, fmt: str = 'md', min_n: int = 1) -> str:
    """
    Builds the report string (Markdown or JSON).
    """
    grade_order = {'validated': 0, 'promising': 1, 'no_evidence': 2, 'negative': 3}

    def sort_cells(cells):
        return sorted(cells, key=lambda c: (grade_order.get(c.get('grade', 'no_evidence'), 99), -c.get('n', 0)))

    forward = [c for c in forward_cells if c.get('n', 0) >= min_n]
    forward = sort_cells(forward)

    replay_cells = []
    if replay_summary and 'cells' in replay_summary:
        replay_cells = [c for c in replay_summary['cells'] if c.get('n', 0) >= min_n]
        # Replay doesn't natively come graded in summary, grade it now
        for rc in replay_cells:
            if 'grade' not in rc:
                net_rs = [rc.get('mean_net_r', 0.0)] * rc['n'] if rc.get('mean_net_r') else []
                gr = grade_cell(rc['n'], rc.get('wins_1r', 0), net_rs)
                rc['grade'] = gr['grade']
                rc['wilson_low'] = gr['wilson_low']
                rc['wilson_high'] = gr['wilson_high']
                rc['breakeven'] = gr['breakeven']
        replay_cells = sort_cells(replay_cells)

    if fmt == 'json':
        out = {'forward': forward}
        if replay_summary:
            out['replay'] = replay_cells
        return json.dumps(out, indent=2)

    lines = ["# Radar Report"]
    lines.append("")
    lines.append("> Medición, no recomendación")
    lines.append("")

    lines.append("## Forward (tiempo real)")
    lines.append("| Kind | TF | Dir | n | Win% 1R | Wilson L-H | Break | Mean R | Grade |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for c in forward:
        n = c['n']
        wlow = c.get('wilson_low')
        whigh = c.get('wilson_high')
        wilson_str = f"{wlow*100:.1f}% - {whigh*100:.1f}%" if wlow is not None else "-"
        be = c.get('breakeven', 0)
        be_str = f"{be*100:.1f}%" if be is not None else "-"
        mean_r = c.get('mean_net_r', 0.0)

        if n < 30:
            win_str = "sin evidencia"
            wilson_str = "sin evidencia"
        else:
            win_pct = (c['wins_1r'] / n * 100) if n > 0 else 0.0
            win_str = f"{win_pct:.1f}%"

        row = [
            escape_pipe(c['kind']),
            escape_pipe(c['tf']),
            escape_pipe(c['direction']),
            str(n),
            win_str,
            wilson_str,
            be_str,
            f"{mean_r:.3f}",
            escape_pipe(c.get('grade', 'no_evidence'))
        ]
        lines.append("| " + " | ".join(row) + " |")

    if replay_summary:
        lines.append("")
        lines.append("## Replay (en muestra, no es evidencia)")
        lines.append("| Kind | TF | Dir | n | Win% 1R | Wilson L-H | Break | Mean R | Grade |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for c in replay_cells:
            n = c['n']
            wlow = c.get('wilson_low')
            whigh = c.get('wilson_high')
            wilson_str = f"{wlow*100:.1f}% - {whigh*100:.1f}%" if wlow is not None else "-"
            be = c.get('breakeven', 0)
            be_str = f"{be*100:.1f}%" if be is not None else "-"
            mean_r = c.get('mean_net_r', 0.0)

            if n < 30:
                win_str = "sin evidencia"
                wilson_str = "sin evidencia"
            else:
                win_pct = (c.get('wins_1r', 0) / n * 100) if n > 0 else 0.0
                win_str = f"{win_pct:.1f}%"

            row = [
                escape_pipe(c['kind']),
                escape_pipe(c['tf']),
                escape_pipe(c['direction']),
                str(n),
                win_str,
                wilson_str,
                be_str,
                f"{mean_r:.3f}",
                escape_pipe(c.get('grade', 'no_evidence'))
            ]
            lines.append("| " + " | ".join(row) + " |")

        lines.append("")
        lines.append("## Confluencia")
        lines.append("| Cell | Trend 4H True | Trend 4H False |")
        lines.append("|---|---|---|")
        for c in replay_cells:
            f = c.get('features', {}).get('trend_4h_aligned', {})
            t_true = f.get('true', {'n': 0, 'wins_1r': 0})
            t_false = f.get('false', {'n': 0, 'wins_1r': 0})

            def render_conf(d):
                n = d.get('n', 0)
                w = d.get('wins_1r', 0)
                if n < 30:
                    return f"n={n} (sin evidencia)"
                p = w / n * 100
                lw, hw = wilson_bounds(w, n)
                return f"{p:.1f}% (W: {lw*100:.1f}-{hw*100:.1f}%) n={n}"

            c_name = f"{c['kind']} {c['tf']} {c['direction']}"
            r_true = render_conf(t_true)
            r_false = render_conf(t_false)

            # Print if either side has data, or just all cells if they exist
            if t_true.get('n', 0) > 0 or t_false.get('n', 0) > 0:
                lines.append(f"| {escape_pipe(c_name)} | {escape_pipe(r_true)} | {escape_pipe(r_false)} |")

    return "\n".join(lines) + "\n"

def main():
    parser = argparse.ArgumentParser(description="Radar Report")

    default_db = os.environ.get('RADAR_DB') or os.path.expanduser('~/.local/share/swal-trade/radar.db')

    parser.add_argument('--db', default=default_db)
    parser.add_argument('--replay', type=str, help="Path to replay summary JSON")
    parser.add_argument('--format', choices=['md', 'json'], default='md')
    parser.add_argument('--min-n', type=int, default=1)
    args = parser.parse_args()

    forward_cells = get_forward_cells(args.db)

    replay_summary = None
    if args.replay and os.path.exists(args.replay):
        with open(args.replay, 'r', encoding='utf-8') as f:
            replay_summary = json.load(f)

    report_str = build_report(forward_cells, replay_summary, fmt=args.format, min_n=args.min_n)
    print(report_str, end='')

if __name__ == '__main__':
    main()
