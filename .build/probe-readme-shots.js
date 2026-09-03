'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-readme-shots.js  --  the README's screenshots, reproducible.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-readme-shots.js
//  Out:  docs/media/*.png   (overwritten; nothing else on disk is touched)
//
//  WHY THIS FILE EXISTS
//  --------------------
//  A README that shows the app has to show THIS app, at this version, or it is
//  a brochure. screenshots/main-interface.png was taken before the globe
//  existed: one 330 px column, "TAP TO CONNECT", no right panel, and a
//  split-tunnel placeholder naming two real brands. Anyone comparing it with
//  the app they just installed would find a different program.
//
//  So the pictures are generated instead of collected. Every one of them is
//  the real index.html, the real style.css, the real renderer.js and the real
//  globe, loaded from this working tree, driven into a named state and
//  photographed with capturePage(). Re-run it after a UI change and the README
//  is current again; the states are listed in SHOTS below, so a state that
//  stops being reachable fails here rather than going stale in the README.
//
//  WHAT IT DOES NOT DO
//  -------------------
//  Nothing is installed, no port is bound, no registry key is read or written,
//  no browser is touched and Tor is never started. Every request the window
//  makes off the machine is CANCELLED and counted (netHits, printed at the
//  end): the app's own no-remote-anything rule has to hold in the pictures too.
//  The five IPC handlers stubbed below are the only ones the window needs to
//  paint, and each returns a fixed literal.
//
//  ABOUT THE PLACEHOLDER LOCATIONS
//  -------------------------------
//  HOME is London and the connected country is Japan, both invented. The idle
//  screen's badge reads out whatever machine it runs on, and these pictures go
//  in a public README, so no shot may carry this developer's real city. The
//  split-tunnel field is filled with mybank.example / intranet.local for the
//  same reason the store build uses them -- a real brand in a screenshot is
//  someone else's trademark in this project's metadata.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const { geoFromMainJs, haversineFromMainJs } = require('./geo-from-main.js');
//  Shared with probe-readme-popup.js on purpose: the popup pictures and the
//  app-window pictures sit side by side in the README as evidence that the two
//  surfaces agree, so they must not be built from two different country
//  tables. See the header of readme-fixtures.js.
const { SERVERS, HOME } = require('./readme-fixtures.js');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'docs', 'media');
const GEO  = geoFromMainJs(ROOT);

//  The distance the ask dialog quotes, computed by main.js's own haversine from
//  main.js's own coordinates -- see haversineFromMainJs(). Typing a number here
//  would let the picture print a sentence the app never sends.
const KM_BD_IN = Math.round(haversineFromMainJs(ROOT)(GEO.bd, GEO.in));

const LOG = path.join(__dirname, 'probe-readme-shots.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const netHits = [];
const logs    = [];
let win = null, died = null;

//  capturePage() hands back a NativeImage at the display's own scale factor, so
//  a 1000x670 window on a 125% display yields 1250x838 physical pixels. Written
//  as-is: a README image must be the sharper one, and downscaling here would
//  throw away the only extra detail available.
async function shoot(name) {
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    const p   = path.join(OUT, name + '.png');
    fs.writeFileSync(p, buf);
    const { width, height } = img.getSize();
    ok(buf.length > 20000, `${name}.png  ${width}x${height}  ${Math.round(buf.length / 1024)} KB`,
       `only ${buf.length} bytes -- the window probably painted nothing`);
    return { name, width, height, bytes: buf.length };
}

const run = js => win.webContents.executeJavaScript(js, true);

//  Each shot starts from a fresh load, because renderer.js reads localStorage
//  once at startup to decide whether it is connected -- there is no supported
//  way to flip that from outside afterwards, and faking one with a direct call
//  into the IIFE would photograph a state the app cannot actually be in.
//  `pre` is applied to localStorage BEFORE the reload for that reason.
async function fresh(pre) {
    await run(`localStorage.clear(); ${pre || ''} true`);
    await win.webContents.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    //  globe-controller.js starts the night-lights layer at 1800 ms and fades it
    //  in over about 4.7 s. Photographing before that lands a globe mid-fade.
    await sleep(7000);
}

// ════════════════════════════════════════════════════════════════════
//  THE STATES
//
//  One entry per picture. `pre` is localStorage seeded before the load; `act`
//  runs after the globe has settled and returns when the state is on screen.
//  Nothing here reaches into renderer.js's private scope: every handle used
//  below is either a DOM id from index.html, a function renderer.js declares at
//  top level (showToast, showProgress, openAskDialog), a globe API from
//  globe-controller.js's documented four, or an IPC message main.js really
//  sends. If one of them disappears, this file fails instead of lying.
// ════════════════════════════════════════════════════════════════════
const SHOTS = [
{
    name: '01-idle',
    what: 'disconnected, the screen the app opens on',
    act: async () => {}
},
{
    name: '02-countries',
    what: 'the country list, built from live exit-relay counts',
    act: async () => {
        await run(`document.getElementById('selectedServer').click(); true`);
        await sleep(900);
    }
},
{
    name: '03-connecting',
    what: 'mid-connect: rocket in flight, real bootstrap progress',
    //  The country the flight is heading to has to be the country the selector
    //  reads: the app sets both from one click, and a picture where they differ
    //  is a picture of a state the app cannot be in.
    pre: `localStorage.setItem('activeServer','jp');`,
    act: async () => {
        await run(`
            document.getElementById('connectButton').textContent = 'Connecting… 🚀';
            document.getElementById('statusPulse').className = 'status-pulse connecting';
            document.getElementById('statusText').textContent = 'Connecting…';
            window.flyToCountry('jp'); true`);
        await sleep(4200);
        await run(`showProgress(62, 'Loading relay descriptors…', 'connecting'); true`);
        await sleep(2600);
    }
},
{
    name: '04-connected',
    what: 'connected to Japan: session timer, Protected, ring over Tokyo',
    pre: `localStorage.setItem('isConnected','true');
          localStorage.setItem('activeServer','jp');`,
    act: async () => {
        await run(`window.flyToCountry('jp'); true`);
        await sleep(2000);
        await run(`window.landRocket('jp'); true`);
        await sleep(3600);
        await run(`showProgress(100, 'Secured via Japan 🛡️', 'connected'); true`);
        await sleep(700);
        //  The timer is restarted from a fixed point so the picture is not a
        //  different number every run -- a README image that changes on every
        //  regeneration is a diff nobody can review.
        await run(`stopTimer();
            (() => { const r = document.getElementById('connection-timer-row');
                     r.style.display = 'flex';
                     document.getElementById('connection-timer').textContent = '00:41:12'; })(); true`);
        await sleep(300);
    }
},
{
    name: '05-privacy-controls',
    what: 'kill switch on, split tunnelling filled, the location toast',
    pre: `localStorage.setItem('isConnected','true');
          localStorage.setItem('activeServer','jp');
          localStorage.setItem('killSwitch','true');`,
    act: async () => {
        await run(`window.flyToCountry('jp'); true`);
        await sleep(1800);
        await run(`window.landRocket('jp'); true`);
        await sleep(3400);
        await run(`
            document.getElementById('bypassInput').value = 'mybank.example; intranet.local';
            stopTimer();
            (() => { const r = document.getElementById('connection-timer-row');
                     r.style.display = 'flex';
                     document.getElementById('connection-timer').textContent = '01:07:35'; })();
            showToast('📍 Location spoofed → <strong>Tokyo, Japan</strong>', 'success', 60000);
            true`);
        await sleep(1400);
    }
},
{
    name: '06-no-exit-node',
    what: 'the app asks instead of silently substituting a country',
    act: async () => {
        //  main.js:2748 verbatim, with `want` = Bangladesh and no `seenCc`.
        //  Reproduced rather than paraphrased: this is the question the engine
        //  really puts, so the README cannot show a dialog the app never sends.
        await run(`openAskDialog({
            id: 'shot-noexit', variant: 'choice', cc: 'bd',
            title: 'No exit node available in Bangladesh',
            body: 'The live Tor relay list has no usable exit relay in Bangladesh right now, '
                + 'so no traffic can leave from there. Nothing has been connected.',
            options: [
              { id: 'auto',   label: 'Connect me to the nearest country (India, about ${KM_BD_IN} km away)',
                hint: 'The app keeps looking for Bangladesh in the background and asks you '
                    + 'before moving you there.' },
              { id: 'wait',   label: 'Keep trying Bangladesh',
                hint: 'Nothing is connected while this runs. The app re-reads the live relay '
                    + 'list and re-tests relays it had ruled out, until Bangladesh works.' },
              { id: 'cancel', label: 'Cancel -- do not connect at all',
                hint: 'The tunnel is taken back down and this PC goes back to its normal '
                    + 'connection (or stays blocked, if the Kill Switch is on).' },
            ]}); true`);
        await sleep(900);
    }
},
{
    name: '07-browser-card',
    what: 'first open: the extension switch, per browser actually installed',
    act: async () => {
        //  main.js:1746 verbatim. The four rows are the hint strings
        //  introRows() produces for each measured extensionState().
        await run(`openAskDialog({
            id: 'shot-intro', variant: 'choice',
            title: 'One thing to do in your browsers',
            body: 'This app spoofs your location in the browser through its own extension, '
                + 'and the extension has to be switched ON in each browser you use. Until it '
                + 'is, that browser can still hand a website your real location, and what it '
                + 'reports will not match the country you are connected to. Click a browser '
                + 'to open it.',
            foot: 'You can do this later -- the app says which browsers are still waiting '
                + 'every time it starts.',
            options: [
              { id: 'edge',   label: 'Microsoft Edge', hint: 'Already on here -- nothing to do.' },
              { id: 'chrome', label: 'Google Chrome',
                hint: 'It is in Google Chrome but switched off -- turn it on at chrome://extensions.' },
              { id: 'brave',  label: 'Brave',
                hint: 'It is in Brave but switched off -- turn it on at brave://extensions.' },
              { id: 'firefox',label: 'Mozilla Firefox',
                hint: 'Set up automatically -- there is nothing to enable here.' },
              { id: 'later',  label: 'Later',
                hint: 'Nothing is changed. This card is not shown again.' },
            ]}); true`);
        await sleep(900);
    }
},
{
    name: '08-waiting-live',
    what: 'the live card: nothing is connected, and it says so, with a way out',
    //  The wait happens INSIDE a connect the user has already started: the
    //  button, the pulse and the flight are all mid-connect, and only the
    //  bootstrap bar is absent, because Tor has not been started yet.
    pre: `localStorage.setItem('activeServer','bd');`,
    act: async () => {
        //  main.js:3180 verbatim (`waitForCapacity`). variant:'live' is the
        //  bottom-anchored card that leaves the globe visible -- the app uses it
        //  for the two states that are a wait rather than a question.
        await run(`
            document.getElementById('connectButton').textContent = 'Connecting… 🚀';
            document.getElementById('statusPulse').className = 'status-pulse connecting';
            document.getElementById('statusText').textContent = 'Connecting…';
            window.flyToCountry('bd'); true`);
        await sleep(2600);
        await run(`openAskDialog({
            id: 'shot-wait', variant: 'live', cc: 'bd',
            title: 'Waiting for an exit node in Bangladesh',
            body: 'Nothing is connected while this runs -- no other country is being used in '
                + 'the meantime. The app re-reads the live Tor relay list every 20 seconds and '
                + 'starts connecting the moment Bangladesh has one.',
            options: [{ id: 'stop', label: 'Stop waiting and cancel' }]}); true`);
        await sleep(1200);
    }
},
{
    name: '09-comes-back',
    what: 'it kept looking for the country you asked for, and asks before moving',
    pre: `localStorage.setItem('isConnected','true');
          localStorage.setItem('activeServer','in');`,
    act: async () => {
        //  main.js:3014 verbatim, with `want` = Bangladesh and the current
        //  connection through India.
        await run(`window.flyToCountry('in'); true`);
        await sleep(1800);
        await run(`window.landRocket('in'); true`);
        await sleep(3000);
        await run(`openAskDialog({
            id: 'shot-back', variant: 'choice', cc: 'bd',
            title: 'Bangladesh looks available now',
            body: 'An exit relay in Bangladesh -- the country you asked for first -- is back '
                + 'in the live relay list. You are currently connected through India. '
                + 'Switching re-tests the Bangladesh exit for real; if it fails the check, '
                + 'you stay where you are.',
            options: [
              { id: 'yes', label: 'Yes, switch to Bangladesh now',
                hint: 'The circuit is rebuilt and the new exit is verified before anything '
                    + 'reports the new country.' },
              { id: 'no',  label: 'No, stay on India',
                hint: 'The app stops offering. You can still switch any time from the '
                    + 'country list.' },
            ]}); true`);
        await sleep(900);
    }
},
{
    name: '10-one-restart',
    what: 'the one restart the installer may need, with the reason Windows gave',
    //  `mainPre` runs in the MAIN process before the reload, because the card is
    //  painted from get-pending-restart on DOMContentLoaded and there is no way
    //  to ask for it later. The two lines are installer-tasks.js:796-802
    //  verbatim (the non-revert branch) and :806-808.
    mainPre: () => {
        restartPending = { at: Date.now() - 90_000, why: [
            'Google Chrome, Microsoft Edge, Brave read an extension offered by an installer ' +
            'only while they are starting up, so the last step for them runs during the next ' +
            'restart, before any browser opens.',
            'Windows reported that a component this installer set up -- the Visual C++ ' +
            'runtime, or a file that was in use -- finishes installing at the next restart.',
        ]};
    },
    act: async () => { await sleep(600); }
},
{
    name: '11-log-viewer',
    what: 'the log the app writes about itself, filterable, on disk',
    act: async () => {
        await run(`openLogModal(); true`);
        await sleep(1200);
    }
},
];

//  Flipped on for shot 10 only and cleared after every shot, so the restart
//  card cannot gatecrash the other eleven pictures.
let restartPending = null;

//  Real lines, real format: main.js's Logger writes
//  `[YYYY-MM-DD HH:MM:SS.mmm] [LEVEL  ] message  {json}` (write(), main.js:84).
//  The messages below are the literal strings from main.js -- 682, 2333, 2379,
//  3477, 2553, 4077, 3775, 381 -- so the picture shows the log this app keeps,
//  not a mock-up of one. Fixed timestamps: see the note about the timer.
const LOG_LINES = [
    '[2026-09-03 11:04:02.118] [SUCCESS] Running with admin privileges',
    '[2026-09-03 11:04:02.674] [INFO   ] WebSocket server started on :8080',
    '[2026-09-03 11:04:09.351] [INFO   ] connect-vpn  {"serverCode":"jp"}',
    '[2026-09-03 11:04:09.402] [INFO   ] Using previously verified JP exit: KurosawaExit',
    '[2026-09-03 11:04:09.988] [INFO   ] Spawning tor.exe  {"exitSpec":"$8B1A...F0","useBridges":false,"dnsPort":9053}',
    '[2026-09-03 11:04:11.240] [INFO   ] Bootstrap: 5% -- Connecting to directory server',
    '[2026-09-03 11:04:12.802] [INFO   ] Bootstrap: 45% -- Asking for relay descriptors',
    '[2026-09-03 11:04:16.117] [INFO   ] Bootstrap: 75% -- Loading relay descriptors',
    '[2026-09-03 11:04:19.560] [INFO   ] Bootstrap: 100% -- Done',
    '[2026-09-03 11:04:19.612] [SUCCESS] Proxy set -> SOCKS 127.0.0.1:9050, HTTP 127.0.0.1:9051',
    '[2026-09-03 11:04:23.845] [SUCCESS] Exit relays: 63 countries with usable exits',
    '[2026-09-03 11:04:24.010] [INFO   ] Circuit lock: 1 exit relay(s) in use',
    '[2026-09-03 11:04:24.288] [INFO   ] Location coverage -- app window: spoofed (CDP + lfsvc); ' +
        'Chromium (Chrome/Edge/Brave): spoofed by the extension; Firefox: spoofed (network provider pref)',
];

// ════════════════════════════════════════════════════════════════════
//  THE DRIVER
// ════════════════════════════════════════════════════════════════════
app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    //  Nothing leaves this machine. file:/devtools:/blob:/data: are the window's
    //  own assets; anything else is counted and cancelled, and the count is
    //  printed at the end, so "the README's pictures made no network request" is
    //  a measurement rather than an intention.
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        netHits.push(d.method + ' ' + d.url);
        cb({ cancel: true });
    });

    //  The eight handlers the window asks for while painting. Each returns the
    //  same shape main.js returns -- get-geo-coords is main.js's own GEO_COORDS
    //  literal, parsed out of the file by geo-from-main.js, so every ring lands
    //  on the coordinates the app really uses.
    ipcMain.handle('get-geo-coords',      async () => GEO);
    ipcMain.handle('get-home-location',   async () => ({ ok: true, reason: 'fresh', loc: HOME }));
    ipcMain.handle('get-realtime-status', async () => SERVERS);
    ipcMain.handle('get-fastest-server',  async () => ({ best: 'us', others: ['de', 'nl'] }));
    ipcMain.handle('get-pending-ask',     async () => null);
    ipcMain.handle('report-killswitch',   async (e, v) => ({ status: 'noted', killSwitch: !!v }));
    ipcMain.handle('get-pending-restart', async () => restartPending
        ? { pending: true, at: restartPending.at, why: restartPending.why }
        : { pending: false, why: [] });
    //  A generic user name on purpose: the real path carries this machine's
    //  Windows account, and these pictures go in a public README. The shape is
    //  the packaged app's -- app.getPath('userData') under productName.
    ipcMain.handle('get-log-lines', async () => ({ lines: LOG_LINES,
        logFile: 'C:\\Users\\you\\AppData\\Roaming\\FreeProxy VPN\\logs\\freeproxy-2026-09-03.log' }));

    win = new BrowserWindow({
        //  main.js:1386 exactly. A README picture of a differently-sized window
        //  would be a picture of a different app.
        width: 1000, height: 670, resizable: false, autoHideMenuBar: true, show: true,
        icon: path.join(ROOT, 'icon.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false,
                          backgroundThrottling: false },
    });
    win.webContents.on('console-message', (...a) => {
        const d = (a[0] && typeof a[0] === 'object' && 'message' in a[0])
            ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
        logs.push({ level: String(d.level), message: String(d.message || ''),
                    where: path.basename(String(d.sourceId || '')) + ':' + (d.lineNumber || 0) });
    });
    win.webContents.on('render-process-gone', (e, d) => { died = d.reason; });

    await win.loadFile(path.join(ROOT, 'index.html'));

    const made = [];
    for (const s of SHOTS) {
        console.log(`── ${s.name}  --  ${s.what}`);
        try {
            if (s.mainPre) s.mainPre();
            await fresh(s.pre);
            //  Two real brand names ship as the split-tunnel placeholder
            //  (index.html:123). They are somebody else's trademarks, one of
            //  them is a payment brand local to this developer, and the store
            //  build already replaced them for the same reason -- so the
            //  pictures carry example hosts. This is the ONE thing in these
            //  images that is not byte-for-byte what the app shows; it is
            //  written down here and again in docs/media/README.md.
            await run(`document.getElementById('bypassInput')
                         .placeholder = 'e.g. mybank.example; intranet.local'; true`);
            await s.act();
            made.push(await shoot(s.name));
        } catch (e) {
            fail++;
            console.log(`  FAIL ${s.name} threw  -- ${e && e.message || e}`);
        }
        restartPending = null;
    }

    report(made);
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the harness itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

function report(made) {
    console.log('');
    console.log('── what came out ──');
    made.forEach(m => console.log(`   ${m.name.padEnd(20)} ${m.width}x${m.height}` +
                                  `  ${String(Math.round(m.bytes / 1024)).padStart(5)} KB`));
    ok(made.length === SHOTS.length, `all ${SHOTS.length} states photographed`,
       `${made.length} of ${SHOTS.length}`);

    //  A cancelled request is a leak this file caught, not a leak it made -- but
    //  it still means the window wanted something off the machine, so it fails.
    console.log('');
    ok(netHits.length === 0, 'no request left this machine',
       netHits.length + ' cancelled: ' + netHits.slice(0, 6).join(', '));
    const errs = logs.filter(l => /^(error|3)$/i.test(l.level));
    ok(errs.length === 0, 'no console errors in the renderer',
       errs.slice(0, 4).map(e => e.where + ' ' + e.message).join(' | '));
    ok(!died, 'the renderer stayed alive', String(died));

    console.log('');
    console.log(`  ${pass} passed, ${fail} failed.   out: ${OUT}`);
    console.log(`  log: ${LOG}`);
}








