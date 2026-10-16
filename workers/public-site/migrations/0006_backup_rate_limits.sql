-- Cupo por cuenta del respaldo cifrado (PUT/GET/DELETE /api/backup). src/backup.js lo usa en
-- cada petición (claimBackupRateLimit) y 0004_backup.sql nunca la creó: sin esta tabla todas las
-- peticiones de respaldo respondían 500 (D1_ERROR: no such table).
-- Una fila por cuenta: ventana fija que se reinicia sola cuando caduca (ver SQL_RATE_CLAIM).
CREATE TABLE IF NOT EXISTS backup_rate_limits (
  account_sub  TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
