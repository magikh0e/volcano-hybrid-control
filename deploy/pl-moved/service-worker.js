// service-worker.js on the old address. The app moved to volcano.magikh0e.com; this
// replaces the old offline copy: it clears its caches, unregisters itself, and reloads
// open tabs so they reach the "We've moved" page and carry their data across.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    const wins = await self.clients.matchAll({ type: "window" });
    wins.forEach((w) => w.navigate(w.url).catch(() => {}));
  })());
});
