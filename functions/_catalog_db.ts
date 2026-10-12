/**
 * Каталог из базы.
 *
 * Раньше цены жили в коде: поменять их мог только разработчик, и то через
 * публикацию сайта. Теперь товары лежат в D1 и правятся из админки.
 * Файл `_catalog.ts` остался как засев и как источник типа — данные берём
 * отсюда.
 *
 * Правило прежнее и главное: цену, пришедшую из браузера, сервер
 * не использует НИКОГДА. Только id, размер и количество.
 */
import type { Product } from './_catalog';

export type DbProduct = Product & { active: boolean; sort: number };

type Row = {
  id: string; name: string; category: string; price: number; old_price: number | null;
  colour: string; composition: string; descr: string; photo: string;
  hit: number; active: number; sort: number;
};

/** Все товары со всеми размерами. Два запроса, а не N+1: список товаров
 *  небольшой, но привычка делать запрос на каждый товар убивает страницу,
 *  как только ассортимент вырастет. */
export async function loadCatalog(db: D1Database, withHidden = false): Promise<DbProduct[]> {
  const where = withHidden ? '' : 'WHERE active = 1';
  const [prods, sizes] = await Promise.all([
    db.prepare(`SELECT * FROM products ${where} ORDER BY sort, name`).all<Row>(),
    db.prepare('SELECT product_id, size, qty FROM product_sizes ORDER BY sort').all<{ product_id: string; size: string; qty: number }>(),
  ]);

  const bySize = new Map<string, { sizes: string[]; stock: Record<string, number> }>();
  for (const s of sizes.results ?? []) {
    const e = bySize.get(s.product_id) ?? { sizes: [], stock: {} };
    e.sizes.push(s.size);
    e.stock[s.size] = s.qty;
    bySize.set(s.product_id, e);
  }

  return (prods.results ?? []).map((r) => {
    const e = bySize.get(r.id) ?? { sizes: [], stock: {} };
    return {
      id: r.id,
      name: r.name,
      category: r.category as Product['category'],
      // В базе копейки, на витрине рубли: считаем в целых, показываем в рублях.
      price: Math.round(r.price / 100),
      ...(r.old_price ? { oldPrice: Math.round(r.old_price / 100) } : {}),
      colour: r.colour,
      composition: r.composition,
      sizes: e.sizes,
      stock: e.stock,
      text: r.descr,
      photo: r.photo,
      ...(r.hit ? { hit: true } : {}),
      active: r.active === 1,
      sort: r.sort,
    };
  });
}

export const findProduct = (list: DbProduct[], id: string) => list.find((p) => p.id === id) ?? null;

/**
 * Списание остатка одной позиции. Условие `qty >= ?` в самом UPDATE —
 * не украшение: без него два одновременных заказа последней вещи оба
 * пройдут проверку и оба спишут, уведя остаток в минус.
 */
export async function takeStock(db: D1Database, productId: string, size: string, qty: number) {
  const res = await db
    .prepare('UPDATE product_sizes SET qty = qty - ? WHERE product_id = ? AND size = ? AND qty >= ?')
    .bind(qty, productId, size, qty)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Возврат остатка при отмене заказа. */
export async function returnStock(db: D1Database, productId: string, size: string, qty: number) {
  await db.prepare('UPDATE product_sizes SET qty = qty + ? WHERE product_id = ? AND size = ?')
    .bind(qty, productId, size).run();
}
