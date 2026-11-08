const CACHE_NAME = "killer-owner-app-v1";
const APP_SHELL = [
  "/admin.html",
  "/style.css",
  "/admin.js?v=20261107-owner-app",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/app-icon-180.png",
  "/app-icon-192.png",
  "/app-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith("killer-owner-app-") && name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate" && ["/admin", "/admin/", "/admin.html"].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => (await caches.match("/admin.html")) || Response.error()));
    return;
  }

  if (APP_SHELL.includes(`${url.pathname}${url.search}`) || APP_SHELL.includes(url.pathname)) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match(url.pathname)) || Response.error()));
  }
});
