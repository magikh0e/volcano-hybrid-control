# Deploying volcano.magikh0e.com

Server-side setup for the app. This folder is kept in git for reference and is
**never uploaded** (`tools/deploy.py` excludes it).

## Where it runs

- **volcano.magikh0e.com**: Hostinger shared hosting (LiteSpeed), in
  `~/domains/volcano.magikh0e.com/public_html/` of the Hostinger account, which also
  hosts other sites. HTTPS is Hostinger's certificate; the DNS record in Cloudflare's
  magikh0e.com zone is DNS-only (not proxied). The repo's `.htaccess` carries the
  security headers, CSP, cache rules and 404 page, and is deployed with the site.
- **volcano.magikh0e.pl**: the old address, on the magikh0e.pl server behind
  Cloudflare. It serves a "We've moved" page from `/var/www/volcano-moved/`
  (`pl-moved/` here) that carries each browser's saved data to the new address in
  the link's #fragment, plus a service worker that retires the old offline copy.
  Every other URL redirects permanently (301) to the same path on the new address.
  The previous app files are kept in `/var/www/volcano/` for a rollback.
- **volcano.tropicalrootsmaui.com**: a Cloudflare Redirect Rule in the
  tropicalrootsmaui.com zone sends every request (301, path and query string kept) to
  the same page on volcano.magikh0e.com. The DNS record must stay proxied.

`tools/live_check.py` checks all three daily (`.github/workflows/live-check.yml`) and
opens an issue if something fails.

## What's here

- `volcano.magikh0e.pl.conf`: the old address's Apache vhost, as live at
  `/etc/apache2/sites-available/volcano.magikh0e.pl.conf`. If you edit the live file,
  copy it back here.
- `pl-moved/`: the old address's "We've moved" page, its script and style, the
  retiring service worker, and the logo and favicon it shows.

## Hostinger access

SSH from hPanel: the site's hosting, then **Advanced → SSH Access** (port 65002). The
deploy key is `~/.ssh/id_hostinger_volcano`; its public half is added there. Settings
go in `.env` (see `.env.example`). The deploy only accepts a target path ending in
`/domains/volcano.magikh0e.com/public_html/`, because `--delete-after` removes
anything there that isn't in this repo.

## The old address

Updating the moved page (from the repo root; the magikh0e.pl server's SSH settings
are in `../magikh0e-website/.env`):

```bash
rsync -avz --delete-after deploy/pl-moved/ root@<server>:/var/www/volcano-moved/
```

Then purge `https://volcano.magikh0e.pl/` and `/service-worker.js` in Cloudflare
(magikh0e.pl zone). Changing the vhost:

```bash
cp -p /etc/apache2/sites-available/volcano.magikh0e.pl.conf /root/volcano.magikh0e.pl.conf.bak-$(date +%Y%m%d%H%M%S)
# edit the file, then:
apache2ctl configtest && systemctl reload apache2
```

Only reload after `configtest` prints `Syntax OK`; otherwise restore the backup.

## Deploying the app

From the repo root (see `.env.example` for configuration):

```bash
python tools/deploy.py --dry-run   # preview: files to upload / delete
python tools/deploy.py             # smoke test + rsync to Hostinger + live check
```

The script refuses to deploy if app files changed without a `CACHE` bump in
`service-worker.js`, and stamps `sitemap.xml` dates from git on every run. Before
uploading it runs the smoke test (below); a failure stops the deploy.

`tools/make_og.py` re-renders `og.jpg`, the link-preview image, when its text or the
app's look changes.

## Releasing a version

Changes collect under `## [Unreleased]` in `CHANGELOG.md` as they land. To release:

1. Pick the number ([semver](https://semver.org/)): major for changes that break saved
   workflows, minor for new features, patch for fixes and polish.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it, and update the compare links at the bottom.
3. Set `VOLCANO_APP_VERSION` in `version.js` to the same number, and bump `CACHE` in
   `service-worker.js`.
4. Commit, then tag and push: `git tag -a vx.y.z -m "vx.y.z" && git push origin vx.y.z`.
5. Deploy. `tools/deploy.py` warns if the version in `version.js` has no changelog entry.
6. Publish the GitHub release with that version's changelog section as its notes:
   `gh release create vx.y.z --verify-tag --title vx.y.z --notes-file notes.md`.

## Testing without a Volcano

`demo-volcano.js` simulates a Volcano Hybrid over the same Bluetooth IDs. It's deployed for
the public demo (`?demo` on any host: heats at about a real Volcano's pace, and keeps its
data in the tab's own storage). For development, serve the repo locally (for example
`python -m http.server 8765`) and open `http://localhost:8765/?fake`, or `?fake=50` to run
the app's timers 50x faster; `?fake` uses the normal storage and only works on localhost.
Connect as usual; the console has `fakeVolcano.state`, `fakeVolcano.log` (every write),
`fakeVolcano.drop()` to drop the link, `fakeVolcano.failReconnects(n)`, and
`fakeVolcano.setSpeed(n)` (what the demo's speed switch calls).

## Smoke test

`python tools/smoke.py` serves the repo on a spare local port and drives the app against the
fake Volcano in headless Chrome: precache files served, Quick Bag run start to finish (write
order, one fill, heat off, session history), a link dropped mid-run, every theme, °F units,
button names, Backup, the Help contents and the 404 page, with no script errors. It needs
Playwright and an installed Chrome:

```bash
pip install --user playwright
```

`--headed` shows the browser. `tools/deploy.py` runs it before every upload (skip with
`--no-smoke`); without Playwright it warns and carries on. GitHub Actions also runs it on
every push to `main` and every pull request (`.github/workflows/smoke.yml`).
