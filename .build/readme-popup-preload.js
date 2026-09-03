'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/readme-popup-preload.js  --  the four `chrome.*` methods the
//  extension's own pages actually call, and nothing else.
//
//  WHY A STUB AT ALL
//  popup.html and welcome.html are ordinary pages; what they cannot do outside
//  a browser extension is talk to background.js. So this preload supplies the
//  message channel and NOTHING more. The list below was taken by grepping the
//  two scripts, not guessed -- if either page starts calling a fifth API, it
//  throws here instead of quietly painting a half-empty picture:
//
//    popup.js    runtime.getURL          flags/<cc>.svg out of this package
//                runtime.sendMessage     WAKE -> {state}, SEND_COMMAND -> {ok}
//                runtime.lastError       read after every sendMessage
//                runtime.onMessage       UI_UPDATE pushes
//    welcome.js  runtime.getManifest     the version in the footer
//                runtime.sendMessage     WELCOME_SEEN, WAKE
//                runtime.lastError, runtime.onMessage
//                tabs.getCurrent/remove  only on the "Got it" click
//
//  WHY THE STATE ARRIVES BY MESSAGE
//  popup.js declares its state with `let st = {...}` at the top level of a
//  classic script, so `st` lives in the script scope and is NOT a property of
//  window: nothing outside the file can assign it. That is a good thing, and it
//  is also the honest way to drive these pictures -- the harness puts a state
//  object here and lets the page's own poll() fetch it through the same WAKE
//  round trip it uses in production, so apply(), render() and refreshList() all
//  run exactly as they do in a browser.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

//  The page's own directory, from the page's own URL -- so the version in the
//  welcome footer is the version in the manifest sitting next to the page, and
//  this preload works for Extension/ and Extension-Store/package/ alike.
function pkgDir() {
    try { return path.dirname(decodeURIComponent(new URL(location.href).pathname).slice(1)); }
    catch (e) { return ''; }
}

let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(pkgDir(), 'manifest.json'), 'utf8')); }
catch (e) { manifest = {}; }

//  What WAKE answers with. The harness writes this, one shot at a time; the
//  shape is main.js's stateForWire() plus background.js's appRunning flag.
window.__fp = { state: null, sent: [], listeners: [] };

window.chrome = {
    runtime: {
        //  Real getURL returns an absolute chrome-extension:// URL. Absolute
        //  file: URL against the page is the same promise kept locally: a path
        //  inside this package, reachable with no network and no host
        //  permission, which is the whole point of shipping the flags.
        getURL: p => new URL(String(p), location.href).href,
        getManifest: () => manifest,
        sendMessage(msg, cb) {
            window.__fp.sent.push(msg && msg.type);
            if (typeof cb !== 'function') return;
            //  Synchronous on purpose: it makes a shot reproducible. The one
            //  thing that would be wrong to fake here is the CONTENT -- WAKE
            //  hands back whatever state the harness set, never an invented
            //  one, and a null state paints "app not running" because that is
            //  what background.js reports when the socket is down.
            if (msg && msg.type === 'WAKE') return cb({ state: window.__fp.state });
            cb({ ok: true });
        },
        onMessage: { addListener: fn => window.__fp.listeners.push(fn) },
        //  Left undefined, which is what Chrome does when nothing went wrong.
        //  Both pages read it after every send.
    },
    //  welcome.js only reaches these from the "Got it" button, which no shot
    //  clicks; they exist so the click handler is not a landmine.
    tabs: { getCurrent: cb => cb(null), remove: () => {} },
};
