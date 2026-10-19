#!/usr/bin/env python3
"""
Check the live site the way a visitor would. .github/workflows/live-check.yml runs it
daily and opens an issue when something fails.

Usage:
    python tools/live_check.py                     # print the results
    python tools/live_check.py --report out.md     # also write them as Markdown

Checks volcano.magikh0e.com (headers, version, redirects, 404, the app and the demo in
headless Chrome), the old address, volcano.magikh0e.pl (the "We've moved" page, its
redirects and the service worker that retires the old offline copy), and
volcano.tropicalrootsmaui.com (redirects everything to the same page on .com). Needs Playwright
and Chrome, as tools/smoke.py. Exit code 1 if anything failed.
"""

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE = "https://volcano.magikh0e.com"
OLD = "https://volcano.magikh0e.pl"
ALIAS = "https://volcano.tropicalrootsmaui.com"   # a Cloudflare redirect rule in that zone
UA = "Mozilla/5.0 (volcano-hybrid-control live check; +https://github.com/magikh0e/volcano-hybrid-control)"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = build_opener(NoRedirect)


def fetch(url, tries=3):
    """(status, headers, text) without following redirects; retried on network errors."""
    for i in range(tries):
        try:
            with OPENER.open(Request(url, headers={"User-Agent": UA}), timeout=20) as r:
                return r.status, r.headers, r.read().decode("utf-8", errors="replace")
        except HTTPError as e:   # 3xx/4xx/5xx land here with no redirect handler
            return e.code, e.headers, e.read().decode("utf-8", errors="replace")
        except (URLError, TimeoutError, ConnectionError) as e:
            if i == tries - 1:
                return 0, {}, str(e)
            time.sleep(10)


def repo_version():
    with open(os.path.join(ROOT, "version.js"), encoding="utf-8") as f:
        return re.search(r'VOLCANO_APP_VERSION = "([^"]+)"', f.read()).group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", help="write the results as Markdown to this file")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(("  ok    " if ok else "  FAIL  ") + name + (f": {detail}" if detail and not ok else ""))

    # ---- the site ----
    st, h, body = fetch(SITE + "/")
    check("volcano.magikh0e.com answers", st == 200, f"HTTP {st}")
    csp = (h.get("Content-Security-Policy") or "") if h else ""
    check("security policy and headers", "script-src 'self'" in csp and h.get("Strict-Transport-Security")
          and h.get("X-Content-Type-Options") == "nosniff", f"CSP: {csp[:60] or 'missing'}")
    check("canonical address is .com", '<link rel="canonical" href="https://volcano.magikh0e.com/">' in body)
    st, _, js = fetch(SITE + "/version.js")
    live = (re.search(r'VOLCANO_APP_VERSION = "([^"]+)"', js) or [None, None])[1]
    want = repo_version()
    check("live version matches the repo", live == want, f"live {live}, repo {want} (a release not deployed?)")
    st, h, _ = fetch("http://volcano.magikh0e.com/help.html")
    check("http redirects to https", st in (301, 308) and (h.get("Location") or "").startswith("https://"), f"HTTP {st}")
    st, _, body = fetch(SITE + "/no-such-page-" + str(int(time.time())))
    check("missing pages get the 404 page", st == 404 and "Page not found" in body, f"HTTP {st}")
    st, _, md = fetch(SITE + "/CHANGELOG.md")
    check("changelog served (What's new)", st == 200 and f"## [{want}]" in md, f"HTTP {st}")

    # ---- the old address ----
    st, _, body = fetch(OLD + "/")
    check("old address shows the moved page", st == 200 and "has moved" in body, f"HTTP {st}")
    st, h, _ = fetch(OLD + "/help.html")
    check("old address redirects to .com", st == 301 and h.get("Location") == SITE + "/help.html",
          f"HTTP {st} -> {h.get('Location') if h else ''}")
    st, _, sw = fetch(OLD + "/service-worker.js")
    check("old offline copy retires itself", st == 200 and "unregister" in sw, f"HTTP {st}")

    # ---- volcano.tropicalrootsmaui.com ----
    st, h, _ = fetch(ALIAS + "/help.html?from=check")
    check("volcano.tropicalrootsmaui.com redirects to .com", st == 301
          and h.get("Location") == SITE + "/help.html?from=check", f"HTTP {st} -> {h.get('Location') if h else ''}")

    # ---- the app and the demo, in a browser ----
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch(channel="chrome")
            ctx = b.new_context(service_workers="block")
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(SITE + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(1500)
            check("app loads without script errors", not errors and page.locator("#v-status").count() == 1, "; ".join(errors)[:200])
            page.goto(SITE + "/?demo", wait_until="load", timeout=30000)
            try:
                page.wait_for_function("() => window.fakeVolcano && fakeVolcano.state.heat === true", timeout=15000)
                check("demo connects and heats", True)
            except Exception:
                check("demo connects and heats", False, page.text_content("#v-status") or "no status")
            b.close()
    except ImportError:
        check("app and demo in a browser", False, "Playwright isn't installed")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed.")
    if args.report:
        run = ""
        if os.environ.get("GITHUB_RUN_ID"):
            run = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        lines = [f"Live check of {SITE} at {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC: "
                 f"{len(results) - len(failed)} of {len(results)} checks passed." + (f" [Run]({run})" if run else ""), "",
                 "| Check | Result |", "|---|---|"]
        lines += [f"| {n} | {'✅' if ok else '❌ ' + (d or 'failed').replace('|', '/')} |" for n, ok, d in results]
        with open(args.report, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
