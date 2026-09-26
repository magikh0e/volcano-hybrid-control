#!/usr/bin/env python3
"""
Deploy volcano.magikh0e.pl: rsync the app to its docroot, then purge
Cloudflare for the files that changed.

No build step -- the repo root *is* the site. Transport and Cloudflare
handling mirror magikh0e-website/tools/deploy.py (same box, same zone).

Usage:
    python tools/deploy.py              # sw-cache check + rsync + purge + live check
    python tools/deploy.py --dry-run    # show what would transfer/delete; no upload
    python tools/deploy.py --skip-purge # rsync only
    python tools/deploy.py --check      # compare live service-worker CACHE to local
    python tools/deploy.py --no-sw-check  # deploy even if CACHE wasn't bumped

Configuration (environment, or .env at this repo root; anything not set
there falls back to ../magikh0e-website/.env so the SSH + Cloudflare
settings don't have to be duplicated):
    VOLCANO_DEPLOY_PATH  required, the subdomain's docroot on the server.
                         Deliberately NOT read from DEPLOY_PATH -- that's the
                         main site's docroot, and rsync --delete-after into it
                         would wipe magikh0e.pl.
    DEPLOY_HOST          required, e.g. root@45.63.91.201
    DEPLOY_PORT          default 22
    DEPLOY_KEY           optional, path to ssh key file
    DEPLOY_SSH           optional, explicit ssh binary for rsync -e
    CF_ZONE_ID           optional, enables purge (magikh0e.pl zone covers the subdomain)
    CF_API_TOKEN         optional, required for purge

Service-worker guard:
    service-worker.js is cache-first for every same-origin GET, so an
    installed PWA keeps serving the old files until CACHE changes. Before
    uploading, a dry-run rsync lists what would transfer; if anything
    besides service-worker.js changed but service-worker.js itself didn't,
    the deploy stops and asks you to bump CACHE.
"""

import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_ENV = os.path.abspath(os.path.join(ROOT, "..", "magikh0e-website", ".env"))

SITE_BASE = "https://volcano.magikh0e.pl"

CF_PURGE_BATCH = 30

# Docroots this script must never sync into (main site).
FORBIDDEN_PATHS = {"/", "/var/www/", "/var/www/html/"}

# Repo-only files. Anything excluded is also protected from --delete-after,
# which is why server-side-only files (.htaccess, ACME challenges) are
# listed here too: they aren't in the repo but must survive a deploy.
EXCLUDES = [
    ".git/",
    ".github/",
    ".claude/",
    "tools/",
    ".env",
    ".env.example",
    ".gitignore",
    "README.md",
    "__pycache__/",
    "*.pyc",
    ".DS_Store",
    "Thumbs.db",
    "/.htaccess",
    "/.well-known/",
]

SW_FILE = "service-worker.js"
SW_CACHE_RE = re.compile(r'const\s+CACHE\s*=\s*"([^"]+)"')


def load_dotenv(path):
    """Lightweight .env parser -- no external deps. Never overrides values
    already set, so the first file loaded wins."""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def cfg(key, default=None, required=False):
    val = os.environ.get(key, default)
    if required and not val:
        print(f"ERROR: {key} not set (in env, .env, or {SITE_ENV})", file=sys.stderr)
        sys.exit(2)
    return val


def run_capture(label, cmd):
    """Run cmd, streaming output live while capturing it for parsing."""
    print(f"\n== {label} ==")
    print("  " + " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    captured = []
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        captured.append(line)
    proc.wait()
    if proc.returncode != 0:
        print(f"!! {label} failed (exit {proc.returncode})", file=sys.stderr)
        sys.exit(proc.returncode)
    return "".join(captured)


def find_ssh_bin():
    """Same preference order as the main site's deploy.py: cwrsync's Cygwin
    ssh first on Windows, because Windows OpenSSH 9.x has a pipe bug that
    kills rsync mid-stream. Returns (path, wants_cygwin_paths)."""
    override = os.environ.get("DEPLOY_SSH")
    if override:
        return override, any(t in override.lower() for t in ("cwrsync", "cygwin"))
    if os.name != "nt":
        return "ssh", False
    home = os.environ.get("USERPROFILE", "")
    for c in (
        os.path.join(home, "scoop", "apps", "cwrsync", "current", "bin", "ssh.exe"),
        r"C:\Program Files\cwRsync\bin\ssh.exe",
        r"C:\Program Files (x86)\cwRsync\bin\ssh.exe",
    ):
        if os.path.isfile(c):
            return c, True
    win_ssh = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                           "System32", "OpenSSH", "ssh.exe")
    if os.path.isfile(win_ssh):
        return win_ssh, False
    return "ssh", False


def to_cygwin_path(p):
    """C:\\foo -> /cygdrive/c/foo so rsync doesn't read 'C:' as a host."""
    if os.name != "nt" or not p or p.startswith("/"):
        return p
    if len(p) >= 2 and p[1] == ":":
        rest = p[2:].replace("\\", "/")
        if not rest.startswith("/"):
            rest = "/" + rest
        return f"/cygdrive/{p[0].lower()}{rest}"
    return p.replace("\\", "/")


def rsync(host, port, key, remote_path, dry_run):
    if not shutil.which("rsync"):
        print("ERROR: rsync not on PATH (scoop install cwrsync).", file=sys.stderr)
        sys.exit(2)

    ssh_bin, wants_cyg = find_ssh_bin()
    ssh_bin = ssh_bin.replace("\\", "/")
    rsh = f'"{ssh_bin}"' if " " in ssh_bin else ssh_bin
    rsh += f" -p {port}"
    if key:
        k = to_cygwin_path(key) if wants_cyg else key
        rsh += f' -i "{k}"' if " " in k else f" -i {k}"

    args = [
        "rsync", "-avz", "--delete-after", "--itemize-changes",
        # Windows reports everything as 0777; force sane modes server-side.
        "--chmod=D755,F644",
        "-e", rsh,
    ] + [f"--exclude={e}" for e in EXCLUDES]
    if dry_run:
        args.append("--dry-run")

    src = to_cygwin_path(ROOT.rstrip("/\\")) + "/"
    label = "rsync" + (" (dry run)" if dry_run else "")
    return run_capture(label, args + [src, f"{host}:{remote_path}"])


def parse_changes(text):
    """Return (transferred_files, deleted_paths) from --itemize-changes output."""
    sent, deleted = [], []
    for raw in text.splitlines():
        raw = raw.rstrip()
        if raw.startswith("*deleting"):
            deleted.append(raw[len("*deleting"):].strip())
            continue
        if len(raw) < 13 or raw[1] != "f" or raw[0] not in "><c":
            continue
        path = raw[12:].strip()
        if path:
            sent.append(path.replace("\\", "/"))
    return sent, deleted


def purge_urls(paths):
    urls = []
    for p in paths:
        p = p.lstrip("./")
        for u in (f"{SITE_BASE}/{p}", f"{SITE_BASE}/" if p == "index.html" else None):
            if u and u not in urls:
                urls.append(u)
    return urls


def cf_purge(zone_id, token, urls):
    print("\n== cloudflare purge ==")
    if not zone_id or not token:
        print("  CF_ZONE_ID or CF_API_TOKEN not set -- skipping")
        return
    if not urls:
        print("  nothing transferred -- nothing to purge")
        return
    api = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache"
    for i in range(0, len(urls), CF_PURGE_BATCH):
        chunk = urls[i:i + CF_PURGE_BATCH]
        req = Request(api, data=json.dumps({"files": chunk}).encode("utf-8"),
                      method="POST", headers={"Authorization": f"Bearer {token}",
                                              "Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if not data.get("success"):
                print(f"  purge failed: {data}")
                sys.exit(3)
        except HTTPError as e:
            print(f"  HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}")
            sys.exit(3)
        except URLError as e:
            print(f"  network error: {e.reason}")
            sys.exit(3)
    for u in urls:
        print(f"    + {u}")
    print(f"  purged {len(urls)} URL(s)")


def local_sw_cache():
    with open(os.path.join(ROOT, SW_FILE), encoding="utf-8") as f:
        m = SW_CACHE_RE.search(f.read())
    return m.group(1) if m else None


def check_live():
    """Compare the live service-worker CACHE name against the local one."""
    print("\n== freshness check ==")
    local = local_sw_cache()
    try:
        url = f"{SITE_BASE}/{SW_FILE}?cb={int(time.time())}"
        with urlopen(Request(url, headers={"User-Agent": "deploy-check"}), timeout=15) as r:
            m = SW_CACHE_RE.search(r.read().decode("utf-8", errors="replace"))
        live = m.group(1) if m else None
    except Exception as e:
        print(f"  cannot fetch live {SW_FILE}: {e}")
        return
    if local == live:
        print(f"  [ok] live and local both on {live}")
    else:
        print(f"  !! MISMATCH: local={local} live={live}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="rsync dry-run; no upload, no purge")
    ap.add_argument("--skip-purge", action="store_true")
    ap.add_argument("--check", action="store_true", help="only compare live vs local SW cache")
    ap.add_argument("--no-sw-check", action="store_true",
                    help="deploy even if files changed without a CACHE bump")
    args = ap.parse_args()

    load_dotenv(os.path.join(ROOT, ".env"))
    load_dotenv(SITE_ENV)

    if args.check:
        check_live()
        return

    host = cfg("DEPLOY_HOST", required=True)
    port = cfg("DEPLOY_PORT", "22")
    key = cfg("DEPLOY_KEY")
    remote_path = cfg("VOLCANO_DEPLOY_PATH", required=True)
    # Git Bash rewrites /var/... env vars into C:/Program Files/Git/var/...
    # before Python sees them, which would sneak past the forbidden-path
    # check below. Only accept a real absolute server path.
    if not remote_path.startswith("/"):
        print(f"ERROR: VOLCANO_DEPLOY_PATH={remote_path} isn't an absolute server path "
              "(Git Bash mangles /paths in env vars -- set it in .env instead).",
              file=sys.stderr)
        sys.exit(2)
    remote_path = posixpath.normpath(remote_path) + "/"
    if remote_path in FORBIDDEN_PATHS or remote_path == "//":
        print(f"ERROR: VOLCANO_DEPLOY_PATH={remote_path} is the main site / a parent "
              "dir; --delete-after would wipe it. Point it at the subdomain docroot.",
              file=sys.stderr)
        sys.exit(2)

    # Always preview first: feeds the SW guard, and on --dry-run it's the result.
    sent, deleted = parse_changes(rsync(host, port, key, remote_path, dry_run=True))

    print(f"\n{len(sent)} file(s) would transfer, {len(deleted)} would be deleted")
    for p in deleted:
        print(f"  - {p}")

    stale_sw = [p for p in sent if p != SW_FILE]
    if stale_sw and SW_FILE not in sent and not args.no_sw_check:
        print(f"\n!! {len(stale_sw)} file(s) changed but {SW_FILE} didn't -- installed PWAs "
              f"would keep the old shell.\n   Bump CACHE (currently {local_sw_cache()}) "
              f"and re-run, or pass --no-sw-check.", file=sys.stderr)
        sys.exit(4)

    if args.dry_run:
        print(f"\n(dry run) would purge: {len(purge_urls(sent))} URL(s)")
        print("(dry run complete -- no upload, no purge)")
        return
    if not sent and not deleted:
        print("\nNothing to deploy -- live already matches.")
        check_live()
        return

    sent, _ = parse_changes(rsync(host, port, key, remote_path, dry_run=False))

    if args.skip_purge:
        print("\n(skipped Cloudflare purge per --skip-purge)")
    else:
        cf_purge(cfg("CF_ZONE_ID"), cfg("CF_API_TOKEN"), purge_urls(sent))

    check_live()


if __name__ == "__main__":
    main()
