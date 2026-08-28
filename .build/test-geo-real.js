'use strict';
// ════════════════════════════════════════════════════════════════════
//  Attempt 6. The one question left, and the reason the previous five
//  could not answer it:
//
//      Control B -- "a stored per-site ALLOW is honoured" -- kept
//      FAILING, because a grant hand-written into Preferences is inert
//      no matter how fresh its timestamps are. With an inert ALLOW,
//      cell D ("policy vs stored ALLOW") was only ever measuring policy
//      vs nothing, so its `denied` meant nothing.
//
//  So the grant is created through Chromium's OWN permission manager
//  over CDP (Browser.setPermission) instead of by editing JSON. That is
//  a genuine content setting, indistinguishable from the user clicking
//  Allow -- which is how the real ipleak.net/google.com entries in this
//  machine's Chrome and Brave profiles got there.
//
//  Browser.close (not taskkill) ends each run, so Preferences is
//  flushed and the grant survives into the next cell.
//
//    B  no policy, genuine ALLOW                 -> granted  (control, at last)
//    C  default=2, no exception                  -> denied   (the Edge case)
//    D  default=2, genuine ALLOW                 -> ??       THE QUESTION
//    E  default=2 + GeolocationBlockedForUrls=*  -> denied   THE PROPOSED FIX
//
//  D granted => the policy default alone is NOT enough, and the stale
//               ALLOW entries in Chrome/Brave are exactly why those two
//               still reported Dhaka while Edge showed Luxembourg.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const PORT = 19099;
const DBG  = 19222;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PATTERN = `http://127.0.0.1:${PORT},*`;
const CMD = path.join(__dirname, 'geo-cmd.json');
const ACK = path.join(__dirname, 'geo-ack.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BROWSERS = [
    { name: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Brave',  exe: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
    { name: 'Edge',   exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
];

const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><body>
<script>
(async function(){
  var out={};
  try{ out.state=(await navigator.permissions.query({name:'geolocation'})).state; }
  catch(e){ out.state='QUERY_THREW'; out.msg=String(e&&e.message); }
  try{ await fetch('/r',{method:'POST',headers:{'Content-Type':'application/json'},
                         body:JSON.stringify(out)}); }catch(e){}
})();
</script></body>`;

let pending = null;
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/r') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            res.writeHead(204).end();
            let o; try { o = JSON.parse(body); } catch (e) { o = { state: 'BAD_JSON' }; }
            if (pending) { const f = pending; pending = null; f(o); }
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                         'Cache-Control': 'no-store' }).end(PAGE);
});

// ── elevated registry helper ────────────────────────────────────────
let seq = 0;
async function tell(cmd) {
    seq += 1;
    fs.writeFileSync(CMD, JSON.stringify({ seq, ...cmd }), 'utf8');
    for (let i = 0; i < 300; i++) {
        await sleep(100);
        try { const a = JSON.parse(fs.readFileSync(ACK, 'utf8')); if (a.seq === seq) return a; }
        catch (e) {}
    }
    throw new Error('helper did not acknowledge ' + seq);
}
async function startHelper() {
    try { fs.unlinkSync(ACK); } catch (e) {}
    try { fs.unlinkSync(CMD); } catch (e) {}
    const script = path.join(__dirname, 'geo-regd.js');
    execSync('powershell -NoProfile -Command "Start-Process -FilePath \'node\' ' +
             `-ArgumentList '\\"${script}\\"' -Verb RunAs -WindowStyle Hidden"`,
             { windowsHide: true, stdio: 'pipe' });
    for (let i = 0; i < 600; i++) {
        await sleep(100);
        try { const a = JSON.parse(fs.readFileSync(ACK, 'utf8')); if (a.ready) return a; } catch (e) {}
    }
    throw new Error('helper never became ready (UAC declined?)');
}

// ── minimal CDP client over the browser-level endpoint ──────────────
async function cdpConnect(port) {
    let info = null;
    for (let i = 0; i < 100; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            info = await r.json();
            if (info.webSocketDebuggerUrl) break;
        } catch (e) {}
        await sleep(150);
    }
    if (!info || !info.webSocketDebuggerUrl) throw new Error('no CDP endpoint on ' + port);

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
    });

    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && waiting.has(m.id)) { const f = waiting.get(m.id); waiting.delete(m.id); f(m); }
    });
    const send = (method, params) => new Promise((res, rej) => {
        const my = ++id;
        waiting.set(my, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
        ws.send(JSON.stringify({ id: my, method, params: params || {} }));
        setTimeout(() => { if (waiting.has(my)) { waiting.delete(my); rej(new Error(method + ' timed out')); } }, 15000);
    });
    return { send, close: () => { try { ws.close(); } catch (e) {} }, version: info.Browser };
}

// ── launches ────────────────────────────────────────────────────────
//  Plain launch: browser opens the probe page, reports, we close it
//  cleanly over CDP so Preferences is flushed.
async function run(exe, ud, { grant = false } = {}) {
    const child = spawn(exe, [
        '--headless=new', `--user-data-dir=${ud}`, `--remote-debugging-port=${DBG}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--disable-sync', 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });

    let cdp = null, out = { state: 'NO_CALLBACK' };
    try {
        cdp = await cdpConnect(DBG);

        if (grant) {
            //  A real content setting, written by Chromium's own permission
            //  manager -- the same path a user clicking "Allow" goes down.
            await cdp.send('Browser.setPermission', {
                origin: ORIGIN,
                permission: { name: 'geolocation' },
                setting: 'granted',
            });
        }

        const got = new Promise(res => { pending = res; });
        await cdp.send('Target.createTarget', { url: ORIGIN + '/' });
        out = await Promise.race([got, sleep(20000).then(() => ({ state: 'PAGE_TIMEOUT' }))]);
    } catch (e) {
        out = { state: 'CDP_FAILED', msg: e.message };
    }

    //  Clean shutdown -- this is what writes Preferences.
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    if (cdp) cdp.close();
    await sleep(1200);
    try { execSync(`taskkill /F /PID ${child.pid} /T`, { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
    await sleep(500);
    return out;
}

const prefsFile = ud => path.join(ud, 'Default', 'Preferences');
function geoExceptions(ud) {
    try {
        const prefs = JSON.parse(fs.readFileSync(prefsFile(ud), 'utf8'));
        return (((prefs.profile || {}).content_settings || {}).exceptions || {}).geolocation || {};
    } catch (e) { return null; }
}
const showEx = ud => { const e = geoExceptions(ud); return e === null ? '(no prefs)' : JSON.stringify(e); };

(async () => {
    console.log('starting elevated registry helper -- approve the UAC prompt if it appears...');
    const ready = await startHelper();
    if (!ready.elevated) { console.log('ABORT -- helper not elevated'); process.exit(2); }
    console.log('helper ready\n');

    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    const summary = {};

    for (const b of BROWSERS) {
        console.log('══ ' + b.name + ' ' + '═'.repeat(60 - b.name.length));
        if (!fs.existsSync(b.exe)) { console.log('  not installed\n'); continue; }

        const ud = path.join(os.tmpdir(), 'fpv-geo-' + b.name.toLowerCase());
        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
        fs.mkdirSync(ud, { recursive: true });

        const got = {};
        await tell({ policy: null });

        //  A -- virgin
        let r = await run(b.exe, ud);
        got.A = r.state;
        console.log(`  A  no policy,  no exception              -> ${String(r.state).padEnd(9)}want prompt   ` +
                    (r.state === 'prompt' ? 'PASS' : 'FAIL') + (r.msg ? '  [' + r.msg + ']' : ''));

        //  B -- genuine grant via Chromium's permission manager
        r = await run(b.exe, ud, { grant: true });
        got.B = r.state;
        console.log(`  B  no policy,  GENUINE ALLOW via CDP     -> ${String(r.state).padEnd(9)}want granted  ` +
                    (r.state === 'granted' ? 'PASS' : 'FAIL'));
        console.log(`       exceptions now in Preferences: ${showEx(ud)}`);

        const grantStuck = !!(geoExceptions(ud) || {})[PATTERN];
        if (!grantStuck) console.log('       WARNING: the grant did not persist to Preferences');

        //  C -- policy block, and the grant deliberately removed first
        const keep = JSON.parse(JSON.stringify(geoExceptions(ud) || {}));
        try {
            const p = JSON.parse(fs.readFileSync(prefsFile(ud), 'utf8'));
            delete p.profile.content_settings.exceptions.geolocation[PATTERN];
            fs.writeFileSync(prefsFile(ud), JSON.stringify(p), 'utf8');
        } catch (e) {}
        let ack = await tell({ policy: { def: 2 } });
        r = await run(b.exe, ud);
        got.C = r.state;
        console.log(`  C  default=2,  no exception              -> ${String(r.state).padEnd(9)}want denied   ` +
                    (r.state === 'denied' ? 'PASS' : 'FAIL'));
        console.log(`       registry: ${ack.state[b.name]}`);

        //  D -- policy block vs that same genuine grant, restored
        try {
            const p = JSON.parse(fs.readFileSync(prefsFile(ud), 'utf8'));
            p.profile.content_settings.exceptions.geolocation =
                Object.assign(p.profile.content_settings.exceptions.geolocation || {}, keep);
            fs.writeFileSync(prefsFile(ud), JSON.stringify(p), 'utf8');
        } catch (e) {}
        r = await run(b.exe, ud);
        got.D = r.state;
        console.log(`  D  default=2,  GENUINE ALLOW             -> ${String(r.state).padEnd(9)}   <<< THE QUESTION`);
        console.log(`       exceptions: ${showEx(ud)}`);

        //  E -- the proposed fix against that same grant
        ack = await tell({ policy: { def: 2, blockedUrls: ['*'] } });
        r = await run(b.exe, ud);
        got.E = r.state;
        console.log(`  E  default=2 + GeolocationBlockedForUrls -> ${String(r.state).padEnd(9)}want denied   ` +
                    (r.state === 'denied' ? 'PASS' : 'FAIL'));
        console.log(`       registry: ${ack.state[b.name]}`);

        await tell({ policy: null });
        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}

        const ok = got.A === 'prompt' && got.B === 'granted' && got.C === 'denied';
        console.log('  ' + '-'.repeat(58));
        console.log('  controls A/B/C: ' + (ok ? 'all PASS -- D and E are finally meaningful'
                                               : 'FAILED -- D and E still prove nothing'));
        if (ok) {
            console.log('  D = ' + got.D + (got.D === 'granted'
                ? '   a real stored ALLOW DOES beat DefaultGeolocationSetting'
                : '    the policy default already wins on its own'));
            console.log('  E = ' + got.E + (got.E === 'denied'
                ? '    GeolocationBlockedForUrls ["*"] overrides a real stored ALLOW'
                : '   the proposed fix does NOT hold'));
        }
        summary[b.name] = got;
        console.log('');
    }

    console.log('══ summary ' + '═'.repeat(50));
    console.log(JSON.stringify(summary, null, 2));
    await tell({ op: 'quit' });
    console.log('\nhelper stopped; HKLM geolocation values cleared.');
    server.close();
    process.exit(0);
})().catch(async e => {
    console.log('THREW: ' + e.stack);
    try { fs.writeFileSync(CMD, JSON.stringify({ seq: 9999, op: 'quit' }), 'utf8'); } catch (e2) {}
    process.exit(1);
});
