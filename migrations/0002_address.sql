-- Адрес в профиле: без него человек вводит его заново при каждом заказе,
-- и половина смысла личного кабинета теряется.
ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT '';
