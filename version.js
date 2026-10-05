// version.js — the app version, shown on every page that has a [data-app-version]
// element (the title badge and footer link). Bump it with a CHANGELOG.md entry on
// each release; see deploy/README.md.

var VOLCANO_APP_VERSION = "2.3.1";
var VOLCANO_CHANGELOG_URL = "https://github.com/magikh0e/volcano-hybrid-control/blob/main/CHANGELOG.md";

document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("[data-app-version]").forEach(function (el) {
    el.textContent = "v" + VOLCANO_APP_VERSION;
    if (el.tagName === "A") {
      el.href = VOLCANO_CHANGELOG_URL;
      el.title = "What's new in each version";
    }
  });
});
