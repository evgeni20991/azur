/**
 * Аккаунты: регистрация, вход, выход, «кто я».
 * Один файл на четыре действия — они делят одну проверку и один формат ответа.
 *
 * POST /api/auth  { action: 'register' | 'login' | 'logout' }
 * GET  /api/auth  → текущий пользователь или null
 */
import {
  type Env, json, bad, hashPassword, randomHex, safeEqual,
  sessionCookie, clearCookie, currentUser, createSession, readToken, validEmail, allowRate, rateLeft, rateReset,
} from '../_lib';
import { tg, ownerChat } from '../_notify';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await currentUser(request, env);
  return json({ user });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return bad('Не удалось прочитать запрос');
  }

  const action = String(body.action || '');

  /* ---------- выход ---------- */
  if (action === 'logout') {
    const token = readToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  /* ---------- забыл пароль: выдать ссылку ---------- */
  if (action === 'reset_request') {
    if (!validEmail(email)) return bad('Проверьте адрес почты');
    // Иначе адресом восстановления заваливают чужую почту письмами.
    if (!(await allowRate(env, request, 'reset', 5, 60 * 60 * 1000))) {
      return json({ ok: true });   // молча: отказ выдал бы, что почта существует
    }
    const user = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?')
      .bind(email).first<{ id: string; name: string }>();

    // Отвечаем одинаково и когда почта найдена, и когда нет: разный ответ
    // позволяет перебором выяснить, кто зарегистрирован в магазине.
    if (user) {
      const token = randomHex(24);
      // Час жизни: ссылка, работающая вечно, однажды утечёт из переписки.
      await env.DB.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(token, user.id, Date.now() + 60 * 60 * 1000).run();

      const origin = env.SITE_URL || new URL(request.url).origin;
      const link = `${origin}/reset/?t=${token}`;

      // Ссылка уходит владельцу в телеграм, а не только на почту: пока
      // почтовый сервис не подключён, передать её покупателю может он сам.
      await tg(env, 'sendMessage', {
        chat_id: ownerChat(env),
        text: `🔑 Восстановление пароля

Покупатель: ${email}
Ссылка действует час:
${link}`,
        disable_web_page_preview: true,
      });
    }
    return json({ ok: true });
  }

  /* ---------- задать новый пароль по ссылке ---------- */
  if (action === 'reset') {
    const token = String(body.token || '');
    if (password.length < 8) return bad('Пароль должен быть не короче восьми символов');

    const row = await env.DB.prepare(
      'SELECT token, user_id, expires_at, used_at FROM password_resets WHERE token = ?',
    ).bind(token).first<{ user_id: string; expires_at: number; used_at: number | null }>();

    if (!row || row.used_at || row.expires_at < Date.now()) {
      return bad('Ссылка недействительна или устарела. Запросите новую.', 410);
    }

    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, row.user_id),
      env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token = ?').bind(Date.now(), token),
      // Старые сессии закрываем: если пароль меняют из-за угона, чужой вход
      // должен оборваться в тот же момент.
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
    ]);

    const fresh = await createSession(env, row.user_id);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(fresh) });
  }

  if (!validEmail(email)) return bad('Проверьте адрес почты');
  if (password.length < 8) return bad('Пароль должен быть не короче восьми символов');

  /* ---------- регистрация ---------- */
  if (action === 'register') {
    if (!(await allowRate(env, request, 'register', 5, 60 * 60 * 1000))) {
      return bad('Слишком много регистраций с одного адреса. Подождите час.', 429);
    }
    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (exists) return bad('Такая почта уже зарегистрирована', 409);

    const id = randomHex(12);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || '').trim().slice(0, 40);

    await env.DB.prepare(
      'INSERT INTO users (id, email, name, phone, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, email, name, phone, hash, salt, Date.now())
      .run();

    const token = await createSession(env, id);
    return json({ user: { id, email, name, phone, address: '' } }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  /* ---------- вход ---------- */
  if (action === 'login') {
    // Десять попыток за четверть часа: человек ошибается пару раз,
    // перебор пароля становится бессмысленным.
    const WIN = 15 * 60 * 1000;
    if (!(await allowRate(env, request, 'login', 10, WIN))) {
      const m = await rateLeft(env, request, 'login', WIN);
      return bad(`Слишком много попыток входа. Осталось ждать ${m} мин.`, 429);
    }
    const row = await env.DB.prepare(
      'SELECT id, email, name, phone, address, pass_hash, pass_salt FROM users WHERE email = ?',
    )
      .bind(email)
      .first<{ id: string; email: string; name: string; phone: string; address: string; pass_hash: string; pass_salt: string }>();

    // Один и тот же текст и для несуществующей почты, и для неверного пароля:
    // разные ответы позволяют перебором выяснить, кто зарегистрирован.
    const fail = () => bad('Неверная почта или пароль', 401);
    if (!row) {
      // Всё равно считаем хеш, чтобы ответ занимал столько же времени:
      // иначе быстрый отказ выдаёт, что такой почты нет.
      await hashPassword(password, 'dummy-salt');
      return fail();
    }
    const hash = await hashPassword(password, row.pass_salt);
    if (!safeEqual(hash, row.pass_hash)) return fail();

    await rateReset(env, request, 'login');
    const token = await createSession(env, row.id);
    return json(
      { user: { id: row.id, email: row.email, name: row.name, phone: row.phone, address: row.address } },
      200,
      { 'Set-Cookie': sessionCookie(token) },
    );
  }

  return bad('Неизвестное действие');
};
