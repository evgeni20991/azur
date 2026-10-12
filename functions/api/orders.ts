/**
 * История заказов в личном кабинете.
 * GET /api/orders → заказы текущего пользователя, новые первыми.
 *
 * Фильтр по user_id стоит в самом запросе, а не в коде после выборки:
 * так чужой заказ физически не может попасть в ответ, даже если позже
 * кто-то добавит сюда новое поле или забудет проверку.
 */
import { type Env, json, currentUser } from '../_lib';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null, orders: [] }, 401);

  const orders = await env.DB.prepare(
    `SELECT id, code, status, total, shipping, address, payment_method, receipt_url, created_at, paid_at
       FROM orders
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50`,
  ).bind(user.id).all<{ id: string }>();

  const list = orders.results ?? [];
  if (!list.length) return json({ user, orders: [] });

  // Одним запросом на все заказы вместо запроса на каждый: в списке из
  // двадцати заказов это разница между 21 обращением к базе и двумя.
  const ids = list.map((o) => o.id);
  const marks = ids.map(() => '?').join(',');
  const items = await env.DB.prepare(
    `SELECT order_id, name, size, price, qty FROM order_items WHERE order_id IN (${marks})`,
  ).bind(...ids).all<{ order_id: string }>();

  const byOrder = new Map<string, unknown[]>();
  for (const it of items.results ?? []) {
    const arr = byOrder.get(it.order_id) ?? [];
    arr.push(it);
    byOrder.set(it.order_id, arr);
  }

  return json({
    user,
    orders: list.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] })),
  });
};
