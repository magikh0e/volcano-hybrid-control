// theme.js — apply the saved colour theme before the page renders, and wire the
// picker in Settings → App. Loaded in <head> without `defer` so there's no flash
// of the default theme; kept out of the HTML for the strict script-src CSP.
// The colours themselves live in volcano.css under [data-theme="…"].

(function () {
  var THEMES = [
    { id: "amber", name: "Amber" },
    { id: "phosphor", name: "Phosphor" },
    { id: "ice", name: "Ice" },
    { id: "neon", name: "Neon" },
    { id: "light", name: "Light" },
    { id: "contrast", name: "High contrast" },
  ];
  var KEY = "volcano-theme";
  var root = document.documentElement;

  function valid(id) { return THEMES.some(function (t) { return t.id === id; }); }
  function saved() {
    try { var id = localStorage.getItem(KEY); return valid(id) ? id : "amber"; } catch (e) { return "amber"; }
  }
  // Browser chrome (address bar / PWA title bar) follows the theme's background.
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (meta && bg) meta.setAttribute("content", bg);
  }
  function apply(id) {
    root.setAttribute("data-theme", id);
    if (document.readyState !== "loading") syncThemeColor();
  }

  apply(saved());

  function renderPicker() {
    var box = document.getElementById("v-themes");
    if (!box) return;
    box.textContent = "";
    var current = root.getAttribute("data-theme");
    THEMES.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "v-theme";
      b.setAttribute("aria-pressed", t.id === current ? "true" : "false");
      var sw = document.createElement("span");
      sw.className = "v-swatch"; sw.setAttribute("data-theme", t.id); sw.setAttribute("aria-hidden", "true");
      b.append(sw, document.createTextNode(t.name));
      b.addEventListener("click", function () {
        apply(t.id);
        try { localStorage.setItem(KEY, t.id); } catch (e) { /* not saved, still applied */ }
        renderPicker();
      });
      box.append(b);
    });
  }

  document.addEventListener("DOMContentLoaded", function () { syncThemeColor(); renderPicker(); });
})();
