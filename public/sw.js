const CACHE_NAME = 'triptab-public-v2';
const OFFLINE_URL = '/offline.html';
const PUBLIC_ASSETS = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  // Updates stay waiting until a traveller explicitly requests activation.
  // Never reload an open expense editor automatically.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PUBLIC_ASSETS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('triptab-public-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING' || event.data === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(event.request, { cache: 'no-store' });
      } catch {
        return (await caches.match(OFFLINE_URL)) || new Response(
          'TripTab needs an internet connection. Reconnect and try again.',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }
    })());
    return;
  }

  // Only the offline screen and app icons are eligible for local storage.
  // Authenticated pages, APIs, and receipts always use the network.
  if (PUBLIC_ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(event.request)));
  }
});

function appUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    if (url.origin === self.location.origin && ['https:', 'http:'].includes(url.protocol)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // An invalid or off-site destination falls back to the app home screen.
  }
  return '/';
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'TripTab update';
    let body = 'Your holiday has an update. Open TripTab to review it.';
    let url = '/';
    let tag = 'triptab-update';

    // Push is only a wake-up signal. Fetch account-specific content with the
    // browser session instead of carrying personal details in the payload.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/notifications', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        const data = await response.json();
        const latest = Array.isArray(data.notifications) ? data.notifications[0] : null;
        if (latest) {
          if (typeof latest.title === 'string' && latest.title.trim()) title = latest.title.slice(0, 100);
          if (typeof latest.body === 'string' && latest.body.trim()) body = latest.body.slice(0, 240);
          url = appUrl(latest.url);
          if (typeof latest.id === 'string') tag = `triptab-${latest.id}`;
        }
      }
    } catch {
      // A visible generic notification is still required when fetching fails.
    } finally {
      clearTimeout(timeout);
    }

    await self.registration.showNotification(title, {
      body,
      tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(appUrl(event.notification.data?.url), self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        if (client.url !== url) await client.navigate(url);
        await client.focus();
        return;
      } catch {
        // If an existing window cannot be focused, try another or open one.
      }
    }
    await self.clients.openWindow(url);
  })());
});
