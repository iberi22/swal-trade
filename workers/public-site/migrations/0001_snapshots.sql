-- Snapshot público de la operativa (sustituye a KV: 1.000 escrituras/día de cuenta en el plan gratuito).
CREATE TABLE IF NOT EXISTS snapshots (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
