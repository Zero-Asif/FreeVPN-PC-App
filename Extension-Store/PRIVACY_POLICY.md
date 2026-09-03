# Privacy Policy — FreeProxy VPN Extension for Microsoft Edge

**Effective date:** 3 September 2026
**Applies to:** the *FreeProxy VPN Extension* published on Microsoft Edge Add-ons.

This policy covers the Microsoft Edge extension only. The FreeProxy VPN desktop
application for Windows has its own policy, in
[`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md) at the root of this repository.

## 1. The short version

This extension collects nothing, stores nothing about you off your own device,
and sends nothing to the developer or to any third party.

There is no account, no login, no subscription, no advertising and no analytics.
The only network address the extension contacts is `ws://127.0.0.1:8080` — a
loopback connection to the FreeProxy VPN desktop application running on your own
PC. Loopback traffic never leaves the machine. There is no server of ours for it
to reach, because this extension has none.

## 2. Information this extension does not collect

The extension does **not** collect, transmit, sell, licence, share or otherwise
make available:

- your name, e-mail address, phone number or any other contact detail;
- your IP address or real location;
- your browsing history, the pages you open, or the contents of any page;
- form input, keystrokes, passwords, cookies or authentication tokens;
- health, financial or any other sensitive personal information;
- device or hardware identifiers, or any advertising identifier.

There is no telemetry, no crash reporting and no usage measurement of any kind.
The developer receives nothing and therefore has nothing to disclose, sell or
hand over. The extension does not engage in data brokering.

## 3. What is stored on your own device

The extension keeps a small amount of state in Microsoft Edge's own extension
storage, inside your browser profile on your PC. It is never uploaded:

| Stored value | What it is | Why |
| --- | --- | --- |
| `geoSpoof` | the coordinates of the country the desktop app is connected to | so a page that asks for your position gets the connected country instead of your real one |
| `geoLast` | the location those pages were last told | so the extension can tell when the country has changed |
| `geoOrigins` | the list of website origins that were given a position | so only those sites are refreshed and cleaned up on a country change |
| `welcomeShownAt` | a timestamp | so the welcome page is shown once, not on every browser start |
| `fpProxyLeftOn` | a true/false marker | so the extension can tell that it left the proxy set and release it |

`geoOrigins` is the only entry that reflects your browsing at all: it is a list
of sites that asked for your location while you were connected. It stays in your
profile, it is emptied when the country changes and when you disconnect, and it
is removed with the extension. It is never transmitted.

## 4. Settings this extension changes in Microsoft Edge

**Proxy.** While the desktop app is connected, the extension sets Microsoft
Edge's proxy setting to the app's local Tor listener on `127.0.0.1`, so this
browser's traffic leaves through the country you chose. Microsoft Edge shows you
that an extension is controlling this setting, and the extension gives it back:

- when you press Disconnect;
- when the desktop app stops running;
- when the last Microsoft Edge window is closed;
- when you switch the extension off or remove it at `edge://extensions`.

**Reported location.** While connected, pages that ask for your position through
the standard geolocation API receive the connected country's coordinates instead
of your real position. Nothing about your real position is read, stored or sent
anywhere in the process — the real value is simply not passed on.

Nothing else in the browser is altered. The extension does not change your
homepage, your new-tab page, your search provider, your favourites or your
downloads, and it does not add, remove or interfere with any other extension.

## 5. Data this extension deletes, and when

### When the connected country changes

The extension clears data in this browser, so that the country you just left
stops being reported:

- this browser's **cache, cookies and browsing history**, for all recorded time;
- for the sites that had been given the previous country only: their local
  storage, IndexedDB, cache storage and service workers.

**Clearing cookies is browser-wide, so this signs you out of the websites you
were signed in to in Microsoft Edge.** That cost is stated here rather than
hidden. Nothing in a cookie says whether it encodes a location, so the only way
to be certain that no site is still holding the country you left is to clear
them; they are deleted, never read or sent anywhere first.

The rest is necessary for the same reason. Websites remember a location outside
the geolocation API as well — Google, for example, keeps it in a cookie — so
without this step a site would keep reporting the country you switched away
from, which is the exact leak the extension exists to prevent.

"The connected country changes" also covers disconnecting and then connecting to
a **different** country later: the pages and site data in this browser still
hold the old one, so it is the same situation. Connecting again to the same
country clears nothing.

### When you disconnect

One cookie is removed, by name: `UULE`, the cookie Google writes to carry a
position. Nothing else is touched — not the cache, not your history, not any
other cookie, not any site's stored data. A full clear would not be
proportionate to an ordinary disconnect, so it does not happen there.

### At every other time

Nothing is deleted. There is no clearing on a browser start, none on a
schedule, and none in the background.

### Also worth knowing

- It deletes; it never reads, copies or transmits. Nothing that is cleared is
  sent anywhere first, and no record of what was cleared is kept.
- It affects this browser on this PC only, and it cannot be undone once done.
- If you would rather it did not happen, stay on one country, or switch the
  extension off at `edge://extensions`. The desktop app by itself still routes
  the whole PC without touching anything in this browser.

The country-change clearing is disclosed on the extension's own welcome page the
first time it runs, in the popup you press the buttons in, and in the store
listing — not only here.

## 6. Third parties, and the Tor network

There are no third parties in this extension. No analytics provider, no
advertising network, no crash reporter, no content delivery network, no font
service, no error tracker, no software development kit belonging to anyone else.
It loads no remote code: every line it runs ships inside the package Microsoft
reviewed, and the code contains no `fetch`, no `XMLHttpRequest`, no `eval` and
no dynamic script loading. The only address it opens is `ws://127.0.0.1:8080`,
on your own PC.

Your browsing itself does travel through the **Tor network** while you are
connected, because Tor is the engine inside the desktop app that this browser's
proxy setting is pointed at. That is the service you chose when you pressed
Connect, and it is worth being exact about what it does and does not mean:

- Tor is run by independent volunteers, not by us. We operate no relay in it and
  have no relationship with the people who do.
- The extension hands Tor nothing about you. It sets a proxy address; what then
  flows is your browser's own traffic, exactly as it would be if you had typed
  that address into Microsoft Edge's settings yourself.
- Tor's design is what keeps any single relay from seeing both who you are and
  what you asked for. Its own documentation is at <https://www.torproject.org>.

## 7. What you control, and how

| If you want to | Do this |
| --- | --- |
| stop routing this browser | press **Disconnect**, in the popup or in the app |
| stop your location being changed | disconnect — pages get your real position again |
| put it aside for a while | switch it off at `edge://extensions` |
| remove it completely | **Remove** at `edge://extensions` |
| remove what it stored | remove the extension; Microsoft Edge deletes an extension's storage along with it |

Switching the extension off, or removing it, hands Microsoft Edge's proxy
setting back — the same as pressing Disconnect. Switching it off leaves the five
values in section 3 in your profile until you remove it; removing it takes them
with it. Neither exists anywhere else, because neither was ever sent anywhere
else.

You are never obliged to use this extension at all. The desktop app routes the
whole PC on its own. The extension exists for the two things the app cannot do
from outside the browser: make the location a website reads match the country
you picked, and let you drive the app without leaving the browser.

## 8. Children

This is a networking tool for adults and is not directed at children. It has no
account, no profile, no social feature, no messaging and no user-generated
content, and it collects nothing from anybody — so there is nothing it could
knowingly collect from a child under 13 either.

## 9. Changes to this policy

If the extension ever begins doing something this policy does not describe, the
policy is updated in the same release and the effective date at the top changes
with it. The version that applies to you is the one linked from the extension's
store listing at the time you installed or last updated it, and its whole
history is public in the repository, commit by commit.

If a future version ever needed to collect anything at all, that would mean a
new permission and a fresh consent from you — not a quiet edit here.

## 10. Who this is, and how to reach them

The extension and the FreeProxy VPN desktop app are written and published by
**Asifuzzaman Asif** (GitHub: [@Zero-Asif](https://github.com/Zero-Asif)) as a
free and open-source project.

- Source code, for both the app and this extension:
  <https://github.com/Zero-Asif/FreeVPN-PC-App>
- Questions, privacy requests, bug reports:
  <https://github.com/Zero-Asif/FreeVPN-PC-App/issues>

Because nothing about you is collected, there is no data of yours to show you,
correct, export or erase on request: the honest answer to a subject-access
request here is that we hold nothing. Everything this extension knows is in your
own browser profile, it is listed in section 3, and it is under your control at
`edge://extensions`.

---

*This policy covers the FreeProxy VPN Extension for Microsoft Edge, version
1.2.0. The FreeProxy VPN desktop application for Windows is covered separately
by [`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md) in the same repository.*

