// moved.js: the app now lives at volcano.magikh0e.com. Saved data lives per address in the
// browser, so this page passes what this browser saved here along in the link's #fragment
// (which never reaches a server); the new address asks before adding it. ?demo and
// shared-workflow links (#wf=...) are carried over as they are.
(function () {
  "use strict";
  var TARGET = "https://volcano.magikh0e.com/";
  var DATA = ["volcano-workflows", "volcano-history", "volcano-presets", "volcano-preset-labels", "volcano-tpl-favs"];
  var saved = {}, has = false;
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^volcano-[\w-]+$/.test(k)) saved[k] = localStorage.getItem(k);
    }
  } catch (e) { /* storage blocked: nothing to carry */ }
  for (var j = 0; j < DATA.length; j++) if (saved[DATA[j]] != null) has = true;

  function b64url(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  var url = TARGET + (location.search || "");
  if (location.hash && !/^#move=/.test(location.hash)) url += location.hash;
  else if (has) url += "#move=" + b64url(JSON.stringify({ app: "volcano-hybrid-control", from: location.hostname, storage: saved }));

  document.addEventListener("DOMContentLoaded", function () {
    var go = document.getElementById("go"), carry = document.getElementById("carry"), cd = document.getElementById("countdown");
    go.href = url;
    if (has) carry.hidden = false;
    var left = 4;
    (function tick() {
      if (left <= 0) { location.replace(url); return; }
      cd.textContent = "Taking you there in " + left + "…";
      left--;
      setTimeout(tick, 1000);
    })();
  });
})();
