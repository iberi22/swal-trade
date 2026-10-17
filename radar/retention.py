from radar.store import RadarStore
import time

def prune_alerts(store: RadarStore, max_age_days: int) -> int:
    """
    Deletes terminal alerts (win_1r, win_2r, loss, expired, missed) older than max_age_days.
    NEVER deletes rows with taken_by_user = 1.
    Returns the number of rows deleted.
    """
    if max_age_days <= 0:
        return 0
    cutoff = time.time() - (max_age_days * 86400)
    with store.get_connection() as conn:
        cursor = conn.execute(
            """
            DELETE FROM alerts
            WHERE status IN ('win_1r', 'win_2r', 'loss', 'expired', 'missed')
              AND created_at < ?
              AND taken_by_user != 1
            """,
            (cutoff,)
        )
        return cursor.rowcount
