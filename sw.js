// Hilltoppers Study service worker.
//
// It exists for one reason: a Web Push notification has to be shown by a worker
// on the site's own origin, and that is the only way to reach a student while
// the Topping — which normally lives inside the Hilltoppers popup — is closed.
//
// It deliberately does NOT cache anything and does NOT handle `fetch`. The site
// is already versioned by the ?v= on its stylesheet, so an offline copy here
// would only ever be a way to serve something stale, and a worker with no fetch
// listener cannot interfere with the page at all.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // The Worker always sends JSON, but a push with no body should still show
  // something rather than nothing.
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title = typeof message.title === 'string' && message.title ? message.title : 'Hilltoppers Study';
  const body = typeof message.body === 'string' && message.body
    ? message.body
    : 'A classmate is looking to study.';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: 'logo.png',
    badge: 'favicon.png',
    // The same tag replaces an earlier, unread notification of the same kind:
    // only the newest invite matters, and the room behind an older one has
    // usually expired by the time it is read.
    tag: typeof message.tag === 'string' && message.tag ? message.tag : 'hilltoppers-study',
    data: { url: typeof message.url === 'string' && message.url ? message.url : './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    // Prefer a tab that is already on the site, so a click focuses the Topping
    // rather than piling up copies of it.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
