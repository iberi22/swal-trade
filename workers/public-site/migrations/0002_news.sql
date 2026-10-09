-- Noticias públicas (BTC/ETH), últimas 48 h. La puerta de 30 min y el cupo mensual
-- viven en news_meta para no gastar el cupo de escrituras de KV (1.000/día en toda la cuenta).
CREATE TABLE IF NOT EXISTS news (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  title            TEXT NOT NULL,
  title_key        TEXT NOT NULL,
  source           TEXT NOT NULL,
  published_at     TEXT NOT NULL,
  snippet          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  symbols          TEXT NOT NULL,
  sentiment_score  REAL NOT NULL,
  sentiment_label  TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_published ON news (published_at);

CREATE TABLE IF NOT EXISTS news_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
