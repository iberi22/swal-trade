import os
import sys

# Ensure package root is in sys.path when executed directly or via -m
_here = os.path.dirname(os.path.abspath(__file__))
_parent = os.path.dirname(_here)
if _parent not in sys.path:
    sys.path.insert(0, _parent)
import os
import sys
import time
import signal
import threading
import argparse
from datetime import datetime, timezone
from typing import Dict, Any, List

from radar.store import RadarStore, get_or_create_token, format_ts
from radar.binance import BinanceClient
from radar.sources.core import CoreSource
from radar.evaluate import evaluate_alert_on_candles
from radar.api import create_api_server
from radar import heartbeat
from radar.retention import prune_alerts
from radar.notify import Notifier

DEFAULT_SYMBOLS = ['BTCUSDC', 'ETHUSDC']
DEFAULT_TFS = ['15m', '1h']
DEFAULT_PORT = 47322


def backoff_seconds(consecutive_failures: int) -> int:
    return min(60, 2 ** consecutive_failures)


def run_cycle(store, binance_client, core_source, symbols, tfs, last_closed_times, state, loop_count, notifier=None):
    now_ts = time.time()
    state['last_scan'] = format_ts(now_ts)

    # 1. Detection on closed candle
    fed = False
    new_alerts = []
    for sym in symbols:
        for tf in tfs:
            try:
                candles = binance_client.fetch_klines(sym, tf, 300)
                if not candles:
                    continue
                fed = True
                last_candle_time = candles[-1]['time']
                key = (sym, tf)
                if last_closed_times.get(key) != last_candle_time:
                    last_closed_times[key] = last_candle_time
                    findings = core_source.scan(sym, tf, candles)
                    for alert in findings:
                        aid = store.create_alert(alert)
                        if aid:
                            alert_copy = dict(alert)
                            alert_copy['id'] = aid
                            new_alerts.append(alert_copy)
            except Exception as e:
                print(f'radar: detection failed for {sym}: {e.__class__.__name__}')
                state['errors'] = state.get('errors', 0) + 1

    if notifier:
        try:
            notifier.notify_new(new_alerts)
        except Exception as e:
            print(f'radar: notify_new failed: {e.__class__.__name__}')

    # 2. Evaluation on 1m klines
    active = store.get_active_alerts()
    m1_cache = {}
    for sym in set(a['symbol'] for a in active):
        try:
            m1_cache[sym] = binance_client.fetch_klines(sym, '1m', 150)
        except Exception:
            m1_cache[sym] = []

    for alert in active:
        try:
            sym = alert['symbol']
            m1_candles = m1_cache.get(sym) or []
            if m1_candles:
                upd = evaluate_alert_on_candles(alert, m1_candles)
                if upd.get('status') != alert.get('status'):
                    store.update_alert(alert['id'], upd)
        except Exception as e:
            print(f'radar: evaluation failed for {alert["id"]}: {e.__class__.__name__}')
            state['errors'] = state.get('errors', 0) + 1

    # 3. User trades sync every 2 minutes (every 2 loops)
    if loop_count % 2 == 0:
        try:
            sync_user_trades(binance_client, store, symbols)
        except Exception:
            pass

    # 4. Latido al dead-man del Worker
    if fed:
        heartbeat.ping()

    # 5. Retention
    if loop_count % 60 == 0:
        retention_days = os.environ.get('RADAR_RETENTION_DAYS')
        if retention_days:
            try:
                days = int(retention_days)
                if days > 0:
                    prune_alerts(store, days)
            except ValueError:
                pass


def parse_args():
    parser = argparse.ArgumentParser(description='Swal Radar — Always-on pattern alerts and forward evaluation')
    parser.add_argument('--once', action='store_true', help='Scan once, evaluate once, print summary and exit')
    parser.add_argument('--port', type=int, default=int(os.environ.get('RADAR_PORT', DEFAULT_PORT)), help='API port (default 47322)')
    parser.add_argument('--db', type=str, default=os.environ.get('RADAR_DB'), help='Path to SQLite database')
    parser.add_argument('--symbols', type=str, default=os.environ.get('RADAR_SYMBOLS', ','.join(DEFAULT_SYMBOLS)), help='Comma-separated symbols')
    parser.add_argument('--tfs', type=str, default=os.environ.get('RADAR_TFS', ','.join(DEFAULT_TFS)), help='Comma-separated timeframes')
    parser.add_argument('--core-path', type=str, default=os.environ.get('RADAR_CORE_PATH'), help='Path to analysis-core.js')
    return parser.parse_args()

def user_trade_sync_enabled() -> bool:
    """Linking the owner's own fills to alerts is opt-in: it uses the owner's read-only API key."""
    return os.environ.get('RADAR_SYNC_USER_TRADES', '').strip().lower() in ('1', 'true', 'yes')


def sync_user_trades(binance_client: BinanceClient, store: RadarStore, symbols: List[str]):
    if not user_trade_sync_enabled() or not binance_client.has_credentials():
        return
    for sym in symbols:
        try:
            trades = binance_client.get_user_trades(sym, limit=50)
            for t in trades:
                store.link_user_trade(t)
            # best-effort pnl sync
            incomes = binance_client.get_realized_pnl(sym, limit=20)
            if incomes:
                total_pnl = sum(float(x.get('income', 0.0)) for x in incomes)
                store.update_user_pnl(sym, round(total_pnl, 4))
        except Exception:
            pass

def run_radar():
    args = parse_args()
    symbols = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
    tfs = [t.strip().lower() for t in args.tfs.split(',') if t.strip()]

    store = RadarStore(db_path=args.db)
    token = get_or_create_token()
    binance_client = BinanceClient()
    core_source = CoreSource(core_path=args.core_path)
    notifier = Notifier.from_env(os.environ)

    state: Dict[str, Any] = {
        'version': '1.0.0',
        'symbols': symbols,
        'tfs': tfs,
        'last_scan': None,
        'errors': 0,
    }

    if args.once:
        print(f'=== Swal Radar --once scan ({symbols} x {tfs}) ===')
        now_ts = time.time()
        state['last_scan'] = format_ts(now_ts)
        created_count = 0

        # 1. Detection
        for sym in symbols:
            for tf in tfs:
                try:
                    candles = binance_client.fetch_klines(sym, tf, 300)
                    if not candles:
                        print(f'[{sym} {tf}] No closed klines fetched from Binance')
                        continue
                    findings = core_source.scan(sym, tf, candles)
                    print(f'[{sym} {tf}] Core detected {len(findings)} measurable findings')
                    for alert in findings:
                        aid = store.create_alert(alert)
                        if aid:
                            created_count += 1
                            print(f'  -> Alert #{aid} created: {alert["title"]} ({alert["direction"]}) @ {alert["entry"]} stop {alert["stop"]}')
                except Exception as e:
                    print(f'radar: detection failed for {sym}: {e.__class__.__name__}')
                    state['errors'] = state.get('errors', 0) + 1

        # 2. Evaluation on 1m klines
        active = store.get_active_alerts()
        print(f'Active alerts before 1m evaluation: {len(active)}')
        resolved_count = 0
        m1_cache = {}
        for sym in set(a['symbol'] for a in active):
            try:
                m1_cache[sym] = binance_client.fetch_klines(sym, '1m', 150)
            except Exception:
                m1_cache[sym] = []

        for alert in active:
            try:
                sym = alert['symbol']
                m1_candles = m1_cache.get(sym) or []
                if m1_candles:
                    upd = evaluate_alert_on_candles(alert, m1_candles)
                    if upd.get('status') != alert.get('status'):
                        store.update_alert(alert['id'], upd)
                        if upd.get('status') in ('win_1r', 'win_2r', 'loss', 'expired'):
                            resolved_count += 1
                            print(f'  -> Alert #{alert["id"]} resolved: {upd["status"]} (outcome: {upd.get("outcome_r")} R)')
            except Exception as e:
                print(f'radar: evaluation failed for {alert["id"]}: {e.__class__.__name__}')
                state['errors'] = state.get('errors', 0) + 1

        # 3. User trades sync
        sync_user_trades(binance_client, store, symbols)

        # Summary
        all_alerts = store.list_alerts('all', limit=100)
        stats = store.get_stats()
        print(f'Summary: {len(all_alerts)} total alerts, {created_count} newly created, {resolved_count} newly resolved')
        print(f'Stats overall: n_resolved={stats["overall"]["n_resolved"]}, triggered_rate={stats["overall"]["triggered_rate"]}, label={stats["overall"]["label"]}')
        sys.exit(0)

    # Daemon mode
    print(f'Starting Swal Radar daemon on 127.0.0.1:{args.port}...')
    server = create_api_server(store, token, state, host='127.0.0.1', port=args.port)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f'Local API listening at http://127.0.0.1:{args.port}/v1/health (Token active, NO CORS)')

    stop_event = threading.Event()

    def handle_sig(sig, frame):
        print('\nShutting down Swal Radar...')
        stop_event.set()
        server.shutdown()

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    last_closed_times: Dict[tuple, int] = {}
    loop_count = 0

    consecutive_failures = 0
    while not stop_event.is_set():
        try:
            run_cycle(store, binance_client, core_source, symbols, tfs, last_closed_times, state, loop_count, notifier)
            consecutive_failures = 0
            loop_count += 1
            stop_event.wait(60)
        except Exception as e:
            print(f'radar: run_cycle failed: {e.__class__.__name__}')
            consecutive_failures += 1
            stop_event.wait(backoff_seconds(consecutive_failures))

    print('Swal Radar stopped cleanly.')

if __name__ == '__main__':
    run_radar()
