// version.js — the app version, shown on every page that has a [data-app-version]
// element (the title badge and footer link). Bump it with a CHANGELOG.md entry on
// each release; see deploy/README.md.

var VOLCANO_APP_VERSION = "2.4.2";
var VOLCANO_CHANGELOG_URL = "https://github.com/magikh0e/volcano-hybrid-control/blob/main/CHANGELOG.md";
var VOLCANO_ISSUE_URL = "https://github.com/magikh0e/volcano-hybrid-control/issues/new";

// "Chrome 129 on Windows (installed app)": the browser and system, for bug reports.
function volcanoDeviceSummary() {
  var ua = navigator.userAgent, m, b = "", os = "";
  if ((m = /Edg\/(\d+)/.exec(ua))) b = "Edge " + m[1];
  else if ((m = /OPR\/(\d+)/.exec(ua))) b = "Opera " + m[1];
  else if (/Bluefy/i.test(ua)) b = "Bluefy";
  else if ((m = /Firefox\/(\d+)/.exec(ua))) b = "Firefox " + m[1];
  else if ((m = /Chrome\/(\d+)/.exec(ua))) b = "Chrome " + m[1];
  else if ((m = /Version\/(\d+).*Safari/.exec(ua))) b = "Safari " + m[1];
  if ((m = /Android (\d+)/.exec(ua))) os = "Android " + m[1];
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/iPhone/.test(ua)) os = "iPhone";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  var installed = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  return (b || "Unknown browser") + (os ? " on " + os : "") + (installed ? " (installed app)" : "");
}

// "Report a problem" links ([data-report-link]) open the bug form with the version,
// browser and device filled in (GitHub fills issue-form fields from the link).
// The app adds the Volcano's firmware once it's connected.
function volcanoReportLinks(extra) {
  var fields = { template: "bug_report.yml", version: "v" + VOLCANO_APP_VERSION, device: volcanoDeviceSummary() };
  if (extra) for (var k in extra) if (extra[k]) fields[k] = extra[k];
  var q = Object.keys(fields).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]); }).join("&");
  document.querySelectorAll("[data-report-link]").forEach(function (a) { a.href = VOLCANO_ISSUE_URL + "?" + q; });
}

document.addEventListener("DOMContentLoaded", function () {
  volcanoReportLinks();
  document.querySelectorAll("[data-app-version]").forEach(function (el) {
    el.textContent = "v" + VOLCANO_APP_VERSION;
    if (el.tagName === "A") {
      el.href = VOLCANO_CHANGELOG_URL;
      el.title = "What's new in each version";
    }
  });
});
