-- Сессии владельца отдельно от покупательских: у них разные права,
-- разный срок жизни и разная цена утечки. Складывать в одну таблицу
-- значит однажды перепутать.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Статусы заказа: pending → checking → paid → sent → done, либо cancelled.
-- Колонки не добавляем: status уже TEXT, ограничений на значения нет.
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
