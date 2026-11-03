/* 每日待办 · Service Worker
   定位：**离线壳缓存**，只让"安装到主屏后断网也能打开"成立。
   不做任何数据同步 —— 本应用的数据本来就只在本机 localStorage，
   SW 只负责把 HTML/CSS/JS 缓存下来，避免断网时连壳都打不开。

   策略：
   - 导航请求：网络优先、失败回落缓存（保证更新能生效，断网时仍能开）
   - 静态资源：缓存优先（带 hash 的资源不会变，命中即返回，秒开）
   - 更新：activate 时清理旧版本缓存；SKIP_WAITING 让新版本立刻接管
*/
const CACHE = 'daily-todo-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 只预缓存入口，资源靠运行时按需缓存（hash 文件名在构建后才确定）
      .then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest']))
      .catch(() => {
        /* 预缓存失败不影响安装，运行时仍会缓存 */
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 导航：网络优先 + 断网回落
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => hit)
    )
  );
});
