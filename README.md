<p align="center">
  <img src="docs/media/hero.svg" width="100%" alt="FreeProxy VPN — Tor-powered privacy for Windows, with the exit country you actually chose">
</p>

<p align="center">
  <img src="docs/media/badges/version.svg" alt="release v2.0.5">
  <img src="docs/media/badges/platform.svg" alt="platform Windows 10 / 11 x64">
  <img src="docs/media/badges/license.svg" alt="license MIT">
  <img src="docs/media/badges/tor.svg" alt="tor 0.4.9.6">
  <img src="docs/media/badges/electron.svg" alt="electron 41.3.0">
  <img src="docs/media/badges/extension.svg" alt="extension MV3 v1.2.0">
</p>
<p align="center">
  <img src="docs/media/badges/countries.svg" alt="74 exit countries spoofable">
  <img src="docs/media/badges/browsers.svg" alt="14 browsers supported">
  <img src="docs/media/badges/telemetry.svg" alt="telemetry none">
  <img src="docs/media/badges/accounts.svg" alt="sign-up not required">
  <img src="docs/media/badges/admin.svg" alt="runs as administrator">
  <img src="docs/media/badges/probes.svg" alt="probe suite 126 scripts">
</p>

<h3 align="center">Pick a country. Everything on this PC comes out there — including where the web thinks you are standing.</h3>

<p align="center">
  <b>FreeProxy VPN</b> drives a bundled <code>tor.exe</code> over loopback, points Windows at it,
  and then does the part almost nothing else does:<br>it makes your <b>browser's geolocation agree
  with your exit country</b>, in 14 browsers, and tells you honestly where it cannot.
</p>

<p align="center">
  <sub>No account · no subscription · no telemetry · no server belonging to this project · MIT licensed</sub>
</p>

<p align="center">
  <img src="docs/media/walkthrough.svg" width="100%" alt="Six panels. One: run the installer once, a per-machine NSIS setup marked requireAdministrator, with the Visual C++ redistributable inside it, asking for one restart. Two: pick where to come out, 74 countries on a globe or in the popup, pinned in the torrc with StrictNodes 1. Three: press Connect, seven stages in the app's own words, the exit read back through the circuit rather than assumed. Four: the whole machine follows, system proxy on 127.0.0.1, DNS pinned to Tor, ports 53 and 853 shut elsewhere, IPv6 blocked both ways, 14 browsers and 9 firewall rules. Five: switch country or split it, and only map sites are cleared. Six: check every claim yourself, with no account, no telemetry and no update check.">
</p>

<p align="center">
  <sub>
    <b>1</b> <a href="#getting-it-running">install</a> &nbsp;·&nbsp;
    <b>2</b> <a href="#the-tour">pick a country</a> &nbsp;·&nbsp;
    <b>3</b> <a href="#one-press-of-connect">connect</a> &nbsp;·&nbsp;
    <b>4</b> <a href="#the-whole-machine-not-just-the-browser">the machine follows</a> &nbsp;·&nbsp;
    <b>5</b> <a href="#what-a-switch-wipes-and-why">switch, or split</a> &nbsp;·&nbsp;
    <b>6</b> <a href="#it-writes-down-what-it-did">check it yourself</a>
  </sub>
</p>

<img src="docs/media/divider.svg" width="100%" alt="">

## What this is, and what it is not

Most "free VPN" apps ask you to trust a company. This one has no company to
trust: there is no account, no server owned by this project, and nothing to
log in to. It starts the real Tor client on your own machine and wires Windows
into it.

| It **does** | It **does not** |
|---|---|
| [Route the whole machine through Tor](#the-whole-machine-not-just-the-browser) — every program's TCP, not just a browser's | Encrypt anything Tor does not; a site on plain HTTP is still plain HTTP to the exit |
| Let you pin the exit to one of **74 countries** and switch without a reconnect | Promise a country is available right now; if a country has no usable exit, it says so and offers alternatives |
| Make `navigator.geolocation` report the connected country's real coordinates in **14 browsers** | Fake the Windows location provider — that has no supported route, so the position is **withheld** instead ([why](#geolocation-the-part-that-is-usually-missing)) |
| Close DNS, IPv6 and pre-existing sockets so they cannot leak around the tunnel | Hide from your ISP that you are using Tor, unless a bridge round happens to work |
| Undo every system change by name on disconnect and on uninstall | Take a snapshot of your old proxy settings — it deletes what it wrote instead |
| Print exactly what it did, per browser, in a log you can open from the UI | Send that log, or anything else, anywhere |

> [!IMPORTANT]
> Tor is a low-latency anonymity network, not a bandwidth service. Expect
> ordinary browsing to work well and large downloads or video to be slower than
> a commercial VPN. That is the trade you are making for not having to trust
> anybody.

<img src="docs/media/divider.svg" width="100%" alt="">

## The tour

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/media/01-idle.png" alt="Idle: the globe centred on your own city, Standing by">
<p align="center"><b>1 · Standing by</b><br><sub>The globe centres on where you actually are, and says so. No connection has been made yet.</sub></p>
</td>
<td width="50%" valign="top">
<img src="docs/media/02-countries.png" alt="The country list with live exit counts per country">
<p align="center"><b>2 · Choose an exit</b><br><sub>74 countries, each with the number of usable exits read from the live Tor relay index.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/media/03-connecting.png" alt="Connecting: bootstrap percentage with the real Tor phase">
<p align="center"><b>3 · Connecting</b><br><sub>The percentage is Tor's own bootstrap, not an animation. The phase text is the phase Tor reported.</sub></p>
</td>
<td width="50%" valign="top">
<img src="docs/media/04-connected.png" alt="Connected: session timer, Protected badge, ring over the exit city">
<p align="center"><b>4 · Connected</b><br><sub>The ring moves to the exit city, the badge turns green, and the session clock starts.</sub></p>
</td>
</tr>
</table>

Switching country while connected does **not** drop the tunnel: the app rewrites
`ExitNodes`, reloads Tor's configuration over the control port, verifies the new
exit through the circuit, and re-broadcasts the new coordinates to every open
browser.

> [!NOTE]
> **A country switch clears the cache, cookies and history of map sites — and
> nothing else.** A map holds the old country in its own URL, in a cookie and in
> the cache, so without that it keeps showing the country you left. You stay
> signed in everywhere, and the rest of your history stays where it is. The whole
> story is in [what a switch wipes, and why](#what-a-switch-wipes-and-why). A
> **disconnect** does not do this.

<img src="docs/media/divider.svg" width="100%" alt="">

## Getting it running

<table>
<tr>
<td width="34%" valign="top">

### 1 · Install

Run **`FreeProxy-VPN-Setup-2.0.5.exe`**. It installs per machine and asks for
administrator **once**.

That prompt is not cosmetic: the extension is offered from `HKLM`, and DNS,
IPv6 and the firewall rules are machine-wide settings. There is no second
elevation prompt later — not on connect, not on a country switch.

</td>
<td width="33%" valign="top">

### 2 · Restart, if it asks

The installer does the browser work while nothing is running, and the app then
offers **one** restart, once.

It is offered only when Windows itself said a restart is pending, or when the
boot pass has real work queued. A clean install on a quiet machine defers
nothing and asks for nothing.

</td>
<td width="33%" valign="top">

### 3 · Connect

Open it, pick a country, press the button. Nothing to sign up for, nothing to
paste in, no configuration file to import.

The first run names the browsers it found on this PC and says what it did to
each one — including the ones it could not reach.

</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/media/07-browser-card.png" alt="First-run card naming each installed browser and what was done to it">
<p align="center"><b>The first-run card</b><br><sub>Only browsers you actually have are listed, and every line is a read-back rather than a plan.</sub></p>
</td>
<td width="50%" valign="top">
<img src="docs/media/10-one-restart.png" alt="The single restart card, offering Restart now or Later">
<p align="center"><b>The one restart</b><br><sub>Offered once and never taken for you. <b>Later</b> leaves everything else working.</sub></p>
</td>
</tr>
</table>

<details>
<summary><b>Everything the installer does, in the order it does it</b></summary>

`installer.nsh` contains **no browser-specific registry path at all**. It runs
the app instead, because only the app can see which browsers are on *this*
machine, sign a package for them and write the entry for the id it just made.

1. **Firewall.** Two named outbound-allow rules — `FreeProxy Tor Engine` for
   the unpacked `tor.exe` and `FreeProxy App` for the app itself. Each is
   deleted before it is added, so a repeat install cannot stack duplicates.
2. **Visual C++ runtime.** Reads
   `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`. If it is
   missing, the bundled `vc_redist.x64.exe` runs `/quiet /norestart`; if even
   that file is absent the installer fetches it from `aka.ms`. Its exit codes
   **3010** and **1641** are the one place in the whole install where a restart
   can legitimately become necessary, and they are read, never assumed.
3. **Directories.** `%LOCALAPPDATA%\FreeProxy VPN\logs` and
   `…\Tor\data\keys`. The real state directory,
   `C:\ProgramData\freeproxy-vpn`, is created by the app itself so that there
   is only one place that decides where it lives.

4. **`"FreeProxy VPN.exe" --fp-setup`**, elevated, headless. Detects the
   installed browsers, stages and RSA-signs the extension into a `.crx`, writes
   the force-install entry for the id that signing just produced, and schedules
   the boot pass — the SYSTEM task that finishes the browser work at the next
   startup, *before any browser has started*, which is the only moment a
   Chromium fork reads an external-extensions offer. If Windows said a restart
   is pending, `--fp-reboot-pending` is passed through to this step, which
   checks `PendingFileRenameOperations` as well before it leaves a marker.
5. **Markers.** `HKLM\Software\FreeProxy VPN` gets `InstallPath`, `Version`
   (electron-builder's own, so it cannot drift from `package.json`) and
   `FirewallConfigured`.

What step 4 reports, and what each answer means:

| Code | Meaning |
|---|---|
| `0` | Force-installed automatically. Nothing for you to do. |
| `10` | Staged and signed, but every installed browser refuses the automatic route. You get `HOW-TO-ENABLE.txt` and one in-app click, once, ever. **On a personal PC this is the normal outcome, not a failure** — measured 2026-09-01: Chrome, Brave *and* Edge all require the machine to be domain-joined, Azure-AD-joined or enrolled in Chrome Browser Cloud Management before an off-store extension can be forced. |
| `3` | Staging failed. |
| `4` | Timed out; the app finishes it on first run. |
| `1` | Crashed; the app retries on first run. |

</details>

<img src="docs/media/divider.svg" width="100%" alt="">

## How it works

<p align="center">
  <img src="docs/media/architecture.svg" width="100%" alt="Four columns: this app, tor.exe on loopback ports 9050, 9080, 9051 and 53, the Windows settings that are changed and changed back, and the surfaces that see the tunnel">
</p>

| Part | What it is |
|---|---|
| **This app** | Electron 41.3.0, one window. The main process writes the `torrc` and seals the tunnel, the renderer draws the globe and the live log, 18 IPC channels connect the two, and the parts Windows guards run elevated. |
| **The Tor engine** | The bundled `tor.exe` 0.4.9.6, started by this app with a configuration this app writes: `SocksPort 9050`, `HTTPTunnelPort 9080`, `ControlPort 9051` — cookie auth, never a password — and `DNSPort 53`, falling back to `9053` when something already holds 53. |
| **Windows** | Both proxy stores — WinINET per user and WinHTTP per machine — plus per-adapter DNS, firewall rules, IPv6 and the location service. Each is changed by name, and each is changed back by name on disconnect — not at the next reboot. |
| **The surfaces** | 8 Chromium browsers (proxy, policy **and** the bundled MV3 extension), 5 Gecko browsers (the geolocation prefs per real profile, **and a real SOCKS5 proxy of their own** — `network.proxy.type=1` at `127.0.0.1:9050` with remote DNS, read back out of the file before it counts as applied), Internet Explorer (proxy only — it has no extension model), Windows' own services and every other program on the machine (the machine proxy, and with the full-device tunnel on, every TCP connection whether the program knows what a proxy is or not; position withheld, never faked). |

Two further loopback channels run underneath all of it.
`ws://127.0.0.1:8080` carries the country, the city and an accuracy to every
open browser, and tells them again the moment any of it changes. A one-time
HTTP server hands the signed extension to a browser during install and stops
the instant it has been taken.

### One press of Connect

<p align="center">
  <img src="docs/media/flow-connect.svg" width="100%" alt="Seven progress stages with their real percentages: 3% selecting server, 5% starting the Tor engine, Tor's own bootstrap forwarded from 5 to 95%, 96% system proxy, 97% leak paths, 98% exit verification, 100% connected">
</p>

Every percentage in that diagram is a number the app actually sends, and every
line of text is a string it actually shows. Between 5% and 95% the app is not
counting anything — it is forwarding Tor's own bootstrap verbatim, which is why
the bar crawls there and why the phase names are Tor's vocabulary instead of
something friendlier that would mean less.

Stage **98** is the one that earns the rest. Instead of trusting the
`ExitNodes` line it just wrote, the app asks — *through the circuit it has just
built* — where that circuit actually came out. If the answer is not the country
you picked, it says so and offers the countries that do have usable exits right
now.

<img src="docs/media/divider.svg" width="100%" alt="">

## Geolocation, the part that is usually missing

A proxy changes the IP address a website sees. It does not change what
`navigator.geolocation` tells that website — so a site that asks for your
position still gets your real street, in the country you were trying to leave.
Every *"the VPN says Japan but Maps says home"* complaint is this one gap.

<p align="center">
  <img src="docs/media/geo-coverage.svg" width="100%" alt="Five surfaces: coordinates are spoofed in this app's own window, in eight Chromium browsers and in five Gecko browsers; withheld for Internet Explorer, WebView hosts and native Windows applications">
</p>

So the app makes the browser's position agree with the exit country. Connect to
Japan and `navigator.geolocation` returns Tokyo's real coordinates with a
plausible accuracy — in every supported browser, in frames and `about:blank`
documents too, and in this app's own window through the DevTools protocol at
the same instant.

> [!NOTE]
> **The two amber rows are not a to-do list.** Windows exposes no supported way
> to inject coordinates into its own location provider; that was measured, and
> the documented *Default Location* setting changes nothing the provider
> actually reports. So for Internet Explorer, WebView hosts and native
> applications the position is **withheld** rather than faked — `lfsvc` is
> stopped and the sensor denied — and the log names which surfaces got which
> treatment every time you connect. A shield can be honest. A coverage claim
> nothing read back could not be.

### The 14 browsers, by name

<table>
<tr>
<th align="left" width="42%">Chromium — proxy, extension, policy</th>
<th align="left" width="34%">Gecko — proxy and prefs</th>
<th align="left" width="24%">No extension model</th>
</tr>
<tr valign="top">
<td>

`Microsoft Edge` · `Google Chrome` · `Brave` · `Vivaldi` ·
`Opera` · `Opera GX` · `Yandex Browser` · `Chromium`

</td>
<td>

`Firefox` · `Waterfox` · `LibreWolf` ·
`Pale Moon` · `SeaMonkey`

</td>
<td>

`Internet Explorer`

</td>
</tr>
</table>

A browser that is not installed is never touched and never named. Gecko
profiles are enumerated per browser, so a second Firefox profile gets the same
prefs as the first rather than being silently skipped.

Gecko takes a **real SOCKS5 proxy**, not the machine's — `network.proxy.type=1`
at `127.0.0.1:9050` with `socks_remote_dns` on, written into the same fenced
block as the coordinates and read back out of the file before it is called
applied. Three things follow from where those prefs live, and all three are
limits rather than bugs:

- **It takes effect at the browser's next start.** `user.js` is read once, at
  startup. A change written while Firefox is open changes nothing until it is
  closed and reopened.
- **A browser that is running when you connect is left alone.** Writing
  `user.js` under a live Gecko process is how a profile gets corrupted, so it is
  skipped, named in the log, and picked up on the next connect.
- **WebRTC is switched off** (`media.peerconnection.enabled=false`) for the
  duration. Tor's SOCKS5 has no UDP, so a WebRTC call would either fail or leak
  the real address around the tunnel. Video calls in a Gecko browser do not work
  while connected; the pref is removed again on disconnect.

<details>
<summary><b>How the extension actually gets in, and why there are four routes</b></summary>

The extension is not on any store in this build. The app generates an RSA key
on first setup, signs `Extension/` into a `.crx` with it, and serves that file
from its own loopback HTTP server. The extension id is derived from that key,
so it is *this machine's* id — which is also why nothing in the installer can
hardcode it.

| Route | Where | Note |
|---|---|---|
| `ExtensionInstallForcelist` | numbered `REG_SZ` slots under each fork's policy key | The textbook route. Also the one an unmanaged Windows PC throws away. |
| `ExtensionSettings` | **one** `REG_SZ` holding a JSON dictionary of every extension the machine has a policy for | Removal is genuinely different here: our key cannot be deleted on its own, so the value is parsed, our entry dropped, and the rest written back byte-for-byte in meaning. |
| the fork's own external-extensions provider | `HKLM\SOFTWARE\<vendor>\[<product>\]Extensions\<id>` | **This is the route that reaches Chrome and Brave at all.** An off-store force-install *policy* is discarded by an unmanaged Chromium; an external-extensions *offer* is not. |
| `ExtensionInstallAllowlist` | a bare id in a numbered slot | Written last, and never removed on evidence of its own — a bare id says nothing about who wrote it, and a workplace permitting one extension by id writes a byte-identical value. |

> [!IMPORTANT]
> **Measured 2026-09-01, and stated because it is true:** Chrome, Brave *and*
> Edge all refuse an off-store force-install unless the machine is
> domain-joined, Azure-AD-joined or enrolled in Chrome Browser Cloud
> Management. On an ordinary personal PC the automatic route therefore does
> **not** land, and what does the work is the external-extensions offer, which a
> Chromium fork reads only while it starts — hence the boot pass, and hence the
> one restart. Where even that cannot apply you get `HOW-TO-ENABLE.txt` and one
> click in the popup, once, ever. The app says which of these happened; it never
> reports an install it did not read back.

</details>

<img src="docs/media/divider.svg" width="100%" alt="">

## The browser extension

Bundled, MV3, `minimum_chrome_version: 111`. It is not a second VPN: it holds no
keys and contacts no network of its own — the only socket it opens is
`ws://127.0.0.1:8080`, where it listens for the country the app is on. It is the
thing that makes `navigator.geolocation` agree with the exit. With the app shut
down it spoofs nothing and reports nothing; the one job it keeps is releasing the
proxy it was holding, so a closed app cannot leave a browser with no internet.

<table>
<tr valign="top">
<td width="25%">
<img src="docs/media/20-popup-idle.png" alt="Popup: the app is running, the tunnel is off">
<p align="center"><sub>The app is running, the tunnel is off — and the popup says exactly that.</sub></p>
</td>
<td width="25%">
<img src="docs/media/21-popup-countries.png" alt="Popup: every exit country with its flag and live exit count">
<p align="center"><sub>Every exit country, its real flag out of the package, live exit counts.</sub></p>
</td>
<td width="25%">
<img src="docs/media/22-popup-connected.png" alt="Popup: connected, showing the coordinates handed to websites">
<p align="center"><sub>Connected, with the coordinates <i>this</i> browser is handing to websites.</sub></p>
</td>
<td width="25%">
<img src="docs/media/23-popup-connecting.png" alt="Popup: bootstrap progress carried from the app, controls locked">
<p align="center"><sub>The app's own bootstrap progress, carried in — not invented here.</sub></p>
</td>
</tr>

<tr valign="top">
<td width="25%">
<img src="docs/media/24-popup-controls.png" alt="Popup: kill switch on and split-tunnel exceptions listed">
<p align="center"><sub>Kill switch and split-tunnel exceptions — the same lists as the app.</sub></p>
</td>
<td width="25%">
<img src="docs/media/25-popup-app-off.png" alt="Popup: the app is not running, so the extension is inert and says so">
<p align="center"><sub>The app is not running: inert, and it says so instead of pretending.</sub></p>
</td>
<td width="25%">
<img src="docs/media/26-popup-asks.png" alt="Popup: the app asks rather than connecting somewhere you did not pick">
<p align="center"><sub>It stops and asks rather than connecting you somewhere you did not pick.</sub></p>
</td>
<td width="25%">
<img src="docs/media/30-welcome.png" alt="The extension's own welcome page on first run">
<p align="center"><sub>The welcome page, showing the live state of the app it depends on.</sub></p>
</td>
</tr>
</table>

The popup is a full second face for the app, not a status light: you can pick a
country, connect, disconnect, arm the kill switch and edit the split-tunnel list
from it. Everything it shows is derived from one state object the app pushes —
when the socket is down that object is `null`, and the popup goes inert rather
than showing a stale country.

### Every permission it asks for, and what each one is actually for

`Extension/manifest.json` asks for eight permissions and `<all_urls>`. That is a
lot, so here is each one and the single thing it does:

| Permission | Used for | Not used for |
|---|---|---|
| `<all_urls>` (host) | injecting the geolocation shim into **every page and every frame** at `document_start`, in both the MAIN and ISOLATED worlds. A page that reads your position before a later-injected script would win otherwise | reading page content. The extension issues **no** `fetch`, no `XMLHttpRequest` and no beacon — its only socket is `ws://127.0.0.1:8080` |
| `proxy` | pointing this browser's own proxy at `127.0.0.1:9050`, so it is covered even before the system proxy applies | anything else |
| `storage` | the connected country, its coordinates, an accuracy, and which origins were told a position — so the next switch knows what to clean up | any browsing history |
| `cookies` | deleting the `UULE` cookie by name. Google writes it; it carries a position, and it survives a tab close | writing any cookie. The extension sets none |
| `browsingData` | the switch-time clear below, **origin-filtered to map sites** — their cache and site storage, and cookies only on domains that are nothing but a map — plus the site storage of origins that were handed the old country | anything browser-wide, anything on a disconnect |
| `history` | deleting the **map URLs** a switch found, one URL at a time, because `browsingData` cannot filter history by origin and its `history: true` is the whole profile | reading your history for anything else. Only URLs a map pattern matches are ever passed to `deleteUrl` |
| `tabs` | reloading tabs after a switch so they ask for the position again, and rewriting a pinned `/maps/@lat,lng` URL | reading what you have open beyond that |
| `notifications` | exactly one notification, once, when the extension is first installed, saying which browser it just became active in | anything after that. There is no second `notifications.create` call in the extension |
| `alarms` | one periodic watchdog. If this browser is pointed at the Tor port and the app has stopped answering, the alarm releases the proxy so the browser is not left with no internet — and picks the socket back up, because a torn-down MV3 worker loses its `setTimeout` chain | keeping itself awake for its own sake |

### What a switch wipes, and why

When the country changes while connected, the extension runs this, in this order,
before it reloads anything:

1. **Delete every `UULE` cookie, by name, wherever it is.** Measured on
   2026-09-01: Google Maps centres from that cookie, not from
   `navigator.geolocation` — so a stale country survives a tab close and a
   browser restart unless the cookie goes.
2. **Clear map sites, and only map sites.** The open tabs and the history entries
   that match a map pattern are collected, then:
   * their history entries go one URL at a time through `chrome.history.deleteUrl`,
   * their cache and site storage go through
     `chrome.browsingData.remove({ origins, since: 0 }, …)`,
   * their **cookies** go only for domains that are *nothing but* a map —
     `openstreetmap.org`, `mapquest.com`, `waze.com`, `mapy.cz`.
3. **Clear the site storage of every origin that was handed the old country**,
   then reload those tabs, every open map, and any map pin rewritten to the new
   country, so they ask again.

Nothing outside that is touched. `google.com`, `bing.com`, `apple.com`, `yandex`
and `here.com` keep their cookies — an origin-filtered cookie clear takes the whole
registrable domain, so naming `maps.google.com` would sign you out of Gmail, and
naming `wego.here.com` would sign you out of HERE — and on the first four the one
cookie *measured* to carry a position goes by name in step 1 instead. That name
sweep is the only part that also runs on a **disconnect**.

Two limits, stated rather than designed around. History search is free text, so
the six keywords (`maps`, `openstreetmap`, `mapquest`, `waze`, `here.com`,
`mapy.cz`) *find* candidates and the map patterns *decide* — a non-map URL a
keyword happens to match is never deleted, and a map entry no keyword matches is
never found. And a site that cached the old country without being a map and
without ever calling the geolocation API is reached by neither step 2 nor step 3;
a reload is what fixes that, and the switch does not force one on it.

If `chrome.browsingData` or `chrome.history` is missing in a particular browser,
the extension writes to its own console that the map cache, map site storage or
map history entries could not be cleared for that switch, and carries on with the
steps it *can* do. It does not report a clear it did not perform.


<img src="docs/media/divider.svg" width="100%" alt="">

## The whole machine, not just the browser

A proxy setting is a request, not a rule. Up to v2.0.0 this app made that request
in four places — the per-user WinINET store, the machine-wide WinHTTP store, a
Chromium policy, and a pref per Gecko profile — and anything that ignored all
four went out over the real IP: a game, an installer, a mail client, a stub
resolver with its own hardcoded DNS. **v2.0.5 adds two layers that need no
cooperation from the program at all.** They answer different halves of the same
problem — one redirects traffic, the other drops what cannot be redirected — and
neither replaces the other.

| Layer | What it actually is | What it cannot do |
|---|---|---|
| **Full-device tunnel** — `Tun\wintun.dll` (Wintun 0.14.1) + `Tun\tun2socks.exe` (2.7.0) | A layer-3 adapter named `FreeProxyTun` at `10.77.77.1/24` owns the route table; `tun2socks` terminates every TCP connection that arrives there in userspace and re-dials it through `127.0.0.1:9050`. Every program's TCP rides Tor, whether that program has ever heard of a proxy or not. **On by default** | Carry **UDP** — Tor's SOCKS5 has no `UDP ASSOCIATE`, so QUIC, WebRTC, games and VoIP have nowhere to ride. **ICMP** is not carried either: `ping` and `tracert` go quiet |
| **Containment** — default-deny outbound | `blockinbound,blockoutbound` on all three firewall profiles, so the Windows Filtering Platform drops every outbound packet no ALLOW rule matches, for every process. The allow list is deliberately tiny: `tor.exe`, `lyrebird.exe`, this app, the tunnel adapter, loopback and DHCP. **Armed by the Kill Switch, not by connecting** | Redirect anything. WFP can permit a packet or drop it; it cannot rewrite the destination, which is why default-deny on its own is a wall rather than a VPN. Local-subnet traffic is deliberately **allowed** — it cannot reach the internet, so blocking it would kill printers and NAS boxes to close a hole that is not there |

Four decisions in that first row are worth stating, because each of them is the
difference between a tunnel and a machine you have to repair:

* **Two `/1` routes, never `0.0.0.0/0`.** `0.0.0.0/1` and `128.0.0.0/1` cover the
  same address space as a default route without touching the real one — so
  teardown is *delete two routes* rather than *restore something we overwrote*, a
  crash leaves the original default in place, and anything with a longer prefix
  (your LAN, loopback, a Hyper-V switch) still routes normally.
* **`10.77.77.0/24`**, picked to sit outside every range a home router hands out.
  If a network really does use it, that `/24` is a longer prefix than the `/1`
  pair and keeps winning — the LAN still works, the tunnel just cannot reach that
  one range.
* **Tor's own relays are routed around the adapter.** Otherwise `tor.exe`'s
  connection to a relay would itself be captured and handed back to `tor.exe`,
  which is a loop, not a tunnel. The app reads `netstat -ano` for Tor's PID every
  4 seconds and pins each live peer with a host route via the physical gateway,
  then deletes exactly those addresses on the way down.
* **The order is not interchangeable.** Arming goes tunnel → containment, because
  containment needs the tunnel's local address to write the one rule that lets
  in-tunnel traffic out. Disarming goes containment → tunnel, because pulling the
  routes first would leave the PC with outbound still denied and nothing left
  allowed to carry traffic — *"the VPN broke my internet"*, at the exact moment
  you asked to be back to normal.

> [!WARNING]
> **While containment is armed, this process is the only thing between the
> machine and no internet at all.** So it refuses to arm until a standalone
> recovery script exists on disk; the outbound policy is handed back at every
> startup, on `will-quit`, and on the kill-switch-off path; and **Restore
> Internet** undoes all of it in one double-click. That last one is a Start Menu
> entry next to the app's own, pointing at a self-elevating `restore-internet.bat`
> in `C:\ProgramData\freeproxy-vpn` — it needs neither this app nor Node nor the
> install directory, because a `.bat` nobody can find is no use to somebody who
> cannot reach a search engine to be told it is there.

The tunnel is the one layer you can turn off without giving up the rest.
`"fullTunnel": false` in `settings.json` — in the app's own data folder,
`%APPDATA%\FreeProxy VPN` — leaves the proxies, the policies, the extension and
the leak blocks exactly as they are and simply never creates the adapter. It is
an edit rather than a switch on purpose: the window's design is frozen, and
somebody who needs UDP back for a game or a video call should not have to wait
for a rebuild. Absent or malformed reads as **on**, and the log says which one it
did — `Full-device tunnel UP` or `Full-device tunnel is disabled in settings.json`.
If either binary is missing from a build, the availability check says so and the
start path refuses; there is no route through this code that reports a tunnel the
kernel does not have.

> [!NOTE]
> **What is verified, and what is not — exactly.**
> `.build/probe-tunnel.js` checks everything that needs no privileges: that the
> `/1` pair is what would be installed, that the `netstat` filter picks Tor's own
> peers out of a live table, and that a build missing either binary reports
> unavailable and **refuses to start** instead of claiming a tunnel. The four
> steps that need administrator — **creating the adapter, reading its address
> back, reading the routes back, and tearing it down** — print
> `NOT VERIFIED (needs admin)` in that probe's own output on an unelevated run,
> and that is exactly what they are here. `node .build/probe-tunnel.js --live`
> from an elevated shell runs them; it deliberately creates the adapter *without*
> the capture routes, so your routing is untouched either way.

<img src="docs/media/divider.svg" width="100%" alt="">

## Leak protection, and a kill switch that means it

<p align="center">
  <img src="docs/media/leak-shield.svg" width="100%" alt="The four leak paths — DNS asked outside the tunnel, IPv6 taking its own road, sockets opened before the switch, and the tunnel dying without saying so — each with what closes it and where; plus the kill switch">
</p>

A SOCKS proxy on its own leaves four ways out. All four are closed before the
app says *connected* — that is stage **97** in the flow above, and the right-hand
column of that diagram is the actual command or call, not a paraphrase.

The fourth one is the one most tools skip. A proxy that has died still accepts
connections from the operating system's point of view, so applications keep
handing traffic to a hole in the ground. The app re-reads the exit on a timer
and tears the tunnel down on a failed read, rather than letting you keep
browsing through nothing.

> [!WARNING]
> **The kill switch is not a preference, it is a lock.** Armed, the system proxy
> is pointed at a port nothing listens on, the DNS cache service is stopped and
> ports 53 and 853 are shut — so nothing resolves and nothing connects, by
> design. *Disconnecting does not lift it.* Until you turn it off the machine
> has no internet, which is exactly what a kill switch is for, and the UI says
> `Kill Switch LOCKED` rather than leaving you to guess.

### Split tunnelling, applied live

<table>
<tr>
<td width="46%" valign="top">
<img src="docs/media/05-privacy-controls.png" alt="Privacy controls: kill switch armed, split-tunnel exceptions filled in, and the location toast">
</td>
<td valign="top">

Some things have to stay off the tunnel: a bank that refuses foreign logins, a
streaming service that blocks Tor outright, an intranet name that does not
resolve anywhere but your office. Type them in, separated by `;`.

Each entry is normalised — scheme and path stripped, wrapped in `*…*` — and
written into `ProxyOverride` alongside `<local>`. Editing the list **while
connected** rewrites only that one value: no reconnect, no new circuit, no
dropped downloads.

Everything else keeps going to
`http=127.0.0.1:9080; https=127.0.0.1:9080; socks=127.0.0.1:9050`. That HTTP
tunnel entry matters more than it looks: applications that speak only HTTP
proxy get a proxy that actually speaks their protocol, instead of quietly
falling back to a direct, unproxied route.

</td>
</tr>
</table>

<img src="docs/media/divider.svg" width="100%" alt="">

## When it cannot do what you asked

<table>
<tr>
<td width="33%" valign="top">
<img src="docs/media/06-no-exit-node.png" alt="The app reporting that a country has no usable exit and offering alternatives">
<p align="center"><b>No usable exit</b><br><sub>It asks, instead of silently substituting a country you did not choose.</sub></p>
</td>
<td width="33%" valign="top">
<img src="docs/media/08-waiting-live.png" alt="The live card during a connect: nothing is connected yet, with a way out">
<p align="center"><b>Still trying</b><br><sub>Nothing is connected, it says so plainly, and it gives you a way out.</sub></p>
</td>
<td width="33%" valign="top">
<img src="docs/media/09-comes-back.png" alt="The app reporting that it found the requested country and asking before switching">
<p align="center"><b>It kept looking</b><br><sub>It found the country you asked for — and asks before moving you to it.</sub></p>
</td>
</tr>
</table>

Exit availability is a fact about the Tor network this minute, not a promise
anyone can make. A country that worked yesterday may have nothing usable today,
and the honest thing to do about that is say so.

A normal attempt walks the best **5** exit relays for your country. If none of
them work you are not moved somewhere else quietly — you are shown what is
actually available and asked. Choose to keep waiting and the search widens to
**12** relays per round, because at that point you have read the options and
picked, and the only wrong answer is giving up early. On a genuinely cold first
start, where there is no consensus cache yet, the engine is also allowed to
restart itself **twice** within **five minutes** with nothing on screen but
progress — measured recovery: 40.4 s of cold consensus, killed, then 22.9 s to
100%.

### obfs4 bridge mode — a maybe, not a rescue

If a direct connection stalls or times out and the automatic direct rounds are
spent, the app makes one more attempt through obfs4 bridges, using the bundled
`lyrebird.exe` and three hard-coded bridge lines.

This is written down the way it was measured rather than the way it would read
best. With the launch bug fixed, `lyrebird` does start — and all three of those
bridges then answered *"general SOCKS server failure"* for 25 seconds straight.
So the bridge round is the **last** automatic move, never an early one, and a
first connect is never allowed to depend on it. If your network blocks Tor
outright, this app may simply not get you through, and it will tell you that
instead of spinning a wheel at you.

The direct rounds are spent first for the same reason: those are the ones
measured to work.

<img src="docs/media/divider.svg" width="100%" alt="">

## It writes down what it did

<table>
<tr>
<td width="45%" valign="top">

The log viewer is in the app: filterable by level, tailing the last 300 lines,
with a button that opens the folder in Explorer.

This log is the reason the coverage claims on this page can be **checked** rather
than believed. It names each browser, each route attempted and the result that
was read back afterwards. If the extension did not land in Brave, the log says
Brave, and says why.

`C:\ProgramData\freeproxy-vpn\logs\freeproxy-YYYY-MM-DD.log`, seven days kept,
then rotated. Nothing is uploaded — there is no server belonging to this project
to upload it to.

</td>
<td valign="top">
<img src="docs/media/11-log-viewer.png" alt="The in-app log viewer, filterable by level, showing what the app did and where the file lives">
</td>
</tr>
</table>

<img src="docs/media/divider.svg" width="100%" alt="">

## What it changes on your machine, and what it changes back

| Setting | While connected | Put back by |
|---|---|---|
| **System proxy** — `HKCU\…\Internet Settings` | `ProxyServer`, `ProxyEnable=1`, `ProxyOverride` | disconnect and uninstall: the values are **deleted**, and `ProxyEnable` set to `0` |
| **Machine proxy** — WinHTTP | `netsh winhttp set proxy` to Tor's HTTP tunnel port, so Windows Update, the Microsoft Store, the update services and .NET / PowerShell clients follow too — they never read the per-user key above | `netsh winhttp reset proxy`, on disconnect, on exit, at the next start after a crash, and from the uninstaller |
| **DNS**, per adapter | every adapter's resolver pinned to `127.0.0.1` | adapters reset to DHCP, the per-interface `NameServer` removed, `dnscache` started again |
| **Network adapter and routes** — `FreeProxyTun` | a Wintun layer-3 adapter at `10.77.77.1/24`, the `0.0.0.0/1` + `128.0.0.0/1` pair pointing at it, and one host route per live Tor relay via your real gateway | the two `/1` routes and every `/32` it added are deleted **by address**, the adapter itself goes when `tun2socks.exe` exits, and one left behind by a crash is cleaned up at the next start before anything is armed |
| **Firewall** | 9 named rules — 3 outbound allows for this app's own binaries, 5 blocks (IPv6 both ways, DNS on UDP/53 and TCP/53, DoT on 853) and 1 location shield. With the Kill Switch armed, 8 more: the allow list that makes default-deny survivable | each deleted **by name**, so nothing else in your profile is touched — and the outbound policy is handed back **before** the allow rules go, in that order, because the other order would leave the PC with no internet at all |
| **Outbound firewall policy** | with the Kill Switch armed: `firewallpolicy blockinbound,blockoutbound` on all three profiles — the policy itself, which is a different object from the rules above | set back to `blockinbound,allowoutbound` on disconnect, on exit, at the next start after a crash, by **Restore Internet**, and by the recovery script even with this app uninstalled |
| **IPv6** | binding off, `DisabledComponents=255`, Teredo / ISATAP / 6to4 off | binding on, `DisabledComponents=0`, all three tunnels back to `default` |
| **Location service** | `lfsvc` stopped, the sensor denied | `sc config lfsvc start= demand`, then the resolver cache flushed |
| **Chromium policy & external-extension entries** | the four routes above, for installed forks only | removed — and only where the entry's update URL is *this machine's own loopback*, so a workplace deployment survives untouched |
| **Gecko prefs** | one fenced block per real profile in `user.js`, holding **17 prefs**: the geolocation six (`geo.provider.network.url`, `geo.wifi.uri` and the four native-provider switches) and eleven for the tunnel — `network.proxy.type=1` at `127.0.0.1:9050`, `socks_remote_dns`, `no_proxies_on` mirroring your split-tunnel list, `network.trr.mode=5`, and `media.peerconnection.enabled=false`. Every one is read back out of the file before it is reported applied | the fenced block is removed, the values Gecko copied into `prefs.js` at its last shutdown are filtered out of there too, and the revert journal is replayed — the only step that can put back what *you* had rather than a browser default |
| **Gecko prefs, with this app gone** | — | `restore-gecko-prefs.ps1`, written into the state directory at every start and run as step 6 of **Restore Internet** and by the uninstaller. Every other recovery step is a Windows setting a proxied Gecko browser does not read, so without this one "Restore Internet" would leave Firefox unable to load a page |
| **hosts file** | one marked block | removed line by line between its markers; hand-written entries above and below survive byte for byte |
| **Certificates** | one, if the geo shield needed it | removed from all six stores, matched on this app's `FriendlyName` or on a **self-signed** `CN=www.googleapis.com`, which a real Google certificate never is |
| **Scheduled tasks** | `FreeProxy VPN Boot Setup`, `FreeProxy VPN Extension Delivery` | deleted, including the belt-and-braces pass that needs no executable |
| **Files** | `C:\ProgramData\freeproxy-vpn`, `%LOCALAPPDATA%\FreeProxy VPN` | removed on uninstall — Tor state, logs, the staged extension **and the RSA signing key** |

> [!NOTE]
> **The two proxy rows are a deletion and a reset, not a restore, and that is
> worth saying out loud.** No version of this app ever took a snapshot of your
> previous proxy setting, so on the way out it removes what *it* wrote instead of
> pretending to put back something it never read. The per-user values are
> deleted; the machine-wide one goes back to `direct access`, which is the
> Windows default and what the overwhelming majority of PCs have. If you were
> using a proxy of your own before installing this — either kind — you will need
> to set it again. Everything else in that table either restores a Windows
> default or replays the app's own revert journal.

The uninstaller is written so that every one of those reverts still happens
**even if the program files are already gone** — electron-builder does not
promise they survive to that point. The registry sweep walks
`HKLM\Software\Policies` by *shape* rather than by a list of vendor paths, in
both registry views, so a Chromium fork nobody has heard of yet is cleaned too,
and a policy entry that is not provably ours is left exactly where it is.

<img src="docs/media/divider.svg" width="100%" alt="">

## Everything it talks to

The complete list. There is no server belonging to this project, so there is
nothing here that phones home.

| Host | Why | When |
|---|---|---|
| `onionoo.torproject.org` | the live relay index — which countries have usable exits, and how many | only when the copy on disk cannot answer (see below); the refresh after that goes **through Tor** |
| `ipleak.net`, `get.geojs.io`, `api.country.is`, `ipinfo.io` | to read back **where the circuit actually came out**, asked *through* the circuit itself | stage 98 of every connect and every switch |
| `free.freeipapi.com`, `ipwho.is`, `get.geojs.io`, `api.ipbase.com` | to place the "you are here" ring before any tunnel exists, tried in that order | once, while idle — if none answer, nothing is drawn |
| `aka.ms` | the Visual C++ redistributable, **only** if the bundled copy is missing from the installer | install time only |

Two more are links, not requests: the *verify privacy* button opens
`https://ipleak.net/` and the footer opens `https://www.torproject.org` — in your
default browser, through the handler that refuses anything that is not `https`.

> [!TIP]
> If you grep the source you will also find `clients2.google.com`,
> `edge.microsoft.com`, `www.google.com`, `www.googleapis.com` and
> `schemas.microsoft.com`. **None of them is contacted by this app.** The first
> two are store update URLs written *into policy* for a store-hosted route this
> build does not use; `www.googleapis.com` appears only in code that *removes* a
> certificate an earlier build left behind; the last two are XML namespaces.

### The relay list is kept on disk, and that is a privacy feature

Picking a country needs the list of exit relays, and that list has to be fetched
before there is any tunnel to fetch it through — so the request goes out **in the
clear, from your own address**. Nothing in the body matters: the destination
alone tells your ISP, and anything reading SNI on the way, that a Tor client is
about to start on this machine. Worse, the two *keep trying this country* loops
used to re-ask every 20 seconds, for as long as you were willing to wait.

So the index is written to `C:\ProgramData\freeproxy-vpn\relay-index.json` and a
usable copy **suppresses that request entirely**. A cold start now connects from
the file, and the list is refreshed *through Tor* seconds after the tunnel comes
up. A successful fetch is also followed by a five-minute floor — Onionoo rebuilds
from the hourly consensus, so asking three times a minute cannot return anything
new.

Two ages, because the file can support one kind of statement and not the other:

| | Age | What it is allowed to do |
|---|---|---|
| **Fresh** | 15 minutes | say a country has **no** usable exit — the app opens a dialog on that, and only a list from minutes ago can carry it |
| **Usable** | 24 hours | hand over relays to **try**. Each one is pinned by fingerprint and verified against the geolocation databases before the connect counts, so a relay that has gone away costs one failed circuit and is retried — not trusted |

**The two limits, stated plainly.**

1. **It removes that cleartext request only when there is something to use
   instead.** A first run has no file. Neither does one older than 24 hours, one
   written by a different Onionoo query, or one whose timestamp is unreadable or
   in the future — all three are thrown away rather than half-trusted. And if you
   ask the app to keep watching for a country *while disconnected*, it asks in the
   clear on purpose, because there is no other way to find out whether an exit has
   appeared there. Every one of those cases is a `warn` line in the log that names
   which one it was; none of them is silent.
2. **A cached list is never evidence of absence.** Past 15 minutes it can still
   be connected from, but it stops being allowed to say a country is empty. That
   split is deliberate: a stale relay wastes one circuit, while a stale *absence*
   would be a dialog telling you to pick somewhere else while an exit was sitting
   right there. That is precisely the failure
   [*When it cannot do what you asked*](#when-it-cannot-do-what-you-asked) is
   written to avoid, so the cache is not allowed to reintroduce it.

The file holds the public relay index and nothing about you, and it goes with the
rest of the state directory on uninstall. `.build/probe-relay-cache.js` checks the
round trip field by field, and that the freshness boundary is enforced where the
claim is made rather than assumed.

<img src="docs/media/divider.svg" width="100%" alt="">

## Build it yourself

```bash
git clone https://github.com/Zero-Asif/FreeVPN-PC-App.git
cd FreeVPN-PC-App
npm install
```

| Command | What you get |
|---|---|
| `npm start` | runs from source. Use an **elevated** terminal, or the system-level steps will fail honestly instead of silently |
| `npm run pack` | an unpacked build in `release/win-unpacked`, no installer |
| `npm run dist` | `release/FreeProxy-VPN-Setup-2.0.5.exe` — NSIS, per-machine, `requireAdministrator` |

Runtime dependencies are one package: `ws`. Everything else is Electron,
electron-builder and what is already vendored in the repository — `tor.exe`,
`lyrebird.exe`, `Tun\wintun.dll` and `Tun\tun2socks.exe`, the globe libraries,
the flag set and the Visual C++ redistributable.

### The probe suite

`.build/` holds **126** scripts named `test-*` or `probe-*`. They are not unit
tests and there is no framework. Each one drives the real thing — the real
registry, a real browser profile, the real `tor.exe`, the real uninstall sweep —
and then reads the result back out of the machine, because that is the only kind
of check that can tell you whether an extension actually landed.

| Script | What it covers |
|---|---|
| `probe-readme-art.js` | every SVG on this page, rendered the way GitHub renders it — on white **and** on `#0d1117`, from a blob, one frame into its animation |
| `probe-readme-shots.js`, `probe-readme-popup.js` | the 19 screenshots above, driven through the real `index.html`, `Extension/popup.html` and `Extension/welcome.html` |
| `probe-readme-links.js` | every local link, every in-page anchor and every `file#Lnnn` reference in every markdown document here — a heading reworded three sections away kills a link silently |
| `probe-md-html.js` | the raw HTML in those documents. GitHub renders broken markup rather than refusing it, and one unclosed `<td>` swallows the rest of the page into a table cell |
| `probe-tunnel.js`, `probe-containment-recovery.js` | the whole-machine layers — the routes that would be installed, the relay filter, the refusal to report a tunnel that does not exist, and the recovery script that has to work with this app uninstalled |
| `test-geo-e2e.js` | the geolocation path from the app to a page's `navigator.geolocation` |
| `test-installer-sweep.js` | the uninstaller's registry sweep, redirected onto a throwaway key so it can be run at all |
| `make-badges.js` | the 12 badges at the top, every value read out of the project rather than typed |

Some need elevation, some need a particular browser installed, some need a port
to be free. They print what they measured.
[`docs/media/README.md`](docs/media/README.md) has the exact commands for the
ones this page depends on — including what in the screenshots is a fixture, and
why.

<img src="docs/media/divider.svg" width="100%" alt="">

## Every interface, listed

<details>
<summary><b>The 18 IPC channels between the window and the main process</b></summary>

| Channel | Does |
|---|---|
| `connect-vpn` | [`main.js:5973`](main.js#L5973) — connect to a country, with the split-tunnel list |
| `switch-vpn` | [`main.js:6222`](main.js#L6222) — change country **without** dropping the tunnel |
| `disconnect-vpn` | [`main.js:5997`](main.js#L5997) — tear down, or hold the block if the kill switch is armed |
| `toggle-killswitch` | [`main.js:6089`](main.js#L6089) — arm or release the lock |
| `update-live-bypass` | [`main.js:6209`](main.js#L6209) — rewrite `ProxyOverride` only, live |
| `get-realtime-status` | [`main.js:5908`](main.js#L5908) — the country table, exit counts and bandwidth |
| `get-geo-coords` | [`main.js:3399`](main.js#L3399) — the coordinate table the spoof reads from |
| `get-home-location` | [`main.js:3417`](main.js#L3417) — where the idle globe centres |
| `report-killswitch` | [`main.js:3437`](main.js#L3437) — the renderer telling the main process what it shows |
| `get-pending-ask` / `ask-user-answer` | [`2512`](main.js#L2512) / [`2503`](main.js#L2503) — the question, and your answer to it |
| `get-log-lines` | [`main.js:3295`](main.js#L3295) — the tail behind the log viewer, with the level filter |
| `open-log-folder` | [`main.js:3298`](main.js#L3298) — Explorer, at the log directory |
| `open-geo-ext-folder` | [`main.js:3302`](main.js#L3302) — the staged extension and `HOW-TO-ENABLE.txt` |
| `get-pending-restart` | [`main.js:3355`](main.js#L3355) — the marker the installer may have left, read once |
| `dismiss-pending-restart` | [`main.js:3363`](main.js#L3363) — *Later*, and it stays later |
| `restart-windows` | [`main.js:3368`](main.js#L3368) — *Restart now*, and only ever from that click |
| `get-fastest-server` | [`main.js:3332`](main.js#L3332) — ranks the exit-capacity table by advertised exit bandwidth. Not a speed test, and it says so: `measured: false`, plus `best: null` when no relay list has arrived |

</details>

<details>
<summary><b>What the extension popup can ask the app to do</b></summary>

Six commands, over the loopback WebSocket. The popup can do everything the main
window can do to a connection.

| Command | Does |
|---|---|
| `CONNECT` / `DISCONNECT` | the same two paths the window's own button takes |
| `CHANGE_SERVER` | switch country, without dropping the tunnel |
| `TOGGLE_KS` | arm or release the kill switch |
| `UPDATE_BYPASS` | replace the split-tunnel list |
| `ASK_ANSWER` | answer the app's question from the popup instead of the window |

When the socket is down the popup's state object is literally `null`, and every
word on the page derives from that — which is why it goes inert instead of
showing you a country that is no longer true.

</details>

<details>
<summary><b>Command-line flags and exit codes</b></summary>

The app is its own installer helper. These are run *by* the installer, the
uninstaller and two scheduled tasks — never by hand in normal use.

| Flag | Runs |
|---|---|
| `--fp-setup` | install-time: detect browsers, sign the `.crx`, write the entries, schedule the boot pass |
| `--fp-teardown` | uninstall-time: replay the revert journal, remove the tasks and the entries |
| `--fp-boot` | the boot pass, as SYSTEM, before any browser has started |
| `--fp-deliver` | the logon helper that serves the package on `127.0.0.1` |
| `--fp-reboot-pending` | a modifier on `--fp-setup`: *Windows itself* said a restart is pending |

| Code | Means |
|---|---|
| `0` | done |
| `1` | crashed |
| `3` | staging the extension failed |
| `4` | timed out |
| `10` | manual step needed — normal on an unmanaged PC, **not** a failure |
| `11` | a restart is advised, and will be **offered**, never taken |

</details>

<details>
<summary><b>Where things live in the repository</b></summary>

```
main.js                   the main process: torrc, tunnel, leak guard, IPC, asks
renderer.js               the window: globe, badge, country list, log viewer
index.html  style.css     the one window
globe-controller.js       the globe, on three.js + globe.gl
installer.nsh             NSIS hooks — and not one browser-specific registry path
lib/
  browsers.js             the 14 browsers, and how to find them on this PC
  geo-ext.js              the four extension routes, written and read back
  geo-spoof.js            the coverage table this README's diagram is drawn from
  crx.js                  RSA key, CRX signing, the id that comes out of it
  ext-host.js             the one-time loopback server that hands over the package
  ext-deliver.js          the logon delivery task
  installer-tasks.js      --fp-setup / --fp-teardown / --fp-boot / --fp-deliver
  tor-control.js          the control port, cookie auth
  exit-selector.js        which relay, for which country, and what was verified
  socks-fetch.js          asking a question *through* the circuit
  home-location.js        the idle globe's "you are here"
  offthread.js            keeping the window responsive during a cold connect
Extension/                the bundled MV3 extension
Extension-Store/          the same extension, packaged for store submission
Tor/                      tor.exe 0.4.9.6 and lyrebird.exe, as shipped
docs/media/               every image on this page, and the script that made it
.build/                   126 probes, the screenshot harnesses, the art gate
```

</details>

<img src="docs/media/divider.svg" width="100%" alt="">

## Known limitations

These are here because a page that only lists what works is not documentation.

**Limits of the platform, not of the effort**

* **Native Windows geolocation cannot be spoofed.** There is no supported way to
  inject coordinates into the Windows location provider — measured, including
  the documented *Default Location* setting, which changes nothing the provider
  reports. Non-browser applications get a **withheld** position, never a fake
  one.
* **An off-store extension cannot be force-installed on an unmanaged PC.**
  Chrome, Brave *and* Edge all require domain-join, Azure-AD-join or Chrome
  Browser Cloud Management. What lands instead is the external-extensions offer
  at the next browser start; where nothing automatic can work you get one click,
  once.
* **obfs4 bridge mode is a maybe.** All three bundled bridges answered "general
  SOCKS server failure" for 25 s straight when measured. A network that blocks
  Tor may simply block this.
* **Tor is not a bandwidth service.** Browsing is fine; large downloads and
  video are slower than a commercial VPN. That is the cost of having nobody to
  trust.
* **Your previous proxy setting is not restored**, because no version of this app
  ever recorded it. It removes what it wrote from the per-user store and returns
  the machine-wide one to `direct access`.
* **UDP does not go through the tunnel.** Tor's SOCKS5 has no `UDP ASSOCIATE`, so
  QUIC, WebRTC, most games and VoIP have nothing to ride. With the Kill Switch
  armed they are blocked rather than sent in the clear; with it off they use your
  real connection, and the app says so. `"fullTunnel": false` in `settings.json`
  gives UDP back at the cost of whole-device coverage
  ([how](#the-whole-machine-not-just-the-browser)).
* **`ping` and `tracert` go quiet while the full-device tunnel is up.** ICMP is
  not carried through a SOCKS5 proxy either, so the tools people reach for to
  check whether the network is working are the two that stop working first.
* **The tunnel's live path has not been verified on this machine.** Creating the
  adapter, reading its address and routes back, and tearing it down all need
  administrator; `.build/probe-tunnel.js` prints `NOT VERIFIED (needs admin)` for
  exactly those four steps on an unelevated run, and this README will not claim
  more than the probe measured.
* **Proxy settings stay per-user.** The machine-wide WinHTTP store is set, and
  the Chromium policies and the tunnel are machine-wide, but the WinINET
  `ProxySettingsPerUser` policy is deliberately left alone — turning it on would
  mean that losing the restore journal leaves *every* account on the PC with a
  dead proxy and no working Settings page to clear it. The reasoning is written
  out in `main.js`, above the leak-protection section.
* **A Gecko browser's prefs land at its next start, and a running one is
  skipped.** `user.js` is read once at startup, so a profile written while
  Firefox is open is unchanged until it is closed and reopened — and a profile
  whose browser is *running* when you connect is not written at all, because
  writing under a live Gecko process is how a profile gets corrupted. It is named
  in the log and picked up on the next connect.
* **WebRTC is switched off in Gecko browsers while connected**
  (`media.peerconnection.enabled=false`), for the same reason UDP does not ride
  the tunnel: a WebRTC call would either fail or find its own way around it. Video
  calls in Firefox and its forks do not work until you disconnect, which removes
  the pref again.
* **Windows 10 / 11, x64 only.** There is no macOS or Linux build and this
  README will not pretend one is coming.

**Three defects this README reported, and what closed them in v2.0.5**

Two of them are visible in the screenshots above. They were left in frame on
purpose: airbrushing a README is how a project starts lying about itself. The
screenshots have not been retaken, so the table below is what the pictures show
and what the code now does.

| Where | What was wrong | What ships in 2.0.5 |
|---|---|---|
| [`main.js:3332`](main.js#L3332) | `get-fastest-server` returned `{ best: 'sg', others: ['hk','jp'] }` unconditionally, and the dropdown painted a `BEST` badge from it. **Nothing was timed.** Nothing can be, either: Tor exit throughput is not rankable from a sample — measured, within-relay spread matches between-relay spread, so onionoo's own order is already as good as this can get. | It ranks the same exit-capacity table the dropdown is sorted by — total advertised exit bandwidth, which relay operators publish and the consensus weighs — returns `best: null` before any relay list has arrived, so an unknown answer paints no badge instead of a wrong one, and carries `measured: false`. The badge's tooltip says "not a speed test" in as many words. |
| [`main.js:4638`](main.js#L4638) | the "your country is available again" ask passed no `foot`, so [`renderer.js:749`](renderer.js#L749) fell back to the idle line — the footer read *"Nothing is connected right now…"* directly under a body that says *"You are currently connected through India."* Visible in `09-comes-back.png`. | That ask is the only question this app raises **while the tunnel is carrying traffic**, so it is the one that must not take the default footer. It now sends its own: *"You stay connected through … while this question is up, and nothing changes until you answer it."* The other two choice cards keep the default, which is true of them — both are up because a connect failed. |
| [`Extension/welcome.html:157`](Extension/welcome.html#L157) | `ol.steps li b { display: block; }` also matched the inline `<b>FreeProxy VPN Extension</b>` on line 257, so a full stop ended up alone on its own line. Visible in `30-welcome.png`. | `ol.steps li > b:first-child`. The child combinator also keeps the rule off any nested markup added later, and a leading text node does not count for `:first-child`, so each step's bold lead line still gets its own row. |

<p align="center"><img src="docs/media/divider.svg" alt="" width="100%"></p>

## Questions people actually ask

<details>
<summary><b>Is it really free? Where is the catch?</b></summary>

<br>

There is no account, no subscription, no trial, no e-mail box to fill in, and no
server belonging to this project — which is the honest reason it can be free.
The bandwidth is donated by the volunteers who run Tor relays. What you give up
instead of money is speed, and the fact that a small number of sites treat
known Tor exits with suspicion.

</details>

<details>
<summary><b>Why does it need administrator rights?</b></summary>

<br>

Four of the things it does are machine-wide, and Windows will not let a normal
process do any of them: writing DNS servers onto every adapter, adding firewall
rules, blocking IPv6, and writing extension policy under `HKLM`. It asks once,
at install, and the elevated work is done by a short-lived child process rather
than the window you are looking at — see the block budget in
[**How it works**](#how-it-works).

</details>

<details>
<summary><b>Why does my browser ask me to turn the extension on?</b></summary>

<br>

Because on a personal PC that is the only way in. Measured on 2026-09-01:
Chrome, Brave **and** Edge all refuse to force-install an extension that did
not come from their web store unless the machine is domain-joined,
Azure-AD-joined or CBCM-enrolled. So the app delivers the extension by the one
route that does reach an unmanaged browser, and that route lands it **disabled**
— one click from you, once, per browser. It never disables it again afterwards.

</details>

<details>
<summary><b>Does it log what I do?</b></summary>

<br>

It writes a local log of what **it** did — the torrc it wrote, the registry keys
it touched, the exit country it read back — so that every claim on this page can
be checked on your own machine instead of taken on trust. It records no browsing
history and no destination you visited, and nothing is uploaded anywhere,
because there is nowhere to upload it to. The file is plain text at
`C:\ProgramData\freeproxy-vpn\logs\`, seven days are kept, and
[**It writes down what it did**](#it-writes-down-what-it-did) shows the viewer.

</details>

<details>
<summary><b>Is this Tor Browser?</b></summary>

<br>

No, and it is not a replacement for it. Tor Browser solves a different problem:
it makes your *browser* look like every other Tor Browser, so a site cannot
fingerprint you. It does nothing for the rest of your machine. This app routes
the whole machine through Tor and fixes the thing Tor Browser deliberately does
not touch — geolocation, per browser, per profile. If your threat model is a
site fingerprinting your browser, use Tor Browser. If it is *everything on this
PC should leave through Tor and stop broadcasting where I am*, this is that.

</details>

<details>
<summary><b>Can a website still tell where I am?</b></summary>

<br>

Yes, by other means, and this page will not pretend otherwise. What is closed is
the IP address, the DNS query, the browser geolocation API and the Windows
location service. What is **not** closed: your system timezone, your browser's
language and `Accept-Language` header, canvas and font fingerprinting, and — most
of all — any account you are already signed into. Google knows where you live
because you told it, not because it looked.

</details>

<details>
<summary><b>Why 74 countries and not all of them?</b></summary>

<br>

74 is the number of entries in `GEO_COORDS` at
[`main.js:160`](main.js#L160) — the table of coordinates the app hands to the
extension when it spoofs a position. A country is listed only if it has a
coordinate to hand over, so that the browser is never told a location the app
made up. Tor itself has exits in more places; the badge counts what can be
*spoofed*, not what can be *routed*.

</details>

<details>
<summary><b>Will it slow everything down, not just my browser?</b></summary>

<br>

Yes. That is the point of a system proxy, and it is the honest cost: every
program on the machine goes through three volunteer relays. If one app needs its
real speed — a bank that refuses Tor, a work intranet, a game — put its domain
in the split-tunnel box and it leaves your normal connection instead, live,
without disconnecting. See
[**Split tunnelling, applied live**](#split-tunnelling-applied-live).

</details>

<details>
<summary><b>What if the app crashes while I am connected?</b></summary>

<br>

Everything it changed is written to a journal *before* it changes it, so the next
start knows exactly what to put back rather than guessing at defaults.
`startupCleanup()` at [`main.js:1132`](main.js#L1132), called from
[`main.js:3210`](main.js#L3210), kills any stale `tor.exe`, restores the recorded
location setting, removes the proxy, clears the DNS pins, drops the IPv6 and DNS
firewall rules and restarts `dnscache`. If it finds no journal it still reverts
all of that — it simply will not touch your location setting, because forcing
*Allow* would quietly switch location on for someone who keeps it off.

</details>

<p align="center"><img src="docs/media/divider.svg" alt="" width="100%"></p>

## The rest of the paperwork

<table>
<tr>
<td width="33%" valign="top">

### 📄 [CONTRIBUTING.md](CONTRIBUTING.md)

How to build it, where each part lives, what the probe suite expects of a change,
and the one rule that matters most here: **a claim goes in only after a read-back
proved it.**

</td>
<td width="33%" valign="top">

### 🤝 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Contributor Covenant 2.1, with the enforcement ladder spelled out rather than
implied.

</td>
<td width="33%" valign="top">

### ⚖️ [LICENSE.txt](LICENSE.txt)

MIT, for this app's own code. The engine it drives is not MIT — see the notices
below.

</td>
</tr>
<tr>
<td valign="top">

### 🔒 [PRIVACY_POLICY.md](PRIVACY_POLICY.md)

The short version is on this page already: no account, no telemetry, no server of
this project. This is the long version.

</td>
<td valign="top">

### 📚 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

Every bundled component and its licence — Tor and its own dependencies,
lyrebird, three.js, globe.gl, `ws`, Electron, the flag icons and the earth
textures.

</td>
<td valign="top">

### 🧪 [docs/media/README.md](docs/media/README.md)

Every picture on this page, which script generated it, and the complete list of
the six values in the screenshots that are fixtures rather than real.

</td>
</tr>
</table>

## Standing on other people's work

This app is a control panel. Almost everything that makes it *work* was written
by someone else, and none of it asked to be involved:

- **The Tor Project** — `tor.exe` 0.4.9.6 and `lyrebird` (obfs4) do the actual
  anonymity. This app writes a torrc and reads a control port; that is the whole
  of its cleverness.
- **The relay operators** — several thousand volunteers paying for the bandwidth
  you are about to use. If this app is useful to you,
  [run a relay](https://community.torproject.org/relay/) or
  [donate](https://donate.torproject.org/) to the people whose machines are
  carrying it.
- **`onionoo.torproject.org`** — the relay directory this app reads to know which
  countries have exits at all.
- **[three.js](https://threejs.org/) r147** and
  **[globe.gl](https://github.com/vasturiano/globe.gl) 2.27.2** — the globe.
- **[Electron](https://www.electronjs.org/) 41.3.0** and
  **[ws](https://github.com/websockets/ws) 8.20.0** — the shell and the one
  runtime dependency.
- **[flag-icons](https://github.com/lipis/flag-icons)** — 74 flags that are not
  emoji, because Windows does not render flag emoji.

<p align="center"><img src="docs/media/divider.svg" alt="" width="100%"></p>

<div align="center">

**FreeProxy VPN** 2.0.5 · MIT · Windows 10 and 11 · no account, no telemetry, no
server of this project

Built by [Zero-Asif](https://github.com/Zero-Asif) ·
[report something](https://github.com/Zero-Asif/FreeVPN-PC-App/issues) ·
[read the code](https://github.com/Zero-Asif/FreeVPN-PC-App)

<sub>Tor is a registered trademark of The Tor Project, Inc. This is an
independent project and is not affiliated with, endorsed by, or supported by
The Tor Project.</sub>

<sub>Every number, port, path and line reference on this page was read out of the
source in this repository, not remembered. Where a check could not be run, this
page says so instead of rounding it up.</sub>

</div>

