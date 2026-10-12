-- Восстановление пароля. Токен одноразовый и короткоживущий: ссылка,
-- которая работает вечно, рано или поздно утечёт из чужой переписки.
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
