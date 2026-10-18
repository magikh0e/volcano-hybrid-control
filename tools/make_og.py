#!/usr/bin/env python3
"""
Render og.jpg, the 1200x630 link-preview image: the app mid-fill (drawing, running
session, temperature graph) beside the title and the address.

Usage:
    python tools/make_og.py

Needs Playwright and an installed Chrome (as tools/smoke.py) and ffmpeg for the
final downscale. The app is driven against the simulated Volcano, so it renders the
same every time.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # the local server
from playwright.sync_api import sync_playwright

ROOT = smoke.ROOT
ADDRESS = "volcano.magikh0e.com"
SHOT = os.path.join(ROOT, "_og-app.png")      # temporary, served next to logo.webp for the card page
CARD = os.path.join(ROOT, "_og-card.html")
BIG = os.path.join(ROOT, "_og-2x.png")
OUT = os.path.join(ROOT, "og.jpg")

CARD_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1200px; height: 630px; background: #0a0a0a; overflow: hidden; }
body { display: flex; align-items: center; justify-content: center; gap: 64px; padding: 0 48px; box-sizing: border-box;
  font: 15px/1.5 ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace; color: #e9e9e9; }
.text { flex: none; }
.brand { display: flex; align-items: center; gap: 20px; }
.brand img { width: 104px; height: 104px; border-radius: 18px; }
h1 { margin: 0; font-size: 50px; line-height: 1.12; color: #e8892e; }
.tag { margin: 26px 0 0; font-size: 25px; line-height: 1.45; color: #e9e9e9; }
.feat { margin: 18px 0 0; font-size: 19px; line-height: 1.6; color: #9a9a9a; }
.demo { margin: 30px 0 0; font-size: 22px; color: #e9e9e9; }
.demo b { color: #e8892e; border-bottom: 2px solid #e8892e; padding-bottom: 3px; font-weight: 600; }
.frame { flex: none; padding: 16px 14px 10px; border-radius: 24px; border: 2px solid #2a3d2f; background: #0a0a0a;
  box-shadow: 0 0 40px rgba(232,137,46,0.18); }
.frame img { display: block; height: 530px; }
</style></head><body>
<div class="text">
  <div class="brand"><img src="logo.webp" alt=""><h1>Volcano Hybrid<br>Web App</h1></div>
  <p class="tag">Control your Volcano from the browser.<br>No app. No account.</p>
  <p class="feat">35 hands-free sessions · live graph<br>session notes · works offline</p>
  <p class="demo">Try the demo: <b>%s</b></p>
</div>
<div class="frame"><img src="_og-app.png" alt=""></div>
</body></html>""" % ADDRESS


def main():
    srv, base = smoke.serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="chrome")
            # 1. The app column mid-fill, after ~40 s so the graph shows the climb, the hold and the fill
            ctx = b.new_context(viewport={"width": 400, "height": 900}, device_scale_factor=2, color_scheme="dark",
                                service_workers="block")
            ctx.add_init_script("window.confirm = () => true; localStorage.clear();")
            page = ctx.new_page()
            page.goto(f"{base}/?fake=1")
            page.wait_for_function("() => !!window.fakeVolcano")
            page.evaluate("""() => { const req = navigator.bluetooth.requestDevice;
              navigator.bluetooth.requestDevice = (...a) => req(...a).then((d) => { d.name = "S&B VOLCANO H"; return d; }); }""")
            page.click("#v-connect")
            page.wait_for_function("() => document.body.classList.contains('v-connected')")
            page.evaluate("fakeVolcano.state.cur = 110; fakeVolcano.setSpeed(3)")
            page.evaluate("""() => { const s = document.querySelector('#v-dev-run select');
              s.value = [...s.options].find((o) => o.text.startsWith('Sampler')).value; s.dispatchEvent(new Event('change')); }""")
            page.click("#v-dev-run .v-btn")
            page.wait_for_function("() => (document.getElementById('v-dev-step').textContent || '').startsWith('FILL')", timeout=90000)
            page.wait_for_timeout(3500)
            page.locator("#v-side").screenshot(path=SHOT)
            ctx.close()
            # 2. The card, at 2x, then scaled down for crisp text
            with open(CARD, "w", encoding="utf-8") as f:
                f.write(CARD_HTML)
            ctx = b.new_context(viewport={"width": 1200, "height": 630}, device_scale_factor=2)
            page = ctx.new_page()
            page.goto(f"{base}/_og-card.html")
            page.wait_for_timeout(500)
            page.screenshot(path=BIG)
            b.close()
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", BIG, "-vf", "scale=1200:630:flags=lanczos",
                        "-q:v", "3", OUT], check=True)
    finally:
        srv.shutdown()
        for f in (SHOT, CARD, BIG):
            if os.path.exists(f):
                os.remove(f)
    print(OUT, os.path.getsize(OUT))


if __name__ == "__main__":
    main()
