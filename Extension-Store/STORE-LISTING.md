# Microsoft Edge Add-ons submission — FreeProxy VPN Extension

Every field Partner Center asks for, written out so it can be pasted rather than
improvised, and each one tied to the policy clause it exists to satisfy. Policy
numbers refer to the *Microsoft Edge Add-ons developer policies* at
<https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies>.

The package to upload is the **contents** of [`package/`](package) — zipped so
that `manifest.json` sits at the root of the zip, not inside a folder. Run
[`build-zip.js`](build-zip.js) and it does exactly that.

---

## 0. Do these first — the submission fails without them

**0.1 Push this folder to `main`.** The privacy-policy URL below points at
`main`. It is on branch `dev` today, so the URL **404s right now**, and policy
1.5.2 requires a policy that is reachable and product-relevant at the time of
submission. A reviewer who clicks a 404 rejects on that alone. Verify by opening
the URL in a private window before you submit:

```
https://github.com/Zero-Asif/FreeVPN-PC-App/blob/main/Extension-Store/PRIVACY_POLICY.md
```

**0.2 Take new screenshots.** The ones in `screenshots/` are of the desktop app
and show third-party brand names in the split-tunnel field. Policy 2.2 wants
metadata you own or are licensed for, and 1.1.2 wants screenshots that are clear
and render properly. Specification is in section 5 below.

**0.3 Have the desktop app installed and running on the machine you submit
from,** and read section 2 before you paste it — a reviewer who cannot make the
extension do anything rejects under 1.3 ("product is testable") and 1.1.3 ("fully
functional"). Section 2 is what stops that happening.

---

## 1. Listing text

### Product name (Partner Center: *Name*)

```
FreeProxy VPN Extension
```

23 characters. Identical to `manifest.json` → `name`, which is what 1.1.2 wants:
the listing and the package must not disagree.

### Short description (Partner Center: *Short description*, 132 char limit)

```
Routes this browser through the FreeProxy VPN Tor engine and reports the connected country's location instead of your real one.
```

127 characters — the same string as `manifest.json` → `description`, deliberately,
so there is nothing for a reviewer to reconcile.

### Description (the long one)

Paste the block below as-is. Every paragraph in it is load-bearing: the first
answers 1.1.1 (single purpose), the "You need the desktop app" section answers
1.2.3 (a dependency on other software is allowed **but must be disclosed in the
description**) and 1.4.1 (an incompatible device must be told what it needs), and
the "What it changes in your browser" section answers 1.1.8 (altering browser
settings must be disclosed in the listing and be easily reversible) and 1.5.1
(data-handling practices stated at install). Do not trim it for brevity — every
removed sentence is a rejection reason returned.

```text
FreeProxy VPN Extension is the browser half of FreeProxy VPN, a free and
open-source VPN app for Windows 10 and 11. The app routes your PC through the
Tor network. This extension does the two things the app cannot do from outside
the browser: it points this browser at the app's engine, and it makes the
location websites read match the country you connected to.

YOU NEED THE FREEPROXY VPN DESKTOP APP
This extension does nothing on its own. It has no VPN, no proxy and no server
of its own -- it is a controller for the FreeProxy VPN desktop app running on
the same Windows PC, and it talks to it over a loopback connection to
127.0.0.1 that never leaves your machine. Without the app installed and
running, the extension tells you so and stays inert. The app is free and open
source, Windows 10/11 only, and is at:
https://github.com/Zero-Asif/FreeVPN-PC-App

WHAT IT DOES
- Connect, disconnect and switch between countries from the toolbar, in sync
  with the app window in both directions.
- Reports the connected country's coordinates to sites that ask for your
  position through the standard geolocation API, instead of your real one.
  Windows works your position out from the Wi-Fi networks around you, which no
  proxy can change -- so this part has to be done in the browser.
- Kill switch and split-tunnel exceptions, the same lists as the app.

WHAT IT CHANGES IN YOUR BROWSER, AND HOW TO UNDO IT
- Proxy: while you are connected, the extension sets this browser's proxy to
  the app's local Tor listener on 127.0.0.1, honouring the split-tunnel
  exceptions you set. Microsoft Edge shows you that an extension is
  controlling the setting. It is handed back when you press Disconnect, when
  the app stops running, when the last browser window closes, and when you
  switch the extension off or remove it at edge://extensions.
- Reported location: while connected, pages that ask for your position get the
  connected country's coordinates. Your real position is never read, stored or
  sent anywhere -- it is simply not passed on.
- Clearing on a country change: when you switch to a DIFFERENT country, the
  extension clears this browser's cache, cookies and history, and the stored
  site data of the sites that had been given the country you are leaving.
  Because cookies are cleared, you are signed out of sites you were signed in
  to. This is deliberate and it is the point: sites remember a location
  outside the geolocation API too -- Google keeps it in a cookie -- so without
  this step a site keeps reporting the country you just left. It happens only
  on a country change; never on an ordinary disconnect, never on a schedule,
  never in the background. If you would rather it did not happen, stay on one
  country or switch the extension off.

PRIVACY
No account, no login, no subscription, no ads, no analytics, no telemetry, no
crash reporting. The extension collects nothing and sends nothing to the
developer or to any third party. The only address it ever opens is
ws://127.0.0.1:8080 on your own PC. It loads no remote code. Full policy:
https://github.com/Zero-Asif/FreeVPN-PC-App/blob/main/Extension-Store/PRIVACY_POLICY.md

OPEN SOURCE
Both the app and this extension, in full:
https://github.com/Zero-Asif/FreeVPN-PC-App
```

Two things that block are **absent on purpose**, and should stay absent:

- **No other browser is named.** 1.1.2 says the listing "must not reference other
  browsers". There is no Chrome, Brave, Firefox or Chromium anywhere in the text
  above, and the store copy of `welcome.html` says *Microsoft Edge* where the
  sideloaded copy says *Chromium*.
- **No streaming service, and no "unblock".** Naming one invites 2.8
  (unauthorized access to website content) and a trademark question under 2.2,
  for no gain in a listing whose subject is location privacy.

---

## 2. Notes for certification

Partner Center: **Availability → Submission options → Notes for certification.**
This is the single most important field in the whole submission for an extension
like this one. 1.3 requires that *"all the steps required for testing the product
must be provided at the time of submission"*, and 1.3.1 puts test credentials and
instructions here. An extension that needs a Windows app to do anything will look
broken to a reviewer who does not have it — and "looks broken" is 1.1.3.

Paste the whole block. Replace the download link on line 3 of section 2 with the
link you have actually verified as downloadable (see checklist item 7.4).

```text
1. WHAT THIS EXTENSION IS
This is the browser-side controller for FreeProxy VPN, a free open-source VPN
application for Windows 10 and 11. The extension contains no VPN of its own. It
connects over a loopback WebSocket to ws://127.0.0.1:8080, which is the desktop
application running on the same PC, and it (a) sets this browser's proxy to the
application's local Tor listener on 127.0.0.1 while connected, and (b) reports
the connected country's coordinates to the geolocation API instead of the real
position. There is no server of ours anywhere; there is no account or login.

2. TO TEST IT YOU NEED THE DESKTOP APP -- IT IS FREE, NO ACCOUNT
Windows 10 or 11 required. Download and install:
  https://github.com/Zero-Asif/FreeVPN-PC-App/releases
Source for the app and for this extension:
  https://github.com/Zero-Asif/FreeVPN-PC-App
No credentials of any kind are needed. There is nothing to buy, register or
activate. The app is free and its whole source is public.

3. STEP-BY-STEP TEST
  a. Install and run the FreeProxy VPN desktop app on the test machine.
  b. Open the extension's popup from the toolbar. It shows the app's live
     state -- the same state as the app window.
  c. Pick a country from the list and press Connect. Expect: the app connects,
     and Microsoft Edge shows that an extension is controlling the proxy
     setting.
  d. Open https://ipleak.net or https://browserleaks.com/geo and allow the
     location prompt. Expect: the reported position is the country you chose,
     not the machine's real one.
  e. Press Disconnect. Expect: the proxy setting is handed straight back, and
     the same page now reports the real position again.

4. WHAT YOU SEE IF YOU DO NOT INSTALL THE APP
The extension is inert, and it says so rather than failing silently: the popup
reports that the desktop app is not running, no proxy is set, and no location
is changed. Its first-run welcome page states the same thing, names Windows
10/11 as the requirement, and links to the download. This is the intended
behaviour of a controller whose engine is absent, not a fault.

5. WARNING: SWITCHING COUNTRY CLEARS THIS BROWSER'S DATA
Please do this on a test profile. When the connected country CHANGES, the
extension clears this browser's cache, cookies and browsing history, plus the
local storage, IndexedDB, cache storage and service workers of the sites that
had been given the previous country. Clearing cookies signs the profile out of
any site it was signed in to. It is disclosed in the store description, on the
first-run welcome page, in the popup itself and in the privacy policy.
It is necessary: sites store a location outside the geolocation API as well --
Google keeps one in a cookie -- so without this a site keeps reporting the
country the user just left, which is the exact leak this extension exists to
close. It runs ONLY on a country change: never on an ordinary disconnect,
never on a schedule, never in the background.

6. WHY EACH PERMISSION IS REQUESTED (minimum set -- policy 1.6)
  proxy         Set this browser's proxy to the app's local Tor listener while
                connected, and release it on disconnect. This is the core
                function; there is no other API for it.
  storage       Five small local values only: the connected country's
                coordinates, the last location reported, the origins that were
                given a position, a "welcome page already shown" timestamp, and
                a marker recording that the proxy was left set. Never
                transmitted -- there is nowhere to transmit them to.
  tabs          Reload the tabs that were given the old country after a switch,
                and open the welcome page once on first run. Used for tab
                reloads and URLs only; page contents are never read.
  notifications One notification, once, on install, saying the extension is
                installed (policy 1.9). Nothing else ever notifies.
  cookies       Remove by name the one cookie MEASURED to carry a position
                (Google's UULE) so the previous country stops being sent in
                request headers. Cookies are removed, never read for content
                and never exported.
  browsingData  The country-change clear described in section 5.
  alarms        A 30-second watchdog that re-asserts the proxy setting while
                connected, and releases it if the app has gone. MV3 service
                workers are torn down when idle; without an alarm the browser
                could be left pointing at a listener that is no longer there.
  <all_urls>    The geolocation content script must run on any page that asks
                for a position, and the proxy applies to all traffic. It is not
                used to read, collect or alter page content: the content script
                replaces the geolocation API on the page and does nothing else.

7. DATA HANDLING (policy 1.5)
Nothing is collected. No name, e-mail, IP address, browsing history, page
content, keystroke, credential, cookie value, device identifier or advertising
identifier is read, stored off-device or transmitted. There is no telemetry, no
analytics and no crash reporting. No data is sold, licensed or shared with
anyone, and there is no data brokering (1.5.3), because no data ever leaves the
machine. The only network address the extension opens is ws://127.0.0.1:8080 --
loopback, to the user's own PC. Privacy policy:
https://github.com/Zero-Asif/FreeVPN-PC-App/blob/main/Extension-Store/PRIVACY_POLICY.md

8. CODE (policy 1.1.7 -- no obfuscation, no remote code)
Every line that runs is in the package. There is no fetch, no XMLHttpRequest,
no eval, no new Function and no importScripts anywhere in it: the source is
plain, unminified, commented JavaScript and can be read top to bottom. The two
HTML pages load nothing but their own local icon.png and their own local
script -- no remote stylesheet, no web font, no CDN, no @import, no url().
The files are background.js (the service worker and the app link), popup.js
(the toolbar UI), geo-spoof.js (replaces the page's geolocation API, MAIN
world), geo-bridge.js (passes the current country to it, ISOLATED world) and
welcome.js (the first-run page). The identical source is public at
https://github.com/Zero-Asif/FreeVPN-PC-App in the Extension-Store/package
folder, so the upload can be diffed against it line for line.

One clarification in case a text search raises it: background.js contains the
string http://127.0.0.1:8099 twice, both times inside a comment. It is the
address of a local test page in a note recording how a past bug was diagnosed.
No code opens it. The only address any code opens is ws://127.0.0.1:8080.
```

---

## 3. Search terms (Partner Center: *Search terms*, max 7 — policy 1.1.4)

```
vpn
proxy
tor
privacy
geolocation
location
ip
```

Seven exactly. No brand name and no service name: 1.1.4 caps the count, and a
streaming brand here would pull 2.2 and 2.8 into a review that currently has no
reason to consider either.

---

## 4. Privacy fields in Partner Center

| Field | Answer |
| --- | --- |
| Does your extension collect personal information? | **No** |
| Privacy policy URL | the `main` URL in section 0.1 — it must resolve before you submit |
| Does your extension use remote code? | **No** |
| Permissions justification | section 6 of the notes above |

---

## 5. Screenshots and logo

1.1.2 wants screenshots that are clear and render properly; 2.2 wants every
piece of metadata, screenshots included, to be original or licensed to you.

**Screenshots — 1 to 10, PNG, either 1280×800 or 640×400.** Shoot all of them
in **Microsoft Edge**, on this extension, at 100% display scaling:

1. The popup open over an ordinary page, disconnected — the idle state.
2. The country list open, showing the flags.
3. The popup connected to a country, with the connected state visible.
4. A location-checking page (`ipleak.net` or `browserleaks.com/geo`) reporting
   the connected country, with the popup beside it. This is the one that shows
   the value proposition, which 1.1.2 asks the first run to make clear.
5. Optional: the first-run welcome page, which is where the disclosures are.

Do not include, in any shot: another browser's window or logo (1.1.2), a
streaming service, a bank, or any third-party brand in the split-tunnel field —
the store copy's placeholder is already `mybank.example; intranet.local` for
exactly this reason. Do not include your own IP address or real location.

**Store logo — 300×300 PNG.** `package/icons/icon-128.png` upscaled is soft at
300px; export a clean 300×300 from the source artwork instead.

## 6. Category, availability, language

| Field | Answer |
| --- | --- |
| Category | Productivity (or Privacy & Security if offered) |
| Language | English (United States) |
| Markets | all, unless you have a reason to exclude one |
| Visibility | Public — but see 7.6 |
| Age rating | as prompted; there is no user-generated content and no ads |

---

## 7. Pre-submit checklist

Tick every line. Each one is a rejection that has a policy number attached.

1. `Extension-Store/` is pushed to `main` and the privacy-policy URL opens in a
   private window. **(1.5.2 — this is the one that 404s today.)**
2. The zip was built by `build-zip.js`, and `manifest.json` is at its **root**.
3. `manifest.json` → `version` is higher than the last version you submitted.
   Partner Center refuses a re-upload at the same version.
4. The app download link in note 2 actually downloads on a machine that has
   never seen this project. **(1.3.2 — the reviewer's download must work.)**
5. You have run the section 3 test yourself, in Edge, on a clean profile, from
   the zip you are about to upload — not from `Extension/`.
6. Screenshots are new, are of Edge, name no other browser and no third-party
   brand. **(1.1.2, 2.2.)**
7. The notes for certification are pasted in full, including the section 5
   warning about the country-change clear. **(1.3, 1.1.8.)**

8. The description block in section 1 is pasted **whole** — the dependency
   paragraph and the "what it changes" paragraph included. **(1.2.3, 1.1.8.)**
9. Nothing in the listing names another browser. **(1.1.2.)**
10. Search terms number seven or fewer. **(1.1.4.)**

---

## 8. After it is approved

The desktop app already has the store-install route written and switched off,
waiting for the one thing only Partner Center can give: the extension's store
id. Put the 32-character id in [`lib/geo-ext.js:327`](../lib/geo-ext.js#L327):

```js
const EDGE_STORE_ID = null;   // <- the id from Partner Center goes here
```

`FP_GEO_EDGE_STORE_ID` in the environment overrides it, which is the cheap way to
test the route once before committing the constant. Until that id is set, Edge
keeps getting the sideloaded [`Extension/`](../Extension) build exactly as it
does today — which is the arrangement you asked for, and nothing about it changes
by publishing.

## 9. If it is rejected anyway

Read the certification report itself before changing anything. It names the
policy number and usually the field, and the fix is almost always paperwork
rather than code — a screenshot, a sentence in the description, a note that was
not pasted. Change the listing, bump `version`, resubmit. Do not start editing
`package/` on a guess: it is a byte-for-byte copy of a build that works, and the
three files that differ from it are listed in [`README.md`](README.md).

