// service-worker.js — offline app shell for the Volcano control PWA.
//
// Cache-first for same-origin GETs so the panel loads instantly and works
// offline (the Web Bluetooth link itself still needs the device in range —
// only the UI is cached, not the BLE session). Bump CACHE on any asset change
// to invalidate the old shell.

const CACHE = "volcano-hybrid-control-v12";
const ASSETS = [
  "./",
  "./index.html",
  "./help.html",
  "./volcano.css",
  "./volcano-ble.js",
  "./pwa.js",
  "./tabs.js",
  "./console.js",
  "./banner.webp",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
