# Contributing to FreeProxy VPN

Thank you for looking. This is a small project with one unusual property that
shapes almost everything below, so it is worth stating first.

## The one rule

**A claim goes in only after a read-back proved it.**

This app writes to the registry, to browser profiles, to the firewall and to DNS
on someone else's machine, and then tells them what it did. If it says an
extension was installed in Brave, the extension has to be in Brave — not
"the policy key was written", not "the API returned success". Windows accepts
plenty of writes that change nothing: an off-store `ExtensionInstallForcelist`
entry reads back perfectly out of the registry and installs nothing at all on an
unmanaged Edge, and the only place that says why is `edge://policy`.

So: if a route cannot work, say so in the UI and in the log. Do not add a
fallback that looks like success. A feature that is honestly reported as
unavailable is worth more here than one that is quietly fake, and every number
this project shows a user — a percentage, a country count, an exit total — has to
be one it measured.

The same rule applies to the README. Every port, path, line number and count on
that page was read out of the source; if you change something it describes,
change the description in the same commit.

## What you need

* **Windows 10 or 11, x64.** There is no other target. The whole app is Windows
  registry, `netsh`, `schtasks`, WinINET proxy settings and browser profile
  layouts.
* **An elevated terminal** for anything that touches the system. `npm start`
  from a normal terminal runs, but every system-level step will fail — honestly,
  with a logged reason, which is itself useful to see once.
* **Node.js and npm**, any recent version. There is no build step for the app
  code: no bundler, no transpiler, no TypeScript.

```bash
git clone https://github.com/Zero-Asif/FreeVPN-PC-App.git
cd FreeVPN-PC-App
npm install
npm start
```

`npm install` pulls exactly three packages: `ws` (the only runtime dependency),
`electron` and `electron-builder`. Everything else is already in the repository —
`tor.exe`, `lyrebird.exe`, the globe libraries, 74 flags and the Visual C++
redistributable.

| Command | What you get |
|---|---|
| `npm start` | runs from source |
| `npm run pack` | `release/win-unpacked` — no installer, fastest way to test packaged behaviour |
| `npm run dist` | `release/FreeProxy-VPN-Setup-2.0.0.exe` — NSIS, per-machine, `requireAdministrator` |

## Where things are

| Path | What lives there |
|---|---|
| `main.js` | the main process — Tor lifecycle, the torrc, the proxy, DNS, the firewall, the kill switch, the WebSocket server, and 18 IPC channels |
| `renderer.js`, `index.html`, `style.css` | the window. `globe-controller.js` owns the globe |
| `lib/` | 12 modules, one job each: `browsers.js` (the 14 browsers), `geo-ext.js` (the four extension routes), `crx.js` (packing and signing), `ext-host.js` (the install-time loopback server), `tor-control.js`, `exit-selector.js`, `offthread.js`, `socks-fetch.js`, `home-location.js`, `geo-spoof.js`, `ext-deliver.js`, `installer-tasks.js` |
| `Extension/` | the MV3 extension: `background.js` (service worker), `geo-spoof.js` + `geo-bridge.js` (the content-script pair), the popup and the welcome page |
| `tor/` | `tor.exe`, `lyrebird.exe`, and Tor's GeoIP data. Not ours — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| `vendor/` | three.js, globe.gl, three earth textures, 74 flags. All pinned by SHA-256 |
| `installer.nsh` | the NSIS hooks. It contains **no browser-specific registry path** on purpose — only the app can see which browsers are on *this* machine |
| `.build/` | 111 probe scripts, the screenshot harnesses, the badge generator, the art gate. Not shipped |
| `docs/media/` | every picture in the README, and a [README of its own](docs/media/README.md) saying which script made each one |

## The probe suite

There is no test framework, and `.build/` is not a unit-test directory. Each of
the 111 scripts drives the real thing — the real registry, a real browser
profile, the real `tor.exe`, the real uninstall sweep — and then reads the result
back out of the machine. That is the only kind of check that can tell you whether
an extension actually landed.

Plain Node scripts run directly:

```bash
node .build/test-vendor.js
```

Ones that need a window or a renderer run under the bundled Electron:

```bash
node_modules/electron/dist/electron.exe .build/probe-readme-art.js
```

They print what they measured, and they exit non-zero when something is wrong.
Read the header comment before running one: it says what the script touches, and
several of them say why an earlier, more obvious version of the same check was
wrong.

### Before you open a pull request

Run these four. They are fast, they need no elevation and no browser:

```bash
node .build/test-vendor.js
```

```bash
node .build/probe-readme-links.js
```

```bash
node .build/probe-md-html.js
```

```bash
node_modules/electron/dist/electron.exe .build/probe-readme-art.js
```

The first pins the vendored globe by hash and refuses any remote resource in a
loading position. The second checks every local link, every in-page anchor and
every `file#Lnnn` reference in every markdown document — a heading reworded three
sections away silently kills a link, and nothing about the rendered page shows
it. The third counts opening against closing tags for the raw HTML in those same
documents, because GitHub renders broken markup instead of refusing it: a single
unclosed `<td>` is invisible in the source and swallows the rest of the page into
a table cell. The fourth renders every SVG the way GitHub does and fails on a
`<script>`, an off-machine `url()`, clipped text, overlapping text, or a gradient
that paints nothing. `0 failed.` is the only acceptable result from the last
three.

If you changed anything a badge counts — a browser, a country, a probe script, a
version — regenerate them, because the numbers are read from the project and not
typed:

```bash
node .build/make-badges.js
```

### Probes that change your machine

Some of the suite installs an extension, writes `HKLM` policy, stops a service or
rewrites DNS. Those are not dangerous, but they are not read-only either, and a
few leave state behind that only an elevated shell can remove. Read the header,
run them on a machine you do not mind poking, and expect to need an elevated
terminal.

Two things worth knowing before you spend an afternoon on them:

* **A test suite's own limit is not a finding.** `test-live.js` prints
  "candidates found 5" for Sweden. Sweden's exit pool is 342 and nothing filters
  them out — the 5 is that script's own cap. Check what a number *is* before
  reporting it as a bug.
* **A dead port reads as a refused install.** If the loopback helper was not
  serving, every browser will look like it declined a self-hosted extension.
  Prove the helper was up before you record a refusal.

## Reporting a bug

Search the [issues](https://github.com/Zero-Asif/FreeVPN-PC-App/issues) first,
then open one with:

* **Windows version** — `winver`, including the build number.
* **The log.** `%ProgramData%\freeproxy-vpn\logs\freeproxy-<date>.log`, or press
  the log button in the app. It records what the app did to your machine, not
  where you went. Read it before attaching it if you would rather be sure.
* **Which browser**, and whether it is managed by a workplace. An unmanaged
  Chrome, Brave or Edge refuses off-store extension installs by design; that one
  is measured, expected, and covered in the README.
* **What you expected, and what happened.** For anything geolocation-related,
  the site you tested on matters — Google Maps centres from a cookie, not from
  `navigator.geolocation`, so it can be stale when everything else is right.

If the app said it did something and your machine says otherwise, that is the
most valuable report there is. Say exactly which line of the log disagrees with
which registry key or which `about:` page.

## Suggesting a change

Say what problem it solves for someone using the app, not just what it adds. A
feature that cannot be verified from the machine afterwards is going to be hard
to accept, however good it sounds — see [the one rule](#the-one-rule).

Things that will be turned down, so nobody wastes an afternoon:

* **Blocking geolocation instead of spoofing it.** It was built, tested and
  reverted. Denial breaks Google Maps and locks the user out of their own site
  settings; it is denial dressed up as spoofing.
* **Faking the Windows location provider.** There is no supported route. The
  documented Default Location changes nothing — measured. The app withholds the
  position and says so.
* **Ranking Tor exits by speed.** Measured: within-relay throughput spread
  matches between-relay spread, so a sample cannot order them and onionoo's own
  order is already as good as this gets.
* **Anything that phones home.** No telemetry, no crash reporter, no update
  check, no analytics, not optional, not opt-in.

## Pull requests

Branch off `dev`, not `main`. `main` is what people download.

| Prefix | For |
|---|---|
| `feature/` | something new |
| `bugfix/` | something broken |
| `docs/` | documentation only |

* **Keep it to one thing.** A PR that fixes a leak and also restyles the window
  is two PRs.
* **Do not restyle the UI as a side effect** of a functional change. If a change
  needs a visual change, say so and show it.
* **Screenshots for anything visible.** `.build/probe-readme-shots.js` and
  `.build/probe-readme-popup.js` regenerate the README's set from the real pages;
  if your change alters one of those states, re-run the harness rather than
  cropping a photo of your screen.
* **Comment the surprise, not the syntax.** This codebase's comments exist to
  record what was measured and what was tried and did not work — `reg add <key>
  /f` creating a stray `(Default)` value, `reg query` omitting its header for a
  valueless key, an MV3 content script beating its own service worker to
  `storage`. That is the kind of comment worth adding. `// increment i` is not.
* **Commit messages**: present tense, imperative, first line ≤72 characters.
  "Release the proxy pref at the last window close", not "Fixed stuff".
* **Say what you verified and what you could not.** "Tested on Windows 11 23H2
  with Chrome and Brave; no Edge on this machine" is a good PR note. Silence
  reads as a claim.

## Security

If you find something that leaks traffic, leaks the real IP, leaks DNS, or
weakens the kill switch, please do not open a public issue first. Contact the
repository owner at <https://github.com/Zero-Asif> and give it a few days.

Anything in this list is a security bug, not a feature request:

* traffic reaching the network while the kill switch is on
* DNS resolving outside the tunnel — port 53 or DoT on 853
* IPv6 escaping while connected
* a browser keeping its real coordinates after a connect
* the proxy or DNS being left behind after a disconnect, a crash, or an uninstall

## Licence

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE.txt), the same as the rest of this project's own code.

---

One more time, because it is the whole point: **do not claim coverage a read-back
did not confirm.** If a route cannot work, the right change is to say so.



