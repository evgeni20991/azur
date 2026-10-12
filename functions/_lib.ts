/**
 * Общие помощники для всех серверных функций: база, пароли, сессии, деньги.
 * Всё считается на сервере — цены, суммы, права. Клиенту доверять нельзя:
 * корзина в браузере это лишь намерение, а не факт.
 */

export interface Env {
  DB: D1Database;
  YOOKASSA_SHOP_ID?: string;
  YOOKASSA_SECRET_KEY?: string;
  SITE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;   // ключ почтового сервиса; без него письма не шлются
  MAIL_FROM?: string;        // отправитель, домен должен быть подтверждён
  OWNER_EMAIL?: string;      // куда владельцу приходят уведомления о продажах
  TELEGRAM_WEBHOOK_SECRET?: string;  // общий секрет с телеграмом: отсекает чужие запросы к /api/tg
  ADMIN_PASSWORD?: string;   // пароль владельца от админки; без него вход закрыт
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export const bad = (msg: string, status = 400) => json({ error: msg }, status);

/* ---------- пароли ---------- */

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (bytes = 16) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);

/**
 * PBKDF2 с индивидуальной солью на каждого человека.
 * Не SHA-256 «в лоб»: обычный хеш перебирается на видеокарте миллиардами
 * вариантов в секунду, а PBKDF2 намеренно медленный.
 *
 * 100 000 итераций — не круглое число «на глаз», а измеренный потолок:
 * на бесплатном тарифе Workers лимит процессорного времени, и 150 000
 * стабильно валили запрос ошибкой 1101. Проверено подбором.
 * Если тариф станет платным, поднять до 600 000 (текущая рекомендация OWASP).
 */
export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

/** Сравнение за постоянное время: обычное === выдаёт длину совпадения по таймингу. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- сессии ---------- */

const COOKIE = 'azur_session';
const DAY = 86_400_000;

export function sessionCookie(token: string, maxAgeDays = 30) {
  // HttpOnly — недоступна из JavaScript, поэтому XSS не крадёт сессию.
  // SameSite=Lax — не уходит на чужие домены, но переживает возврат
  // с платёжной страницы обратно на сайт.
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`;
}

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readToken(request: Request): string | null {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export type SessionUser = { id: string; email: string; name: string; phone: string; address: string };

export async function currentUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.address
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(token, Date.now())
    .first<SessionUser>();
  return row ?? null;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now, now + 30 * DAY)
    .run();
  return token;
}

/* ---------- деньги ---------- */

/** Всё внутри считается в копейках целыми числами: рубли во float дают
 *  ошибки округления, которые всплывают ровно на чеке. */
export const rub = (kopecks: number) => (kopecks / 100).toFixed(2);

export const validEmail = (v: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(v);

/**
 * Ограничение частоты обращений.
 *
 * Считаем попытки в окне фиксированной длины по паре «действие + адрес».
 * Без этого пароль от панели подбирается перебором: сервер отвечает быстро
 * и не устаёт, а двенадцать символов машина переберёт за ночь.
 *
 * Возвращает true, если запрос разрешён.
 */
export async function allowRate(
  env: Env,
  request: Request,
  action: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  // Адрес берём из заголовка Cloudflare: он проставляется на границе сети
  // и подделать его запросом нельзя, в отличие от X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${action}:${ip}`;
  const now = Date.now();

  const row = await env.DB.prepare('SELECT hits, window_from FROM rate_limits WHERE key = ?')
    .bind(key).first<{ hits: number; window_from: number }>();

  if (!row || now - row.window_from > windowMs) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (key, hits, window_from) VALUES (?, 1, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET hits = 1, window_from = excluded.window_from',
    ).bind(key, now).run();
    return true;
  }

  if (row.hits >= limit) return false;
  await env.DB.prepare('UPDATE rate_limits SET hits = hits + 1 WHERE key = ?').bind(key).run();
  return true;
}

/**
 * Сколько минут осталось до снятия запрета. Нужно, чтобы сказать человеку
 * точное время вместо расплывчатого «подождите»: иначе он жмёт кнопку
 * ещё десять раз и злится.
 */
export async function rateLeft(env: Env, request: Request, action: string, windowMs: number) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const row = await env.DB.prepare('SELECT window_from FROM rate_limits WHERE key = ?')
    .bind(`${action}:${ip}`).first<{ window_from: number }>();
  if (!row) return 0;
  return Math.max(1, Math.ceil((row.window_from + windowMs - Date.now()) / 60000));
}

/**
 * Сброс счётчика после удачного входа.
 *
 * Без этого владелец, вошедший с третьей попытки, остаётся с тремя
 * израсходованными: опечатался в другой день дважды — и заперт на четверть
 * часа при том, что пароль он знает. Счётчик защищает от перебора,
 * а перебор удачным входом и заканчивается.
 */
export async function rateReset(env: Env, request: Request, action: string) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(`${action}:${ip}`).run();
}

/**
 * Уборка просроченного. Вызывается изредка, а не по расписанию: в Pages
 * нет планировщика, а таблицы без чистки растут бесконечно.
 */
export async function sweep(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_from < ?').bind(now - 24 * 60 * 60 * 1000),
  ]).catch(() => {});
}
