// tabs.js — show/hide the Control / Settings / Workflows / Console panels and
// wire the ARIA tablist keyboard pattern: Left/Right (and Up/Down) move between
// tabs, Home/End jump to the ends, and a roving tabindex keeps a single tab in
// the Tab order. Pure DOM, no Bluetooth — no-ops gracefully if tabs are absent.
// Remembers the last tab in localStorage.

(function () {
  "use strict";
  var KEY = "volcano-tab";
  var tabs = [].slice.call(document.querySelectorAll(".v-tab[data-tab]"));
  var panels = [].slice.call(document.querySelectorAll(".v-tabpanel[data-tab]"));
  if (!tabs.length || !panels.length) return;

  function show(name, focus) {
    tabs.forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;          // roving tabindex: only the active tab is tabbable
      if (on && focus) t.focus();
    });
    panels.forEach(function (p) { p.hidden = p.dataset.tab !== name; });
    try { localStorage.setItem(KEY, name); } catch (e) { /* ignore */ }
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { show(t.dataset.tab); });
    t.addEventListener("keydown", function (e) {
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      show(tabs[next].dataset.tab, true);
    });
  });

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  var valid = tabs.some(function (t) { return t.dataset.tab === saved; });
  show(valid ? saved : "control");
})();
