-- Каталог переезжает из кода в базу: без этого владелец не может ни
-- поменять цену, ни добавить товар — только позвонить разработчику.
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  -- Цены в КОПЕЙКАХ целым числом: рубли во float дают ошибки округления,
  -- которые всплывают ровно на чеке.
  price       INTEGER NOT NULL,
  old_price   INTEGER,
  colour      TEXT NOT NULL DEFAULT '',
  composition TEXT NOT NULL DEFAULT '',
  descr       TEXT NOT NULL DEFAULT '',
  photo       TEXT NOT NULL DEFAULT '',
  hit         INTEGER NOT NULL DEFAULT 0,
  -- Скрытый товар не показывается в каталоге и не продаётся, но остаётся
  -- в старых заказах: удалять то, что уже купили, нельзя.
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 100,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_sizes (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       TEXT NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, size)
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort);
