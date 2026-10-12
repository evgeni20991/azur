/**
 * Живой каталог для витрины: GET /api/catalog
 *
 * Страницы собраны статикой и знают цены на момент публикации. Этот адрес
 * отдаёт то, что в базе прямо сейчас, — витрина обновляет цены и остатки
 * при открытии. Иначе владелец правил бы цену в админке и не видел изменений
 * до следующей публикации сайта.
 */
import { type Env, json } from '../_lib';
import { loadCatalog } from '../_catalog_db';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const list = await loadCatalog(env.DB);
  return json(
    { products: list },
    200,
    // Минута кэша: цены меняются редко, а каталог открывают часто.
    { 'Cache-Control': 'public, max-age=60' },
  );
};
