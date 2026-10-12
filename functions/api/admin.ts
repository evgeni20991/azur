/**
 * Админка: всё, чем владелец управляет магазином без разработчика.
 *
 * GET  /api/admin?what=orders|products|stats
 * POST /api/admin  { action: 'login' | 'logout' | 'order_status'
 *                            | 'save_product' | 'save_stock' | 'toggle_product' }
 *
 * Доступ по отдельному паролю, а не по покупательскому аккаунту: у владельца
 * и покупателя разные права и разная цена утечки. Пароль лежит в секретах
 * проекта — в коде его нет и быть не должно.
 */
import { type Env, json, bad, randomHex, safeEqual, hashPassword, allowRate, rateLeft, rateReset, sweep } from '../_lib';
import { loadCatalog } from '../_catalog_db';

const COOKIE = 'azur_admin';
const LIFE = 12 * 60 * 60 * 1000; // 12 часов: смена длиннее рабочего дня не нужна

const adminCookie = (t: string) =>
  `${COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LIFE / 1000}`;
const dropCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readToken(request: Request): string {
  const raw = request.headers.get('Cookie') || '';
  return raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

/** Пускать дальше только по живой сессии. Просроченные чистим по дороге. */
async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const token = readToken(request);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?')
    .bind(token).first<{ expires_at: number }>();
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
    return false;
  }
  return true;
}

const STATUSES = ['pending', 'checking', 'paid', 'sent', 'done', 'cancelled'] as const;

/* ────────────────────────────── чтение ────────────────────────────── */

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await isAdmin(request, env))) return json({ error: 'нет доступа' }, 401);
  const what = new URL(request.url).searchParams.get('what') || 'orders';

  if (what === 'products') {
    // Скрытые тоже показываем: владелец должен видеть, что он спрятал.
    return json({ products: await loadCatalog(env.DB, true) });
  }

  if (what === 'stats') {
    const s = await env.DB.prepare(
      `SELECT
         COUNT(*) AS all_orders,
         SUM(CASE WHEN status IN ('paid','sent','done') THEN 1 ELSE 0 END) AS paid_orders,
         SUM(CASE WHEN status IN ('paid','sent','done') THEN total ELSE 0 END) AS revenue,
         SUM(CASE WHEN status = 'checking' THEN 1 ELSE 0 END) AS waiting
       FROM orders`,
    ).first<Record<string, number>>();
    const low = await env.DB.prepare(
      `SELECT p.name, s.size, s.qty FROM product_sizes s
       JOIN products p ON p.id = s.product_id
       WHERE s.qty <= 2 AND p.active = 1 ORDER BY s.qty, p.name`,
    ).all();
    return json({ stats: s, low: low.results ?? [] });
  }

  // Заказы вместе с составом: отдельный запрос на каждый заказ убивает
  // страницу, как только заказов станет несколько сотен.
  const orders = await env.DB.prepare(
    `SELECT id, code, status, total, shipping, name, phone, email, address,
            payment_method, receipt_url, created_at, paid_at
     FROM orders ORDER BY created_at DESC LIMIT 200`,
  ).all<Record<string, unknown>>();
  const items = await env.DB.prepare(
    `SELECT order_id, name, size, price, qty FROM order_items
     WHERE order_id IN (SELECT id FROM orders ORDER BY created_at DESC LIMIT 200)`,
  ).all<{ order_id: string }>();

  const byOrder: Record<string, unknown[]> = {};
  for (const i of items.results ?? []) (byOrder[i.order_id] ||= []).push(i);

  return json({
    orders: (orders.results ?? []).map((o) => ({ ...o, items: byOrder[o.id as string] ?? [] })),
  });
};

/* ────────────────────────────── запись ────────────────────────────── */

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return bad('Не удалось прочитать запрос');
  }
  const action = String(body.action || '');

  /* ---------- вход ---------- */
  if (action === 'login') {
    // Восемь попыток за четверть часа: владелец успевает опечататься
    // и вспомнить раскладку, а перебор пароля остаётся бессмысленным —
    // это меньше восьмисот попыток в сутки.
    const WIN = 15 * 60 * 1000;
    if (!(await allowRate(env, request, 'admin-login', 8, WIN))) {
      const m = await rateLeft(env, request, 'admin-login', WIN);
      return bad(`Слишком много попыток. Осталось ждать ${m} мин.`, 429);
    }
    const set = (env.ADMIN_PASSWORD || '').trim();
    if (!set) return bad('Админка не настроена: не задан пароль', 503);

    // Сравниваем хеши, а не строки: сравнение строк выходит из цикла
    // на первом различии, и по времени ответа пароль подбирается посимвольно.
    const given = String(body.password || '');
    const [a, b] = await Promise.all([
      hashPassword(given, 'admin-login'),
      hashPassword(set, 'admin-login'),
    ]);
    if (!safeEqual(a, b)) return bad('Неверный пароль', 401);

    // Счётчик обнуляем: перебор удачным входом и заканчивается, а вот
    // хозяин с израсходованными попытками запирается на пустом месте.
    await rateReset(env, request, 'admin-login');

    const token = randomHex(24);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
      .bind(token, now, now + LIFE).run();
    // Убираем просроченное при входе: планировщика в Pages нет, а таблицы
    // без чистки растут бесконечно.
    await sweep(env);
    return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(token) });
  }

  if (action === 'logout') {
    const t = readToken(request);
    if (t) await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(t).run();
    return json({ ok: true }, 200, { 'Set-Cookie': dropCookie() });
  }

  if (!(await isAdmin(request, env))) return json({ error: 'нет доступа' }, 401);

  /* ---------- статус заказа ---------- */
  if (action === 'order_status') {
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!(STATUSES as readonly string[]).includes(status)) return bad('Неизвестный статус');

    const cur = await env.DB.prepare('SELECT id, status FROM orders WHERE id = ?')
      .bind(id).first<{ id: string; status: string }>();
    if (!cur) return bad('Заказ не найден', 404);

    const wasPaid = ['paid', 'sent', 'done'].includes(cur.status);
    const willPaid = ['paid', 'sent', 'done'].includes(status);

    // Остаток трогаем только на переходе через границу «оплачен»:
    // иначе перевод из «оплачен» в «отправлен» списал бы товар второй раз.
    const { takeStockForOrder, returnStockForOrder } = await import('../_notify');
    if (!wasPaid && willPaid) await takeStockForOrder(env, id);
    if (wasPaid && !willPaid) await returnStockForOrder(env, id);

    await env.DB.prepare('UPDATE orders SET status = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?')
      .bind(status, willPaid ? Date.now() : null, id).run();
    return json({ ok: true, status });
  }

  /* ---------- товар ---------- */
  if (action === 'save_product') {
    const p = body.product || {};
    const id = String(p.id || '').trim().slice(0, 40);
    const name = String(p.name || '').trim().slice(0, 120);
    if (!/^[a-z0-9_-]+$/i.test(id)) return bad('Артикул: латиница, цифры, дефис');
    if (!name) return bad('Укажите название');

    // Цену принимаем в рублях, храним в копейках: дробные рубли во float
    // дают ошибки округления, которые всплывают ровно на чеке.
    const price = Math.max(0, Math.round(Number(p.price) || 0)) * 100;
    const oldPrice = p.oldPrice ? Math.max(0, Math.round(Number(p.oldPrice))) * 100 : null;
    if (!price) return bad('Укажите цену');
    if (oldPrice && oldPrice <= price) return bad('Старая цена должна быть больше новой');

    // Путь к фото — только свой файл или https-адрес. Произвольная строка
    // попадает прямо в src картинки на витрине.
    const photo = String(p.photo || '').trim().slice(0, 300);
    if (photo && !/^(\/[\w./-]*|https:\/\/[\w./?=&%-]+)$/i.test(photo)) {
      return bad('Фото: путь вида /img/p10.webp или адрес на https://');
    }

    await env.DB.prepare(
      `INSERT INTO products (id,name,category,price,old_price,colour,composition,descr,photo,hit,active,sort,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, category=excluded.category, price=excluded.price,
         old_price=excluded.old_price, colour=excluded.colour, composition=excluded.composition,
         descr=excluded.descr, photo=excluded.photo, hit=excluded.hit, sort=excluded.sort,
         updated_at=excluded.updated_at`,
    ).bind(
      id, name, String(p.category || 'Верх'), price, oldPrice,
      String(p.colour || '').slice(0, 60), String(p.composition || '').slice(0, 200),
      String(p.text || '').slice(0, 600), photo,
      p.hit ? 1 : 0, 1, Number(p.sort) || 100, Date.now(),
    ).run();

    // Размеры переписываем целиком: вычислять разницу ради трёх строк —
    // лишний код и лишний способ ошибиться.
    if (Array.isArray(p.sizes)) {
      await env.DB.prepare('DELETE FROM product_sizes WHERE product_id = ?').bind(id).run();
      const rows = p.sizes
        .map((s: any, i: number) => ({ size: String(s.size || '').trim().slice(0, 40), qty: Math.max(0, Number(s.qty) || 0), i }))
        .filter((s: any) => s.size);
      if (rows.length) {
        await env.DB.batch(rows.map((s: any) =>
          env.DB.prepare('INSERT INTO product_sizes (product_id,size,qty,sort) VALUES (?,?,?,?)')
            .bind(id, s.size, s.qty, s.i)));
      }
    }
    return json({ ok: true, id });
  }

  /* ---------- показать или спрятать ---------- */
  if (action === 'toggle_product') {
    const id = String(body.id || '');
    // Не удаляем: товар есть в старых заказах, и удаление порвало бы историю.
    await env.DB.prepare('UPDATE products SET active = 1 - active, updated_at = ? WHERE id = ?')
      .bind(Date.now(), id).run();
    const row = await env.DB.prepare('SELECT active FROM products WHERE id = ?').bind(id).first<{ active: number }>();
    return json({ ok: true, active: row?.active === 1 });
  }

  /* ---------- быстрая правка остатка ---------- */
  if (action === 'save_stock') {
    const id = String(body.id || '');
    const size = String(body.size || '');
    const qty = Math.max(0, Math.round(Number(body.qty) || 0));
    await env.DB.prepare('UPDATE product_sizes SET qty = ? WHERE product_id = ? AND size = ?')
      .bind(qty, id, size).run();
    return json({ ok: true, qty });
  }

  return bad('Неизвестное действие');
};
