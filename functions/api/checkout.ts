/**
 * Оформление заказа и создание платежа.
 *
 * Главное правило: из браузера принимаются ТОЛЬКО id товара, размер
 * и количество. Цена, сумма доставки и итог считаются здесь, по серверному
 * каталогу. Если брать сумму из запроса, её меняют в инструментах
 * разработчика за десять секунд и покупают тренч за рубль.
 *
 * POST /api/checkout
 *   { items: [{ id, size, qty }], name, email, phone, address }
 * → { orderId, paymentUrl }
 */
import { type Env, json, bad, randomHex, currentUser, validEmail } from '../_lib';
import { loadCatalog, findProduct } from '../_catalog_db';
import { afterOrder } from '../_notify';

// Доставка бесплатна для всех: так решил владелец на время запуска.
// Порог и тариф оставлены рядом — вернуть платную доставку значит
// поменять SHIPPING обратно на 39_000, и то же самое в src/scripts/cart.ts.
const FREE_FROM = 0;         // порог бесплатной доставки в копейках
const SHIPPING = 0;          // тариф в копейках, когда порог не достигнут

type InItem = { id?: unknown; size?: unknown; qty?: unknown };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('Не удалось прочитать запрос');
  }

  // Ловушка для спама: поле скрыто от человека, робот заполняет всё подряд.
  if (String(body.website ?? '').trim() !== '') return json({ ok: true });

  const name = String(body.name ?? '').trim().slice(0, 80);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 120);
  const phone = String(body.phone ?? '').trim().slice(0, 40);
  const address = String(body.address ?? '').trim().slice(0, 300);

  // Способ оплаты берём из списка, а не как пришло: в payment_method_data
  // уходит значение из запроса, и произвольная строка там недопустима.
  const ALLOWED = ['sbp', 'bank_card', 'cash'] as const;
  const raw_method = String(body.method ?? '');
  const method = (ALLOWED as readonly string[]).includes(raw_method) ? raw_method : null;
  const cash = method === 'cash';

  if (!name) return bad('Укажите имя');
  if (!validEmail(email)) return bad('Проверьте адрес почты');
  if (!phone) return bad('Укажите телефон');
  if (!address) return bad('Укажите адрес доставки');

  const raw = Array.isArray(body.items) ? (body.items as InItem[]) : [];
  if (!raw.length) return bad('Корзина пуста');
  if (raw.length > 50) return bad('Слишком много позиций');

  // Пересобираем корзину заново из каталога. Всё, что пришло сверх id,
  // размера и количества, отбрасывается.
  // Каталог читаем из базы: цена в коде и цена в админке разойдутся
  // в первый же день, а платит за это покупатель или магазин.
  const catalogue = await loadCatalog(env.DB);

  const lines: { id: string; name: string; size: string; price: number; qty: number }[] = [];
  let subtotal = 0;
  for (const it of raw) {
    const p = findProduct(catalogue, String(it.id ?? ''));
    // Товар мог быть снят с продажи, пока корзина лежала в браузере.
    if (!p) return bad('Один из товаров в корзине больше не продаётся. Откройте корзину и уберите его.');
    const qty = Math.max(1, Math.min(20, Math.floor(Number(it.qty) || 1)));
    // У товаров с единственным размером клиент может его не присылать:
    // подставляем сами. Гонять русскую фразу «один размер» через JSON, URL
    // и сравнения — лишняя точка отказа, достаточно одной перекодировки.
    let size = String(it.size ?? '').trim().slice(0, 40);
    if (!size && p.sizes.length === 1) size = p.sizes[0];
    if (size && !p.sizes.includes(size)) {
      // У товара с единственным размером слово «размер» в ошибке лишнее:
      // «размер один размер недоступен» человек не понимает.
      return bad(p.sizes.length === 1
        ? `«${p.name}» сейчас не продаётся — уберите из корзины`
        : `У товара «${p.name}» больше нет размера ${size}. Выберите другой.`);
    }
    // Остаток проверяем ЗДЕСЬ, а не только в браузере: там кнопку можно
    // включить обратно в инструментах разработчика за пять секунд.
    const left = p.stock?.[size] ?? 0;
    if (left <= 0) {
      return bad(p.sizes.length === 1
        ? `«${p.name}» закончился`
        : `«${p.name}» размера ${size} уже разобрали`);
    }
    if (qty > left) {
      return bad(p.sizes.length === 1
        ? `«${p.name}» осталось ${left} шт — уменьшите количество`
        : `«${p.name}» размера ${size} осталось ${left} шт`);
    }
    const price = p.price * 100;                 // каталог в рублях, считаем в копейках
    lines.push({ id: p.id, name: p.name, size, price, qty });
    subtotal += price * qty;
  }

  const shipping = subtotal >= FREE_FROM ? 0 : SHIPPING;
  const total = subtotal + shipping;

  const user = await currentUser(request, env);

  // Запоминаем данные в профиле, чтобы второй заказ не начинался
  // с повторного ввода имени, телефона и адреса.
  if (user) {
    await env.DB.prepare('UPDATE users SET name = ?, phone = ?, address = ? WHERE id = ?')
      .bind(name, phone, address, user.id).run();
  }

  const orderId = randomHex(10);

  // Короткий номер для человека: его вписывают в сообщение к переводу,
  // переключившись в банковское приложение. Двадцать знаков вперемешку
  // с буквами там не наберёт никто — и платёж будет не сопоставить.
  // Внутренний id остаётся длинным: по нему открывается страница заказа,
  // и подобрать чужой не должно быть можно.
  let code = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000;
    const taken = await env.DB.prepare('SELECT 1 FROM orders WHERE code = ?').bind(`AZ-${n}`).first();
    if (!taken) { code = `AZ-${n}`; break; }
  }
  // Если шесть попыток подряд дали занятый номер — не отказываем покупателю,
  // а падаем обратно на внутренний id. Заказ важнее красивого номера.
  if (!code) code = orderId.slice(0, 8).toUpperCase();

  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO orders (id, user_id, email, name, phone, address, shipping, total, status, payment_method, code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(orderId, user?.id ?? null, email, name, phone, address, shipping, total, method ?? 'sbp', code, now)
    .run();

  // batch — одна транзакция: либо все позиции записались, либо ни одной.
  await env.DB.batch(
    lines.map((l) =>
      env.DB.prepare(
        'INSERT INTO order_items (order_id, product_id, name, size, price, qty) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(orderId, l.id, l.name, l.size, l.price, l.qty),
    ),
  );

  const origin = env.SITE_URL || new URL(request.url).origin;
  const returnUrl = `${origin}/order/?id=${orderId}`;

  /* ---------- наличными курьеру ---------- */
  // Платежа не будет, подтверждать нечего — поэтому владельцу сообщаем
  // ПРЯМО СЕЙЧАС. Иначе о заказе он узнает, только заглянув в базу.
  // Статус остаётся pending: заказ станет оплаченным, когда курьер привезёт
  // деньги, и отметить это должен человек, а не сайт.
  if (cash) {
    await afterOrder(env, orderId, origin, true);
    return json({ orderId, paymentUrl: returnUrl, cash: true, total });
  }

  /* ---------- перевод по СБП ---------- */
  // Без ключей ЮKassa деньги принимаются переводом по СБП прямо на счёт
  // продавца: комиссии нет, договор с платёжным сервисом не нужен.
  // Сайт не может узнать о переводе сам — заказ подтверждает владелец,
  // сверившись с поступлением. Поэтому статус остаётся pending.
  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
    await env.DB.prepare('UPDATE orders SET payment_url = ? WHERE id = ?')
      .bind(`/pay/?id=${orderId}`, orderId)
      .run();
    return json({ orderId, paymentUrl: `/pay/?id=${orderId}`, transfer: true, total });
  }

  /* ---------- ЮKassa ---------- */
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  const payload = {
      amount: { value: (total / 100).toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      // Если способ выбран — открываем сразу его. Если нет, ЮKassa покажет
      // все, что подключены магазину: навязывать один способ не надо.
      ...(method ? { payment_method_data: { type: method } } : {}),
      description: `Заказ ${orderId} — azur`,
      metadata: { order_id: orderId },
      receipt: {
        customer: { email },
        items: lines.map((l) => ({
          description: `${l.name}${l.size ? ` (${l.size})` : ''}`.slice(0, 128),
          quantity: String(l.qty),
          amount: { value: (l.price / 100).toFixed(2), currency: 'RUB' },
          vat_code: 1,
          payment_subject: 'commodity',
          payment_mode: 'full_payment',
        })),
      },
  };

  let res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      // Ключ идемпотентности: если запрос повторится из-за обрыва связи,
      // ЮKassa вернёт ТОТ ЖЕ платёж, а не создаст второй. Без него
      // дрогнувшая сеть превращается в двойное списание.
      'Idempotence-Key': orderId,
    },
    body: JSON.stringify(payload),
  });

  // Тестовый магазин ЮKassa поддерживает не все способы оплаты, и навязанный
  // СБП он отвергает. Вместо отказа покупателю повторяем запрос без выбора —
  // ЮKassa сама покажет то, что магазину доступно.
  if (!res.ok && method) {
    const detail = await res.text();
    console.error('yookassa отверг способ', method, res.status, detail.slice(0, 300));
    // Ключ идемпотентности другой: это другой запрос, а не повтор прежнего.
    res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': `${orderId}-any`,
      },
      body: JSON.stringify({ ...payload, payment_method_data: undefined }),
    });
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error('yookassa create failed', res.status, detail);
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(orderId).run();
    return bad('Не удалось создать платёж. Попробуйте ещё раз или напишите нам.', 502);
  }

  const payment = (await res.json()) as {
    id: string;
    confirmation?: { confirmation_url?: string };
  };
  const url = payment.confirmation?.confirmation_url;

  await env.DB.prepare('UPDATE orders SET payment_id = ?, payment_url = ? WHERE id = ?')
    .bind(payment.id, url ?? null, orderId)
    .run();

  return json({ orderId, paymentUrl: url, total });
};
