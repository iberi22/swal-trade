-- Explicador IA (POST /api/explain). Una sola tabla clave/valor con caducidad, como
-- `snapshots`: guarda el límite por IP (ventana móvil de 1 h), el cupo diario global y
-- la caché de 5 minutos de respuestas idénticas. D1 permite 100.000 escrituras/día en el
-- plan gratuito; el KV SNAPSHOTS (1.000/día para TODA la cuenta) queda solo como respaldo.
CREATE TABLE IF NOT EXISTS explain_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
