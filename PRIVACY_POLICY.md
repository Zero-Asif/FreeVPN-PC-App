# Privacy Policy — FreeProxy VPN

**Effective date:** 3 September 2026 · **Applies to:** the FreeProxy VPN desktop
application for Windows (v2.0.0) and the FreeProxy VPN browser extension (v1.1.0)

This document is written to be checkable rather than reassuring. Every statement
below can be verified against the source in this repository, and where something
*is* disclosed to a third party, it is named — including the case where that
happens over your real IP address before any tunnel exists.

## 1. In one paragraph

There is no account, no sign-up, no subscription, no telemetry, no crash
reporter, no analytics and no update check. **This project operates no server of
any kind**, so there is nothing for the developer to collect, and no database in
which anything about you could exist. The app runs entirely on your own machine.
It writes a local diagnostic log, which never leaves that machine. Four
categories of third-party host *are* contacted, for reasons listed in §4, and one
of those happens over your real IP.

## 2. What the developer receives

**Nothing.** Not an identifier, not a timestamp, not a country, not a crash
report, not a count of installations. This is not a policy choice that could be
reversed by a settings change — there is no endpoint to send anything to.

If you open a GitHub issue you will be giving the developer whatever you choose
to put in it. That is the only channel that exists, and it is entirely in your
hands.

## 3. What is stored on your own computer

### 3.1 The diagnostic log

`%ProgramData%\freeproxy-vpn\logs\freeproxy-<date>.log`, plain text, **seven days
kept and older files deleted**. You can open it from the app.

It exists so that the claims this project makes can be checked on your own
machine instead of taken on trust. It records **what the app did**:

* the `torrc` it wrote, and Tor's own bootstrap phases and percentages
* the registry keys, firewall rules, DNS pins and services it changed, by name
* per browser, what was attempted and what a read-back afterwards actually found
* the exit country it read back through the circuit, and the coordinates handed
  to the extension
* **the split-tunnel domains you type**, when you apply them — those are a
  setting the app acted on, so they are recorded like any other

It does **not** record your browsing history, the sites you visit, the pages you
load, DNS queries you make, or the content of any traffic. The app never sees
them: Tor resolves and carries them, and the app only ever writes a config file
and reads a control port.

Nothing in this file is transmitted anywhere. If you attach it to a bug report,
read it first — it is yours, and it is legible on purpose.

### 3.2 State files

Three JSON files under `%ProgramData%\freeproxy-vpn\`, and that is the whole set:

| File | Holds |
|---|---|
| `geo-restore.json` | what each browser's and Windows' location settings were **before** the connection, so a disconnect — or a crash — puts back the real value instead of guessing at a default |
| `restart-pending.json` | whether the one post-install restart is still owed |
| `browser-intro-shown.json` | whether the first-run browser card has been shown |

Your chosen country, the kill-switch state and your split-tunnel list are **not
written to disk at all**. They live in one in-memory object for the life of the
process and are gone when the app closes. There is also an `exit-cache.json`
alongside the app, which is Tor's relay list — public data about relays, nothing
about you.

The uninstaller removes all of these by name.

### 3.3 What the browser extension keeps

In `chrome.storage.local`, per browser: the connected country code, its
coordinates and an accuracy figure, the connection state, and **the list of
origins that were handed a position** — that last one exists solely so the next
country switch knows whose site storage to clear. No browsing history, no page
content, no destinations.

## 4. Third parties, named

None of these belongs to this project. They are listed with the route each one is
reached over, because that determines what it can see.

| Host | Asked for | Route | What it can therefore see |
|---|---|---|---|
| `onionoo.torproject.org` | the Tor relay directory — which countries have usable exits | **your normal connection**, before any tunnel exists | your real IP, and that it is asking for a relay list |
| `free.freeipapi.com`, `ipwho.is`, `get.geojs.io`, `api.ipbase.com` — tried in that order, first answer wins | an approximate position for your **own** IP, to draw the idle "you are here" ring | **your normal connection, while disconnected** | your real IP, which is exactly what it is being asked about |
| `ipleak.net`, `get.geojs.io`, `api.country.is`, `ipinfo.io` | "what IP do you see?", to confirm the exit country | **through the Tor circuit** | the exit relay's IP, not yours |
| `aka.ms` | Microsoft's Visual C++ redistributable, **only** if the bundled copy is missing | your normal connection, at install | your real IP, once, at install |

> **The second row is the one that matters most, so it is not buried.** To centre
> the globe on where you are *before* you connect, the app asks a third party
> where your IP is. That host learns your IP — it has to, that is the question.
> If none of the four answers, the app draws nothing rather than guessing. If you
> would rather no one were asked, stay disconnected and simply do not open the
> idle globe view, or connect first: once the tunnel is up, every subsequent
> lookup goes through it.

No identifier of any kind is attached to these requests. The app sets no cookie of
its own and sends no `User-Agent` it composed to identify itself. Each host has
its own terms and its own privacy policy, over which this project has no control.

Five other `http(s)://` strings exist in the source and are **not** requests:
`clients2.google.com` and `edge.microsoft.com` are store update URLs written
*into* a policy value; `www.googleapis.com` appears only in the code that removes
a certificate an earlier build created; `www.google.com` and
`schemas.microsoft.com` are XML namespace identifiers. Grep the source and you
will find them — that is why they are accounted for here.

## 5. The Tor network

Your traffic is carried by three volunteer-operated relays. **This project does
not own, operate, fund, choose or control any of them**, and cannot see what they
see.

Two consequences worth being plain about:

* **Tor encrypts between relays, not to the destination.** If a site is on plain
  HTTP, the exit relay can read that traffic. Tor does not fix that and neither
  does this app.
* **Your ISP can see that you are using Tor**, unless a bridge happens to work.
  Bridge mode exists in the app and is a measured *maybe*, not a guarantee.

The Tor Project has its own privacy policy at
<https://www.torproject.org/privacy-policy/>.

## 6. The browser extension's permissions

The extension asks for `proxy`, `storage`, `tabs`, `notifications`, `cookies`,
`browsingData`, `alarms` and `<all_urls>`. Because that is a broad set, each one
is accounted for individually in the README under
[Every permission it asks for](README.md#every-permission-it-asks-for-and-what-each-one-is-actually-for).

The two that deserve stating here:

* **`<all_urls>`** lets the extension inject its geolocation shim into every page
  and frame at `document_start`. It reads no page content, and it issues **no**
  `fetch`, `XMLHttpRequest` or beacon of any kind — the only socket it opens is
  `ws://127.0.0.1:8080`, to the app on your own machine.
* **`browsingData` + `cookies`.** When you switch country while connected, the
  extension deletes every `UULE` cookie by name and then clears this browser's
  **cache, cookies and history, browser-wide, over all recorded time**. That
  signs you out of every site. It is the only way a switch reliably takes effect;
  the reasoning and the narrower version that failed are in
  [What a switch wipes, and why](README.md#what-a-switch-wipes-and-why). A
  **disconnect** does not do this.

Nothing removed this way is copied, read or sent anywhere first. It is deleted.

## 7. Administrator rights

The app requires elevation for four machine-wide things Windows will not let an
ordinary process do: writing DNS servers onto every network adapter, adding
firewall rules, blocking IPv6, and writing extension policy under `HKLM`. It asks
once, at install. Elevation is not used to read your files, enumerate your
software, or inspect anything unrelated to those four jobs.

## 8. What this app cannot protect

Stated because a privacy policy that only lists its wins is not much use.

Connecting closes your IP address, your DNS queries, `navigator.geolocation` in
14 browsers, and the Windows location service. It does **not** close:

* **your system timezone** — a site can read it, and it will not match your exit
* **your browser's language and `Accept-Language` header**
* **canvas, font, WebGL and audio fingerprinting** — this is not Tor Browser and
  does not attempt Tor Browser's job
* **any account you are already signed into.** A service you are logged into
  knows where you live because you told it, not because it looked
* **the Windows location provider itself**, which has no supported spoofing
  route. The app **withholds** the position instead of faking it, and says so in
  the UI rather than pretending

## 9. Removal

Uninstalling reverts every system change by name, not by reboot: the proxy, the
DNS pins, the IPv6 and DNS firewall rules, the location service, the extension
policy in all four of its registry forms, the scheduled tasks, and the log and
state directories.

One asymmetry, disclosed because it can surprise you: **the app does not snapshot
a proxy you had configured beforehand.** It deletes what it wrote rather than
restoring what was there, so if you were using a proxy of your own before
installing, you will need to set it again.

## 10. Children

This software is not directed at children and collects nothing from anyone,
including children.

## 11. Changes

Material changes will be made in this file with a new effective date, in a commit
you can read. Because no contact information is collected, there is no way to
notify you directly — the commit history is the notification.

## 12. Contact

* **Developer:** Zero-Asif (Asifuzzaman Asif)
* **Repository:** <https://github.com/Zero-Asif/FreeVPN-PC-App>
* **Report a privacy problem:**
  <https://github.com/Zero-Asif/FreeVPN-PC-App/issues>

If you find a statement in this document that the source does not support, that
is a defect and it will be corrected. Please say which file disagrees with which
paragraph.

---

<sub>Every claim above was written against the code in this repository. The list
of hosts in §4 was produced by reading every `http(s)://` literal in `main.js`
and `lib/*.js` and classifying each one, which is why §4 ends by accounting for
the five that are not requests.</sub>



