/**
 * Живые цены и остатки на витрине.
 *
 * Страницы собраны статикой: в HTML лежат цены на момент публикации сайта.
 * Владелец правит их в админке, и без этого модуля увидел бы изменения
 * только после новой публикации — то есть никогда, потому что публикую я.
 *
 * Поэтому при открытии страницы забираем каталог из базы и поправляем
 * то, что разошлось. Статический HTML остаётся: поисковик и человек
 * на медленной связи видят содержимое сразу, а не пустой экран.
 *
 * Считать по этим данным ничего нельзя: сумму заказа всё равно считает
 * сервер по своему каталогу. Здесь только показ.
 */
export type LiveProduct = {
  id: string; name: string; category: string; price: number; oldPrice?: number;
  colour: string; composition: string; sizes: string[]; stock: Record<string, number>;
  text: string; photo: string; hit?: boolean;
};

const money = (n: number) => `${n.toLocaleString('ru')} ₽`;

let cache: Promise<LiveProduct[]> | null = null;

export function liveCatalog(): Promise<LiveProduct[]> {
  cache ||= fetch('/api/catalog')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => d.products as LiveProduct[])
    .catch(() => []);           // сеть отвалилась — остаётся то, что в HTML
  return cache;
}

/** Обновляет карточки каталога: цену, скидку, доступность размеров. */
function paintCard(card: HTMLElement, p: LiveProduct) {
  const price = card.querySelector('.price');
  if (price) price.textContent = money(p.price);

  const old = card.querySelector('.old');
  if (p.oldPrice && !old) {
    const s = document.createElement('s');
    s.className = 'old numeral';
    s.innerHTML = `<span class="sr">старая цена </span>${money(p.oldPrice)}`;
    card.querySelector('.prices')?.append(s);
  } else if (!p.oldPrice && old) old.remove();
  else if (p.oldPrice && old) old.innerHTML = `<span class="sr">старая цена </span>${money(p.oldPrice)}`;

  card.querySelectorAll<HTMLButtonElement>('.sz[data-size]').forEach((b) => {
    const left = p.stock[b.dataset.size!] ?? 0;
    b.disabled = left <= 0;
    b.title = left <= 0 ? 'Закончился' : left <= 3 ? `Осталось ${left}` : '';
    const few = b.querySelector('i.few');
    if (left > 0 && left <= 3) {
      if (few) few.textContent = String(left);
      else { const i = document.createElement('i'); i.className = 'few'; i.textContent = String(left); b.append(i); }
    } else few?.remove();
  });
}

export async function syncCatalog() {
  const cards = [...document.querySelectorAll<HTMLElement>('.item[data-id]')];
  if (!cards.length) return;
  const list = await liveCatalog();
  if (!list.length) return;

  const byId = new Map(list.map((p) => [p.id, p]));
  for (const card of cards) {
    const p = byId.get(card.dataset.id!);
    // Товар спрятали в админке — убираем из витрины, а не показываем
    // то, что нельзя купить.
    if (!p) { card.remove(); continue; }
    paintCard(card, p);
  }

  // Товары, добавленные после публикации сайта, дорисовываем копией карточки:
  // иначе владелец добавил бы вещь и не увидел её на витрине.
  const grid = document.querySelector('.grid');
  const known = new Set(cards.map((c) => c.dataset.id));
  const sample = cards[0];
  if (!grid || !sample || grid.closest('.cat-head')) return;
  const isFull = document.querySelector('[data-pane]') === null && cards.length > 4;
  if (!isFull) return;   // на главной показываем подборку, а не весь каталог

  for (const p of list) {
    if (known.has(p.id)) continue;
    const card = sample.cloneNode(true) as HTMLElement;
    card.dataset.id = p.id;
    card.dataset.cat = p.category;
    card.querySelectorAll('a').forEach((a) => a.setAttribute('href', `/product/${p.id}/`));
    const img = card.querySelector('img');
    if (img) { img.src = p.photo; img.alt = p.name; }
    const h = card.querySelector('.h3 a');
    if (h) h.textContent = p.name;
    const col = card.querySelector('.colour');
    if (col) col.textContent = p.colour;
    card.querySelectorAll('.tag').forEach((t) => t.remove());
    const chips = card.querySelector('.picker-chips');
    if (chips) {
      chips.innerHTML = p.sizes.map((sz) => `<button class="sz press" data-size="${sz}">${sz}</button>`).join('');
    }
    paintCard(card, p);
    card.removeAttribute('data-reveal-soft');
    grid.append(card);
  }
}

/** Страница товара: цена, размеры, наличие. */
export async function syncProduct(id: string) {
  const list = await liveCatalog();
  const p = list.find((x) => x.id === id);
  if (!p) return;

  // Цена на странице не одна: та же сумма стоит в липкой панели покупки.
  // Обновить только первую — значит показать две разные цены на одном экране.
  document.querySelectorAll('[data-live-price]').forEach((el) => {
    el.textContent = money(p.price);
  });
  document.querySelectorAll<HTMLElement>('[data-live-old]').forEach((el) => {
    el.innerHTML = p.oldPrice ? `<span class="sr">старая цена </span>${money(p.oldPrice)}` : '';
    el.hidden = !p.oldPrice;
  });

  document.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const input = chip.querySelector<HTMLInputElement>('input[type="radio"]');
    if (!input) return;
    const left = p.stock[input.value] ?? 0;
    input.disabled = left <= 0;
    chip.classList.toggle('out', left <= 0);
    const few = chip.querySelector('i.few');
    const label = left === 0 ? 'нет' : left <= 3 ? `осталось ${left}` : '';
    if (label) {
      if (few) few.textContent = label;
      else { const i = document.createElement('i'); i.className = 'few'; i.textContent = label; chip.querySelector('span')?.append(i); }
    } else few?.remove();
  });
}
