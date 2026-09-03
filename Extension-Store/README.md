# Extension-Store — the Microsoft Edge Add-ons build

This folder is the **publishable** copy of the FreeProxy VPN browser extension,
kept apart from the one the app sideloads so that neither can break the other.

Nothing in the main project points at this folder. The desktop app installs
[`../Extension`](../Extension) into every browser exactly as it did before, and
it keeps doing that until the store id exists — see [Afterwards](#afterwards).

## Why there are two

They are not two extensions. They are one extension with two sets of paperwork.

| | [`../Extension`](../Extension) | [`package/`](package) |
| --- | --- | --- |
| How it gets installed | sideloaded by the desktop app's installer | user presses **Add** on the Edge Add-ons store |
| Who reads its wording | the person who installed the app | a Microsoft certification reviewer, first |
| Browsers | Chrome, Edge, Brave, Vivaldi, Opera… | Microsoft Edge |
| Status | **untouched — do not edit for store reasons** | edited for store policy only |

Some sentences that are true in the sideloaded build are false in a store build.
The installer did put that copy in your browser; nobody's installer put this one
there. Uninstalling the app does take that copy with it; it cannot take this one.
That is the entire reason this folder exists: to say the true thing in each
place, instead of one wording that is wrong in one of them.

## What is in here

```
Extension-Store/
  package/              <- THE EXTENSION. This is what gets zipped.
  build-zip.js          <- makes the upload; verifies it afterwards
  PRIVACY_POLICY.md     <- the URL the store listing must point at
  STORE-LISTING.md      <- every Partner Center field, paste-ready
  README.md             <- this file
  FreeProxy-VPN-Extension-<version>.zip   <- build output, not committed
```

Only `package/` is the extension. The paperwork sits outside it deliberately, so
that zipping the contents of `package/` cannot pick up a Markdown file and hand
the reviewer a question to ask.

## Exactly how it differs from `../Extension`

`diff -rq ../Extension package` is the whole answer, and it is four lines:

```
Only in package: icons
Files ../Extension/manifest.json and package/manifest.json differ
Files ../Extension/popup.html   and package/popup.html   differ
Files ../Extension/welcome.html and package/welcome.html differ
```

**All five JavaScript files are byte-identical** — `background.js`, `popup.js`,
`welcome.js`, `geo-spoof.js`, `geo-bridge.js`. One engine, verified with `cmp`,
not by inspection. No behaviour was changed to get published, and there is no
store-only code path anywhere. What changed:

- **`manifest.json`** — `version` 1.1.0 → 1.2.0; an `icons` block and a
  four-size `action.default_icon` (the store shows an icon; a sideload never
  had to). Permissions, host permissions, content scripts and
  `minimum_chrome_version` are unchanged.
- **`icons/`** — new: `icon-16`, `-32`, `-48`, `-128`. `icon.png` stays in the
  package as well, because `popup.html`, `welcome.html` and
  `background.js` (`chrome.runtime.getURL('icon.png')`, the install
  notification) all still ask for it by that name.
- **`welcome.html`** — wording. The browser is named as *Microsoft Edge*
  instead of *Chromium* (policy 1.1.2 forbids naming other browsers); the
  false "the app's installer put this here / removing the app removes it"
  claims are gone; the country-change data clearing has a card of its own,
  including that it signs you out of sites; links to the app download and the
  privacy policy. Plus the CSS for those links — the only style change.
- **`popup.html`** — three strings. The split-tunnel placeholder is
  `mybank.example; intranet.local` instead of two real brands (2.2); a stale
  code comment; and the footer now states what pressing the buttons changes
  (1.1.8). No layout, no colour, no font, no markup structure.

Design and behaviour are the current extension's, unchanged. That was the
requirement, and the diff above is what enforces it.

## Building the upload

```bash
node Extension-Store/build-zip.js
```

It writes `FreeProxy-VPN-Extension-<version>.zip` beside itself and then reads
the finished archive's central directory back to prove three things: that
`manifest.json` is at the root, that the entry list matches `package/` exactly,
and that no entry name contains a backslash.

That last check is not theoretical. PowerShell's `Compress-Archive` was tried
first and it stored `flags\ae.svg` and `icons\icon-16.png` — with backslashes,
which the zip format does not allow as a separator. Those are not files in
folders, they are files with a backslash in the name, so `flags/bd.svg` and the
manifest's `icons/icon-16.png` would both have been missing from an archive that
uploaded and installed perfectly. The zip is therefore written by hand with
`zlib`, and the bug is now an assertion.

Verified once by extracting the built zip with .NET and diffing the result
against `package/`: identical, byte for byte, all 87 files.

## Keeping the two in step

When you change something in `../Extension`, the JavaScript must stay
byte-identical here. After the change:

```bash
cd Extension-Store && for f in background.js popup.js welcome.js geo-spoof.js geo-bridge.js; do cmp -s "../Extension/$f" "package/$f" || echo "OUT OF STEP: $f"; done
```

Copy any file that reports, then re-run `build-zip.js` and bump
`package/manifest.json` → `version` before you resubmit. Partner Center refuses
a re-upload at a version it has already seen.

The three diverged files must **not** be copied over from `../Extension` — their
wording is the reason this folder exists. Merge the change by hand, in the store
copy's words.

## Submitting

[`STORE-LISTING.md`](STORE-LISTING.md) has every Partner Center field written
out to be pasted, each one tied to the policy clause it satisfies, and a
pre-submit checklist. Two items in it are blocking and are not code:

1. **This folder has to be on `main`** before you submit. The privacy-policy URL
   in the listing points at `main`, it is on `dev` today, and a reviewer who
   clicks a 404 rejects under policy 1.5.2.
2. **New screenshots**, taken in Microsoft Edge, of this extension, with no
   other browser and no third-party brand in frame (1.1.2, 2.2).

## Afterwards

The desktop app already contains the store-install route, written and switched
off, waiting for the one thing only Partner Center can supply — the extension's
id. It goes in [`../lib/geo-ext.js:327`](../lib/geo-ext.js#L327):

```js
const EDGE_STORE_ID = null;   // <- the 32-character id from Partner Center
```

Until that line has an id in it, Edge is served the sideloaded
[`../Extension`](../Extension) build, precisely as it is today. Publishing does
not change how any browser is handled; setting that constant does, and only for
Edge.

## What this folder does not do

It is not wired into anything. No file in `lib/`, `main.js`, `renderer.js` or
`.build/` reads it, and none should until the id above is set. Nothing here
installs, elevates, reboots, or writes outside this folder. `build-zip.js`
writes one zip, beside itself, and reads it back.
