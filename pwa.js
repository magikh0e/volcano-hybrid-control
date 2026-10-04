// pwa.js — register the offline service worker and wire the install button.
// Kept in its own file (not inline) so the app works under a strict
// `script-src 'self'` Content-Security-Policy.

if ("serviceWorker" in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js").then(function (reg) {
      // An installed app can stay open for days: look for a new version
      // whenever it comes back to the front (at most every 30 minutes).
      var checked = Date.now();
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState !== "visible" || Date.now() - checked < 30 * 60 * 1000) return;
        checked = Date.now();
        reg.update().catch(function () {});
      });
    }).catch(function () {});
  });
  // The new service worker takes over as soon as it installs, but this page is
  // still running the old code: offer a reload. The first install has nothing to reload.
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) { hadController = true; return; }
    updateReady();
  });
}

// "v1.5.0 is ready" banner. Hidden while a session runs (a reload would cut it
// off), shown again when it ends.
function updateReady() {
  if (document.getElementById("v-update")) return;
  fetch("version.js").then(function (r) { return r.text(); }).catch(function () { return ""; }).then(function (src) {
    var m = /VOLCANO_APP_VERSION = "([^"]+)"/.exec(src);
    var fresh = m && m[1] !== (typeof VOLCANO_APP_VERSION === "string" ? VOLCANO_APP_VERSION : "") ? m[1] : "";
    var bar = document.createElement("div");
    bar.id = "v-update"; bar.className = "v-update"; bar.setAttribute("role", "status");
    var text = document.createElement("span");
    text.textContent = fresh ? "Version " + fresh + " is ready." : "An update is ready.";
    var go = document.createElement("button");
    go.type = "button"; go.className = "v-btn"; go.textContent = "Reload";
    go.title = "Loads the new version. Connect the Volcano again afterwards.";
    go.addEventListener("click", function () { location.reload(); });
    var later = document.createElement("button");
    later.type = "button"; later.className = "v-mini"; later.textContent = "\u2715";
    later.title = "Later"; later.setAttribute("aria-label", "Later");
    later.addEventListener("click", function () { bar.remove(); });
    bar.append(text, go, later);
    var panel = document.getElementById("v-panel");
    if (panel) panel.insertBefore(bar, document.getElementById("v-error")); else document.body.prepend(bar);
    var sync = function () { bar.hidden = document.body.classList.contains("v-running"); };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
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
