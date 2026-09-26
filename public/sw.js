"use strict";
// Installability only: Chrome requires a service worker with a fetch handler
// before offering the PWA install prompt. This worker caches nothing — every
// request goes to the network, preserving the server's no-store/no-cache
// strategy that keeps the app shell and modules from going stale.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
