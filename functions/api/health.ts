/**
 * Проверка каналов уведомлений: GET /api/health
 *
 * Отвечает на единственный вопрос — почему не пришло уведомление.
 * Раньше на него нельзя было ответить, не залезая в логи Cloudflare:
 * снаружи и «ключа нет», и «ключ неверный» выглядели одинаково — тишиной.
 *
 * Секреты наружу не выходят: только «настроен / не настроен» и текст ошибки
 * от самого телеграма. Имя бота публично и так — его видно в @BotFather.
 */
import { type Env, json } from '../_lib';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();

  let telegram: Record<string, unknown> = { ключ: false, итог: 'токен не добавлен' };
  if (token) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const d = (await r.json()) as any;
      telegram = d?.ok
        ? { ключ: true, бот: `@${d.result?.username}`, итог: 'токен рабочий' }
        : {
            ключ: true,
            итог:
              d?.error_code === 404
                ? 'токен недействителен — бота с таким токеном нет (строку обрезало при вставке или бот удалён)'
                : d?.error_code === 401
                  ? 'токен отозван — возьмите новый в @BotFather'
                  : `телеграм отказал: ${d?.description ?? r.status}`,
          };
    } catch (e) {
      telegram = { ключ: true, итог: `не достучались до телеграма: ${e}` };
    }
  }

  return json({
    телеграм: telegram,
    почта: {
      ключ_resend: Boolean(env.RESEND_API_KEY),
      адрес_владельца: env.OWNER_EMAIL || null,
      итог: env.RESEND_API_KEY ? 'письма отправляются' : 'нет ключа Resend — письма не отправляются',
    },
    оплата: {
      юkassa: Boolean(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY),
      итог: env.YOOKASSA_SHOP_ID
        ? 'эквайринг ЮKassa'
        : 'перевод по СБП напрямую продавцу, подтверждение кнопкой в телеграме',
      кнопки_в_телеграме: Boolean((env.TELEGRAM_WEBHOOK_SECRET || '').trim()),
    },
  });
};
