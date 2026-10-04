# Changelog

All notable changes to the Volcano Hybrid Web App ([volcano.magikh0e.pl](https://volcano.magikh0e.pl/)).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses
[Semantic Versioning](https://semver.org/): **major** for changes that break saved workflows or
how the app is used, **minor** for new features (templates, tabs, settings), **patch** for fixes
and polish. The version shown in the app and on the Help page comes from `version.js`.

## [Unreleased]

## [1.6.0] - 2026-10-04

### Added

- Favourite templates: tap ☆ next to a template's name, or next to the dropdown under the
  Volcano drawing. Favourites come first in that dropdown, have their own "★ Favourites" filter,
  and are included in backups.

## [1.5.0] - 2026-10-04

### Added

- "📣 Notify in background" on the Workflows tab: while a session runs and the app is in the
  background, a system notification says when to fit a fresh bag, when the bag is full, and when
  the session ends or stops on an error. Tapping it brings the app back.
- When a new version is installed, a banner names it and offers Reload. It stays hidden while a
  session runs. An installed app also checks for a new version when it comes back to the front.

### Fixed

- Right after an update, the offline cache could serve a file from the previous version until
  the next reload.

## [1.4.0] - 2026-10-03

### Added

- While a session runs, the browser tab's title shows the current step and time (for example
  "FILL 0:21 · Volcano"), so it can be followed from another tab.
- Session history on the Workflows tab: each run's name, start time, length, bags filled and
  how it ended. It's kept in this browser and included in backups; restoring merges it.
- Duplicate (⧉) on each saved workflow, to make a variation without rebuilding it.
- The Help page opens with a contents list of its sections and every FAQ entry. Links open
  the entry, so a single answer can be shared.

### Changed

- Better contrast: dim text, inactive tabs and the drawing's status line are easier to read in
  every theme, and the Light theme's orange and yellow are darker. All text now meets
  WCAG AA (4.5:1).
- Screen readers hear whether the drawing's HEAT and AIR buttons are on, and every icon-only
  button (share, export, move, delete) has a name.

## [1.3.0] - 2026-10-03

### Added

- Wide screens (1000 px and up): the Volcano drawing, its run dropdown and Fill bag sit in a
  left column that stays in view on every tab, with the tab's content on the right.
- New screenshots in the README and in the install dialog (wide ones for desktops, narrow ones
  for phones).

### Fixed

- The session line now keeps counting during a workflow run (it froze while runs paused the
  status polling).
- Console text is a little smaller on phones, so command listings no longer wrap mid-column.

## [1.2.0] - 2026-10-03

### Added

- The Control tab's run dropdown has a 🛍 Bags / 💨 Whip / All switch; the list shows only the
  matching templates and saved workflows. The choice is remembered.

- The app version shows as a badge next to the title on the app and Help pages, linking to
  this changelog.

- A workflow or template that loses the Bluetooth link mid-run now reconnects (for up to a
  minute) and carries on from the interrupted step; a fill cut short counts as done. If it
  can't reconnect, it stops and says the heater may still be on.
- The Control tab's run dropdown remembers the last profile picked.
- The Volcano drawing shows a bag (Bags mode) or a whip hose (Whip mode) on top, with vapor
  flowing while the fan runs; its panel pulses while heating and glows at temperature; and
  during a run its screen shows the current step (FIT BAG 0:24, FILL 0:31, HEAT → 185 °C…).
  Motion is replaced by static states for people who prefer reduced motion.
- A small fan icon on the drawing's screen lights up and spins while the fan runs, opposite
  the heater dot.
- A "by magikh0e · source" line under the title on the app, Help and 404 pages.

### Changed

- Shorter page heading: "Volcano Hybrid Web App".
- Control tab: the Target, Heat, Fan and Bag rows are gone (the drawing covers them); tap the
  drawing's screen to type an exact target. Fill bag sits under the run dropdown, with the
  presets below it.
- The Control tab's Run ladder is now the "Vapesuvius 5-min Ladder" template (5 minutes at
  each rung once reached). The console's `ladder` command still runs the timed ladder.
- The session line (runtime and auto-off countdown) moved from the Control tab to just under
  the connection status, so it shows on every tab while connected.

## [1.1.0] - 2026-10-03

### Added

- The screen stays on while a workflow or template runs, so a phone doesn't sleep and drop
  the Bluetooth connection mid-session.
- Sound and vibration cues: two beeps when it's time to fit a fresh bag, one when the bag is
  full. Toggle with "🔔 Sound & vibration cues" on the Workflows tab.
- "■ Stop & heat off" in the running banner, next to Stop.
- App units: show temperatures in °F (Settings → App units). Current and target temperature,
  presets and workflow progress follow it; the Volcano's own screen has its own setting.
- Control tab: an interactive Volcano drawing replaces the Current/Target boxes. Its screen
  shows current and target temperature; − and + change the target (sent after a short
  pause), and HEAT and AIR toggle the heater and fan, lighting up while on. A dropdown under
  it runs any saved workflow or template, with progress and Stop right there.
- Themes: Amber (default), Phosphor, Ice, Neon, Light and High contrast, picked in
  Settings → App → Theme and shared by the app, Help and 404 pages.
- Backup and restore: "⤓ Backup" downloads every saved workflow and the presets as one file;
  "⤒ Restore" adds the workflows back (skipping any already saved) and restores the presets.

### Changed

- The running banner says "Fit a fresh bag" during the wait before a fill, and "Filling bag"
  while it fills.
- Settings: the Volcano's display setting is now labelled "Device units", and a new "App"
  section holds App units and Install app.
- The Install app button moved from the footer to Settings → App, where it also says when the
  app is already installed or how to install it from the browser menu.

## [1.0.0] - 2026-10-03

### Added

- Version number in the app footer (with a link to this changelog) and a `version` console
  command.
- This changelog.

## Before 1.0.0

### 2026-10-01 to 2026-10-03

- Templates run straight from the list with ▶, next to + Save. Saved templates show
  "✓ Saved · Show". A banner at the top of the Workflows tab shows what's running, with Stop.
- "My workflows" heading; templates open by default when nothing is saved yet.
- Six whip templates: Whip @ 185 °C, Whip @ 205 °C, Two-Stage Whip, Whip Ramp, Long Whip
  Session, Whip Wind-Down.
- Support links (Patreon, Buy Me a Coffee) in the footer, Help and 404 page.
- The Apache vhost and a deploy runbook are tracked in `deploy/`; missing pages get the branded
  404 page.

### 2026-09-29

- Build-your-own ladder (start, end, step; bags or whip), and filter buttons for the template
  list (Bags, Whip, Single bag, Utility).
- Party Rounds template: 8 bags at 190 °C, 2½ minutes apart.
- New logo: page header, app icons, favicon and social card.
- SEO: "web app" titles, shorter descriptions, a 404 page, sitemap dates from git.
- The service worker always fetches fresh files when the cache version changes.

### 2026-09-26

- Template library: Project Onyx's premade workflows, then 20+ more sessions. Ladders run
  hands-free in a Bags or Whip version, with bag counts shown up front.
- Conditional Temp Set waits for the chamber to reach (or cool to) each rung before its hold.
  Exit When Temp Reached can compare against the target, the chamber, or either.
- Bags now fill completely before the heat turns off.
- `tools/deploy.py`: rsync to the server, Cloudflare purge, and a check that the
  service-worker cache was bumped.

### 2026-07-05 to 2026-07-06

- First release: control the Volcano Hybrid from the browser over Web Bluetooth.
  Temperature, heat, fan, bag fill, editable presets and the Vapesuvius ladder (optionally
  filling a bag at each rung).
- Settings tab: auto-off, LED brightness, display and vibration options.
- Workflows tab: an editor and engine for heat / fan / wait / LED / conditional-temperature /
  loop sequences, shareable as links.
- Console tab: a command line and small scripting language for the Volcano.
- Help page with FAQ, a boiling-point temperature guide and BLE protocol notes.
- Installable as an offline PWA; hosted on its own subdomain.

[Unreleased]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/magikh0e/volcano-hybrid-control/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/magikh0e/volcano-hybrid-control/releases/tag/v1.0.0
