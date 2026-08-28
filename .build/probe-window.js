'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-window.js  --  load the REAL index.html in the REAL renderer.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-window.js
//
//  Everything else about the globe change is proven statically: the five files
//  are hash-pinned, no document holds a remote tag, and the two bundles execute
//  under `vm`. None of that proves the globe still DRAWS -- a texture path that
//  resolves in Node can still 404 under file://, and "the globe renders black"
//  is exactly the failure the vendoring was supposed to prevent.
//
//  So this opens a window with the same webPreferences main.js uses, loads
//  index.html, and then looks at what actually happened:
//
//    * every network request the page attempts is recorded AND CANCELLED, so
//      the probe cannot itself phone home and the list is the honest answer to
//      "what does a launch reach for";
//    * the three earth textures are checked for a decoded bitmap, not just a
//      resolvable path;
//    * the framebuffer is captured and counted, so a black globe fails.
//
//  It does not start Tor, bind 8080, or touch the registry: it is the window
//  only. main.js is not loaded.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

//  PROBE_MODE picks what the window is told when it asks where the user is.
//  The lookup does not happen in the window any more, so the injection point is
//  no longer a protocol handler -- it is the two IPC channels main.js serves,
//  registered here and answered from memory. No mode reaches the network, and
//  in every mode the count of requests the window itself attempts must be zero:
//
//    blocked  (default) { ok:false, reason:'no-answer' } -- the lookup was made
//                       and all four providers failed
//    ok                 a well-formed answer
//    garbage            ok:true with a body carrying no usable coordinates
//    killswitch         the kill switch is restored ON, so the window must not
//                       ask the question at all, and the caption has to say
//                       THAT rather than blaming a lookup that never ran
//
//  The point is the same in all four: what the globe SAYS must be what it was
//  told. It used to caption a hard-coded Dhaka whenever the lookup failed, and
//  it reported a kill switch that was working correctly as a dead API.
const MODE = (process.env.PROBE_MODE || 'blocked').toLowerCase();
const BERLIN = { lat: 52.52, lng: 13.405, city: 'Berlin', country: 'Germany', cc: 'DE' };
const HOME_REPLY = {
    ok:         { ok: true,  reason: 'fresh',      loc: BERLIN },
    garbage:    { ok: true,  reason: 'fresh',      loc: { city: 'Nowhere', country: 'Nowhere', cc: 'ZZ' } },
    blocked:    { ok: false, reason: 'no-answer',  loc: null },
    killswitch: { ok: false, reason: 'killswitch', loc: null },
};

//  The country coordinates are LIFTED OUT OF main.js rather than written down
//  again here -- see .build/geo-from-main.js for why a third copy of that table
//  would be a hole in this probe rather than a convenience.
const { geoFromMainJs } = require('./geo-from-main.js');
const GEO_COORDS = geoFromMainJs(ROOT);
const SHOT = path.join(__dirname, `probe-globe-${MODE}.png`);


const net = [];          // every off-machine request the page tried to make
const logs = [];         // everything it printed
let failed = null;

//  Electron on Windows does not reliably reach the parent shell's stdout, so
//  every line also lands in a file the runner can read back.
const LOG = path.join(__dirname, 'probe-window.log');
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

let homeAsks = 0, geoAsks = 0, folderAsks = 0;

//  The country-unavailable dialog. `pendingAsk` is what main.js's
//  get-pending-ask would still have on the table, and `askAnswers` is every
//  answer the window sent back -- read off the MAIN process, so "the dialog can
//  be answered" is not a claim the page gets to make about itself.
let pendingAsk = null;
const askAnswers = [];

app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        net.push(d.method + ' ' + d.url);
        //  Cancelled in every mode now. There is nothing left for the window to
        //  ask the network for, so anything recorded here is a finding.
        cb({ cancel: true });
    });

    //  main.js is not running, so the channels the window depends on are served
    //  from here -- the same names, the same reply shapes as main.js:1165 and
    //  main.js:1183, including the two refusals that carry a reason.
    ipcMain.handle('get-geo-coords', async () => { geoAsks++; return GEO_COORDS; });
    ipcMain.handle('get-home-location', async () => {
        homeAsks++;
        return HOME_REPLY[MODE] || HOME_REPLY.blocked;
    });
    //  renderer.js reports the restored kill switch at startup; main does state
    //  only for it and changes nothing about the machine, so neither does this.
    ipcMain.handle('report-killswitch', async (e, v) => ({ status: 'noted', killSwitch: !!v }));
    //  The setup-toast link asks main.js to open the extension folder. Served
    //  here as a counter rather than left unregistered, so the click check reads
    //  "the renderer asked" off the main process instead of trusting the page,
    //  and no Explorer window opens during a probe run.
    ipcMain.handle('open-geo-ext-folder', async () => { folderAsks++; return { ok: true }; });
    //  The two ends of the ask channel, with main.js's own names and shapes.
    ipcMain.handle('get-pending-ask', async () => pendingAsk);
    ipcMain.on('ask-user-answer', (e, d) => { askAnswers.push(d); });

    //  The same options as main.js:981 -- nodeIntegration on, contextIsolation
    //  off. Probing a safer window than the app ships would prove nothing.
    const win = new BrowserWindow({
        width: 1000, height: 670, resizable: false, autoHideMenuBar: true,
        show: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false,
                          backgroundThrottling: false },
    });

    //  Electron moved console-message to a single details object; accept both
    //  shapes so this probe does not quietly stop reporting on an upgrade.
    win.webContents.on('console-message', (...a) => {
        const d = (a[0] && typeof a[0] === 'object' && 'message' in a[0])
            ? a[0]
            : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] };
        logs.push({
            level: String(d.level),
            message: String(d.message || ''),
            where: path.basename(String(d.sourceId || '')) + ':' + (d.lineNumber || 0),
        });
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
        failed = `did-fail-load ${code} ${desc} ${url}`;
    });
    win.webContents.on('render-process-gone', (e, d) => {
        failed = 'render process gone: ' + d.reason;
    });

    await win.loadFile(path.join(ROOT, 'index.html'));

    //  The kill switch is restored from localStorage by the page itself, and
    //  there is no way to seed that before a first load. So: load once, write
    //  the key, load again -- and zero the counters in between, so what gets
    //  asserted is what the SECOND window did, which is the one that came up
    //  with the switch already on. Exactly the sequence a user gets when they
    //  leave the kill switch on and reopen the app.
    if (MODE === 'killswitch') {
        await win.webContents.executeJavaScript("localStorage.setItem('killSwitch','true')", true);
        homeAsks = 0; geoAsks = 0; net.length = 0; logs.length = 0;
        const reloaded = new Promise(r => win.webContents.once('did-finish-load', r));
        win.webContents.reload();
        await reloaded;
    }

    //  globe-controller.js runs its enhance pass at +1800 ms and fades the night
    //  layer in after that, so a shorter wait would photograph an unfinished
    //  globe and call it black.
    await new Promise(r => setTimeout(r, 9000));

    const probe = await win.webContents.executeJavaScript(PROBE_SRC, true);
    const shot = await win.webContents.capturePage();

    //  Only now, with the photograph taken, are the controls clicked -- a toast
    //  sits over the globe half and would otherwise be counted as "the globe is
    //  painted".
    //
    //  This half of the probe exists because index.html's script-src stopped
    //  granting 'unsafe-inline'. Four things in this window used to be inline
    //  handlers and are addEventListener now, and a policy refusal is silent
    //  from the outside: the button simply does nothing. Static tests can only
    //  see that the attributes are gone. So the real toast is produced by
    //  renderer.js's own geo-ext-setup handler -- the shipped string, not markup
    //  written here -- and then clicked.
    win.webContents.send('geo-ext-setup',
        { browsers: ['Chrome'], auto: [], dir: path.join(ROOT, 'Extension') });
    await new Promise(r => setTimeout(r, 300));
    const clicks = await win.webContents.executeJavaScript(CLICK_SRC, true);
    clicks.folderAsks = folderAsks;

    //  ── the country-unavailable dialog ──────────────────────────────
    //  The engine STOPS on this question: it will not connect anywhere until an
    //  answer comes back. So the thing worth proving is not that a box appears,
    //  it is that the box can be answered -- over the real channel, by a real
    //  click, with the answer arriving in the main process.
    const A = {};
    win.webContents.send('ask-user', ASK_CHOICE);
    await new Promise(r => setTimeout(r, 400));
    A.up = await win.webContents.executeJavaScript(ASK_READ, true);
    A.clicked = await win.webContents.executeJavaScript(ASK_CLICK('auto'), true);
    await new Promise(r => setTimeout(r, 300));
    A.after = await win.webContents.executeJavaScript(ASK_READ, true);

    //  A close for a question that has already been replaced must not blank the
    //  one now on screen -- the "wait" card would vanish and leave the user
    //  looking at a connect that appears to have stopped happening.
    win.webContents.send('ask-user', ASK_LIVE);
    await new Promise(r => setTimeout(r, 300));
    win.webContents.send('ask-user-close', { id: ASK_CHOICE.id });
    await new Promise(r => setTimeout(r, 250));
    A.stale = await win.webContents.executeJavaScript(ASK_READ, true);
    win.webContents.send('ask-user-close', { id: ASK_LIVE.id });
    await new Promise(r => setTimeout(r, 250));
    A.gone = await win.webContents.executeJavaScript(ASK_READ, true);

    //  Reload-survival. A window that reloads while the engine is waiting must
    //  put the question back, or the answer can never be given.
    //
    //  The counters are put back to what the FIRST load left them at: this
    //  reload is the probe's own doing, and "asked once, not once per repaint"
    //  is a statement about the page, not about a reload requested from here.
    const homeWas = homeAsks, geoWas = geoAsks;
    pendingAsk = ASK_LIVE;
    const askReloaded = new Promise(r => win.webContents.once('did-finish-load', r));
    win.webContents.reload();
    await askReloaded;
    await new Promise(r => setTimeout(r, 900));
    A.restored = await win.webContents.executeJavaScript(ASK_READ, true);
    A.answers = askAnswers.slice();
    pendingAsk = null;
    homeAsks = homeWas; geoAsks = geoWas;

    //  Leave nothing behind. This window's localStorage is the same file://
    //  origin the real app uses, so a probe run that left killSwitch=true set
    //  would hand the next launch of the actual app a kill switch the user
    //  never turned on -- and it would then decline to look up their location
    //  and be right to.
    if (MODE === 'killswitch')
        await win.webContents.executeJavaScript("localStorage.removeItem('killSwitch')", true)
            .catch(() => {});
    report(probe, shot, clicks, A);
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});
//  Runs inside the page. `globe` and the renderer's helpers are top-level
//  bindings of classic scripts, so they resolve by name from here.
const PROBE_SRC = `(() => {
    const out = { maps: [], remote: [] };
    out.three   = window.THREE ? String(window.THREE.REVISION) : null;
    out.globeFn = typeof Globe;
    const c = document.querySelector('#ultimate-globe-container canvas');
    out.canvas  = c ? (c.width + 'x' + c.height) : null;
    try { out.gl = !!(c && (c.getContext('webgl2') || c.getContext('webgl'))); }
    catch (e) { out.gl = 'threw: ' + e.message; }

    //  A DECODED bitmap, not merely a path that resolved: three keeps the image
    //  it decoded on texture.image, so width > 0 means the file was really read
    //  off disk by the renderer.
    //
    //  Uniforms are walked as well as the named slots. The night layer is a
    //  ShaderMaterial now -- masked to the dark hemisphere instead of laid flat
    //  over the whole earth -- so its texture hangs off uniforms.uNight, and a
    //  probe that only knew about .map would have reported earth-night.jpg as
    //  never decoded while it was on screen.
    const g = (typeof globe !== 'undefined' && globe) ? globe : null;
    if (g && g.scene) g.scene().traverse(o => {
        for (const m of (o.material ? [].concat(o.material) : [])) {
            if (!m) continue;
            const slots = [];
            for (const k of ['map', 'bumpMap', 'specularMap']) if (m[k]) slots.push(m[k]);
            for (const u of Object.values(m.uniforms || {}))
                if (u && u.value && u.value.isTexture) slots.push(u.value);
            for (const t of slots) {
                const img = t.image;
                if (!img || !img.width) continue;
                const src = img.currentSrc || img.src ||
                            (String(img.tagName || '').toUpperCase() === 'CANVAS' ? 'canvas' : '?');
                const line = String(src).split('/').pop() + ' ' + img.width + 'x' + img.height;
                if (!out.maps.includes(line)) out.maps.push(line);
            }
        }
    });

    out.remote = [...document.querySelectorAll('[src],[href]')]
        .map(n => n.getAttribute('src') || n.getAttribute('href'))
        .filter(v => /^https?:/i.test(v || ''));
    out.overlay = (document.getElementById('status-overlay') || {}).textContent || null;

    //  What the globe believes about home, and whether it drew a marker for it.
    //  A ring at 0,0 for an unknown home is the failure this checks for.
    out.home = (typeof HOME_LOC !== 'undefined' && HOME_LOC)
        ? { lat: HOME_LOC.lat, lng: HOME_LOC.lng, name: HOME_LOC.name,
            code: HOME_LOC.code, known: HOME_LOC.known }
        : null;
    //  WHY it is unknown, which the caption now distinguishes, plus the anchor
    //  the flight logic hangs off and whether the toggle is actually showing on.
    out.homeWhy = (typeof HOME_WHY !== 'undefined') ? String(HOME_WHY) : null;
    out.anchor  = (typeof ANCHOR !== 'undefined' && ANCHOR)
        ? { kind: ANCHOR.kind, code: ANCHOR.code, placed: !!ANCHOR.placed } : null;
    out.pending = (typeof PENDING !== 'undefined' && PENDING) ? PENDING.code : null;
    const kel = document.getElementById('killSwitchToggle');
    out.ks  = kel ? !!kel.checked : null;
    //  The country table came over IPC from main.js, so there is exactly one of
    //  it. -1 means the window never got it and no ring could be placed.
    out.geo = (typeof GEO !== 'undefined' && GEO) ? Object.keys(GEO).length : -1;
    out.api = ['flyToCountry', 'landRocket', 'explodeRocket', 'backToHome']
        .filter(k => typeof window[k] !== 'function');
    try { out.rings = g && g.ringsData ? g.ringsData().length : -1; }
    catch (e) { out.rings = 'threw: ' + e.message; }

    //  The drawn country badge, exercised for real: the old one was an <img>
    //  from flagcdn, so "does it have a box and a gradient" is the check.
    if (typeof getFlagImg === 'function') {
        const d = document.createElement('div');
        d.innerHTML = getFlagImg('de');
        document.body.appendChild(d);
        const n = d.firstElementChild, r = n.getBoundingClientRect();
        out.badge = { text: n.textContent, box: Math.round(r.width) + 'x' + Math.round(r.height),
                      bg: getComputedStyle(n).backgroundImage.slice(0, 48) };
        d.remove();
    }
    return out;
})()`;

//  Also runs inside the page: clicks the four controls that stopped being inline
//  handlers when script-src dropped 'unsafe-inline', and reports what each one
//  actually did.
//
//  shell.openExternal is swapped for a recorder on the very module object
//  renderer.js destructured at line 1, so the code under test is the shipped
//  path and no browser opens. It is put back in a finally, because this window
//  keeps running until report() is done with it.
const CLICK_SRC = `(async () => {
    const out = { links: {}, opened: [], toasts: [], action: null, href: null };
    const sh = require('electron').shell;
    const realOpen = sh.openExternal;
    sh.openExternal = u => { out.opened.push(String(u)); return Promise.resolve(); };
    try {
        //  href stays "#" in the markup: a real remote href on an anchor in THIS
        //  window would be a navigation into a page with require().
        for (const id of ['verifyPrivacyBtn', 'torLinkBtn']) {
            const a = document.getElementById(id);
            out.links[id] = a
                ? { href: a.getAttribute('href'), ext: a.dataset.external || null }
                : 'missing';
            if (a) a.click();
        }

        //  The toast renderer.js built for the geo-ext notice, and the two
        //  generated controls inside it.
        const container = document.getElementById('toast-container');
        const count = () => container ? container.querySelectorAll('.toast').length : -1;
        out.toasts.push(count());
        const link = container && container.querySelector('.toast-action');
        out.action = link ? (link.dataset.action || '') : 'missing';
        if (link) link.click();
        out.toasts.push(count());                 // the action must not close it
        const close = container && container.querySelector('.toast-close');
        out.close = close ? close.type : 'missing';
        if (close) close.click();
        await new Promise(r => setTimeout(r, 20));
        out.toasts.push(count());                 // the × must

        out.href = location.href.split('/').pop();
    } finally { sh.openExternal = realOpen; }
    return out;
})()`;

//  ── the country-unavailable dialog ──────────────────────────────────
//  Both fixtures are the shape main.js really sends: askCountryUnavailable()
//  for the choice, waitForCapacity()'s gate for the live one. The wording is
//  trimmed, the option IDS are not -- the id is what travels back as the
//  answer, so a probe that made up its own would prove nothing about the real
//  channel.
const ASK_CHOICE = {
    id: 'probe-ask-1', variant: 'choice', cc: 'lu',
    title: 'No exit node available in Luxembourg',
    body: 'The live Tor relay list has no usable exit relay in Luxembourg right now, ' +
          'so no traffic can leave from there. Nothing has been connected.',
    note: 'Already tried: 2 relay(s) in Luxembourg failed the exit check.',
    options: [
        { id: 'auto', label: 'Connect me to the nearest country (Belgium, about 189 km away)',
          hint: 'The app verifies the Belgium exit for real before moving you there.' },
        { id: 'wait', label: 'Keep trying Luxembourg',
          hint: 'Nothing is connected while this runs.' },
        { id: 'cancel', label: 'Cancel -- do not connect at all',
          hint: 'This PC goes back to its normal connection.' },
    ],
};
const ASK_LIVE = {
    id: 'probe-ask-2', variant: 'live', cc: 'lu',
    title: 'Waiting for an exit node in Luxembourg',
    body: 'The app re-reads the live Tor relay list every 20 seconds and starts ' +
          'connecting the moment Luxembourg has one.',
    options: [{ id: 'stop', label: 'Stop waiting and cancel' }],
};

//  Reads the dialog the way a person looks at it: the computed display, the
//  measured box, the text that is actually in the nodes, and -- the part no
//  shim can answer -- what a click at the middle of the globe would hit.
//  async because the flag is decoded rather than merely pointed at: decode()
//  rejects on a missing file, which naturalWidth cannot tell apart from an
//  SVG that carries no intrinsic size.
const ASK_READ = `(async () => {
    const m = document.getElementById('ask-modal');
    if (!m) return { missing: true };
    const cs   = getComputedStyle(m);
    const box  = m.querySelector('.ask-box');
    const br   = box ? box.getBoundingClientRect() : { width: 0, height: 0 };
    const note = document.getElementById('ask-note');
    const dots = document.getElementById('ask-dots');
    const flag = document.getElementById('ask-flag');
    const img  = flag ? flag.querySelector('img') : null;
    const a    = document.activeElement;
    const gc   = document.getElementById('ultimate-globe-container');
    const gr   = gc ? gc.getBoundingClientRect() : null;
    const hit  = gr ? document.elementFromPoint(gr.left + gr.width / 2,
                                                gr.top + gr.height / 2) : null;
    const out = {
        open: m.classList.contains('open'),
        live: m.classList.contains('live'),
        display: cs.display,
        pointer: cs.pointerEvents,
        boxW: Math.round(br.width), boxH: Math.round(br.height),
        title: (document.getElementById('ask-title') || {}).textContent || '',
        body:  (document.getElementById('ask-body')  || {}).textContent || '',
        note:  note ? note.textContent : null,
        noteShown: !!(note && note.classList.contains('show')),
        dotsShown: !!(dots && dots.classList.contains('show')),
        foot: (document.getElementById('ask-foot-text') || {}).textContent || '',
        flagText: flag ? flag.textContent : null,
        flagSrc: img ? img.getAttribute('src') : null,
        flagOk: null,
        opts: [...document.querySelectorAll('#ask-options .ask-opt')].map(b => ({
            id: b.dataset.answer, cls: b.className, type: b.type,
            label: (b.querySelector('.ask-opt-label') || {}).textContent || '',
            hint:  b.querySelector('.ask-opt-hint')
                   ? b.querySelector('.ask-opt-hint').textContent : null,
            disabled: !!b.disabled,
        })),
        focus: a ? ((a.dataset && a.dataset.answer) || a.id || a.tagName) : null,
        hitCentre: hit ? (hit.id || hit.className || hit.tagName) : null,
        hitInModal: !!(hit && m.contains(hit)),
    };
    if (img) out.flagOk = await img.decode()
        .then(() => 'decoded ' + img.naturalWidth + 'x' + img.naturalHeight,
              e => 'FAILED ' + (e && e.name));
    return out;
})()`;

//  A real click, and on the LABEL inside the button: the listener is delegated
//  on #ask-options, so the event has to bubble up out of the span the way a
//  finger's does. Then two more, because clicked twice must still be decided
//  once -- the second answer would race the close.
const ASK_CLICK = id => `(() => {
    const b = document.querySelector('#ask-options .ask-opt[data-answer="${id}"]');
    if (!b) return { found: false };
    const state = () => [...document.querySelectorAll('#ask-options .ask-opt')]
        .map(x => !!x.disabled);
    const label = b.querySelector('.ask-opt-label') || b;
    label.click();
    const out = { found: true, afterFirst: state(),
                  open: document.getElementById('ask-modal').classList.contains('open') };
    label.click(); label.click();
    out.afterMore = state();
    return out;
})()`;
function report(p, shot, k, a) {
    console.log('── the window loaded at all ──');
    ok(!failed, 'no load failure and no renderer crash', failed);
    ok(p.three === '147', 'three.js in the real renderer is revision 147', String(p.three));
    ok(p.globeFn === 'function', 'globe.gl exposed Globe()', String(p.globeFn));
    ok(!!p.canvas, 'the globe built a canvas', String(p.canvas));
    ok(p.gl === true, 'with a live WebGL context', String(p.gl));

    console.log('\n── the earth textures came off disk, decoded ──');
    const named = n => p.maps.some(m => m.startsWith(n));
    for (const n of ['earth-blue-marble.jpg', 'earth-topology.png'])
        ok(named(n), `${n} decoded into the globe material`, p.maps.join(' | ') || 'no maps');
    ok(named('earth-night.jpg'), 'earth-night.jpg decoded and was added to the scene',
       p.maps.join(' | ') || 'no maps');

    console.log('\n── nothing in the live document points off the machine ──');
    ok(!p.remote.length, 'no element in the loaded DOM has an http(s) src or href',
       JSON.stringify(p.remote));
    const hosts = [...new Set(net.map(u => {
        try { return new URL(u.split(' ')[1]).hostname; } catch (e) { return u; }
    }))];
    ok(!hosts.length,
       'a launch reaches for nothing off the machine at all -- the one lookup ' +
       'the app makes moved into the main process, so this window has no ' +
       'remote host in its connect-src to reach even if it wanted to',
       JSON.stringify(hosts));
    console.log('       requests attempted (all cancelled): ' +
                (net.length ? net.join(', ') : 'none'));

    console.log('\n── the flight API and the one country table are in place ──');
    ok(!p.api.length, 'renderer.js finds every globe function it calls',
       JSON.stringify(p.api));
    ok(geoAsks >= 1, 'the window asked the main process for the country coordinates',
       String(geoAsks));
    ok(p.geo === Object.keys(GEO_COORDS).length,
       `and got all ${Object.keys(GEO_COORDS).length} of them, so there is one table and not two`,
       String(p.geo));
    ok(p.pending === null, 'nothing is mid-connect on a window that has just opened',
       String(p.pending));

    console.log(`\n── the home marker claims only what it was told (mode: ${MODE}) ──`);
    console.log('       overlay: ' + JSON.stringify(p.overlay));
    console.log('       home:    ' + JSON.stringify(p.home) + '  why: ' + p.homeWhy);
    console.log('       anchor:  ' + JSON.stringify(p.anchor) + '  killSwitch shown: ' + p.ks);
    if (MODE === 'ok') {
        ok(homeAsks === 1, 'the question was asked once, not once per repaint', String(homeAsks));
        ok(!!p.home && p.home.known === true && p.home.code === 'de',
           'an answering lookup is used as given', JSON.stringify(p.home));
        ok(/Standing by in Berlin, Germany/.test(p.overlay || ''),
           'the caption names the place it was told, and only that', String(p.overlay));
        ok(p.rings >= 1, 'and the "you are here" ring is drawn there', String(p.rings));
        ok(!!p.anchor && p.anchor.kind === 'home',
           'the flight anchor starts at home, so the first rocket launches from there',
           JSON.stringify(p.anchor));
    } else if (MODE === 'killswitch') {
        //  The whole point of this mode: the kill switch is the promise that
        //  nothing gets to grab an address off this device, and an
        //  IP-geolocation lookup is exactly such a grab. The old build made it
        //  anyway and then captioned the refusal as a dead API.
        ok(p.ks === true, 'the restored kill switch is showing as ON before the globe reads it',
           String(p.ks));
        ok(homeAsks === 0, 'the window did not ask where the user is -- not once',
           homeAsks + ' ask(s)');
        ok(!!p.home && p.home.known === false && p.homeWhy === 'killswitch',
           'home is unknown, and for that reason', JSON.stringify(p.home) + ' ' + p.homeWhy);
        ok(/[Kk]ill switch on/.test(p.overlay || '') &&
           !/unavailable|did not answer/i.test(p.overlay || ''),
           'and the caption says so instead of blaming a lookup that never ran',
           String(p.overlay));
        ok(p.rings === 0, 'no marker is drawn anywhere on the globe', String(p.rings));
        ok(p.anchor === null, 'and there is no anchor for a rocket to launch from',
           JSON.stringify(p.anchor));
    } else {
        //  blocked: nothing answered. garbage: an answer with no coordinates.
        //  Both used to become "Standing by in Dhaka, Bangladesh".
        ok(!!p.home && p.home.known === false,
           'a lookup that gives no usable position leaves home unknown', JSON.stringify(p.home));
        ok(/unavailable/i.test(p.overlay || '') && !/Dhaka|Bangladesh/.test(p.overlay || ''),
           'the caption says so instead of naming a city', String(p.overlay));
        ok(p.rings === 0, 'and no marker is drawn anywhere on the globe', String(p.rings));
        ok(p.anchor === null, 'with no anchor, so no rocket can launch from a guess',
           JSON.stringify(p.anchor));
    }

    console.log('\n── the country badge is drawn, with a real box ──');
    ok(!!p.badge, 'getFlagImg() exists in the app window', 'missing');
    if (p.badge) {
        ok(p.badge.text === 'DE', 'it renders the country code', p.badge.text);
        ok(p.badge.box === '22x15', 'at the size the list reserves for it', p.badge.box);
        ok(/linear-gradient/.test(p.badge.bg), 'as a gradient, not an image request', p.badge.bg);
    }
    console.log('\n── and it is not a black circle: the framebuffer ──');
    {
        const { width: w, height: h } = shot.getSize();
        const buf = shot.toBitmap();                       // BGRA
        //  capturePage reports DIPs; the buffer is device pixels. Derive the
        //  real stride instead of assuming a scale factor.
        const scale = Math.max(1, Math.round(Math.sqrt((buf.length / 4) / (w * h))));
        const W = w * scale, H = h * scale;
        let nonBg = 0, total = 0;
        const seen = new Set();
        for (let y = Math.floor(H * 0.12); y < Math.floor(H * 0.88); y += 2) {
            for (let x = Math.floor(W * 0.42); x < W; x += 2) {
                const i = (y * W + x) * 4;
                const b = buf[i], g = buf[i + 1], r = buf[i + 2];
                total++;
                //  #090b14 is the panel background the globe sits on.
                if (Math.abs(r - 9) + Math.abs(g - 11) + Math.abs(b - 20) > 26) {
                    nonBg++;
                    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
                }
            }
        }
        const pct = total ? (nonBg / total) * 100 : 0;
        ok(pct > 4, 'the globe half of the window is painted, not empty',
           pct.toFixed(1) + '% of sampled pixels differ from the background');
        ok(seen.size > 40, 'in many colours -- a textured earth, not a flat disc',
           seen.size + ' distinct colours');
        try {
            fs.writeFileSync(SHOT, shot.toPNG());
            console.log('       screenshot: ' + path.relative(ROOT, SHOT) +
                        `  (${W}x${H}, ${pct.toFixed(1)}% painted, ${seen.size} colours)`);
        } catch (e) { console.log('       could not write the screenshot: ' + e.message); }
    }

    console.log('\n── the four de-inlined controls, clicked for real ──');
    {
        //  script-src in this window no longer grants 'unsafe-inline', so the
        //  onclick= attributes these four used to carry would now be refused
        //  silently. What is asserted is the OUTCOME of a click, which is the
        //  only thing that tells the two apart.
        const L = k.links || {};
        for (const [id, want] of [['verifyPrivacyBtn', 'https://ipleak.net/'],
                                  ['torLinkBtn', 'https://www.torproject.org']]) {
            const a = L[id];
            ok(a && a.ext === want, `${id} carries ${want} as data-external`, JSON.stringify(a));
            ok(a && a.href === '#',
               'and its href stays "#", so no click can navigate this window into a page with require()',
               JSON.stringify(a));
            ok(k.opened.includes(want), 'clicking it hands that URL to shell.openExternal',
               JSON.stringify(k.opened));
        }
        ok(k.opened.length === 2, 'those two and nothing else', JSON.stringify(k.opened));
        ok(k.href === 'index.html', 'and the window is still on index.html afterwards',
           String(k.href));

        ok(k.action === 'open-geo-ext-folder',
           'the setup toast renderer.js built carries the folder link', String(k.action));
        ok(k.folderAsks === 1, 'and clicking it asks the main process to open the folder',
           k.folderAsks + ' ask(s)');
        ok(k.close === 'button',
           'the generated close control is a <button type=button>, not a bare anchor',
           String(k.close));
        const t = k.toasts || [];
        ok(t[0] >= 1, 'a toast is on screen before the ×', JSON.stringify(t));
        ok(t[1] === t[0], 'the folder link does not dismiss it', JSON.stringify(t));
        ok(t[2] === 0, 'and the × removes it', JSON.stringify(t));
    }

    console.log('\n── the country-unavailable question, asked and answered for real ──');
    {
        //  The engine STOPS on this question -- it connects nowhere until an
        //  answer comes back. So what is worth proving is not that a box
        //  appears, it is that the box on screen is the engine's own question
        //  and that a real click on it puts a real answer in the main process.
        const up = a.up || {}, after = a.after || {}, c = a.clicked || {};
        const stale = a.stale || {}, gone = a.gone || {}, back = a.restored || {};
        const answers = a.answers || [];
        const O = ASK_CHOICE.options;

        ok(up.open === true && up.display === 'flex',
           'the question main.js sent came up in the shipped window',
           up.open + ' / ' + up.display);
        ok(up.live === false && up.pointer !== 'none',
           'as a modal, because nothing is connected while it is up', String(up.live));
        ok(up.boxW > 400 && up.boxH > 150, 'with a measured box, not a zero-size node',
           up.boxW + 'x' + up.boxH);
        ok(up.title === ASK_CHOICE.title, 'showing the engine\'s own title', up.title);
        ok(up.body === ASK_CHOICE.body, 'and its body verbatim, invented nowhere in the page',
           up.body.slice(0, 60));
        ok(up.noteShown === true && up.note === ASK_CHOICE.note,
           'the note band carries what an earlier round already tried', String(up.note));
        ok(up.dotsShown === false,
           'and no "still working" dots on a question that is standing still', String(up.dotsShown));
        ok(/no country has been chosen for you/i.test(up.foot),
           'the footer says outright that nothing was picked on the user\'s behalf', up.foot);

        ok(up.flagText === 'LU' && up.flagSrc === 'vendor/flags/lu.svg',
           'the country is named by its code and its flag comes from the local folder',
           up.flagText + ' ' + up.flagSrc);
        ok(/^decoded/.test(String(up.flagOk)),
           'and that flag file really decoded off disk', String(up.flagOk));

        const ids = (up.opts || []).map(o => o.id).join(',');
        ok(ids === 'auto,wait,cancel',
           'one button per option the engine offered, in the engine\'s order', ids);
        ok(up.opts.length === 3 && up.opts.every(o => o.type === 'button'),
           'each a <button type=button>, so no click can submit or navigate anything',
           JSON.stringify(up.opts.map(o => o.type)));
        ok(up.opts.every((o, i) => o.label === O[i].label && o.hint === O[i].hint),
           'with the labels and hints main.js wrote, not a paraphrase',
           JSON.stringify(up.opts.map(o => o.label)));
        ok(/primary/.test(up.opts[0].cls) && !/danger/.test(up.opts[0].cls),
           'letting the app choose the nearest country leads', up.opts[0].cls);
        ok(/danger/.test(up.opts[2].cls) && !/primary/.test(up.opts[2].cls),
           'and cancelling is the one marked destructive', up.opts[2].cls);
        ok(up.opts.every(o => o.disabled === false),
           'every option is live before anything is pressed',
           JSON.stringify(up.opts.map(o => o.disabled)));
        ok(up.focus === 'auto',
           'focus is already on the first option, so the choice is answerable without a mouse',
           String(up.focus));
        ok(up.hitInModal === true,
           'and the modal covers the globe: nothing behind it can be clicked while the ' +
           'engine is blocked on this answer', String(up.hitCentre));

        ok(c.found === true, 'the option button is really there to be clicked', JSON.stringify(c));
        ok((c.afterFirst || []).length === 3 && c.afterFirst.every(Boolean),
           'the instant one is pressed, every option goes disabled',
           JSON.stringify(c.afterFirst));
        ok(after.open === false, 'the question comes off the screen', String(after.open));
        ok(JSON.stringify(answers) === JSON.stringify([{ id: ASK_CHOICE.id, answer: 'auto' }]),
           'and the MAIN process received that one answer, carrying the question\'s own id',
           JSON.stringify(answers));
        ok((c.afterMore || []).every(Boolean) && answers.length === 1,
           'two further clicks send nothing -- decided once, not once per click',
           answers.length + ' answer(s)');

        ok(stale.open === true && stale.live === true && stale.title === ASK_LIVE.title,
           'a close for the question that was already answered does not blank the ' +
           '"keep trying" card that replaced it',
           stale.open + ' / ' + stale.title);
        ok(stale.dotsShown === true && /Nothing is connected while this runs/.test(stale.foot),
           'that card shows itself as still working, and says nothing is connected meanwhile',
           stale.dotsShown + ' / ' + stale.foot);
        ok(stale.noteShown === false && stale.note === '',
           'with no note band, because the live card was sent without one', String(stale.note));
        ok((stale.opts || []).length === 1 && stale.opts[0].id === 'stop' &&
           /danger/.test(stale.opts[0].cls) && !/primary/.test(stale.opts[0].cls),
           'and a single Stop option, not styled as though it were a recommendation',
           JSON.stringify(stale.opts));
        ok(stale.pointer === 'none' && stale.hitInModal === false,
           'it leaves the globe visible and clickable behind it, because that wait runs ' +
           'for minutes', stale.pointer + ' / ' + String(stale.hitCentre));
        ok(gone.open === false, 'the matching close is the one that takes it down',
           String(gone.open));

        ok(back.open === true && back.live === true && back.title === ASK_LIVE.title,
           'a window that reloads while the engine is still waiting gets the question ' +
           'straight back from get-pending-ask, so the answer can still be given',
           back.open + ' / ' + back.title);
        ok((back.opts || []).length === 1 && back.opts[0].id === 'stop',
           'with its option intact after the reload', JSON.stringify(back.opts));
    }

    console.log('\n── what the page printed ──');
    {
        //  Expected noise: globe.gl bundles its own three (it did from the CDN
        //  too), and main.js is not running, so every channel except the three
        //  registered above has no handler. The request-failure patterns that
        //  used to be listed here are gone on purpose -- the window attempts no
        //  request now, so a net:: error is a finding, not noise.
        const EXPECTED = /Multiple instances of Three\.js|No handler registered/i;
        const bad = logs.filter(l => (l.level === 'error' || l.level === '3' ||
                                      l.level === 'warning' || l.level === '2') &&
                                     !EXPECTED.test(l.message));
        ok(!bad.length, 'no unexplained error or warning from the app\'s own scripts',
           bad.map(l => `[${l.where}] ${l.message}`).join(' | '));
        for (const l of logs.slice(0, 14))
            console.log(`       ${l.level} [${l.where}] ${l.message.slice(0, 120)}`);
        if (logs.length > 14) console.log(`       ... ${logs.length - 14} more`);
    }

    console.log('');
    console.log(`${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`${fail} FAILED`);
}

