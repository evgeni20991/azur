/**
 * Подтверждение оплаты.
 *
 * POST /api/payment            — уведомление от ЮKassa (webhook)
 * POST /api/payment?demo=1     — «оплата» в демо-режиме, когда ключей нет
 * GET  /api/payment?id=<order> — статус заказа для страницы результата
 *
 * Главное правило webhook: тело запроса — это не доказательство оплаты.
 * Его может прислать кто угодно, зная адрес. Поэтому мы берём из тела
 * только идентификатор платежа и СПРАШИВАЕМ У ЮKassa, что с ним на самом
 * деле. Подтверждаем заказ только по её ответу.
 */
import { type Env, json, bad } from '../_lib';
import { afterOrder, notifyTransferClaim, takeStockForOrder } from '../_notify';

type OrderRow = {
  id: string; status: string; total: number; payment_id: string | null;
  payment_url: string | null; name: string; email: string; created_at: number; paid_at: number | null;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return bad('Не указан заказ');

  const order = await env.DB.prepare(
    'SELECT id, code, status, total, shipping, address, payment_url, payment_method, receipt_url, name, created_at, paid_at FROM orders WHERE id = ?',
  ).bind(id).first<OrderRow>();
  if (!order) return bad('Заказ не найден', 404);

  const items = await env.DB.prepare(
    'SELECT name, size, price, qty FROM order_items WHERE order_id = ?',
  ).bind(id).all();

  return json({ order, items: items.results ?? [] });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);

  /* ---------- покупатель сообщил, что перевёл ---------- */
  // Это НЕ подтверждение оплаты, а заявка на проверку: поверить браузеру
  // на слово нельзя, деньги видит только владелец в своём банке.
  // Поэтому статус становится 'checking', а не 'paid'.
  if (url.searchParams.get('claim') === '1') {
    const id = url.searchParams.get('id') || '';
    const order = await env.DB.prepare('SELECT id, status FROM orders WHERE id = ?')
      .bind(id).first<{ id: string; status: string }>();
    if (!order) return bad('Заказ не найден', 404);
    if (order.status === 'pending') {
      await env.DB.prepare("UPDATE orders SET status = 'checking' WHERE id = ?").bind(id).run();
      await notifyTransferClaim(env, id);
    }
    return json({ ok: true, status: 'checking' });
  }

  /* ---------- демо-оплата ---------- */
  if (url.searchParams.get('demo') === '1') {
    if (env.YOOKASSA_SECRET_KEY) return bad('Демо-оплата отключена: подключён настоящий магазин', 403);
    const id = url.searchParams.get('id') || '';
    const order = await env.DB.prepare('SELECT id, status FROM orders WHERE id = ?')
      .bind(id).first<{ id: string; status: string }>();
    if (!order) return bad('Заказ не найден', 404);
    if (order.status !== 'paid') {
      await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?")
        .bind(Date.now(), id).run();
      await takeStockForOrder(env, id);
      await afterOrder(env, id, env.SITE_URL || url.origin);
    }
    return json({ ok: true, status: 'paid' });
  }

  /* ---------- уведомление от ЮKassa ---------- */
  let body: any;
  try {
    body = await request.json();
  } catch {
    return bad('Не удалось прочитать запрос');
  }

  const paymentId = String(body?.object?.id ?? '');
  if (!paymentId) return bad('Нет идентификатора платежа');

  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
    console.error('webhook received but YooKassa keys are not configured');
    return bad('Магазин не настроен', 500);
  }

  // Перепроверяем у ЮKassa. Тело уведомления не является доказательством:
  // адрес webhook публичный, и подделать POST может кто угодно.
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error('yookassa verify failed', res.status, await res.text());
    // 500 — чтобы ЮKassa повторила уведомление позже, а не сочла доставленным
    return bad('Не удалось проверить платёж', 500);
  }

  const payment = (await res.json()) as {
    id: string; status: string; paid?: boolean;
    amount?: { value?: string };
    metadata?: { order_id?: string };
  };

  const orderId = String(payment.metadata?.order_id ?? '');
  if (!orderId) return json({ ok: true });   // чужой платёж — просто подтверждаем приём

  const order = await env.DB.prepare('SELECT id, status, total FROM orders WHERE id = ?')
    .bind(orderId).first<{ id: string; status: string; total: number }>();
  if (!order) return json({ ok: true });

  if (payment.status === 'succeeded' && payment.paid) {
    // Сверяем сумму: платёж на меньшую сумму не должен закрывать заказ.
    const paid = Math.round(Number(payment.amount?.value ?? '0') * 100);
    if (paid < order.total) {
      console.error('underpaid', orderId, paid, order.total);
      return json({ ok: true });
    }
    if (order.status !== 'paid') {
      await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?")
        .bind(Date.now(), orderId).run();
      await takeStockForOrder(env, orderId);
      await afterOrder(env, orderId, env.SITE_URL || url.origin);
    }
  } else if (payment.status === 'canceled') {
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status != 'paid'")
      .bind(orderId).run();
  }

  // ЮKassa считает уведомление доставленным по коду 200. Любой другой код
  // заставит её повторять запрос — это и нужно при наших сбоях.
  return json({ ok: true });
};
