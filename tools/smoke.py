#!/usr/bin/env python3
"""
Smoke test: serve the repo locally and drive the app against the simulated
Volcano (demo-volcano.js) in headless Chrome. tools/deploy.py runs it
before every upload.

Usage:
    python tools/smoke.py            # headless
    python tools/smoke.py --headed   # watch it run

Needs Playwright and an installed Chrome:
    pip install --user playwright

Checks:
  - every file the service worker precaches is served (a missing one
    breaks the PWA install)
  - the app, Help and 404 pages load with no script errors
  - connect, run Quick Bag 185 °C hands free: heater on and 185 °C set
    before the fill, one fill, heat off at the end, logged in session history
  - drop the Bluetooth link mid-run: it reconnects and finishes
  - every theme applies, °F app units show on the drawing
  - a starred template leads the drawing's list and the Favourites filter
  - Backup downloads workflows, presets, history and favourites
  - ↻ on a history row runs it again (also for entries saved without a source)
  - saved workflows with duplicate ids get fresh ones on load
  - deleting a workflow, an action or a preset happens at once and Undo
    (or Ctrl+Z) puts it back
  - ▲ / ▼ reorder saved workflows, keeping focus on the moved card
  - the demo (?demo) connects itself to "Demo Volcano" and keeps its data out of
    the real storage
  - the temperature graph draws; the end-of-session summary opens the note
    editor, and a note and rating save and back up
  - keyboard shortcuts H and + drive the heater and target; preset labels show
  - a Help contents link opens its FAQ entry
  - in the background, notifications say fit a bag, bag full, complete
  - a new version (served from a temporary copy of the site) shows the
    reload banner, hides it during a run, and Reload loads it
  - contrast: with the graph, summary and Undo bars, note editor, preset
    labels, update banner and demo banner on screen, every visible text in
    all six themes and every tab meets WCAG AA (4.5:1, or 3:1 for large text
    and the graph's lines)
"""

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import threading
from urllib.request import urlopen

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEED = 40          # ?fake=N: app timers run N times faster
INIT = "window.confirm = () => true; window.alert = () => {};"
# For pages loaded without the simulator (no ?fake or ?demo) on browsers with no
# Web Bluetooth at all, such as Chrome on Linux in CI: without it the app shows
# its "unsupported" note instead of the panel.
NO_BT = """
if (!navigator.bluetooth) Object.defineProperty(navigator, "bluetooth", { configurable: true,
  value: { requestDevice: () => Promise.reject(new DOMException("No Bluetooth here", "NotFoundError")) } });
"""
# The page reports itself hidden, notifications are on and allowed, and every
# notification's title is recorded in window.__notes.
BACKGROUND = """
Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" });
Object.defineProperty(Document.prototype, "hidden", { get: () => true });
localStorage.setItem("volcano-notify", "1");
window.__notes = [];
window.Notification = function (title) { window.__notes.push(title); };
window.Notification.permission = "granted";
window.Notification.requestPermission = () => Promise.resolve("granted");
"""


THEMES = ["amber", "phosphor", "ice", "neon", "light", "contrast"]
TABS = ["control", "settings", "workflows", "console"]
# Every visible text (and the graph's lines) against what's actually behind it:
# colours composited with opacity up the tree, backgrounds stacked down from <html>.
AUDIT = r"""() => {
  const rgba = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ""); if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (f, b) => { const a = f[3]; return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)).concat(1); };
  const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const chain = (el) => { const c = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) c.push(n); return c; };
  const bgOf = (el) => chain(el).reverse().reduce((bg, n) => { const c = rgba(getComputedStyle(n).backgroundColor);
    return c && c[3] > 0 ? over(c, bg) : bg; }, [255, 255, 255, 1]);
  const opacityOf = (el) => chain(el).reduce((o, n) => o * parseFloat(getComputedStyle(n).opacity), 1);
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "") + (el.id ? "#" + el.id : "");
  const out = [], seen = new Set();
  const check = (el, text, colour, needed) => {
    const bg = bgOf(el), fg = over([colour[0], colour[1], colour[2], colour[3] * opacityOf(el)], bg), v = ratio(fg, bg);
    if (v < needed) out.push({ el: name(el), text: text.slice(0, 40), ratio: Math.round(v * 100) / 100, need: needed });
  };
  const shown = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility === "visible" && !el.closest("[hidden]"); };
  const off = (el) => el.closest("button:disabled, input:disabled, select:disabled, [aria-disabled='true'], svg, script, style, option");
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const t = walk.currentNode, el = t.parentElement;
    if (!t.nodeValue.trim() || !el || seen.has(el)) continue;
    seen.add(el);
    if (off(el) || !shown(el)) continue;
    const cs = getComputedStyle(el), c = rgba(cs.color); if (!c) continue;
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    check(el, t.nodeValue.trim(), c, large ? 3 : 4.5);
  }
  document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select, textarea").forEach((el) => {
    if (off(el) || !shown(el) || !el.value) return;
    check(el, "[" + el.value + "]", rgba(getComputedStyle(el).color), 4.5);
  });
  document.querySelectorAll("#v-graph-svg polyline").forEach((pl) => {
    if (!shown(pl.closest(".v-graph-plot"))) return;
    const cs = getComputedStyle(pl), c = rgba(cs.stroke); if (!c) return;
    const bg = bgOf(pl.closest(".v-graph-plot"));
    const fg = over([c[0], c[1], c[2], c[3] * parseFloat(cs.strokeOpacity || "1")], bg), v = ratio(fg, bg);
    if (v < 3) out.push({ el: "graph " + pl.getAttribute("class"), text: "line", ratio: Math.round(v * 100) / 100, need: 3 });
  });
  return out;
}"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], ConnectionError):   # the browser hung up early: fine
            super().handle_error(request, client_address)


def serve(directory=ROOT):
    handler = functools.partial(Quiet, directory=directory)
    srv = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://localhost:{srv.server_address[1]}"


class Smoke:
    def __init__(self, base):
        self.base = base
        self.failures = []
        self.errors = []

    def check(self, ok, what):
        print(("  ok    " if ok else "  FAIL  ") + what)
        if not ok:
            self.failures.append(what)

    def watch(self, page):
        page.on("pageerror", lambda e: self.errors.append(f"{page.url}: {e}"))
        page.on("console", lambda m: m.type == "error" and self.errors.append(f"{page.url}: {m.text}"))

    def precache(self):
        sw = open(os.path.join(ROOT, "service-worker.js"), encoding="utf-8").read()
        block = re.search(r"const ASSETS = \[(.*?)\];", sw, re.S).group(1)
        missing = []
        for path in re.findall(r'"\./([^"]*)"', block):
            try:
                with urlopen(f"{self.base}/{path}") as r:
                    if r.status != 200:
                        missing.append(path)
            except Exception:
                missing.append(path)
        self.check(not missing, "service worker precache list is served" + (f" (missing: {missing})" if missing else ""))

    def connect(self, page, query=""):
        page.goto(f"{self.base}/?fake={SPEED}{query}")
        page.wait_for_function("() => !!window.fakeVolcano")
        page.click("#v-connect")
        page.wait_for_function("() => document.body.classList.contains('v-connected')", timeout=10000)

    def run_template(self, page, name):
        page.evaluate("""(name) => {
          document.querySelector(".v-dev-modes button:last-child").click();   // All
          const s = document.querySelector("#v-dev-run select");
          const o = [...s.options].find((x) => x.text.startsWith(name));
          s.value = o.value; s.dispatchEvent(new Event("change"));
        }""", name)
        page.click("#v-dev-run .v-btn")

    def history(self, page):
        return page.evaluate("JSON.parse(localStorage.getItem('volcano-history') || '[]')")

    def run(self, browser):
        def context(init="", **kw):
            ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block", **kw)
            ctx.add_init_script(INIT + init)
            return ctx

        # Quick Bag, start to finish
        ctx = context(accept_downloads=True)
        page = ctx.new_page(); self.watch(page)
        self.connect(page)
        self.check(page.title().startswith("Volcano"), "app loads and connects to the fake Volcano")
        page.evaluate("fakeVolcano.state.cur = 183")
        self.run_template(page, "Quick Bag 185")
        page.wait_for_function("() => document.title.endsWith('· Volcano')", timeout=15000)
        self.check(True, "tab title shows the running step")
        page.wait_for_function("() => document.getElementById('v-dev-heat').getAttribute('aria-pressed') === 'true'", timeout=10000)
        self.check(True, "drawing's HEAT button reports pressed while heating")
        page.wait_for_function("() => (localStorage.getItem('volcano-history') || '[]') !== '[]'", timeout=60000)
        log = [line.split(" ", 1)[1] for line in page.evaluate("fakeVolcano.log")]
        names = [x.split(" ")[0] for x in log]
        self.check("heatOn" in names and "set 185" in log and log.index("set 185") < names.index("fanOn"),
                   "heater on and target 185 °C set before the fill")
        self.check(names.count("fanOn") == 1 and names.index("fanOn") < names.index("fanOff"), "one fill: pump on, then off")
        self.check(names[-1] == "heatOff" or "heatOff" in names[names.index("fanOff"):], "heat off after the fill")
        h = self.history(page)
        self.check(len(h) == 1 and h[0]["outcome"] == "complete" and h[0]["bags"] == 1,
                   f"session history: {h[0] if h else 'empty'}")
        self.check(page.title() == "Volcano Hybrid Control" or "·" not in page.title(), "tab title restored after the run")
        page.wait_for_function("() => !document.getElementById('v-graph').hidden", timeout=10000)
        self.check(page.locator("#v-graph-svg .vg-cur").count() == 1, f"temperature graph: {page.text_content('#v-graph-cap')}")

        # Favourite a template: first in the drawing's list, counted in the filter
        page.click(".v-tab[data-tab='workflows']")
        if page.get_attribute("button:has-text('📋 Templates')", "aria-expanded") != "true":
            page.click("button:has-text('📋 Templates')")
        page.click(".v-wf-tpl:has(strong:text-is('Quick Bag 185 °C')) .v-wf-fav")
        first = page.evaluate("""() => { const g = document.querySelector("#v-dev-run select optgroup");
          return g.label + ": " + [...g.querySelectorAll("option")].map((o) => o.text).join(", "); }""")
        self.check(first.startswith("★ Favourites: Quick Bag 185 °C"), f"starred template leads the drawing's list ({first})")
        self.check("(1)" in page.text_content(".v-wf-filters button:has-text('Favourites')"), "Favourites filter counts it")

        # The end-of-session summary leads to a note and rating on that history row
        done = page.text_content("#v-done .v-undo-text") if page.is_visible("#v-done") else "no summary bar"
        self.check(done.startswith("Done: Quick Bag 185 °C · 1 bag in"), f"session summary: {done}")
        page.click("#v-done .v-done-note")
        self.check(page.evaluate("document.activeElement.classList.contains('v-hist-notein')"),
                   "Add a note opens that session's note editor")
        page.click(".v-hist-noteedit .v-hist-star:nth-child(4)")
        page.fill(".v-hist-notein", "Blue Dream")
        page.click(".v-hist-noteedit .v-btn")
        h = self.history(page)
        self.check(h[0].get("rating") == 4 and h[0].get("note") == "Blue Dream"
                   and "★★★★☆ Blue Dream" in page.text_content(".v-hist-row .v-hist-note"), "history note and rating saved")

        # Backup carries workflows, presets, history and favourites
        with page.expect_download() as dl:
            page.click("button:has-text('⤓ Backup')")
        data = json.loads(open(dl.value.path(), encoding="utf-8").read())
        page.click("button:has-text('+ New workflow')")
        unnamed = page.evaluate(r"""() => [...document.querySelectorAll("button")].filter((b) => b.offsetParent &&
          !(b.getAttribute("aria-label") || b.textContent.trim().replace(/[^\p{L}\p{N}]/gu, ""))).map((b) => b.outerHTML.slice(0, 80))""")
        self.check(not unnamed, "every visible button has a readable name" + (f" ({unnamed[:3]})" if unnamed else ""))
        self.check(all(k in data for k in ("workflows", "presets", "history")) and len(data["history"]) == 1
                   and data.get("favourites") == ["Quick Bag 185 °C"] and data["history"][0].get("note") == "Blue Dream",
                   "backup has workflows, presets, history (with notes) and favourites")

        # Run again from history: a recorded template, then an older entry with no source
        page.evaluate("document.querySelector('.v-wf-history').open = true")
        page.click(".v-hist-row .v-hist-again")
        page.wait_for_function("() => JSON.parse(localStorage.getItem('volcano-history') || '[]').length === 2", timeout=60000)
        h = self.history(page)
        self.check(h[0]["name"] == "Quick Bag 185 °C" and h[0].get("src") == {"tpl": "Quick Bag 185 °C", "mode": None}
                   and h[0]["outcome"] == "complete", f"↻ runs a history row again ({h[0].get('src')})")
        page.evaluate("""() => { const h = JSON.parse(localStorage.getItem('volcano-history'));
          delete h[0].src; localStorage.setItem('volcano-history', JSON.stringify(h)); }""")
        page.reload()
        page.wait_for_function("() => !!window.fakeVolcano")
        page.click("#v-connect")
        page.wait_for_function("() => document.body.classList.contains('v-connected')", timeout=10000)
        page.evaluate("fakeVolcano.state.cur = 183")   # a fresh fake starts cold
        page.click(".v-tab[data-tab='workflows']")
        page.evaluate("document.querySelector('.v-wf-history').open = true")
        page.click(".v-hist-row .v-hist-again")
        page.wait_for_function("() => JSON.parse(localStorage.getItem('volcano-history') || '[]').length === 3", timeout=60000)
        h = self.history(page)
        self.check(h[0].get("src", {}).get("tpl") == "Quick Bag 185 °C", "an entry without a source is found by name and runs again")

        # Keyboard shortcuts (not while typing in a field)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("h")
        page.wait_for_function("() => fakeVolcano.state.heat === true", timeout=5000)
        page.keyboard.press("h")
        page.wait_for_function("() => fakeVolcano.state.heat === false", timeout=5000)
        was = page.evaluate("fakeVolcano.state.set")
        page.keyboard.press("+")
        page.wait_for_function("(was) => fakeVolcano.state.set === was + 1", arg=was, timeout=5000)
        page.click(".v-tab[data-tab='console']")
        page.focus("#v-term-in")
        page.keyboard.press("h")
        self.check(page.evaluate("fakeVolcano.state.heat") is False and page.input_value("#v-term-in") == "h",
                   "H toggles the heater, + raises the target; typing in a field isn't a shortcut")
        ctx.close()

        # Duplicate saved ids (from older versions) are repaired on load
        ctx = context("""localStorage.setItem("volcano-workflows", JSON.stringify([
          { id: "wf2_1", name: "A", actions: [{ type: "heatOff" }] },
          { id: "wf2_1", name: "B", actions: [{ type: "heatOff" }] }]));""" + NO_BT)   # no simulator on this page
        page = ctx.new_page(); self.watch(page)
        page.goto(self.base + "/")
        ids = page.evaluate("JSON.parse(localStorage.getItem('volcano-workflows')).map((w) => w.id)")
        self.check(len(ids) == 2 and len(set(ids)) == 2, f"duplicate workflow ids repaired ({', '.join(ids)})")

        # Undo instead of confirm (no ?fake here, so the undo window runs in real time)
        saved = "JSON.parse(localStorage.getItem('volcano-workflows')).map((w) => w.name + ':' + w.actions.length).join(' ')"
        page.click(".v-tab[data-tab='workflows']")
        page.evaluate("[...document.querySelectorAll('.v-wf-card')].find((c) => c.querySelector('.v-wf-name').value === 'A').querySelector('.v-wf-head .v-wf-del').click()")
        gone = page.evaluate(saved)
        msg = page.text_content("#v-undo .v-undo-text") if page.is_visible("#v-undo") else "no undo bar"
        page.click("#v-undo .v-btn")
        self.check(gone == "B:1" and page.evaluate(saved) == "A:1 B:1",
                   f"delete workflow, then Undo ({msg} -> {page.evaluate(saved)})")
        page.evaluate("[...document.querySelectorAll('.v-wf-card')].find((c) => c.querySelector('.v-wf-name').value === 'B').querySelector('.v-wf-action .v-wf-del').click()")
        gone = page.evaluate(saved)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Control+z")
        self.check(gone == "A:1 B:0" and page.evaluate(saved) == "A:1 B:1", "delete an action, then Ctrl+Z")
        page.evaluate("[...document.querySelectorAll('.v-wf-card')].find((c) => c.querySelector('.v-wf-name').value === 'B').querySelector('.v-wf-up').click()")
        order = page.evaluate(saved)
        focus = page.evaluate("document.activeElement.getAttribute('aria-label')")
        self.check(order == "B:1 A:1" and focus == "Move B down", f"▲ moves a workflow up ({order}; focus: {focus})")
        page.keyboard.press("Enter")
        self.check(page.evaluate(saved) == "A:1 B:1", "and ▼ (by keyboard) moves it back")
        page.click(".v-tab[data-tab='control']")
        page.click("#v-preset-edit")
        before = page.evaluate("[...document.querySelectorAll('#v-presets button[data-temp]')].map((b) => b.dataset.temp).join(',')")
        page.click("#v-presets button[data-temp]")
        fewer = page.evaluate("[...document.querySelectorAll('#v-presets button[data-temp]')].map((b) => b.dataset.temp).join(',')")
        page.click("#v-undo .v-btn")
        self.check(fewer != before and page.evaluate("[...document.querySelectorAll('#v-presets button[data-temp]')].map((b) => b.dataset.temp).join(',')") == before, f"remove a preset, then Undo ({before})")
        page.fill("#v-preset-add-in", "185")
        page.fill("#v-preset-add-label", "Clouds")
        page.click("#v-preset-add")
        page.reload()
        chip = page.text_content("#v-presets button[data-temp='185']")
        self.check(chip.startswith("Clouds 185°"), f"preset label saved and shown ({chip})")
        ctx.close()

        # Link drops mid-run: reconnect and finish. The page is "in the background"
        # with notifications on, so each cue should also notify.
        ctx = context(BACKGROUND)
        page = ctx.new_page(); self.watch(page)
        self.connect(page)
        page.evaluate("fakeVolcano.state.cur = 178")
        self.run_template(page, "Quick Bag 185")
        page.wait_for_function("() => (document.getElementById('v-dev-step').textContent || '').startsWith('HEAT')", timeout=15000)
        before = page.evaluate("fakeVolcano.failReconnects(1), fakeVolcano.drop(), fakeVolcano.log.length")
        page.wait_for_function("() => (localStorage.getItem('volcano-history') || '[]') !== '[]'", timeout=90000)
        after = [x.split(" ", 1)[1].split(" ")[0] for x in page.evaluate("fakeVolcano.log")[before:]]
        h = self.history(page)
        self.check(h and h[0]["outcome"] == "complete" and "fanOn" in after and "heatOff" in after,
                   f"link dropped while heating (first reconnect refused): resumes, fills, finishes "
                   f"({h[0]['outcome'] if h else 'no entry'})")
        notes = page.evaluate("window.__notes")
        self.check(notes[:1] == ["Fit a fresh bag"] and "Bag full" in notes and notes[-1] == "Session complete",
                   f"background notifications: {', '.join(notes) or 'none'}")

        # Themes and °F
        page.click(".v-tab[data-tab='settings']")
        themes = page.eval_on_selector_all("#v-themes button", "bs => bs.map((b) => b.dataset.theme || b.getAttribute('data-id') || '')")
        applied = []
        for i in range(len(themes)):
            page.locator("#v-themes button").nth(i).click()
            applied.append(page.evaluate("document.documentElement.dataset.theme || ''"))
        self.check(len(themes) >= 6 and len(set(applied)) == len(themes), f"{len(themes)} themes apply ({', '.join(applied)})")
        page.click("#v-appunits button[data-unit='F']")
        self.check("°F" in page.text_content("#v-set"), "°F app units show on the drawing")
        ctx.close()

        # Help and 404
        ctx = context()
        page = ctx.new_page(); self.watch(page)
        page.goto(f"{self.base}/help.html")
        link = page.locator(".v-toc a[href^='#faq-']").first
        target = link.get_attribute("href")[1:]
        link.click()
        page.wait_for_timeout(200)
        self.check(page.evaluate("(id) => document.getElementById(id).open", target), f"Help contents link opens #{target}")
        page.goto(f"{self.base}/404.html")
        self.check(page.locator("a[href='/']").count() > 0 or page.locator("a").count() > 0, "404 page loads")
        ctx.close()

        # The public demo: own storage, simulated device
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block")
        ctx.add_init_script(INIT)
        page = ctx.new_page(); self.watch(page)
        page.goto(f"{self.base}/?demo")
        page.wait_for_selector(".v-demo-bar", timeout=10000)
        page.wait_for_function("() => document.body.classList.contains('v-connected')", timeout=10000)   # connects itself
        page.click(".v-tab[data-tab='workflows']")
        page.click("button:has-text('+ New workflow')")
        kept = page.evaluate("""() => ({ real: localStorage.getItem("volcano-workflows"),
          demo: sessionStorage.getItem("volcano-demo:volcano-workflows") })""")
        self.check(page.text_content("#v-dev-state") == "Demo Volcano" and kept["real"] is None and bool(kept["demo"]),
                   "demo connects to Demo Volcano and saves only to its own storage")
        ctx.close()

        self.contrast(browser)
        self.update(browser)
        self.check(not self.errors, "no script errors" + ("".join("\n          " + e for e in self.errors[:8]) if self.errors else ""))


    def contrast(self, browser):
        """Every new and old piece of UI on screen at once, measured in all themes and tabs."""
        seed = """if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1");
          localStorage.setItem("volcano-history", JSON.stringify([{ name: "Quick Bag 185 °C", started: "2026-10-01T18:00:00Z",
            secs: 75, bags: 1, outcome: "stopped", rating: 3, note: "Quick one" }]));
          localStorage.setItem("volcano-preset-labels", JSON.stringify({ 179: "Terps" })); }"""
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block")
        ctx.add_init_script(INIT + seed)
        page = ctx.new_page(); self.watch(page)
        self.connect(page)
        page.evaluate("fakeVolcano.state.cur = 183")
        self.run_template(page, "Quick Bag 185")
        page.wait_for_selector("#v-done:not([hidden])", timeout=60000)            # summary bar
        page.click(".v-tab[data-tab='workflows']")
        page.evaluate("document.querySelector('.v-wf-history').open = true")
        page.click(".v-hist-row:nth-child(2) .v-hist-notebtn")                   # note editor, stars
        page.click(".v-tab[data-tab='control']")
        page.click("#v-preset-edit")                                             # preset editor, labels
        page.evaluate("updateReady()")                                           # update banner
        page.wait_for_selector("#v-update")
        page.click("#v-presets button[data-temp='230']")                         # Undo bar (8 s)
        fails = {}
        for theme in THEMES:
            page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
            for tab in TABS:
                page.click(f".v-tab[data-tab='{tab}']")
                for f in page.evaluate(AUDIT):
                    fails.setdefault(f"{theme}: {f['el']} '{f['text']}' {f['ratio']}:1 (needs {f['need']})", 1)
        ctx.close()
        # the demo's banner and speed switch
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block")
        ctx.add_init_script(INIT)
        page = ctx.new_page(); self.watch(page)
        page.goto(f"{self.base}/?demo")
        page.wait_for_selector(".v-demo-bar")
        for theme in THEMES:
            page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
            for f in page.evaluate(AUDIT):
                fails.setdefault(f"{theme}: {f['el']} '{f['text']}' {f['ratio']}:1 (needs {f['need']})", 1)
        # the Help page, every answer open
        page = ctx.new_page(); self.watch(page)
        page.goto(f"{self.base}/help.html")
        page.evaluate("document.querySelectorAll('details').forEach((d) => { d.open = true; })")
        for theme in THEMES:
            page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
            for f in page.evaluate(AUDIT):
                fails.setdefault(f"{theme} (help): {f['el']} '{f['text']}' {f['ratio']}:1 (needs {f['need']})", 1)
        ctx.close()
        self.check(not fails, "contrast in all themes and tabs, and on Help" +
                   "".join("\n          " + k for k in list(fails)[:80]) + (f"\n          … {len(fails) - 80} more" if len(fails) > 80 else ""))

    def update(self, browser):
        """Publish a "new version" into a copy of the site and watch an open page pick it up."""
        tmp = tempfile.mkdtemp(prefix="volcano-smoke-")
        site = os.path.join(tmp, "site")
        shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns(".git", ".claude", "tools", "deploy", "screenshots"))
        srv, base = serve(site)
        try:
            ctx = browser.new_context(viewport={"width": 1280, "height": 800})
            ctx.add_init_script(INIT + NO_BT)
            page = ctx.new_page(); self.watch(page)
            page.goto(base + "/")
            page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=15000)

            def edit(name, old, new):
                path = os.path.join(site, name)
                text = open(path, encoding="utf-8").read()
                open(path, "w", encoding="utf-8", newline="").write(re.sub(old, new, text, count=1))
            edit("service-worker.js", r'const CACHE = "([^"]+)"', r'const CACHE = "\g<1>-next"')
            edit("version.js", r'VOLCANO_APP_VERSION = "[^"]+"', 'VOLCANO_APP_VERSION = "9.9.9"')

            page.evaluate("document.body.classList.add('v-running')")   # as if a session were running
            page.evaluate("navigator.serviceWorker.getRegistration().then((r) => r.update())")
            page.wait_for_selector("#v-update", state="attached", timeout=15000)
            self.check(page.is_hidden("#v-update"), "update banner waits while a session runs")
            page.evaluate("document.body.classList.remove('v-running')")
            page.wait_for_selector("#v-update", state="visible", timeout=5000)
            self.check("9.9.9" in page.text_content("#v-update"), f"update banner: {page.text_content('#v-update').strip()}")
            page.click("#v-update .v-btn")
            page.wait_for_function("() => (document.querySelector('[data-app-version]') || {}).textContent === 'v9.9.9'", timeout=10000)
            self.check(True, "Reload loads the new version")
            ctx.close()
        finally:
            srv.shutdown()
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright isn't installed: pip install --user playwright", file=sys.stderr)
        sys.exit(3)

    srv, base = serve()
    print(f"== smoke test against {base} (fake Volcano, {SPEED}x timers) ==")
    smoke = Smoke(base)
    try:
        smoke.precache()
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=not args.headed)
            try:
                smoke.run(browser)
            except Exception as e:
                smoke.check(False, f"{type(e).__name__}: {str(e).splitlines()[0]}")
            finally:
                browser.close()
    finally:
        srv.shutdown()

    if smoke.failures:
        print(f"\n{len(smoke.failures)} check(s) failed.", file=sys.stderr)
        sys.exit(1)
    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
