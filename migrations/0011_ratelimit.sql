-- Ограничение попыток входа. Без него пароль от панели подбирается
-- перебором: сервер отвечает быстро и не устаёт.
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,   -- действие + адрес обратившегося
  hits        INTEGER NOT NULL DEFAULT 0,
  window_from INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_limits(window_from);
