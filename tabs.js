// tabs.js — show/hide the Control / Settings / Workflows panels.
// Pure DOM, no Bluetooth: kept out of volcano-ble.js so that engine stays
// byte-identical to the site copy (there are no tabs there, and this no-ops
// gracefully when .v-tab elements are absent). Remembers the last tab.

(function () {
  "use strict";
  var KEY = "volcano-tab";
  var tabs = [].slice.call(document.querySelectorAll(".v-tab[data-tab]"));
  var panels = [].slice.call(document.querySelectorAll(".v-tabpanel[data-tab]"));
  if (!tabs.length || !panels.length) return;

  function show(name) {
    tabs.forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach(function (p) { p.hidden = p.dataset.tab !== name; });
    try { localStorage.setItem(KEY, name); } catch (e) { /* ignore */ }
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () { show(t.dataset.tab); });
  });

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  var valid = tabs.some(function (t) { return t.dataset.tab === saved; });
  show(valid ? saved : "control");
})();
