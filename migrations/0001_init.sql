-- azur — схема магазина. Одна база D1 на всё: люди, сессии, заказы.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  -- Пароль НИКОГДА не хранится как есть: только PBKDF2-хеш и своя соль
  -- на каждого человека. Утечка базы тогда не даёт войти в чужой аккаунт.
  pass_hash   TEXT NOT NULL,
  pass_salt   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Заказ можно оформить и без аккаунта, тогда контакты лежат прямо здесь
  email        TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  shipping     INTEGER NOT NULL DEFAULT 0,
  -- Суммы в КОПЕЙКАХ и целым числом: дробные рубли в float дают ошибки
  -- округления, которые всплывают на чеках
  total        INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | cancelled
  payment_id   TEXT,
  payment_url  TEXT,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_id);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       TEXT NOT NULL DEFAULT '',
  price      INTEGER NOT NULL,   -- копейки за единицу
  qty        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
