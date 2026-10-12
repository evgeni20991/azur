import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  // Адрес нужен карте сайта: без него ссылки в ней будут относительными
  // и поисковик их не примет.
  site: 'https://azur-shop.pages.dev',
  integrations: [
    sitemap({
      // Служебные и личные страницы в карте сайта не нужны: панель управления
      // в выдаче — приглашение подбирать пароль, а страница заказа
      // содержит чужие персональные данные.
      filter: (page) => !/\/(admin|pay|order|account|checkout)\/?$/.test(new URL(page).pathname),
    }),
  ],
  // Статика на Cloudflare Pages. Серверный рендер потребовал бы переезда
  // на Workers: адаптер собирает под другую платформу, а это смена адреса
  // сайта и повторный ввод всех ключей. Изменяемые данные — цены, остатки,
  // заказы — живут в D1 и подтягиваются страницей при открытии.
  vite: { plugins: [tailwind()] },
  build: { inlineStylesheets: 'auto' },
});
