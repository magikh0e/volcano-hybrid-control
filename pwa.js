// pwa.js — register the offline service worker and wire the install button.
// Kept in its own file (not inline) so the app works under a strict
// `script-src 'self'` Content-Security-Policy.

if ("serviceWorker" in navigator) {
  addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js").catch(function () {});
  });
}

// The install row lives in Settings → App. It shows the Install button when the
// browser offers one, "installed" when running as the app, and otherwise points
// to the browser's own menu (iOS Safari/Bluefy and Firefox have no prompt).
(function () {
  var deferred = null;
  var btn = document.getElementById("v-install");
  var note = document.getElementById("v-install-note");
  function installed() {
    return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }
  function show(canPrompt) {
    if (btn) btn.hidden = !canPrompt;
    if (note) note.textContent = installed() ? "Installed: you're using the app."
      : canPrompt ? "Adds it to your home screen or desktop; works offline."
      : "Your browser's menu can install this as an app (Install app / Add to Home Screen).";
  }
  show(false);
  addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e; show(true);
  });
  if (btn) btn.addEventListener("click", function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.finally(function () { deferred = null; show(false); });
  });
  addEventListener("appinstalled", function () { deferred = null; show(false); });
})();
