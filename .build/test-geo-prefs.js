'use strict';
// ════════════════════════════════════════════════════════════════════
//  Attempt 3, narrowed to what can be established WITHOUT elevation.
//
//  Two earlier harness failures, both mine:
//    * getCurrentPosition() as the signal -- headless auto-denies
//      prompts, so every cell read PERMISSION_DENIED including controls.
//    * HKCU\SOFTWARE\Policies is ACL'd read-only for a non-admin user,
//      so `reg add` returned "Access is denied" and the helper swallowed
//      it. No cell ever had a policy applied.
//
//  Elevation is needed to test the policy at all, and the app writes
//  HKLM elevated anyway -- so the policy half gets verified during the
//  real app run. What this probe settles is the half the fix actually
//  hinges on, and it needs no admin rights:
//
//      Does editing a profile's Preferences while the browser is CLOSED
//      change the geolocation content setting the browser then uses?
//
//  If yes, removing the stale per-site ALLOW entries that Chrome and
//  Brave are carrying for ipleak.net is a deterministic fix rather than
//  a bet on Chromium's provider precedence.
//
//      1  virgin profile, Chrome writes its own Preferences  -> prompt
//      2  inject ALLOW  for the probe origin                 -> granted
//      3  inject BLOCK  for the probe origin                 -> denied
//      4  scrub the exception back out                       -> prompt
//
//  Cell 2 or 3 failing means Chrome ignores outside edits and the whole
//  approach is wrong. Cell 4 is the fix itself.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const PORT = 19099;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PATTERN = `http://127.0.0.1:${PORT},*`;

const BROWSERS = [
    { name: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Brave',  exe: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
    { name: 'Edge',   exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
];

//  window.close() after reporting, so the browser shuts down cleanly and
//  FLUSHES Preferences -- taskkill /F is what lost it last time.
const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><body>
<script>
(async function(){
  var out={};
  try{ out.state=(await navigator.permissions.query({name:'geolocation'})).state; }
  catch(e){ out.state='QUERY_THREW'; out.msg=String(e&&e.message); }
  try{
    await fetch('/r',{method:'POST',headers:{'Content-Type':'application/json'},
                      body:JSON.stringify(out)});
  }catch(e){}
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

function launch(exe, ud) {
    return new Promise(resolve => {
        const child = spawn(exe, [
            '--headless=new',
            `--user-data-dir=${ud}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--disable-sync',
            ORIGIN + '/',
        ], { windowsHide: true, stdio: 'ignore' });

        let result = null, exited = false, settled = false;
        const done = () => {
            if (settled) return; settled = true;
            clearTimeout(hard);
            resolve(result || { state: 'NO_CALLBACK' });
        };
        //  Wait for the process to LEAVE on its own -- that clean exit is
        //  what writes Preferences. Force-kill only as a backstop.
        child.on('exit', () => { exited = true; setTimeout(done, 400); });
        pending = r => {
            result = r;
            setTimeout(() => {
                if (exited) return;
                try { execSync(`taskkill /F /PID ${child.pid} /T`,
                    { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
                setTimeout(done, 400);
            }, 6000);
        };
        const hard = setTimeout(() => {
            try { execSync(`taskkill /F /PID ${child.pid} /T`,
                { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
            done();
        }, 30000);
        child.on('error', e => { result = { state: 'SPAWN_FAILED', msg: e.message }; done(); });
    });
}

// ── Preferences helpers, operating only while the browser is closed ──
const prefsFile = ud => path.join(ud, 'Default', 'Preferences');

function readGeoExceptions(ud) {
    const p = prefsFile(ud);
    if (!fs.existsSync(p)) return null;
    try {
        const prefs = JSON.parse(fs.readFileSync(p, 'utf8'));
        return (((prefs.profile || {}).content_settings || {}).exceptions || {}).geolocation || {};
    } catch (e) { return null; }
}

function writeGeoException(ud, setting) {
    const p = prefsFile(ud);
    if (!fs.existsSync(p)) return 'NO PREFS FILE';
    const prefs = JSON.parse(fs.readFileSync(p, 'utf8'));
    prefs.profile = prefs.profile || {};
    prefs.profile.content_settings = prefs.profile.content_settings || {};
    const cs = prefs.profile.content_settings;
    cs.exceptions = cs.exceptions || {};
    cs.exceptions.geolocation = cs.exceptions.geolocation || {};
    if (setting === null) delete cs.exceptions.geolocation[PATTERN];
    else cs.exceptions.geolocation[PATTERN] = { last_modified: '13300000000000000', setting };
    fs.writeFileSync(p, JSON.stringify(prefs), 'utf8');
    return 'ok';
}

const show = o => JSON.stringify(o) === '{}' ? '{}' : JSON.stringify(o);

(async () => {
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    console.log('probe on ' + ORIGIN + '   signal = permissions.query(geolocation).state\n');

    for (const b of BROWSERS) {
        console.log('══ ' + b.name + ' ' + '═'.repeat(60 - b.name.length));
        if (!fs.existsSync(b.exe)) { console.log('  not installed\n'); continue; }

        const ud = path.join(os.tmpdir(), 'fpv-geo-' + b.name.toLowerCase());
        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
        fs.mkdirSync(ud, { recursive: true });

        //  1  let the browser build its own profile
        let r = await launch(b.exe, ud);
        const wrote = fs.existsSync(prefsFile(ud));
        console.log(`  1  virgin profile                   -> ${String(r.state).padEnd(10)} want prompt   ` +
                    (r.state === 'prompt' ? 'PASS' : 'FAIL'));
        console.log(`     browser wrote Default/Preferences: ${wrote ? 'yes' : 'NO -- everything below is void'}`);
        if (!wrote) { console.log(''); continue; }
        console.log(`     geolocation exceptions in it: ${show(readGeoExceptions(ud))}`);

        //  2  inject ALLOW
        console.log(`     inject ALLOW: ${writeGeoException(ud, 1)}`);
        r = await launch(b.exe, ud);
        const allowOk = r.state === 'granted';
        console.log(`  2  exception = ALLOW                -> ${String(r.state).padEnd(10)} want granted  ` +
                    (allowOk ? 'PASS' : 'FAIL'));
        console.log(`     exceptions after the run: ${show(readGeoExceptions(ud))}`);

        //  3  inject BLOCK
        console.log(`     inject BLOCK: ${writeGeoException(ud, 2)}`);
        r = await launch(b.exe, ud);
        const blockOk = r.state === 'denied';
        console.log(`  3  exception = BLOCK                -> ${String(r.state).padEnd(10)} want denied   ` +
                    (blockOk ? 'PASS' : 'FAIL'));

        //  4  scrub it out -- this is the fix
        console.log(`     scrub exception: ${writeGeoException(ud, null)}`);
        r = await launch(b.exe, ud);
        const scrubOk = r.state === 'prompt';
        console.log(`  4  exception removed                -> ${String(r.state).padEnd(10)} want prompt   ` +
                    (scrubOk ? 'PASS' : 'FAIL'));
        console.log(`     exceptions after the run: ${show(readGeoExceptions(ud))}`);

        console.log('  ' + '-'.repeat(58));
        console.log('  ' + (allowOk && blockOk && scrubOk
            ? 'Outside edits to Preferences ARE honoured. Scrubbing the stale\n'
            + '  ALLOW entries is a deterministic fix, not a bet on precedence.'
            : 'Outside edits are NOT reliably honoured in this browser -- the\n'
            + '  scrub cannot be the primary mechanism here.'));

        try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
        console.log('');
    }

    server.close();
    process.exit(0);
})();
