# Third-party notices

FreeProxy VPN is MIT licensed — that covers the code in this repository and
nothing else. The parts that make it actually work were written by other people
under other licences, and this file lists every one of them.

**One of them is not MIT and matters most: `tor.exe` is GPL-3.0.** It is shipped
as a separate executable, run as a child process and spoken to over a local
control port. This app does not link against it, statically or dynamically, and
contains none of its code.

Versions below were read from the shipped files, not from memory. Where a version
string was printed by the binary itself, the command that printed it is given.

---

## The anonymity engine

### Tor — `tor/tor/tor.exe`

| | |
|---|---|
| **Version** | 0.4.9.6 (`git-894a92ac2279747e`) |
| **Licence** | GNU General Public License v3.0 |
| **Home** | <https://www.torproject.org/> · <https://gitlab.torproject.org/tpo/core/tor> |
| **How verified** | `tor/tor/tor.exe --version` |

```
Tor version 0.4.9.6 (git-894a92ac2279747e).
This build of Tor is covered by the GNU General Public License
(https://www.gnu.org/licenses/gpl-3.0.en.html)
```

The same command names the libraries built into that binary. They are listed
here because they ship inside it:

| Library | Version | Licence |
|---|---|---|
| Libevent | 2.1.12-stable | BSD 3-Clause |
| OpenSSL | 3.5.5 | Apache License 2.0 |
| zlib | 1.3.2 | zlib licence |
| liblzma | not built in (`N/A`) | — |
| libzstd | not built in (`N/A`) | — |

Compiled with clang 19.1.7, per the same output.

Full text: <https://www.gnu.org/licenses/gpl-3.0.txt>

### lyrebird — `tor/tor/pluggable_transports/lyrebird.exe`

| | |
|---|---|
| **Licence** | BSD 3-Clause |
| **Home** | <https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird> |
| **Role here** | the obfs4 pluggable transport. Used only in bridge mode, which this app treats as a last resort — see [obfs4 bridge mode](README.md#obfs4-bridge-mode--a-maybe-not-a-rescue). |

lyrebird is the current implementation of `obfs4proxy` and carries the
Yawning Angel / Tor Project BSD 3-Clause licence. It is a Go binary and vendors
its own Go module dependencies; those are recorded in that project's `go.mod`
and are not reproduced here.

### The GeoIP databases — `tor/data/geoip`, `tor/data/geoip6`

Shipped with Tor, derived from the MaxMind GeoLite2 data under the
[Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
licence. This product includes GeoLite2 data created by MaxMind, available from
<https://www.maxmind.com>. The app reads them only through Tor; it does no
geolocation lookup of its own against them.
---

## The application shell

### Electron

| | |
|---|---|
| **Version** | `^41.3.0` (`package.json` → `devDependencies`) |
| **Licence** | MIT |
| **Home** | <https://www.electronjs.org/> |

Electron bundles Chromium and Node.js, each with its own large licence set.
Those are shipped inside the packaged app as `LICENSES.chromium.html` and
`LICENSE` next to the executable; electron-builder places them there, and this
file does not attempt to duplicate them.

### ws

| | |
|---|---|
| **Version** | `^8.20.0` — **the only runtime dependency of this project** |
| **Licence** | MIT — Copyright (c) 2011 Einar Otto Stangvik, (c) 2013 Arnout Kazemier and contributors, (c) 2016 Luigi Pinca and contributors |
| **Home** | <https://github.com/websockets/ws> |
| **Role here** | the loopback WebSocket server on `127.0.0.1:8080` that tells the browser extension the country, the city and an accuracy |

### electron-builder

| | |
|---|---|
| **Version** | `^26.8.1` (build-time only; not shipped) |
| **Licence** | MIT |
| **Home** | <https://www.electron.build/> |

### Microsoft Visual C++ 2015–2022 Redistributable (x64)

Shipped as `VC_redist.x64.exe` and copied to `resources/vc_redist.x64.exe` by
the `extraResources` block in `package.json`. Redistributed under the Microsoft
Software License Terms that accompany it. The installer runs it only when the
runtime is found to be missing, and if the file itself is absent it falls back to
fetching Microsoft's own `aka.ms` link — that is the one and only case in which
this app contacts a Microsoft host.

---

## The globe

All five files below are committed under `vendor/` and pinned by SHA-256 in
[`.build/test-vendor.js:42-48`](.build/test-vendor.js#L42). They were downloaded
once, at development time. **Nothing here is fetched at runtime** — before that
change, `index.html` loaded two of them from unpkg over whatever network the user
happened to be on, in a window that runs with `nodeIntegration: true`.

### three.js — `vendor/three.min.js`

| | |
|---|---|
| **Version** | r147 (`REVISION="147"`, and `three@0.147.0` per the CDN tag it replaced) |
| **Licence** | MIT — Copyright © 2010-2022 three.js authors, per the `@license` header in the file |
| **Home** | <https://threejs.org/> |

### globe.gl — `vendor/globe.gl.min.js`

| | |
|---|---|
| **Version** | 2.27.2, per the file's own first line |
| **Licence** | MIT — Copyright © Vasco Asturiano |
| **Home** | <https://github.com/vasturiano/globe.gl> |

It carries **three-globe** 2.45.2 and, with it, the rest of the
`vasturiano/*` d3-and-three stack; all of those are MIT.

### The three earth textures

`vendor/earth-blue-marble.jpg`, `vendor/earth-topology.png`,
`vendor/earth-night.jpg`.

These files came from three-globe 2.45.2's example assets — which is what the
unversioned unpkg path the app used to load resolved to on the day they were
downloaded. The imagery in them is NASA's: *Blue Marble Next Generation* and
*Earth at Night*, published by NASA Visible Earth
(<https://visibleearth.nasa.gov/>). NASA material is generally not subject to
copyright and may be reused; NASA asks that it not be used to imply endorsement.

To be exact about what was checked here: the byte content of the three files is
pinned and verified, and the path they were fetched from is recorded. That they
are the NASA originals rather than a re-processed derivative was **not**
independently established — it is what the upstream project states about them.

### flag-icons — `vendor/flags/*.svg` and `Extension/flags/*.svg`

| | |
|---|---|
| **Licence** | MIT for the project; the flag artwork itself is public domain |
| **Home** | <https://github.com/lipis/flag-icons> |
| **Which files** | `flags/4x3/<cc>.svg`, one per country in `GEO_COORDS` — 74, plus a `README.txt` this project wrote |

The same 74 are copied into `Extension/flags` so the browser popup draws an
identical flag out of its own package, with no host permission and no network.
They replaced a per-country `flagcdn.com` request that told a third party which
country the user was about to connect to, over the real IP, before the tunnel
existed. Provenance and the integrity check are described in
[`vendor/flags/README.txt`](vendor/flags/README.txt).

---

## Services this app reads from

None of these is bundled, and none belongs to this project. They are listed
because using them is a dependency too, and because a reader is entitled to know
who gets told something.

| Host | What it is asked | Over which route |
|---|---|---|
| `onionoo.torproject.org` | the Tor relay directory — which countries have exits at all | your normal connection, before the tunnel exists |
| `ipleak.net`, `get.geojs.io`, `api.country.is`, `ipinfo.io` | "what IP do you see?", to read the exit country back | **through the circuit that was just built** |
| `free.freeipapi.com`, `ipwho.is`, `get.geojs.io`, `api.ipbase.com` | the idle "you are here" ring, tried in that order | your normal connection, while disconnected |
| `aka.ms` | Microsoft's VC++ redistributable, **only** if the bundled copy is missing | your normal connection, at install |

Each is subject to its own terms and privacy policy. The app sends no identifier
with any of these requests, sets no cookie of its own, and if none of the
"you are here" hosts answers it draws nothing rather than guessing. The full
accounting, including the five URL literals in the source that are **not**
requests, is in [Everything it talks to](README.md#everything-it-talks-to).

---

## Trademarks

**Tor** is a registered trademark of The Tor Project, Inc. This is an independent
project. It is not affiliated with, endorsed by, sponsored by or supported by The
Tor Project, and no claim of association is intended by the fact that it drives
their software.

Microsoft, Windows, Edge and Internet Explorer are trademarks of Microsoft
Corporation. Chrome and Chromium are trademarks of Google LLC. Brave, Vivaldi,
Opera, Opera GX, Yandex Browser, Firefox, Waterfox, LibreWolf, Pale Moon and
SeaMonkey are the trademarks of their respective owners. They appear in this
project only to name the browser a setting is being written for.

---

## Corrections

If a licence here is wrong, a version is stale, or a component is bundled and not
listed, that is a defect and it will be fixed —
[open an issue](https://github.com/Zero-Asif/FreeVPN-PC-App/issues). Please say
which file you found it in; every entry above is meant to be re-checkable from
the repository alone.



