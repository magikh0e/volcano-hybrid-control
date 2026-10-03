// help.js — open the FAQ answer a link points at (#faq-…), on load and when the
// hash changes, so jump-list links and shared links land on an expanded answer.
(function () {
  function openTarget() {
    var id = decodeURIComponent(location.hash.slice(1));
    var el = id && document.getElementById(id);
    if (el && el.tagName === "DETAILS") { el.open = true; el.scrollIntoView({ block: "start" }); }
  }
  addEventListener("hashchange", openTarget);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", openTarget);
  else openTarget();
})();
