import urllib.request
import urllib.error
import urllib.parse
import json
import time
from collections import deque
from typing import List, Dict, Any, Optional

# Grades ordering for filtering
GRADES_ORDER = {
    'no_evidence': 0,
    'negative': 1,
    'promising': 2,
    'validated': 3
}

class Notifier:
    def __init__(self, token: str, chat_id: str, min_grade: str = 'no_evidence', max_per_hour: int = 6):
        self._token = token
        self._chat_id = chat_id
        self._min_grade_val = GRADES_ORDER.get(min_grade, 0)
        self._max_per_hour = max_per_hour

        # State for rate limiting and deduplication
        self._sent_timestamps = deque()
        self._sent_alert_ids = set()

    @property
    def enabled(self) -> bool:
        return bool(self._token and self._chat_id)

    @classmethod
    def from_env(cls, env: Dict[str, str]) -> 'Notifier':
        token = env.get('RADAR_TELEGRAM_BOT_TOKEN', '').strip()
        chat_id = env.get('RADAR_TELEGRAM_CHAT_ID', '').strip()
        min_grade = env.get('RADAR_NOTIFY_MIN_GRADE', 'no_evidence').strip()
        try:
            max_per_hour = int(env.get('RADAR_NOTIFY_MAX_PER_HOUR', 6))
        except ValueError:
            max_per_hour = 6

        return cls(token, chat_id, min_grade, max_per_hour)

    def _clean_text(self, text: str) -> str:
        """Removes markdown/html chars to ensure plain text."""
        if not text:
            return ""
        # The message text must not contain `*`, `_`, backticks or `<`.
        return text.replace('*', '').replace('_', '').replace('`', '').replace('<', '').replace('>', '')

    def format_alert(self, alert: Dict[str, Any], cell_grade: str = 'no_evidence') -> str:
        """
        Formats alert strictly in plain text.
        Example format required:
        RADAR (experimental) BTCUSDC 15m long - bullflag
        entrada 67890.5 stop 67500.0 objetivo 1R 68281.0
        evidencia de la celda: sin evidencia (n=12)
        Esto es una medicion, no una recomendacion.
        """
        sym = self._clean_text(alert.get('symbol', ''))
        tf = self._clean_text(alert.get('tf', ''))
        dir_ = self._clean_text(alert.get('direction', ''))
        kind = self._clean_text(alert.get('kind', ''))
        title = self._clean_text(alert.get('title', ''))

        if title:
            line1 = f"RADAR (experimental) {sym} {tf} {dir_} - {title}"
        else:
            line1 = f"RADAR (experimental) {sym} {tf} {dir_} - {kind}"

        entry = alert.get('entry', 0)
        stop = alert.get('stop', 0)
        target = alert.get('target_1r', 0)

        line2 = f"entrada {entry} stop {stop} objetivo 1R {target}"

        # Determine n if available, else omit n
        n_val = alert.get('n')
        if n_val is not None:
            evidence_str = f"evidencia de la celda: {self._clean_text(cell_grade)} (n={n_val})"
        else:
            evidence_str = f"evidencia de la celda: {self._clean_text(cell_grade)}"

        # Hard requirement "sin evidencia" instead of "no_evidence" for user-facing, if we have raw string, let's map it:
        if "no_evidence" in evidence_str:
            evidence_str = evidence_str.replace("no_evidence", "sin evidencia")
        if "noevidence" in evidence_str:
            evidence_str = evidence_str.replace("noevidence", "sin evidencia")

        line3 = evidence_str
        line4 = "Esto es una medicion, no una recomendacion."

        return f"{line1}\n{line2}\n{line3}\n{line4}"

    def notify_new(self, alerts: List[Dict[str, Any]], post_fn=None):
        if not self.enabled or not alerts:
            return

        post_fn = post_fn or urllib.request.urlopen

        # 1. Filter by minimum grade and deduplicate
        filtered = []
        for a in alerts:
            aid = a.get('id')
            if aid in self._sent_alert_ids:
                continue

            grade_str = a.get('grade', 'no_evidence')
            grade_val = GRADES_ORDER.get(grade_str, 0)
            if grade_val >= self._min_grade_val:
                filtered.append(a)
                if aid is not None:
                    self._sent_alert_ids.add(aid)

        if not filtered:
            return

        # 2. Rate limiting
        now = time.time()
        # Remove timestamps older than 1 hour
        while self._sent_timestamps and now - self._sent_timestamps[0] > 3600:
            self._sent_timestamps.popleft()

        current_count = len(self._sent_timestamps)
        allowed = max(0, self._max_per_hour - current_count)

        to_send = filtered[:allowed]
        extra_count = len(filtered) - allowed

        # 3. Send allowed individual alerts
        for a in to_send:
            text = self.format_alert(a, a.get('grade', 'no_evidence'))
            self._send_text(text, post_fn)
            self._sent_timestamps.append(now)

        # 4. Send summary for extra alerts if any
        if extra_count > 0:
            summary = f"+{extra_count} alertas mas (limite por hora)\nEsto es una medicion, no una recomendacion."
            self._send_text(summary, post_fn)
            self._sent_timestamps.append(now)

    def _send_text(self, text: str, post_fn):
        url = f"https://api.telegram.org/bot{self._token}/sendMessage"
        payload = {
            "chat_id": self._chat_id,
            "text": text
        }
        # No parse_mode to ensure plain text
        req = urllib.request.Request(
            url,
            json.dumps(payload).encode('utf-8'),
            {"Content-Type": "application/json"}
        )
        try:
            post_fn(req, timeout=5)
        except Exception as e:
            # Never log URL or token
            print(f"radar: telegram notification failed: {type(e).__name__}")
