// Handles push notifications and caches static assets.

const CACHE_NAME = "embervy-v55";
const CACHE_URLS = ["/style.css?v=122", "/app.js?v=138", "/settings.js?v=114", "/games.js?v=1", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((n) => caches.delete(n)))
    ).then(() =>
      caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_URLS))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()).then(() => {
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "reload" }));
      });
    })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only the listed static assets are kept by the worker, so deleted content is never revived from it.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !CACHE_URLS.includes(url.pathname + url.search)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && !response.redirected && !/no-store|private/i.test(response.headers.get("cache-control") || "")) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)));
        } else {
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.delete(event.request)));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Embervy", body: "New message" };
  try {
    data = event.data.json();
  } catch {}

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: false }).then((windowClients) => {
      const appInForeground = windowClients.some((c) => c.visibilityState === "visible");
      if (appInForeground) return;

      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: "/icon-192.svg",
        badge: "/icon-192.svg",
        tag: "embervy-message",
        renotify: true,
        vibrate: [200, 100, 200],
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
