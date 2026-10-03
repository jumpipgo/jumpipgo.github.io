// Имя кэша получает отпечаток сборки: скрипт ставится
// scripts/stamp-sw.mjs после `vite build`. Пока имя было постоянным, байты
// service-worker.js не менялись от деплоя к деплою — значит, не запускались ни
// install, ни activate, и чистка старых assets/index-*.js|css не выполнялась
// никогда: кэш рос, а комментарий ниже описывал поведение, которого не было.
const CACHE_NAME = 'meso-pwa-v6-75a32dd524c0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  // Плитка сетки точек: без неё офлайн на первом запуске фон был бы однотонным.
  './bg/dots.svg',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/**
 * Список файлов сборки берём из самой index.html.
 *
 * Раньше в precache попадали только оболочка и иконки, а хешированные
 * assets/index-*.js|css — нет: service worker регистрируется по событию
 * `load`, то есть после загрузки бандла, и мимо него запросы проходят.
 * Сценарий «установил, закрыл, ушёл в зал без сети» заканчивался вечным
 * скелетоном: index.html отдавался из кэша, а на бандл сети не было и в кэше
 * его тоже не было.
 */
async function buildAssetList() {
  try {
    const response = await fetch('./index.html', { cache: 'no-cache' });
    if (!response.ok) return [];
    const html = await response.text();
    return [...html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css|svg|png|webmanifest))"/g)]
      .map((match) => `./${match[1]}`);
  } catch {
    return [];
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const assets = await buildAssetList();
      // Пустой список — это не успех, а поломка: регулярка в buildAssetList
      // завязана на `base: './'`, и при его смене precache молча опустел бы,
      // установка прошла бы, а офлайн кончился бы вечным скелетоном.
      if (!assets.length) throw new Error('precache: в index.html не найдено ни одного ассета');
      // По одному файлу: addAll падает целиком, если недоступен хоть один URL,
      // и тогда в кэш не попадает ничего — даже то, что удалось скачать.
      const failed = [];
      await Promise.all([...APP_SHELL, ...assets].map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => {
          failed.push(url);
          return undefined;
        })));
      if (failed.length) console.warn('precache: не удалось положить в кэш', failed);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      // Ранее ушедшие из оборота assets/index-*.js|css копились в кэше
      // вечно: имя кэша постоянное, а файлы с хешами меняются каждый деплой.
      .then(() => buildAssetList())
      .then(current => caches.open(CACHE_NAME))
      .then(cache => cache.keys().then((requests) => ({ cache, requests, current })))
      .then(({ cache, requests, current }) => Promise.all(requests.map((request) => {
        const path = new URL(request.url).pathname;
        if (!path.includes('/assets/')) return Promise.resolve(false);
        // current содержит «./assets/index-*.js», а путь из кэша — «index-*.js»
        // после /assets/: без префикса сравнение всегда было ложным, и весь
        // precache считался устаревшим.
        const name = path.split('/assets/')[1];
        const stale = !current.includes(`./assets/${name}`);
        // Именно cache.delete: caches.delete(name) из CacheStorage ждёт ИМЯ
        // кэша, а получает Request, не находит такого и молча ничего не делает.
        return stale ? cache.delete(request) : Promise.resolve(false);
      })))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(request, fallbackToIndex = false) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackToIndex) return caches.match('./index.html');
    throw new Error('Нет сети и нет кэшированного ресурса');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Range-запросы класть в Cache API запрещено: put() бросает исключение.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirst(request, true));
    return;
  }

  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
