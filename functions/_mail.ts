/**
 * Письма: покупателю — подтверждение заказа, владельцу — уведомление о продаже.
 *
 * ВАЖНО про чеки. Фискальный чек по 54-ФЗ отправляет НЕ этот код, а ЮKassa:
 * мы передаём ей `receipt.customer.email` при создании платежа, и она шлёт
 * настоящий чек с QR из налоговой. Подделывать чек своим письмом нельзя —
 * это документ, а не оформление. Наше письмо про заказ: что купили, куда
 * везём, когда ждать.
 *
 * Отправка не должна ронять обработку платежа: если почтовый сервис
 * недоступен, заказ всё равно остаётся оплаченным. Деньги важнее письма.
 */
import type { Env } from './_lib';

type Line = { name: string; size?: string; price: number; qty: number };
type Order = {
  id: string; code?: string | null; name: string; email: string; phone: string;
  address: string; total: number; shipping: number;
};

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru')} ₽`;

/** Одна отправка через Resend. Без ключа тихо ничего не делает. */
async function send(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  const key = env.RESEND_API_KEY;
  if (!key || !to) return false;
  // Домен должен быть подтверждён в Resend, иначе письма уйдут в спам
  // или будут отклонены. Пока домена нет — их тестовый отправитель.
  const from = env.MAIL_FROM || 'azur <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      console.error('resend failed', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('resend threw', e);
    return false;
  }
}

/** Общий каркас письма: одна колонка, инлайновые стили — почтовые клиенты
 *  вырезают <style> и не понимают половину современного CSS. */
function shell(title: string, body: string) {
  return `<!doctype html><html lang="ru"><body style="margin:0;padding:0;background:#F1F4F9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F4F9;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FBFCFE;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1B2540;">
  <tr><td style="padding:26px 28px 0;">
    <div style="font-size:26px;letter-spacing:-0.04em;font-weight:700;color:#1B2540;">azur</div>
  </td></tr>
  <tr><td style="padding:18px 28px 6px;">
    <div style="font-size:21px;line-height:1.25;font-weight:600;">${esc(title)}</div>
  </td></tr>
  ${body}
  <tr><td style="padding:22px 28px 28px;border-top:1px solid #E2E9F2;">
    <p style="margin:0;font-size:12px;line-height:1.6;color:#7C89A3;">
      Тестовый магазин. Название, адрес и реквизиты вымышлены.<br />
      Вопросы по заказу — ответьте на это письмо.
    </p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function itemRows(items: Line[]) {
  return items
    .map(
      (i) => `<tr>
        <td style="padding:9px 0;font-size:14px;color:#1B2540;border-bottom:1px solid #EDF1F7;">
          ${esc(i.name)}${i.size ? ` · ${esc(i.size)}` : ''} <span style="color:#7C89A3;">× ${i.qty}</span>
        </td>
        <td align="right" style="padding:9px 0;font-size:14px;white-space:nowrap;border-bottom:1px solid #EDF1F7;">
          ${money(i.price * i.qty)}
        </td>
      </tr>`,
    )
    .join('');
}

/** Покупателю: что купил, куда везём, сколько заплатил. */
export async function mailBuyer(env: Env, order: Order, items: Line[], siteUrl: string, cash = false) {
  const body = `
  <tr><td style="padding:6px 28px 0;">
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#4A5673;">
      ${cash
        ? 'Спасибо за заказ. Мы собираем посылку — напишем, когда передадим её курьеру. Оплатить нужно будет при получении.'
        : 'Спасибо за заказ. Мы получили оплату и собираем посылку — напишем, когда передадим её курьеру.'}
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${itemRows(items)}
      <tr>
        <td style="padding:9px 0;font-size:14px;color:#7C89A3;">Доставка</td>
        <td align="right" style="padding:9px 0;font-size:14px;">${order.shipping ? money(order.shipping) : 'бесплатно'}</td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;font-size:15px;font-weight:600;">${cash ? 'К оплате курьеру' : 'Итого'}</td>
        <td align="right" style="padding:12px 0 0;font-size:19px;font-weight:600;">${money(order.total)}</td>
      </tr>
    </table>
    ${cash ? '<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#4A5673;">Приготовьте сумму курьеру — он принимает наличные. Пересчитайте заказ при нём, до оплаты.</p>' : ''}
  </td></tr>
  <tr><td style="padding:20px 28px 0;">
    <div style="background:#F1F4F9;border-radius:10px;padding:14px 16px;">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#7C89A3;">Куда везём</p>
      <p style="margin:0;font-size:14px;line-height:1.5;">${esc(order.address)}</p>
      <p style="margin:8px 0 0;font-size:13px;color:#4A5673;">Заказ № ${esc(order.code || order.id)}</p>
    </div>
  </td></tr>
  <tr><td style="padding:20px 28px 0;">
    <a href="${esc(siteUrl)}/account/" style="display:inline-block;background:#3B6FD4;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:13px 24px;border-radius:999px;">
      Мои заказы
    </a>
  </td></tr>
  <tr><td style="padding:18px 28px 0;">
    <p style="margin:0;font-size:12px;line-height:1.6;color:#7C89A3;">
      ${cash ? 'Чек передаст курьер вместе с заказом.' : 'Фискальный чек придёт отдельным письмом от платёжного сервиса.'}<br />
      Не подошло — обмен или возврат 30 дней, деньги возвращаем на карту.
    </p>
  </td></tr>`;
  return send(
    env,
    order.email,
    cash ? `Заказ ${order.code || order.id} принят — azur` : `Заказ ${order.code || order.id} оплачен — azur`,
    shell(cash ? 'Заказ принят' : 'Заказ оплачен', body),
  );
}

/** Владельцу: кто купил, как связаться, что и куда везти. */
export async function mailOwner(env: Env, order: Order, items: Line[], cash = false) {
  const to = env.OWNER_EMAIL;
  if (!to) return false;
  const body = `
  <tr><td style="padding:6px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${itemRows(items)}
      <tr>
        <td style="padding:9px 0;font-size:14px;color:#7C89A3;">Доставка</td>
        <td align="right" style="padding:9px 0;font-size:14px;">${order.shipping ? money(order.shipping) : 'бесплатно'}</td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;font-size:15px;font-weight:600;">Итого</td>
        <td align="right" style="padding:12px 0 0;font-size:19px;font-weight:600;">${money(order.total)}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 28px 0;">
    <div style="background:#F1F4F9;border-radius:10px;padding:14px 16px;">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#7C89A3;">Покупатель</p>
      <p style="margin:0 0 3px;font-size:14px;"><b>${esc(order.name)}</b></p>
      <p style="margin:0 0 3px;font-size:14px;"><a href="tel:${esc(order.phone)}" style="color:#3B6FD4;text-decoration:none;">${esc(order.phone)}</a></p>
      <p style="margin:0 0 10px;font-size:14px;"><a href="mailto:${esc(order.email)}" style="color:#3B6FD4;text-decoration:none;">${esc(order.email)}</a></p>
      <p style="margin:0 0 3px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#7C89A3;">Адрес</p>
      <p style="margin:0;font-size:14px;line-height:1.5;">${esc(order.address)}</p>
    </div>
  </td></tr>`;
  return send(
    env,
    to,
    cash
      ? `Заказ на ${money(order.total)} — оплата курьеру · ${order.id}`
      : `Продажа ${money(order.total)} — заказ ${order.code || order.id}`,
    shell(cash ? `Новый заказ ${order.code || order.id} — оплата курьеру` : `Новый заказ ${order.code || order.id}`, body),
  );
}
