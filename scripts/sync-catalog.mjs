/**
 * Снимок каталога из базы в файл перед сборкой.
 *
 * Витрина собирается статикой, и без этого шага в HTML попадали бы цены
 * и остатки на момент, когда я последний раз правил код. Скрипт на странице
 * их потом поправит, но до его срабатывания человек видит старое число,
 * а поисковик индексирует именно его.
 *
 * Если база недоступна — оставляем прежний снимок и продолжаем сборку:
 * упасть из-за сети хуже, чем собрать с чуть устаревшими данными.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = 'functions/_catalog.json';

// Запускаем сам файл wrangler, а не npx: Node на Windows отказывается
// исполнять .cmd напрямую (EINVAL), а через оболочку начинаются пляски
// с кавычками в SQL.
// Путь собираем руками: пакет wrangler не выставляет bin через exports,
// и require.resolve на него ругается.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const q = (sql) => {
  const raw = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'azur', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(raw.slice(raw.indexOf('[')))[0].results;
};

try {
  const rows = q('SELECT * FROM products WHERE active = 1 ORDER BY sort, name');
  const sizes = q('SELECT product_id, size, qty FROM product_sizes ORDER BY sort');

  const bySize = new Map();
  for (const s of sizes) {
    const e = bySize.get(s.product_id) ?? { sizes: [], stock: {} };
    e.sizes.push(s.size);
    e.stock[s.size] = s.qty;
    bySize.set(s.product_id, e);
  }

  const products = rows.map((r) => {
    const e = bySize.get(r.id) ?? { sizes: [], stock: {} };
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      price: Math.round(r.price / 100),
      ...(r.old_price ? { oldPrice: Math.round(r.old_price / 100) } : {}),
      colour: r.colour,
      composition: r.composition,
      sizes: e.sizes,
      stock: e.stock,
      text: r.descr,
      photo: r.photo,
      ...(r.hit ? { hit: true } : {}),
    };
  });

  if (!products.length) throw new Error('база вернула пустой каталог');
  writeFileSync(OUT, JSON.stringify(products, null, 1) + '\n', 'utf8');
  console.log(`  каталог из базы: ${products.length} товаров -> ${OUT}`);
} catch (e) {
  if (!existsSync(OUT)) {
    console.error('  каталог не получен и снимка нет — сборка невозможна');
    process.exit(1);
  }
  console.warn(`  каталог из базы не получен (${e.message.split('\n')[0]}), беру прежний снимок`);
}
