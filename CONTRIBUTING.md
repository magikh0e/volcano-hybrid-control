# Contributing

Bug reports, ideas, session templates and pull requests are all welcome. For reports and ideas,
use the [issue forms](https://github.com/magikh0e/volcano-hybrid-control/issues/new/choose); the
app's **Report a problem** link opens the bug form with the version and browser filled in.
Problems with the Volcano in Home Assistant belong with
[SavageNL's integration](https://github.com/SavageNL/home-assistant-volcano-hybrid).

## How the app is built

Plain HTML, CSS and JavaScript with no build step, no framework and no dependencies. What's in
the repo is what's served.

| File | What it is |
|---|---|
| `index.html`, `volcano.css` | The app's page and styles, including the six themes |
| `volcano-ble.js` | Bluetooth, the drawing, workflows and templates, history, backups |
| `console.js`, `tabs.js`, `theme.js`, `pwa.js`, `version.js`, `greeting.js` | Console tab, tabs, themes, install and updates, version, the DevTools greeting |
| `help.html`, `help.js` | The Help page |
| `demo-volcano.js` | The simulated Volcano behind the demo and the tests |
| `service-worker.js` | Offline copy of the app |
| `tools/smoke.py` | The automated test; `tools/deploy.py` is the maintainer's deploy |

The site runs under a strict Content Security Policy: no inline `<script>` or `style=""`, and no
outside scripts, styles or fonts. Keep code in the `.js` files and styles in `volcano.css`.

## Running it locally

```bash
python -m http.server 8765
```

Then open <http://localhost:8765/?fake> for a simulated Volcano with the app's normal storage
(`?fake=50` runs the app's timers 50 times faster), or <http://localhost:8765/?demo> for the demo.
A real Volcano needs Chrome, Edge or Opera on desktop, or Chrome on Android. The browser console
has `fakeVolcano.state`, `fakeVolcano.log`, `fakeVolcano.drop()` and `fakeVolcano.setSpeed(n)`.

## Adding a session template

Templates live in `WF_TEMPLATES` in `volcano-ble.js`. A ladder lists its temperatures and gets
bag and whip versions automatically:

```js
{ group: "Your name", name: "Evening Ladder", temps: [180, 190, 200], whipSecs: 240,
  desc: "Three steps for an evening session: 180, 190 and 200 °C." },
```

Other templates spell out their actions (`heatOn`, `conditionalTemp`, `fanOn`, `wait`, `heatOff`,
and so on); the existing ones are the best examples. Help's "What are Workflows" answer explains
each action.

## The smoke test

```bash
pip install --user playwright
python tools/smoke.py
```

It serves the repo, drives the app against the simulated Volcano in headless Chrome, and checks
sessions, reconnects, history, backups, the demo, contrast in every theme and more. It also runs
on GitHub for every push and pull request. Please make sure it passes.

## Before opening a pull request

- Add a line under `## [Unreleased]` in `CHANGELOG.md`, written for people who use the app.
- If you changed anything the app loads, bump `CACHE` in `service-worker.js`.
- Say whether you tried it on a real Volcano, in the demo, or both.

Contributions are released under the project's licence, [GPL-3.0](LICENSE).
