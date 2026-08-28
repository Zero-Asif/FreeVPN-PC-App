'use strict';
// ════════════════════════════════════════════════════════════════════
//  Attempt 5. Registry work is delegated to geo-regd.js running
//  elevated; the browsers stay UNELEVATED here, which is both what
//  attempt 4 got wrong and what production actually looks like.
//
//  Signal: navigator.permissions.query({name:'geolocation'}).state.
//  It reports the RESOLVED content setting without requesting anything,
//  so it is immune to headless prompt auto-denial and to whether the
//  network location provider can reach Google.
//
//  Cells, per browser. A-C are controls; if any fails, D and E are void.
//
//    A  no policy, no exception                  -> prompt
//    B  no policy, exception=ALLOW               -> granted
//    C  default=2, no exception                  -> denied   (the Edge case)
//    D  default=2, exception=ALLOW               -> ??       THE QUESTION
//    E  default=2 + GeolocationBlockedForUrls=*  -> denied   THE PROPOSED FIX
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const PORT = 19099;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PATTERN = `http://127.0.0.1:${PORT},*`;
const CMD = path.join(__dirname, 'geo-cmd.json');
const ACK = path.join(__dirname, 'geo-ack.json');

const chromiumNow = () => String((Date.now() + 11644473600000) * 1000);
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
  setTimeout(function(){ window.close(); },150);
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

// ── elevated helper ─────────────────────────────────────────────────
let seq = 0;
async function tell(cmd) {
    seq += 1;
    fs.writeFileSync(CMD, JSON.stringify({ seq, ...cmd }), 'utf8');
    for (let i = 0; i < 300; i++) {
        await sleep(100);
        try {
            const a = JSON.parse(fs.readFileSync(ACK, 'utf8'));
            if (a.seq === seq) return a;
        } catch (e) { /* mid-write */ }
    }
    throw new Error('elevated helper did not acknowledge command ' + seq);
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
        try {
            const a = JSON.parse(fs.readFileSync(ACK, 'utf8'));
            if (a.ready) return a;
        } catch (e) {}
    }
    throw new Error('elevated helper never became ready (UAC declined?)');
}

// ── profile ─────────────────────────────────────────────────────────
const prefsFile = ud => path.join(ud, 'Default', 'Preferences');

function setException(ud, setting) {
    const p = prefsFile(ud);
    if (!fs.existsSync(p)) return 'NO PREFS';
    const prefs = JSON.parse(fs.readFileSync(p, 'utf8'));
    prefs.profile = prefs.profile || {};
    prefs.profile.content_settings = prefs.profile.content_settings || {};
    const cs = prefs.profile.content_settings;
    cs.exceptions = cs.exceptions || {};
    cs.exceptions.geolocation = cs.exceptions.geolocation || {};
    if (setting === null) delete cs.exceptions.geolocation[PATTERN];
    else {
        //  Fresh last_modified AND last_visit: a stale grant gets swept by
        //  the unused-site-permission revocation before the page can ask,
        //  which is what made attempt 3's ALLOW cell read `prompt`.
        const now = chromiumNow();
        cs.exceptions.geolocation[PATTERN] = { last_modified: now, last_visit: now, setting };
    }
    fs.writeFileSync(p, JSON.stringify(prefs), 'utf8');
    return 'ok';
}

function readException(ud) {
    try {
        const prefs = JSON.parse(fs.readFileSync(prefsFile(ud), 'utf8'));
        const ex = (((prefs.profile || {}).content_settings || {}).exceptions || {}).geolocation || {};
        return ex[PATTERN] ? 'setting=' + ex[PATTERN].setting : 'absent';
    } catch (e) { return '?'; }
}

function launch(exe, ud) {
    return new Promise(resolve => {
        const child = spawn(exe, [
            '--headless=new', `--user-data-dir=${ud}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--disable-sync', ORIGIN + '/',
        ], { windowsHide: true, stdio: 'ignore' });

        let result = null, exited = false, settled = false;
        const done = () => { if (settled) return; settled = true;
                             clearTimeout(hard); resolve(result || { state: 'NO_CALLBACK' }); };
        //  Let it exit on its own -- the clean shutdown is what flushes
        //  Preferences. Force-kill is only a backstop.
        child.on('exit', () => { exited = true; setTimeout(done, 400); });
        pending = r => {
            result = r;
            setTimeout(() => {
                if (exited) return;
                try { execSync(`taskkill /F /PID ${child.pid} /T`, { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
                setTimeout(done, 400);
            }, 6000);
        };
        const hard = setTimeout(() => {
            try { execSync(`taskkill /F /PID ${child.pid} /T`, { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
            done();
        }, 30000);
        child.on('error', e => { result = { state: 'SPAWN_FAILED', msg: e.message }; done(); });
    });
}

const CELLS = [
    { id: 'A', txt: 'no policy,  no exception              ', pol: null,                            ex: null, want: 'prompt'  },
    { id: 'B', txt: 'no policy,  exception=ALLOW           ', pol: null,                            ex: 1,    want: 'granted' },
    { id: 'C', txt: 'default=2,  no exception              ', pol: { def: 2 },                      ex: null, want: 'denied'  },
    { id: 'D', txt: 'default=2,  exception=ALLOW           ', pol: { def: 2 },                      ex: 1,    want: null      },
    { id: 'E', txt: 'default=2 + GeolocationBlockedForUrls ', pol: { def: 2, blockedUrls: ['*'] },  ex: 1,    want: 'denied'  },
];

(async () => {
    console.log('starting elevated registry helper -- approve the UAC prompt...');
    const ready = await startHelper();
    console.log('helper ready, elevated=' + ready.elevated + '\n');
    if (!ready.elevated) { console.log('ABORT -- helper is not elevated.'); process.exit(2); }

    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    console.log('probe on ' + ORIGIN + '   signal = permissions.query(geolocation).state\n');

    const summary = {};

    for (const b of BROWSERS) {
        console.log('══ ' + b.name + ' ' + '═'.repeat(60 - b.name.length));
        if (!fs.existsSync(b.exe)) { console.log('  not installed\n'); continue; }

        const ud = path.join(os.tmpdir(), 'fpv-geo-' + b.name.toLowerCase());
        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
        fs.mkdirSync(ud, { recursive: true });

        await tell({ policy: null });
        await launch(b.exe, ud);                       //  let it author its own profile
        if (!fs.existsSync(prefsFile(ud))) { console.log('  browser never wrote Preferences -- void\n'); continue; }

        const got = {};
        for (const c of CELLS) {
            setException(ud, c.ex);
            const ack = await tell({ policy: c.pol });
            const r = await launch(b.exe, ud);
            got[c.id] = r.state;
            const v = c.want === null ? '   <<< THE QUESTION' : (r.state === c.want ? '  PASS' : '  FAIL');
            console.log(`  ${c.id}  ${c.txt} -> ${String(r.state).padEnd(9)}` +
                        `${c.want ? 'want ' + c.want.padEnd(8) : '                '}${v}`);
            console.log(`       registry: ${ack.state[b.name]}`);
            console.log(`       exception after run: ${readException(ud)}` +
                        (ack.errs && ack.errs.length ? '   REG ERRORS: ' + ack.errs.join('; ') : ''));
        }

        await tell({ policy: null });
        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}

        const ok = got.A === 'prompt' && got.B === 'granted' && got.C === 'denied';
        console.log('  ' + '-'.repeat(58));
        console.log('  controls A/B/C: ' + (ok ? 'all PASS -- D and E are meaningful'
                                               : 'FAILED -- D and E prove nothing'));
        if (ok) {
            console.log('  D = ' + got.D + (got.D === 'granted'
                ? '   a stored per-site ALLOW DOES beat DefaultGeolocationSetting'
                : '    the policy default already wins; the cause lies elsewhere'));
            console.log('  E = ' + got.E + (got.E === 'denied'
                ? '    GeolocationBlockedForUrls ["*"] overrides the stored ALLOW -- SHIP IT'
                : '   the proposed fix does NOT hold -- do not ship it'));
        }
        summary[b.name] = got;
        console.log('');
    }

    console.log('══ summary ' + '═'.repeat(50));
    console.log(JSON.stringify(summary, null, 2));

    await tell({ op: 'quit' });
    console.log('\nelevated helper stopped; HKLM geolocation values cleared.');
    server.close();
    process.exit(0);
})().catch(e => {
    console.log('THREW: ' + e.message);
    try { fs.writeFileSync(CMD, JSON.stringify({ seq: 9999, op: 'quit' }), 'utf8'); } catch (e2) {}
    process.exit(1);
});
