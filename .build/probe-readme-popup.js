'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-readme-popup.js  --  the extension's pictures, reproducible.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-readme-popup.js
//  Out:  docs/media/2*.png, docs/media/3*.png   (overwritten, nothing else)
//
//  WHY A SECOND HARNESS
//  probe-readme-shots.js photographs the app window. It cannot photograph the
//  browser popup, because the popup is not part of the app: it is
//  Extension/popup.html, and the only thing it does not have here is
//  background.js on the other end of chrome.runtime. So this harness supplies
//  exactly that -- see readme-popup-preload.js, four methods, measured by
//  grepping the two pages -- loads the REAL popup.html, welcome.html, popup.js,
//  welcome.js and flags/*.svg out of the working tree, and drives each state
//  through the page's own WAKE round trip.
//
//  WHAT IS REAL AND WHAT IS A FIXTURE
//  Real: every pixel of markup, style and script; the flags; the manifest
//  version in the welcome footer; and the code path -- apply() -> render() ->
//  refreshList() runs here as it runs in Edge. Fixture: the country table and
//  the connected country (shared with the app-window harness through
//  readme-fixtures.js, so the two picture sets cannot contradict each other),
//  the pinned session clock, and the split-tunnel placeholder.
//
//  THE PLACEHOLDER, STATED OUT LOUD
//  popup.html:474 ships placeholder="e.g. bkash.com; bank.com.bd". Every shot
//  replaces it with two reserved example hosts, for the same reason the store
//  build does: a screenshot in a public README is project metadata, and someone
//  else's brand in it is a trademark question for no benefit. It is the ONE
//  thing in these images that is not byte-for-byte what the extension ships,
//  and docs/media/README.md records it.
//
//  WHAT IT DOES NOT DO
//  No browser is launched, no extension is installed anywhere, no port is
//  bound, no registry key is touched, the desktop app is never started. Every
//  request that would leave the machine is CANCELLED and counted; the count is
//  asserted to be zero at the end, because "the only address it opens is
//  127.0.0.1" has to be true of the pictures too.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const { SERVERS, SHOWN_CC, BYPASS_PLACEHOLDER, BYPASS_FILLED, SESSION_MS }
    = require('./readme-fixtures.js');
const { geoFromMainJs, haversineFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'docs', 'media');
const EXT  = path.join(ROOT, 'Extension');
const GEO  = geoFromMainJs(ROOT);          // main.js's own table, not a copy
//  Same number the app-window harness prints, from the same formula and the
//  same coordinates -- the two pictures show the same question.
const KM_BD_IN = Math.round(haversineFromMainJs(ROOT)(GEO.bd, GEO.in));
const PRELOAD = path.join(__dirname, 'readme-popup-preload.js');

const LOG = path.join(__dirname, 'probe-readme-popup.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = (...a) => {
    const line = a.join(' ');
    console.log(line);
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
};

let win = null, fail = 0, died = null, sawWake = false, electronNags = 0;
const netHits = [], consoleErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = js => win.webContents.executeJavaScript(js, true);

//  The state the popup is a view of: main.js stateForWire() (main.js:1440)
//  plus the appRunning flag background.js adds on top (background.js:1145).
//  `geo` comes out of main.js's GEO_COORDS for the connected country, exactly
//  as stateForWire() builds it -- city and accuracy included, because the
//  popup prints both and a made-up pair would be a made-up claim.
function wire(over) {
    const cc = (over && over.serverCode) || SHOWN_CC;
    const g  = GEO[cc.toLowerCase()];
    const connected = !!(over && over.connected);
    return Object.assign({
        appRunning: true,
        connected: false,
        busy: false,
        serverCode: cc,
        killSwitch: false,
        bypassList: '',
        servers: SERVERS,
        since: null,
        progress: null,
        ask: null,
        geo: connected && g ? {
            lat: g.lat, lng: g.lng, accuracy: g.accuracy, city: g.city, cc: cc.toUpperCase(),
        } : null,
    }, over || {});
}
//  ── the ask the popup can be holding ────────────────────────────────
//  Copied from main.js askCountryUnavailable() (main.js:2745-2780) with the
//  country filled in: the wording in the picture has to be the wording the app
//  sends, not a summary of it. Bangladesh because it is the two-exit country in
//  the fixture table -- the case where the one relay can be gone by the time
//  Connect is pressed is exactly what this question exists for.
const ASK_NO_EXIT = {
    id: 'ask-readme-1',
    variant: 'choice',
    cc: 'bd',
    title: 'No exit node available in Bangladesh',
    body: 'The live Tor relay list has no usable exit relay in Bangladesh right now, ' +
          'so no traffic can leave from there. Nothing has been connected.',
    options: [
        { id: 'auto',
          label: `Connect me to the nearest country (India, about ${KM_BD_IN} km away)`,
          hint: 'The app keeps looking for Bangladesh in the background and asks you ' +
                'before moving you there.' },
        { id: 'wait',
          label: 'Keep trying Bangladesh',
          hint: 'Nothing is connected while this runs. The app re-reads the live relay ' +
                'list and re-tests relays it had ruled out, until Bangladesh works.' },
        { id: 'cancel',
          label: 'Cancel -- do not connect at all',
          hint: 'The tunnel is taken back down and this PC goes back to its normal ' +
                'connection (or stays blocked, if the Kill Switch is on).' },
    ],
};
// ── the states, in the order the README uses them ────────────────────
//  `state` is what WAKE answers with. `after` runs once the page has taken it,
//  for the two things a state cannot express: a dropdown the user opened, and
//  a clock frozen so the image diffs cleanly.
const SHOTS = [
{
    page: 'popup', name: '20-popup-idle',
    what: 'the app is running, the tunnel is off -- and the popup says exactly that',
    state: wire({}),
},
{
    page: 'popup', name: '21-popup-countries',
    what: 'every exit country, its real flag out of the package, live exit counts',
    state: wire({}),
    //  The page's own click handler, not a class poked onto the element: it is
    //  what calls refreshList(), and a list painted any other way would be a
    //  list this code never built.
    after: async () => { await run(`document.getElementById('picked').click(); true`);
                         await sleep(500); },
},
{
    page: 'popup', name: '22-popup-connected',
    what: 'connected, with the coordinates this browser is handing to websites',
    state: wire({ connected: true, since: Date.now() - SESSION_MS.connected }),
    after: () => pinClock('00:41:12'),
},
{
    page: 'popup', name: '23-popup-connecting',
    what: 'the app\'s own bootstrap progress, carried into the popup, not invented here',
    //  main.js's real progress record: status 'connecting' is what makes the
    //  popup disable its controls, so the picture shows the locked state too.
    state: wire({ busy: true, progress: { status: 'connecting', percent: 62,
                  message: 'Loading relay descriptors...' } }),
},
{
    page: 'popup', name: '24-popup-controls',
    what: 'kill switch and split-tunnel exceptions, the same lists as the app',
    state: wire({ connected: true, since: Date.now() - SESSION_MS.controls,
                  killSwitch: true, bypassList: BYPASS_FILLED }),
    after: () => pinClock('01:07:35'),
},
{
    page: 'popup', name: '25-popup-app-off',
    what: 'the app is not running: inert, and it says so instead of pretending',
    //  null, not a doctored object: this is literally what background.js reports
    //  when the WebSocket to the app is down, and the popup derives every word
    //  of the picture from it.
    state: null,
},
{
    page: 'popup', name: '26-popup-asks',
    what: 'the app stops and asks rather than connecting you somewhere you did not pick',
    state: wire({ serverCode: 'bd', ask: ASK_NO_EXIT }),
},
{
    page: 'welcome', name: '30-welcome',
    what: 'the first-run page, with the live state of the app it depends on',
    state: wire({ connected: true, since: Date.now() - SESSION_MS.connected }),
},
];
// ── the mechanics ────────────────────────────────────────────────────
const PAGES = {
    //  340 px is popup.html's own body width; welcome.html is a full page whose
    //  .wrap caps at 720, so 800 leaves its side padding intact.
    popup:   { file: path.join(EXT, 'popup.html'),   width: 340 },
    welcome: { file: path.join(EXT, 'welcome.html'), width: 800 },
};

//  render() prints elapsed(Date.now() - st.since) once a second, so an unpinned
//  clock changes between runs and every regenerated image is a diff. elapsed()
//  is a top-level function declaration in a classic script, which means it IS a
//  property of window and can be replaced; the read-back below proves the
//  replacement took, rather than assuming it.
async function pinClock(txt) {
    await run(`window.elapsed = function () { return ${JSON.stringify(txt)}; };
               render(); true`);
    await sleep(1200);                       // let the 1 s render tick run once
    const got = await run(`document.getElementById('timer').textContent`);
    if (got !== txt) throw new Error(`the clock did not pin: timer reads ${JSON.stringify(got)}`);
}

//  Content-sized to the page, in two passes.
//
//  One pass is not enough, and the first run of this harness proved it: every
//  popup picture came out 699 CSS px tall -- the window's own height -- because
//  documentElement.scrollHeight never reports less than the viewport, so a
//  short popup measured as tall as whatever window it was already in and every
//  image carried a dead band of background under it. So the window is squeezed
//  to 200 px first, which forces the body box to be content-driven (welcome.html
//  sets min-height:100%, and 100% of 200 is out of the way), and only then
//  measured. .list is measured separately because it is position:absolute -- an
//  open country list hangs below the document and does not grow scrollHeight,
//  so a window left at the document height would cut it in half.
async function fit(width) {
    win.setContentSize(width, 200);
    await sleep(250);
    const h = await run(`(function () {
        var h = Math.ceil(document.body.getBoundingClientRect().height);
        var n = document.querySelector('.list');
        if (n && n.offsetParent !== null) h = Math.max(h, Math.ceil(n.getBoundingClientRect().bottom) + 14);
        return h;
    })()`);
    win.setContentSize(width, Math.max(200, Math.ceil(h)));
    await sleep(450);                        // one paint after the resize
    return h;
}

async function shoot(name) {
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, png);
    const bytes = fs.statSync(file).size;
    const size = img.getSize();
    //  A blank or half-painted capture is the failure this catches: every one of
    //  these surfaces is a dark card with text and a flag on it, and none of
    //  them compresses to under 8 KB.
    if (bytes < 8000) throw new Error(`${name}.png is only ${bytes} bytes -- nothing painted`);
    say(`  ok   ${name}.png  ${size.width}x${size.height}  ${Math.round(bytes / 1024)} KB`);
    return { name, width: size.width, height: size.height, bytes };
}
//  A fresh page per shot, so a dropdown left open or a question left up in one
//  picture cannot appear in the next one.
async function open(page) {
    const p = PAGES[page];
    if (!p) throw new Error(`unknown page ${page}`);
    win.setContentSize(p.width, 700);
    await win.loadFile(p.file);
    await sleep(300);
    return p;
}

//  The state goes in where background.js's answer would, and then the PAGE
//  fetches it -- poll() is the same function that runs every 1.5 s in a
//  browser, and it walks the same apply() -> render() -> refreshList() path.
async function feed(state) {
    await run(`window.__fp.state = ${JSON.stringify(state)}; poll(); true`);
    await sleep(400);
    //  Proof the picture is of the fed state and not of the page's own
    //  defaults: the page has to have come and asked for it.
    const asked = await run(`window.__fp.sent.indexOf('WAKE') >= 0`);
    if (!asked) throw new Error('the page never sent WAKE -- it is not reading the fed state');
    sawWake = true;
}

//  popup.html:474 names two real companies in its placeholder. Overridden in
//  every picture; see the header. render() never rewrites a placeholder, only a
//  value, so this sticks for the life of the page.
async function neutralPlaceholder() {
    await run(`(function () {
        var b = document.getElementById('bypass');
        if (b) b.placeholder = ${JSON.stringify(BYPASS_PLACEHOLDER)};
    })(); true`);
}

function report(made) {
    say('\n── what came out ──');
    for (const m of made)
        say(`   ${m.name.padEnd(20)} ${String(m.width) + 'x' + m.height}`.padEnd(40) +
            `${Math.round(m.bytes / 1024)} KB`);

    const check = (ok, good, bad) => { if (ok) say('  ok   ' + good); else { fail++; say('  FAIL ' + bad); } };
    check(made.length === SHOTS.length, `all ${SHOTS.length} states photographed`,
          `only ${made.length} of ${SHOTS.length} states photographed`);
    check(netHits.length === 0, 'no request left this machine',
          `${netHits.length} request(s) tried to leave: ${netHits.slice(0, 4).join(' | ')}`);
    check(consoleErrors.length === 0, 'no console errors in either page' +
          (electronNags ? `  (${electronNags} Electron dev-mode CSP notices about the harness, ignored)` : ''),
          `console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    check(!died, 'the pages stayed alive', `a render process died: ${died}`);
    //  The stub is only honest if the pages really did ask for their state
    //  through it. If WAKE never appeared, the pictures were painted from the
    //  page's own defaults and every state label in them is a guess.
    check(sawWake, 'every state arrived through the page\'s own WAKE round trip',
          'no WAKE was ever sent -- the pages were not reading the fed state');
}
// ── run it ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    //  Same posture as the app-window harness: anything that is not already on
    //  this disk is cancelled and counted. The extension's own promise is that
    //  the only address it opens is the app on 127.0.0.1, and a picture of it
    //  quietly pulling a web font would make that a false promise.
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        netHits.push(d.method + ' ' + d.url);
        cb({ cancel: true });
    });

    win = new BrowserWindow({
        width: 360, height: 700, show: true, frame: false, resizable: true,
        backgroundColor: '#0b0d17', useContentSize: true,
        webPreferences: {
            preload: PRELOAD,
            //  contextIsolation off so the preload's `chrome` lands on the same
            //  window object the pages read, which is where a real extension's
            //  chrome object is. nodeIntegration stays OFF: these are the
            //  extension's own pages and they must not gain an ability here
            //  that they do not have in a browser.
            contextIsolation: false, nodeIntegration: false, sandbox: false,
            backgroundThrottling: false,
        },
    });
    win.webContents.on('console-message', (e, level, message) => {
        //  Electron prints its own development-mode security advice into the
        //  page console -- "Insecure Content-Security-Policy", because this
        //  harness window has no CSP of its own. It is Electron talking about
        //  the harness, not the extension: popup.html runs under the CSP in
        //  manifest.json when it runs in a browser. Counted, not swallowed, so
        //  the number is visible in the report and a real error still fails.
        if (/Electron Security Warning/.test(message)) { electronNags++; return; }
        if (level >= 2) consoleErrors.push(message);
    });
    win.webContents.on('render-process-gone', (e, details) => { died = JSON.stringify(details); });

    const made = [];
    for (const s of SHOTS) {
        say(`── ${s.name}  --  ${s.what}`);
        try {
            const p = await open(s.page);
            await neutralPlaceholder();
            await feed(s.state);
            if (s.after) await s.after();
            await fit(p.width);
            made.push(await shoot(s.name));
        } catch (e) {
            fail++;
            say(`  FAIL ${s.name} threw  -- ${e && e.message || e}`);
        }
    }

    report(made);
    //  Eight pictures plus the five assertions report() makes about them.
    const total = SHOTS.length + 5;
    say(`\n  ${total - fail} passed, ${fail} failed.   out: ${OUT}`);
    say(`  log: ${LOG}`);
    win.destroy();
    app.exit(fail ? 1 : 0);
});


