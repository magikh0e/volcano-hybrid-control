// pwa.js — register the offline service worker and wire the install button.
// Kept in its own file (not inline) so the app works under a strict
// `script-src 'self'` Content-Security-Policy.

if ("serviceWorker" in navigator) {
  addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js").catch(function () {});
  });
}

(function () {
  var deferred = null;
  var btn = document.getElementById("v-install");
  addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    if (btn) btn.hidden = false;
  });
  if (btn) btn.addEventListener("click", function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.finally(function () { deferred = null; btn.hidden = true; });
  });
  addEventListener("appinstalled", function () { if (btn) btn.hidden = true; });
})();
