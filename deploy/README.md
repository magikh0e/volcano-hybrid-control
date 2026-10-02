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
`service-worker.js`, and stamps `sitemap.xml` dates from git on every run.
