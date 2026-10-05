// service-worker.js — offline app shell for the Volcano control PWA.
//
// Network first for same-origin GETs, so every load online gets the current
// version; the cache is the fallback when offline or when the network takes
// longer than NET_WAIT_MS (the Web Bluetooth link itself still needs the
// device in range; only the UI is cached, not the BLE session). Bump CACHE on
// any asset change so the offline copy is refreshed too.

const CACHE = "volcano-hybrid-control-v70";
const NET_WAIT_MS = 4000;
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
  "./demo-volcano.js",
  "./greeting.js",
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
  event.respondWith((async () => {
    // Only this version's cache: right after an update the old one still exists
    // for a moment, and caches.match() would serve the old files from it.
    const cache = await caches.open(CACHE);
    // By URL (a navigation request can't be re-made with options), revalidated
    // with the server rather than taken from the browser's HTTP cache.
    const net = fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      // A page can't be handed a redirected response as is; pass on just its content.
      .then((res) => (res.redirected ? res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers })) : res))
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
    net.catch(() => {});   // if the cached copy answered first, a later network failure is fine
    const offline = () => cache.match(req).then((hit) => hit || (req.mode === "navigate" ? cache.match("./index.html") : undefined));
    try {
      // A slow network falls back to the cached copy if there is one.
      const res = await Promise.race([net, new Promise((r) => setTimeout(r, NET_WAIT_MS))]);
      if (res) return res;
      return (await offline()) || (await net);
    } catch (e) {
      return (await offline()) || Response.error();
    }
  })());
});
