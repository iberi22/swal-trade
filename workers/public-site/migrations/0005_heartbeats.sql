-- Latidos de servicios locales (guardián, radar): POST /heartbeat/<nombre> con Bearer HEARTBEAT_TOKEN.
-- Una fila por servicio. El POST solo escribe si el último latido tiene 60 s o más (como mucho
-- 1.440 escrituras/día por servicio). El cron de 5 min lee la tabla y avisa por Telegram una vez
-- al callarse (HEARTBEAT_STALE_S, defecto 600) y otra al volver; `state` guarda 'ok' | 'stale'.
CREATE TABLE IF NOT EXISTS heartbeats (
  name      TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  state     TEXT NOT NULL DEFAULT 'ok'
);
