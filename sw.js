const CACHE = 'shift-workbench-v29';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg'
];

// 监听主线程发来的跳过等待消息
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// 点击锁屏/通知中心的通知 → 打开（或聚焦）工作台
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) { list[0].focus(); return; }
      return clients.openWindow('./');
    })
  );
});

// 安装：逐个缓存核心资源，单个失败不影响整体（保证 index.html 一定进缓存）
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 先把最关键的页面壳缓存好
    try { await cache.add('./index.html'); } catch (err) { console.warn('[SW] index.html 缓存失败', err); }
    // 其余资源尽力缓存
    await Promise.allSettled(SHELL.map((u) =>
      cache.add(u).catch((err) => console.warn('[SW] 缓存失败', u, err))
    ));
    await self.skipWaiting();
  })());
});

// 激活：清理旧缓存并立即接管页面
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只处理同源请求；跨域（如天气 API）直接放行，不拦截
  if (url.origin !== self.location.origin) return;

  // 页面导航：缓存优先，保证离线/弱网也能打开；在线时后台刷新
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) {
        // 后台静默更新缓存
        fetch(req).then((res) => {
          if (res && res.status === 200) caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        }).catch(() => {});
        return cached;
      }
      // 还没缓存过：尝试网络
      try {
        const res = await fetch(req);
        if (res && res.status === 200) caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      } catch (err) {
        // 最后兜底：返回任意已缓存的文档，绝不给 undefined
        const any = await caches.match('./').catch(() => null);
        return any || Response.error();
      }
    })());
    return;
  }

  // 静态资源：缓存优先，后台更新
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
