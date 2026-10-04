// service-worker.js — offline app shell for the Volcano control PWA.
//
// Cache-first for same-origin GETs so the panel loads instantly and works
// offline (the Web Bluetooth link itself still needs the device in range —
// only the UI is cached, not the BLE session). Bump CACHE on any asset change
// to invalidate the old shell.

const CACHE = "volcano-hybrid-control-v59";
const ASSETS = [
  "./",
  "./index.html",
  "./help.html",
  "./help.js",
  "./volcano.css",
  "./volcano-ble.js",
  "./pwa.js",
  "./theme.js",
  "./version.js",
  "./tabs.js",
  "./console.js",
  "./logo.webp",
  "./assets/favicon-32.png",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // cache: "reload" skips the browser's HTTP cache, so a CACHE bump can't
    // lock a stale copy of an asset into the new cache.
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Tapping a session notification brings the app back to the front.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const app = wins.find((w) => !/\/(help|404)\.html/.test(new URL(w.url).pathname)) || wins[0];
      return app ? app.focus() : self.clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Only this version's cache: right after an update the old one still exists
  // for a moment, and caches.match() would serve the old files from it.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          cache.put(req, res.clone());
          return res;
        }).catch(() => cache.match("./index.html"))
      )
    )
  );
});
