-- Короткий номер для человека. Внутренний id остаётся длинным и случайным:
-- по нему открывается страница заказа, и угадать чужой не должно быть можно.
-- А в сообщении к банковскому переводу человек пишет вот это.
ALTER TABLE orders ADD COLUMN code TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_code ON orders(code);
