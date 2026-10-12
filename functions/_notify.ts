/**
 * Уведомления о заказе: покупателю на почту, владельцу на почту и в телеграм.
 *
 * Живёт отдельным файлом, потому что поводов два, и они наступают в разные
 * моменты: онлайн-оплата подтверждается вебхуком, а заказ с оплатой курьеру
 * подтверждать нечем — о нём надо сказать сразу при оформлении, иначе
 * магазин узнает о нём, только когда сам заглянет в базу.
 */
import type { Env } from './_lib';
import { mailBuyer, mailOwner } from './_mail';

const money = (k: number) => `${(k / 100).toLocaleString('ru')} ₽`;

/** Один вызов к телеграму. Возвращает ok и пишет причину отказа в лог. */
export async function tg(env: Env, method: string, body: Record<string, unknown>) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`telegram ${method} отказал`, res.status, (await res.text()).slice(0, 300));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`telegram ${method} упал`, e);
    return null;
  }
}

/** chat_id владельца. Не секрет: его видит любой бот, которому пишет владелец. */
export const ownerChat = (env: Env) => (env.TELEGRAM_CHAT_ID || '').trim();
const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Сообщение владельцу в телеграм. Возвращает, дошло ли. */
export async function notifyTelegram(env: Env, orderId: string, cash: boolean): Promise<boolean> {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  // chat_id берем только из окружения: без него уведомления молчат,
  // а кнопки в боте не слушаются никого.
  const chat = ownerChat(env);
  if (!token || !chat) return false;

  try {
    const o = await env.DB.prepare(
      'SELECT id, code, name, phone, email, address, total, shipping FROM orders WHERE id = ?',
    ).bind(orderId).first<any>();
    if (!o) return false;
    const items = await env.DB.prepare(
      'SELECT name, size, price, qty FROM order_items WHERE order_id = ?',
    ).bind(orderId).all<any>();

    const rows = (items.results ?? []).map(
      (i: any) => `• ${esc(i.name)}${i.size ? ` (${esc(i.size)})` : ''} × ${i.qty} — ${money(i.price * i.qty)}`,
    );

    const text = [
      cash ? '<b>💵 Заказ — оплата курьеру</b>' : '<b>🛍 Оплачен заказ</b>',
      `<b>Номер:</b> ${esc(o.code || o.id)}`,
      `<b>Имя:</b> ${esc(o.name)}`,
      `<b>Телефон:</b> ${esc(o.phone)}`,
      `<b>Почта:</b> ${esc(o.email)}`,
      `<b>Адрес:</b> ${esc(o.address)}`,
      '',
      ...rows,
      '',
      o.shipping ? `<b>Доставка:</b> ${money(o.shipping)}` : '<b>Доставка:</b> бесплатно',
      `<b>Итого:</b> ${money(o.total)}`,
      ...(cash
        ? ['', '⚠️ Деньги забирает курьер. Чек в «Мой налог» оформите после получения оплаты.']
        : []),
    ].join('\n');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    // Телеграм отвечает 200 далеко не всегда: «chat not found», если владелец
    // не нажал «Запустить», и 401 на отозванном токене. Без этой ветки оба
    // случая выглядели снаружи одинаково — тишиной.
    if (!res.ok) {
      console.error('telegram отказал', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('owner notify failed', e);
    return false;
  }
}

/**
 * Всё, что происходит по факту заказа: письмо покупателю, письмо владельцу,
 * сообщение в телеграм. Каждый канал независим — отказ почты не отменяет
 * телеграм. Заказ остаётся в базе в любом случае: деньги важнее уведомления.
 */
export async function afterOrder(env: Env, orderId: string, siteUrl: string, cash = false) {
  const o = await env.DB.prepare(
    'SELECT id, code, name, phone, email, address, total, shipping FROM orders WHERE id = ?',
  ).bind(orderId).first<any>();
  if (!o) return;
  const rows = await env.DB.prepare(
    'SELECT name, size, price, qty FROM order_items WHERE order_id = ?',
  ).bind(orderId).all<any>();
  const items = (rows.results ?? []) as any[];

  // allSettled, а не all: отказ одного канала не должен отменять остальные.
  const r = await Promise.allSettled([
    mailBuyer(env, o, items, siteUrl, cash),
    mailOwner(env, o, items, cash),
    notifyTelegram(env, orderId, cash),
  ]);

  // Итог по каждому каналу в лог. Без этой строки «уведомление не пришло»
  // невозможно расследовать: код отработал, ошибки нет, письма нет.
  const say = (x: PromiseSettledResult<unknown>) =>
    x.status === 'rejected' ? `упал: ${x.reason}` : x.value ? 'ok' : 'не отправлено';
  console.log(
    `[${orderId}] покупателю: ${say(r[0])} | владельцу: ${say(r[1])} | телеграм: ${say(r[2])}`,
  );
}

/** Состав и контакты заказа одним текстом — общий кусок для всех сообщений. */
async function orderText(env: Env, orderId: string) {
  const o = await env.DB.prepare(
    'SELECT id, code, name, phone, email, address, total, shipping FROM orders WHERE id = ?',
  ).bind(orderId).first<any>();
  if (!o) return null;
  const items = await env.DB.prepare(
    'SELECT name, size, price, qty FROM order_items WHERE order_id = ?',
  ).bind(orderId).all<any>();
  const rows = (items.results ?? []).map(
    (i: any) => `• ${esc(i.name)}${i.size ? ` (${esc(i.size)})` : ''} × ${i.qty} — ${money(i.price * i.qty)}`,
  );
  return {
    order: o,
    body: [
      `<b>Номер:</b> ${esc(o.code || o.id)}`,
      `<b>Имя:</b> ${esc(o.name)}`,
      `<b>Телефон:</b> ${esc(o.phone)}`,
      `<b>Почта:</b> ${esc(o.email)}`,
      `<b>Адрес:</b> ${esc(o.address)}`,
      '',
      ...rows,
      '',
      o.shipping ? `<b>Доставка:</b> ${money(o.shipping)}` : '<b>Доставка:</b> бесплатно',
      `<b>Итого:</b> ${money(o.total)}`,
    ].join('\n'),
  };
}

/**
 * Покупатель нажал «я оплатил». Владельцу уходит сообщение с двумя кнопками:
 * подтвердить или отменить. Кнопка нужна именно здесь — деньги видит только
 * владелец в своём банке, сайту о переводе узнать неоткуда.
 */
export async function notifyTransferClaim(env: Env, orderId: string): Promise<boolean> {
  const d = await orderText(env, orderId);
  if (!d) return false;
  const text = [
    '<b>💸 Покупатель сообщил об оплате</b>',
    '',
    d.body,
    '',
    `Проверьте поступление ${money(d.order.total)} по СБП и подтвердите.`,
  ].join('\n');
  const res = await tg(env, 'sendMessage', {
    chat_id: ownerChat(env),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Деньги пришли', callback_data: `paid:${orderId}` },
        { text: '✖️ Отменить', callback_data: `cancel:${orderId}` },
      ]],
    },
  });
  console.log(`[${orderId}] заявка об оплате → телеграм: ${res ? 'ok' : 'не отправлено'}`);
  return Boolean(res);
}

/**
 * Списание остатков по оплаченному заказу.
 *
 * Списываем именно ЗДЕСЬ, при подтверждении оплаты, а не при оформлении:
 * иначе брошенные корзины и неоплаченные заказы съедали бы товар,
 * который никто не купил.
 */
export async function takeStockForOrder(env: Env, orderId: string) {
  const rows = await env.DB.prepare(
    'SELECT product_id, size, qty FROM order_items WHERE order_id = ?',
  ).bind(orderId).all<{ product_id: string; size: string; qty: number }>();

  for (const r of rows.results ?? []) {
    if (!r.size) continue;
    const res = await env.DB.prepare(
      'UPDATE product_sizes SET qty = qty - ? WHERE product_id = ? AND size = ? AND qty >= ?',
    ).bind(r.qty, r.product_id, r.size, r.qty).run();
    // Условие qty >= ? в самом UPDATE защищает от двух одновременных
    // заказов последней вещи: без него оба пройдут и остаток уйдёт в минус.
    if ((res.meta?.changes ?? 0) === 0) {
      console.error(`[${orderId}] не хватило остатка: ${r.product_id} ${r.size} x${r.qty}`);
    }
  }
}

/** Возврат остатков при отмене заказа. */
export async function returnStockForOrder(env: Env, orderId: string) {
  const rows = await env.DB.prepare(
    'SELECT product_id, size, qty FROM order_items WHERE order_id = ?',
  ).bind(orderId).all<{ product_id: string; size: string; qty: number }>();
  for (const r of rows.results ?? []) {
    if (!r.size) continue;
    await env.DB.prepare('UPDATE product_sizes SET qty = qty + ? WHERE product_id = ? AND size = ?')
      .bind(r.qty, r.product_id, r.size).run();
  }
}
