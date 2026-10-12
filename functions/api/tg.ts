/**
 * Приём сообщений и нажатий из телеграма: POST /api/tg
 *
 * Две задачи:
 *   — кнопки «Деньги пришли» / «Отменить» под заказом;
 *   — приём ссылки на фискальный чек, которую владелец присылает ответом.
 *
 * Адрес публичный, поэтому доверять телу запроса нельзя. Защита двойная:
 *   1. Секрет в заголовке — телеграм присылает его сам, если задать при
 *      подключении webhook. Чужой запрос без секрета отсекается сразу.
 *   2. Сверка отправителя с chat_id владельца — даже утечка секрета
 *      не даст постороннему подтвердить чужой заказ.
 */
import { type Env, json } from '../_lib';
import { afterOrder, tg, ownerChat, takeStockForOrder, returnStockForOrder } from '../_notify';

/**
 * Разовое подключение webhook: GET /api/tg?setup=<секрет>
 *
 * Токен бота лежит в секретах проекта и наружу не выходит — команду
 * телеграму отдаёт сервер. Ключом служит тот же секрет, что телеграм
 * потом присылает в заголовке: знать его должен только владелец.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const given = new URL(request.url).searchParams.get('setup') || '';
  if (!secret || given !== secret) return json({ error: 'нет доступа' }, 403);

  const origin = env.SITE_URL || new URL(request.url).origin;
  const res = await tg(env, 'setWebhook', {
    url: `${origin}/api/tg`,
    secret_token: secret,
    // message нужен для ссылки на чек: её владелец присылает обычным ответом.
    allowed_updates: ['callback_query', 'message'],
    drop_pending_updates: true,
  });
  return json({ подключено: Boolean(res), адрес: `${origin}/api/tg` });
};

const CODE = /AZ-\d{6}/;
const URL_RE = /https?:\/\/\S+/;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    console.error('tg webhook: неверный секрет');
    // 200, чтобы телеграм не долбил повторами: запрос обработан и отвергнут.
    return json({ ok: true });
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }

  if (update?.callback_query) return handleButton(env, request, update.callback_query);
  if (update?.message) return handleMessage(env, update.message);
  return json({ ok: true });
};

/* ---------- нажатие кнопки под заказом ---------- */
async function handleButton(env: Env, request: Request, cq: any) {
  const answer = (text: string) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false });

  if (String(cq.from?.id ?? '') !== ownerChat(env)) {
    await answer('Подтверждать заказы может только владелец магазина');
    return json({ ok: true });
  }

  const [action, orderId] = String(cq.data ?? '').split(':');
  if (!orderId) return json({ ok: true });

  const order = await env.DB.prepare('SELECT id, code, status, total FROM orders WHERE id = ?')
    .bind(orderId).first<{ id: string; code: string | null; status: string; total: number }>();
  if (!order) {
    await answer('Заказ не найден');
    return json({ ok: true });
  }

  const origin = env.SITE_URL || new URL(request.url).origin;
  let note = '';

  if (action === 'paid') {
    if (order.status === 'paid') {
      note = '✅ Уже подтверждён';
      await answer('Этот заказ уже подтверждён');
    } else {
      await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?")
        .bind(Date.now(), orderId).run();
      await takeStockForOrder(env, orderId);
      await afterOrder(env, orderId, origin);
      note = '✅ Оплата подтверждена';
      await answer('Готово. Покупателю открылось подтверждение');

      // Сразу просим чек, пока платёж перед глазами: если не спросить здесь,
      // про него вспомнят через неделю, когда сопоставить будет уже нечего.
      await tg(env, 'sendMessage', {
        chat_id: cq.message?.chat?.id,
        text:
          `Заказ ${order.code ?? orderId} на ${(order.total / 100).toLocaleString('ru')} ₽ подтверждён.\n\n` +
          'Сформируйте чек в «Мой налог» и пришлите ссылку на него ответом на это сообщение — ' +
          'она появится у покупателя на странице заказа.\n\n' +
          'Если чек не нужен, просто не отвечайте.',
        reply_markup: { force_reply: true, input_field_placeholder: 'ссылка на чек' },
      });
    }
  } else if (action === 'cancel') {
    // Возвращаем остаток только если он был списан, то есть заказ был оплачен.
    if (order.status === 'paid') await returnStockForOrder(env, orderId);
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?")
      .bind(orderId).run();
    note = '✖️ Заказ отменён';
    await answer('Заказ отменён');
  } else {
    return json({ ok: true });
  }

  // Кнопки убираем и дописываем итог: иначе непонятно, нажимал ты уже или нет.
  await tg(env, 'editMessageText', {
    chat_id: cq.message?.chat?.id,
    message_id: cq.message?.message_id,
    text: `${cq.message?.text ?? ''}\n\n${note}`,
    disable_web_page_preview: true,
  });

  return json({ ok: true });
}

/* ---------- обычное сообщение: ссылка на чек ---------- */
async function handleMessage(env: Env, msg: any) {
  if (String(msg.from?.id ?? '') !== ownerChat(env)) return json({ ok: true });

  const text = String(msg.text ?? '');
  const link = text.match(URL_RE)?.[0];
  if (!link) return json({ ok: true });

  // Номер заказа ищем сначала в самом сообщении, потом в том, на которое
  // отвечают: так работает и «ответить на просьбу о чеке», и «прислать
  // номер со ссылкой одной строкой» — не заставляя выбирать способ.
  const code = text.match(CODE)?.[0] ?? String(msg.reply_to_message?.text ?? '').match(CODE)?.[0];
  const say = (t: string) =>
    tg(env, 'sendMessage', { chat_id: msg.chat?.id, text: t, disable_web_page_preview: true });

  if (!code) {
    await say('Не понял, к какому заказу чек. Пришлите ссылку ответом на сообщение о заказе или добавьте номер вида AZ-123456.');
    return json({ ok: true });
  }

  const order = await env.DB.prepare('SELECT id, code FROM orders WHERE code = ?')
    .bind(code).first<{ id: string; code: string }>();
  if (!order) {
    await say(`Заказ ${code} не найден.`);
    return json({ ok: true });
  }

  await env.DB.prepare('UPDATE orders SET receipt_url = ? WHERE id = ?').bind(link, order.id).run();
  await say(`Чек прикреплён к заказу ${code}. Покупатель видит его на странице заказа.`);
  console.log(`[${order.id}] чек прикреплён`);
  return json({ ok: true });
}
