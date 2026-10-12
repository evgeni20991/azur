/**
 * Корзина на стороне браузера.
 *
 * Здесь хранится только НАМЕРЕНИЕ купить: id товара, размер, количество.
 * Цены нужны лишь для показа; итог, по которому выставляется счёт, считает
 * сервер по своему каталогу. Поэтому подмена в localStorage ничего не даёт.
 */
import { products } from '../content/site';

export type Line = { id: string; size: string; qty: number };

const KEY = 'azur-cart-v1';
const EVT = 'azur-cart';

export function read(): Line[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // Чистим при чтении: в хранилище могло остаться что угодно от прошлых
    // версий или от чужих рук, а неверная строка ломает всю отрисовку.
    return raw
      .filter((l) => l && typeof l.id === 'string')
      .map((l) => ({ id: l.id, size: String(l.size ?? ''), qty: Math.max(1, Math.min(20, Number(l.qty) || 1)) }))
      .filter((l) => products.some((p) => p.id === l.id));
  } catch {
    return [];
  }
}

function write(lines: Line[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    /* приватный режим или переполнение — корзина просто не переживёт перезагрузку */
  }
  window.dispatchEvent(new CustomEvent(EVT, { detail: lines }));
}

export function add(id: string, size: string) {
  const lines = read();
  const found = lines.find((l) => l.id === id && l.size === size);
  if (found) found.qty = Math.min(20, found.qty + 1);
  else lines.push({ id, size, qty: 1 });
  write(lines);
}

export function setQty(id: string, size: string, qty: number) {
  let lines = read();
  const i = lines.findIndex((l) => l.id === id && l.size === size);
  if (i < 0) return;
  if (qty <= 0) lines.splice(i, 1);
  else lines[i].qty = Math.min(20, qty);
  write(lines);
}

export const clear = () => write([]);

export const count = () => read().reduce((s, l) => s + l.qty, 0);

/** Подробности для показа: цена и название берутся из каталога, а не из хранилища. */
export function detailed() {
  return read().map((l) => {
    const p = products.find((x) => x.id === l.id)!;
    return { ...l, name: p.name, price: p.price, photo: p.photo, sum: p.price * l.qty };
  });
}

export const subtotal = () => detailed().reduce((s, l) => s + l.sum, 0);

// Держать в согласии с functions/api/checkout.ts: расхождение витрины
// и сервера всплывает ровно на счёте, когда сумма уже названа покупателю.
export const FREE_FROM = 0;
export const SHIPPING = 0;
export const shippingFor = (sum: number) => (sum >= FREE_FROM || sum === 0 ? 0 : SHIPPING);

export function onChange(fn: (lines: Line[]) => void) {
  window.addEventListener(EVT, () => fn(read()));
  // storage — когда корзину поменяли в другой вкладке того же сайта
  window.addEventListener('storage', (e) => { if (e.key === KEY) fn(read()); });
}
