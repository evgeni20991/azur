/**
 * Подсказки адреса и карта при оформлении заказа.
 *
 * Зачем: в поле «город, улица, дом» человек пишет как придётся —
 * «дом 32 к2 стр1», «пр-т» и «проспект», опечатки в названии улицы.
 * Курьер потом звонит и переспрашивает, а часть заказов просто не доезжает.
 * Подсказка отдаёт адрес в том виде, в котором его понимает служба доставки.
 *
 * Устройство:
 *   — подсказки берём у Яндекса обычным запросом, без тяжёлых библиотек;
 *   — карту грузим ТОЛЬКО по кнопке: её скрипт весит около трёхсот
 *     килобайт, и тянуть его на каждого покупателя нельзя;
 *   — без ключей поле остаётся обычным и ничего не ломается.
 *
 * Ключи лежат в открытом виде — так устроен клиентский API Яндекса.
 * Защита не в секретности, а в ограничении по адресу сайта в кабинете
 * разработчика: чужой сайт с этим ключом работать не будет.
 */
import { maps } from '../content/site';

type Suggest = { title: { text: string }; subtitle?: { text: string }; tags?: string[] };

const DEBOUNCE = 250;   // меньше — лишние запросы на каждую букву, больше — заметная задержка

export function initAddress(input: HTMLInputElement) {
  if (!maps.suggestKey) return;   // ключа нет — обычное поле, и это нормально

  const wrap = document.createElement('div');
  wrap.className = 'sug-wrap';
  input.parentElement?.insertBefore(wrap, input);
  wrap.append(input);

  const list = document.createElement('ul');
  list.className = 'sug';
  list.hidden = true;
  wrap.append(list);

  let timer: number | undefined;
  let items: string[] = [];
  let active = -1;

  const close = () => { list.hidden = true; active = -1; };

  const paint = () => {
    list.innerHTML = items
      .map((t, i) => `<li><button type="button" class="sug-i${i === active ? ' on' : ''}" data-i="${i}">${t}</button></li>`)
      .join('');
    list.hidden = !items.length;
  };

  const pick = (i: number) => {
    if (!items[i]) return;
    input.value = items[i];
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  };

  list.addEventListener('mousedown', (e) => {
    // mousedown, а не click: click приходит после blur, и список успевает
    // закрыться раньше, чем выбор сработает.
    const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
    if (!b) return;
    e.preventDefault();
    pick(Number(b.dataset.i));
  });

  input.addEventListener('input', () => {
    const text = input.value.trim();
    window.clearTimeout(timer);
    if (text.length < 3) { items = []; close(); return; }
    timer = window.setTimeout(async () => {
      try {
        const url = new URL('https://suggest-maps.yandex.ru/v1/suggest');
        url.searchParams.set('apikey', maps.suggestKey);
        url.searchParams.set('text', text);
        url.searchParams.set('lang', 'ru');
        url.searchParams.set('results', '6');
        // Просим дома, а не станции метро и организации: адрес доставки
        // должен быть адресом, куда приедет курьер.
        url.searchParams.set('types', 'house,street');
        if (maps.bbox) url.searchParams.set('bbox', maps.bbox);
        const r = await fetch(url.toString());
        if (!r.ok) return;
        const d = await r.json();
        items = (d.results ?? []).map((s: Suggest) =>
          [s.title?.text, s.subtitle?.text].filter(Boolean).join(', '));
        active = -1;
        paint();
      } catch { /* сеть отвалилась — человек допишет адрес сам */ }
    }, DEBOUNCE);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') close();
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ── карта по кнопке ───────────────────────────────────────────────── */

let mapsReady: Promise<void> | null = null;

function loadMaps(): Promise<void> {
  mapsReady ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(maps.jsKey)}&lang=ru_RU`;
    s.onload = () => (window as any).ymaps.ready(res);
    s.onerror = rej;
    document.head.append(s);
  });
  return mapsReady;
}

export function initMapButton(input: HTMLInputElement, host: HTMLElement, btn: HTMLButtonElement) {
  if (!maps.jsKey) { btn.hidden = true; return; }

  btn.addEventListener('click', async () => {
    if (host.dataset.on === '1') { host.hidden = !host.hidden; return; }
    btn.disabled = true;
    btn.textContent = 'Загружаем карту…';
    try {
      await loadMaps();
      const ymaps = (window as any).ymaps;
      host.hidden = false;
      host.dataset.on = '1';

      const map = new ymaps.Map(host, { center: maps.center, zoom: 12, controls: ['zoomControl'] });
      const pin = new ymaps.Placemark(maps.center, {}, { draggable: true, preset: 'islands#blueDotIcon' });
      map.geoObjects.add(pin);

      // Метка ставится по клику и тащится мышью; адрес подставляем обратный,
      // чтобы человек видел словами то, что показал пальцем.
      const toAddress = async (coords: number[]) => {
        const res = await ymaps.geocode(coords, { results: 1 });
        const obj = res.geoObjects.get(0);
        if (obj) {
          input.value = obj.getAddressLine();
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      map.events.add('click', (e: any) => {
        const c = e.get('coords');
        pin.geometry.setCoordinates(c);
        toAddress(c);
      });
      pin.events.add('dragend', () => toAddress(pin.geometry.getCoordinates()));

      // Если адрес уже введён — показываем именно его, а не центр города.
      if (input.value.trim().length > 5) {
        const res = await ymaps.geocode(input.value, { results: 1 });
        const obj = res.geoObjects.get(0);
        if (obj) {
          const c = obj.geometry.getCoordinates();
          map.setCenter(c, 16);
          pin.geometry.setCoordinates(c);
        }
      }
      btn.textContent = 'Скрыть карту';
    } catch {
      btn.textContent = 'Карта не загрузилась';
    }
    btn.disabled = false;
  });
}
