-- Respaldo cifrado de extremo a extremo (Socio SWAL; gratis durante desarrollo con BACKUP_DEV_OPEN).
-- El servidor guarda SOLO el sobre cifrado {v, kdf, iter, salt, iv, ct} (JSON en texto): nunca
-- ve la frase, la clave derivada ni el texto en claro (contrato E2EE de docs/SWAL/GOAL.md).
-- Clave por cuenta = `sub` de la licencia Ed25519; una fila por cuenta (el PUT hace upsert).
-- El contador del límite por cuenta se guarda en la tabla explain_kv (migración 0003), reutilizada
-- como almacén clave/valor para no sumar otra tabla ni gastar escrituras de más.
CREATE TABLE IF NOT EXISTS backups (
  account_sub TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  envelope   TEXT NOT NULL
);
