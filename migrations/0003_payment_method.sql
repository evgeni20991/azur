-- Способ оплаты нужен в базе, а не только в момент оформления: курьеру
-- надо знать, везёт он оплаченный заказ или собирает деньги на месте.
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'sbp';
