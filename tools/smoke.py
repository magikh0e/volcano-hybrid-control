#!/usr/bin/env python3
"""
Smoke test: serve the repo locally and drive the app against the simulated
Volcano (tools/fake-volcano.js) in headless Chrome. tools/deploy.py runs it
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
  - Backup downloads workflows, presets and history
  - a Help contents link opens its FAQ entry
"""

import argparse
import functools
import http.server
import json
import os
import re
import sys
import threading
from urllib.request import urlopen

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEED = 40          # ?fake=N: app timers run N times faster
INIT = "window.confirm = () => true; window.alert = () => {};"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
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
        def context(**kw):
            ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block", **kw)
            ctx.add_init_script(INIT)
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

        # Backup carries workflows, presets and history
        page.click(".v-tab[data-tab='workflows']")
        with page.expect_download() as dl:
            page.click("button:has-text('⤓ Backup')")
        data = json.loads(open(dl.value.path(), encoding="utf-8").read())
        page.click("button:has-text('+ New workflow')")
        unnamed = page.evaluate(r"""() => [...document.querySelectorAll("button")].filter((b) => b.offsetParent &&
          !(b.getAttribute("aria-label") || b.textContent.trim().replace(/[^\p{L}\p{N}]/gu, ""))).map((b) => b.outerHTML.slice(0, 80))""")
        self.check(not unnamed, "every visible button has a readable name" + (f" ({unnamed[:3]})" if unnamed else ""))
        self.check(all(k in data for k in ("workflows", "presets", "history")) and len(data["history"]) == 1,
                   "backup has workflows, presets and history")
        ctx.close()

        # Link drops mid-run: reconnect and finish
        ctx = context()
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

        self.check(not self.errors, "no script errors" + ("".join("\n          " + e for e in self.errors[:8]) if self.errors else ""))


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
