"use strict";

const SHELL_CACHE = "buylist-shell-v1";
const SHELL_URLS = ["/", "/index.html", "/app.js", "/style.css", "/data/categories.json", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategie: statische Shell aus dem Cache (offline-fähig), alles /api/* nur Netz.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  // Navigation: erst Cache (offline), sonst Netz + in den Cache legen
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/index.html").then((cached) => cached || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put("/index.html", copy));
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
      }
      return res;
    }))
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = { title: "Buylist", body: "", url: "/" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
