# Deploying volcano.magikh0e.pl

Server-side setup for the standalone app. This folder is kept in git for
reference and is **never uploaded** to the docroot (`tools/deploy.py`
excludes it).

## What's here

- `volcano.magikh0e.pl.conf` — the Apache vhost, as live on the server at
  `/etc/apache2/sites-available/volcano.magikh0e.pl.conf` (enabled via a
  symlink in `sites-enabled/`). If you edit the live file, copy it back here.

## The vhost, in short

- **:80** redirects everything to HTTPS.
- **:443** serves `/var/www/volcano` with `AllowOverride None` (so `.htaccess`
  files are ignored — put directives in the vhost), blocks `/.git`, sets the
  security headers and CSP, keeps the HTML shell and service worker
  revalidating, and serves `/404.html` for missing pages.
- **TLS** uses a Cloudflare Origin Certificate at
  `/etc/ssl/cloudflare/volcano.magikh0e.pl.{pem,key}`, with the zone's SSL/TLS
  mode at Full (strict). The cert files must exist before the vhost is enabled,
  or `apache2ctl configtest` fails for every site.

## Changing the vhost

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
python tools/deploy.py             # rsync + Cloudflare purge + live check
```

The script refuses to deploy if app files changed without a `CACHE` bump in
`service-worker.js`, and stamps `sitemap.xml` dates from git on every run. Before
uploading it runs the smoke test (below); a failure stops the deploy.

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

`tools/fake-volcano.js` simulates a Volcano Hybrid over the same Bluetooth IDs. Serve the
repo locally (for example `python -m http.server 8765`) and open
`http://localhost:8765/?fake` (or `?fake=50` to run the app's timers 50x faster). Connect
as usual; the console has `fakeVolcano.state`, `fakeVolcano.log` (every write),
`fakeVolcano.drop()` to drop the link and `fakeVolcano.failReconnects(n)`. It only loads on
localhost with `?fake`, and `tools/` is never deployed.

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
