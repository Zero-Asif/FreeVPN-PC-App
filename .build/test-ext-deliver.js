'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-ext-deliver.js  --  the delivery half, unelevated
//
//  lib/ext-deliver.js exists because of one measurement: with the payload
//  served on the port the live policies name, Edge, Chrome and Brave each
//  fetched /updates.xml and the CRX within about five seconds of starting. The
//  routes were right; the port was dead by the time a browser asked. So what
//  has to be true of this module is narrow and testable without touching a
//  policy hive, a browser or an elevated directory:
//
//    * the bundle written by an elevated run is the bundle a later, unelevated
//      helper reads -- same port, same id, same bytes;
//    * the CRX comes back byte-for-byte, because a truncated CRX is a corrupt
//      install in every browser that fetches it;
//    * a repack while the helper is running is picked up WITHOUT a restart,
//      or an app that updates the extension would be serving a version its own
//      policy no longer describes;
//    * probeOurs() says yes only to OUR manifest, never merely to "something
//      answered on 8081";
//    * a busy port is waited out rather than surrendered -- the boot pass and an
//      elevated app start both hold it for seconds, and a helper that quits on
//      EADDRINUSE leaves every browser pointed at a dead port until next logon;
//    * the task XML is UTF-16 with a BOM and says logon, because schtasks
//      rejects the file otherwise and the whole point is the logon moment.
//
//  Nothing here registers a scheduled task or writes to ProgramData.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const deliver  = require('../lib/ext-deliver');
const browsers = require('../lib/browsers');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const warns = [];
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: (...a) => warns.push(a.join(' ')),
              error: (...a) => warns.push(a.join(' ')) };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpdlv-'));
const ID  = 'abcdefghijklmnopabcdefghijklmnop';      // 32 chars, our shape
const VER = '2.0.0.7';
const CRX = crypto.randomBytes(64 * 1024);           // stands in for 838 KB
const XML = `<?xml version='1.0' encoding='UTF-8'?>\n` +
            `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
            `  <app appid='${ID}'>\n` +
            `    <updatecheck codebase='http://127.0.0.1:PORT/freeproxy-geo.crx' ` +
            `version='${VER}' />\n  </app>\n</gupdate>\n`;

/** One request, with the body as a Buffer -- byte comparison is the point. */
function req(port, route, method = 'GET') {
    return new Promise(resolve => {
        const r = http.request({ host: '127.0.0.1', port, path: route, method,
                                 timeout: 4000 }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                                          body: Buffer.concat(chunks) }));
        });
        r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); });
        r.on('error', e => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), err: e.code }));
        r.end();
    });
}

/** A port nothing is on, asked of the OS rather than guessed. */
function freePort() {
    return new Promise(resolve => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

(async () => {
    const PORT = await freePort();
    const xml  = XML.replace('PORT', String(PORT));
    const p    = deliver.bundlePaths(TMP);

    console.log('── writeBundle(): what the elevated run leaves for the helper ──');
    const meta = deliver.writeBundle({ stateDir: TMP, id: ID, version: VER,
                                       port: PORT, crx: CRX, xml, log });
    ok(!!meta, 'writeBundle() returned a meta');
    ok(meta && meta.port === PORT && meta.id === ID && meta.version === VER,
       'it records the port, the id and the version', JSON.stringify(meta));
    ok(meta && meta.url === `http://127.0.0.1:${PORT}/updates.xml`,
       'the url it records is the one the policies name', meta && meta.url);
    ok(fs.existsSync(p.crx) && fs.existsSync(p.xml) && fs.existsSync(p.meta),
       'all three files are on disk');
    ok(fs.readFileSync(p.crx).equals(CRX), 'the CRX on disk is byte-identical');
    ok(!fs.existsSync(p.crx + '.tmp') && !fs.existsSync(p.xml + '.tmp'),
       'no half-written temporary file is left behind');

    const back = deliver.readBundle(TMP);
    ok(back && JSON.stringify(back) === JSON.stringify(meta),
       'readBundle() gives back exactly what was written');
    ok(deliver.readBundle(path.join(TMP, 'nope')) === null,
       'readBundle() on a directory with no bundle is null, not a throw');

    console.log('── an identical repack must not touch the CRX ──');
    //  A browser watches an unpacked extension's directory. Rewriting identical
    //  bytes on every connect makes it reload for nothing.
    const before = fs.statSync(p.crx).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    deliver.writeBundle({ stateDir: TMP, id: ID, version: VER, port: PORT,
                          crx: CRX, xml, log });
    ok(fs.statSync(p.crx).mtimeMs === before, 'same bytes -> the file is left alone');

    console.log('── Deliverer: the two routes, exactly ──');
    const d = new deliver.Deliverer({ stateDir: TMP, log });
    const bound = await d.start();
    ok(bound === PORT, 'start() bound the port the bundle recorded, not another', String(bound));

    const rx = await req(PORT, '/updates.xml');
    ok(rx.status === 200, 'GET /updates.xml -> 200', String(rx.status));
    ok(rx.body.toString('utf8') === xml, 'the manifest is served byte-for-byte');
    ok(/text\/xml/.test(rx.headers['content-type'] || ''), 'as text/xml',
       rx.headers['content-type']);
    ok(String(rx.headers['content-length']) === String(Buffer.byteLength(xml, 'utf8')),
       'with a Content-Length that matches', rx.headers['content-length']);
    ok(rx.headers['cache-control'] === 'no-store', 'and no-store, so a repack is never cached');

    const rc = await req(PORT, '/freeproxy-geo.crx');
    ok(rc.status === 200, 'GET /freeproxy-geo.crx -> 200', String(rc.status));
    ok(rc.body.length === CRX.length && rc.body.equals(CRX),
       `the CRX is served byte-for-byte (${CRX.length} bytes)`,
       `${rc.body.length} bytes`);
    ok(rc.headers['content-type'] === 'application/x-chrome-extension',
       'as application/x-chrome-extension', rc.headers['content-type']);

    console.log('── HEAD, and everything that is not one of the two routes ──');
    //  Chromium's updater probes with HEAD in some builds, and a 404 there
    //  aborts the whole update check.
    const rh = await req(PORT, '/freeproxy-geo.crx', 'HEAD');
    ok(rh.status === 200, 'HEAD /freeproxy-geo.crx -> 200', String(rh.status));
    ok(rh.body.length === 0, 'with no body');
    ok(String(rh.headers['content-length']) === String(CRX.length),
       'but the real Content-Length', rh.headers['content-length']);

    ok((await req(PORT, '/')).status === 404, 'GET / -> 404');
    ok((await req(PORT, '/../ext-key.pem')).status === 404,
       'a traversal attempt is just an unknown route -> 404');
    ok((await req(PORT, '/freeproxy-geo.crx?os=win&arch=x64')).status === 200,
       'the updater\'s own query string is ignored, not 404');
    ok((await req(PORT, '/updates.xml', 'POST')).status === 405,
       'POST -> 405, because nothing here is writable');

    console.log('── a repack while the helper runs is picked up, no restart ──');
    const CRX2 = crypto.randomBytes(48 * 1024);
    deliver.writeBundle({ stateDir: TMP, id: ID, version: '2.0.0.8', port: PORT,
                          crx: CRX2, xml, log });
    const rc2 = await req(PORT, '/freeproxy-geo.crx');
    ok(rc2.body.equals(CRX2), 'the new bytes are served by the already-running helper',
       `${rc2.body.length} vs ${CRX2.length}`);

    console.log('── a missing payload is 503, never a lie and never a crash ──');
    fs.renameSync(p.crx, p.crx + '.away');
    ok((await req(PORT, '/freeproxy-geo.crx')).status === 503,
       'the CRX gone -> 503');
    ok((await req(PORT, '/updates.xml')).status === 200,
       'the manifest still answers, so the browser is not left guessing');
    fs.renameSync(p.crx + '.away', p.crx);
    ok((await req(PORT, '/freeproxy-geo.crx')).status === 200, 'and it recovers by itself');

    //  Exactly what was really handed over, which is the number serveUntilDelivered
    //  reports back: two manifests (the first GET and the one during the 503
    //  section) and five packages (GET, HEAD, the query-string GET, the GET after
    //  the repack, the GET after recovery). The 503 is NOT among them -- a
    //  request that got no bytes must never be counted as a delivery.
    ok(d.served.xml === 2 && d.served.crx === 5,
       'the served counters count deliveries only, never the 503',
       JSON.stringify(d.served));

    console.log('── probeOurs(): our manifest, not merely "something answered" ──');
    ok((await deliver.probeOurs(PORT, ID)) === true, 'true for our own id');
    ok((await deliver.probeOurs(PORT, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')) === false,
       'false for a stranger\'s manifest on the same port');
    const dead = await freePort();
    ok((await deliver.probeOurs(dead, ID, 600)) === false, 'false when nothing is listening');

    d.stop();
    ok((await req(PORT, '/updates.xml')).status === 0, 'stop() really releases the port');

    console.log('── no bundle, and a port somebody else holds ──');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fpdlv-empty-'));
    warns.length = 0;
    const d2 = new deliver.Deliverer({ stateDir: empty, log });
    ok((await d2.start()) === null, 'start() with no bundle returns null');
    ok(warns.some(w => /no extension delivery bundle/i.test(w)),
       'and says so instead of listening on a port nothing describes', warns.join(' | '));

    //  Not a range, deliberately: every policy on the machine names ONE port, so
    //  a helper that landed on a different one would serve an address nobody
    //  asks for. The honest outcome is a warning.
    const squat = http.createServer((q, s) => s.writeHead(200).end('not ours'));
    await new Promise(r => squat.listen(PORT, '127.0.0.1', r));
    warns.length = 0;
    const d3 = new deliver.Deliverer({ stateDir: TMP, log });
    ok((await d3.start()) === null, 'a taken port is null, never a silent shift to 8082');
    ok(warns.some(w => new RegExp(`Port ${PORT} is not available`).test(w)),
       'and it names the port', warns.join(' | '));
    await new Promise(r => squat.close(r));

    console.log('── missing(): read from the browsers\' own profiles ──');
    ok(deliver.missing('').length === 0, 'no id -> nothing is missing anything');
    ok(deliver.missing(null).length === 0, 'null id likewise');
    const installed = browsers.detectChromium().filter(b => b.dataDir).map(b => b.id);
    const none = deliver.missing('qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
    ok(none.length === installed.length &&
       installed.every(id => none.includes(id)),
       'an id no browser has is missing from every installed browser',
       `${none.join(', ')} vs ${installed.join(', ')}`);

    //  The exit condition, against a profile tree built here rather than a
    //  browser's -- both shapes it has to recognise, and the two it must not.
    const prof = path.join(TMP, 'fake-userdata');
    fs.mkdirSync(path.join(prof, 'Default', 'Extensions', ID), { recursive: true });
    ok(browsers.profileHasExtension(prof, ID) === true,
       'Extensions\\<id> in Default is recognised (force-installed CRX)');
    const prof2 = path.join(TMP, 'fake-userdata-2');
    fs.mkdirSync(path.join(prof2, 'Profile 1'), { recursive: true });
    fs.writeFileSync(path.join(prof2, 'Profile 1', 'Secure Preferences'),
                     JSON.stringify({ extensions: { settings: { [ID]: { location: 4 } } } }));
    ok(browsers.profileHasExtension(prof2, ID) === true,
       'a Secure Preferences entry in Profile 1 is recognised (loaded by hand)');
    ok(browsers.profileHasExtension(prof2, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz') === false,
       'a different id in the same profile is not');
    ok(browsers.profileHasExtension(path.join(TMP, 'nothing-here'), ID) === false,
       'a directory that does not exist is false, not a throw');
    ok(browsers.profileHasExtension(prof, '') === false, 'an empty id is false');

    console.log('── serveUntilDelivered(): the two exits that serve nothing ──');
    const r0 = await deliver.serveUntilDelivered({ stateDir: empty, log });
    ok(r0.ok === false && r0.why === 'no-bundle',
       'no bundle -> no-bundle, and no listener opened', JSON.stringify(r0));

    //  Ours already being served -- by the app, or by another session's helper.
    //  A second one waits out its grace window (capMs here, since that is
    //  shorter) and then leaves the port to whoever got there first, because a
    //  server answering with our own manifest is doing the job either way.
    const d4 = new deliver.Deliverer({ stateDir: TMP, log });
    ok((await d4.start()) === PORT, 'a first helper holds the port');
    const r1 = await deliver.serveUntilDelivered({ stateDir: TMP, log, capMs: 2000, pollMs: 500 });
    ok(r1.ok === true && ['already-serving', 'already-delivered'].includes(r1.why),
       `a second helper stands down rather than failing (${r1.why})`, JSON.stringify(r1));
    //  Which of the two it is depends on this machine, and both are correct --
    //  so the machine's own answer is printed rather than asserted away.
    console.log(`       (this machine: ${r1.why}; missing: ${(r1.missing || []).join(', ') || 'none'})`);
    d4.stop();

    console.log('── the boot-pass race: a busy port is a queue, not a refusal ──');
    //  Measured 2026-08-31 on a from-scratch install plus the restart the app
    //  asks for. The boot task (BootTrigger, SYSTEM) held 8081 for the ~28 s it
    //  spent staging the bundle and writing policy; this helper, started two
    //  seconds earlier by the logon trigger, hit EADDRINUSE, returned
    //  port-unavailable and exited 3. The boot pass then released the port --
    //  so all four routes were correct, every browser was pointed at
    //  127.0.0.1:8081, and nothing was listening there until the next logon.
    //
    //  What has to be true now: a helper that finds the port busy waits for it
    //  and serves the rest of its window instead of surrendering it.
    //
    //  Both cases below need at least one Chromium profile on this machine to
    //  be missing this id -- with none, serveUntilDelivered answers
    //  already-delivered before it ever looks at the port, which is correct and
    //  says nothing about the race. So the machine is checked, not assumed.
    const raceable = browsers.detectChromium().some(b => b.dataDir);
    if (!raceable) {
        console.log('       (skipped: no Chromium profile on this machine to deliver to)');
    } else {
        const d5 = new deliver.Deliverer({ stateDir: TMP, log });
        ok((await d5.start()) === PORT, 'a short-lived holder (the boot pass) has the port first');
        setTimeout(() => d5.stop(), 1200);      // it finishes and lets go, as the boot pass does
        const r2 = await deliver.serveUntilDelivered({ stateDir: TMP, log, capMs: 6000, pollMs: 300 });
        ok(r2.why === 'timed-out',
           'the helper waited, took the port over and served the window out',
           JSON.stringify(r2));
        ok(r2.why !== 'port-unavailable' && r2.why !== 'already-serving',
           'it did not exit while the holder was still there -- the 2026-08-31 regression');

        //  The other half of the same decision. A port held by something that
        //  is NOT ours never frees on our account, so the grace window has to
        //  end in an honest failure rather than a 3.5-hour wait.
        const foreign = http.createServer((req, res) => res.writeHead(404).end());
        await new Promise(r => foreign.listen(PORT, '127.0.0.1', r));
        const r3 = await deliver.serveUntilDelivered({ stateDir: TMP, log, capMs: 1500, pollMs: 300 });
        ok(r3.ok === false && r3.why === 'port-unavailable',
           'a foreign holder ends the grace window as port-unavailable', JSON.stringify(r3));
        await new Promise(r => foreign.close(r));
    }

    console.log('── the task XML: what schtasks and Windows require of it ──');
    const EXE = 'C:\\Program Files\\Acme & Co\\FreeProxy "VPN".exe';
    const x = deliver.deliverTaskXml(EXE);
    ok(x.charCodeAt(0) === 0xFEFF, 'it starts with a BOM -- schtasks rejects the file without one');
    ok(/^\uFEFF<\?xml version="1\.0" encoding="UTF-16"\?>/.test(x),
       'and declares UTF-16, which is what it is written as');
    ok(/<Task version="1\.2"/.test(x), 'Task 1.2, the schema Windows 10 accepts');
    ok(/<LogonTrigger>/.test(x) && !/<BootTrigger>/.test(x),
       'it triggers at LOGON -- a browser can only be started by someone logged on');
    ok(/<GroupId>S-1-5-32-545<\/GroupId>/.test(x),
       'for the Users group, so a second account is served too, not just the installer');
    ok(!/<UserId>/.test(x), 'and not for one hard-coded account');
    ok(/<RunLevel>HighestAvailable<\/RunLevel>/.test(x), 'HighestAvailable, never a UAC prompt');
    ok(/<MultipleInstancesPolicy>IgnoreNew</.test(x),
       'a second logon does not start a second helper fighting for the port');
    ok(/<ExecutionTimeLimit>PT4H<\/ExecutionTimeLimit>/.test(x),
       'PT4H, above the loop\'s own 3.5h cap so it exits on its own terms');
    ok(deliver.CAP_MS < 4 * 3600 * 1000, 'and the cap really is below it',
       String(deliver.CAP_MS));
    ok(/<Arguments>--fp-deliver<\/Arguments>/.test(x), 'the argument is --fp-deliver');
    ok(x.includes('<Command>C:\\Program Files\\Acme &amp; Co\\FreeProxy &quot;VPN&quot;.exe</Command>'),
       'and the exe path is XML-escaped, quotes and ampersand included');
    ok(x.split('\n').every(l => l.endsWith('\r') || l === ''), 'CRLF throughout');
    const bytes = Buffer.from(x, 'utf16le');
    ok(bytes[0] === 0xFF && bytes[1] === 0xFE, 'utf16le encodes the BOM as FF FE, as Windows wants');

    console.log('── the task itself is only ever asked of Windows ──');
    ok(typeof deliver.deliverTaskRegistered() === 'boolean',
       'deliverTaskRegistered() answers with a boolean and does not throw');
    ok(deliver.runDeliverTaskNow(log) === false || deliver.deliverTaskRegistered(),
       'runDeliverTaskNow() refuses when the task is not registered');

    console.log('── unregisterDeliverTask(): also takes the payload away ──');
    ok(fs.existsSync(p.crx), 'the bundle is there before');
    deliver.unregisterDeliverTask(log, TMP);
    ok(!fs.existsSync(p.crx) && !fs.existsSync(p.xml) && !fs.existsSync(p.meta),
       'the three served files are gone -- nothing of ours is left to serve');
    ok(deliver.readBundle(TMP) === null, 'and readBundle() now says there is nothing');

    console.log('── the wiring, read out of the source that ships ──');
    //  A module that works and is never called is the exact failure this whole
    //  path is fixing, so the four places that have to name it are checked here
    //  rather than trusted.
    const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const tasksSrc = src('lib/installer-tasks.js');
    ok(/'--fp-deliver':\s*'deliver'/.test(tasksSrc), 'installer-tasks maps --fp-deliver');
    ok(/deliver:\s*taskDeliver/.test(tasksSrc), 'and routes it to taskDeliver');
    ok(/deliver\.registerDeliverTask\(log\)/.test(tasksSrc) &&
       /deliver\.runDeliverTaskNow\(log\)/.test(tasksSrc),
       'taskSetup registers the task and starts it immediately');
    ok(/deliver\.unregisterDeliverTask\(log, ctx\.stateDir\)/.test(tasksSrc),
       'taskTeardown removes it');
    ok(/deliver:\s*deliver\.CAP_MS\s*\+/.test(tasksSrc),
       'and the watchdog is derived from the cap, so it can never fire first');

    const geoSrc = src('lib/geo-ext.js');
    ok(/deliver\.writeBundle\(/.test(geoSrc), 'prepare() writes the bundle');
    ok(/deliver\.probeOurs\(/.test(geoSrc) && /this\.host\.adopt\(/.test(geoSrc),
       'and adopts a live helper instead of shifting the port every policy names');
    ok(/browsers\.profileHasExtension\(userData, this\.id\)/.test(geoSrc),
       'presence() and the helper share ONE definition of "is it really there"');

    ok(/schtasks \/delete \/tn "FreeProxy VPN Extension Delivery" \/f/.test(src('installer.nsh')),
       'installer.nsh deletes the task even if nothing of ours ran');
    ok(/installerTasks\.deliverTaskRegistered\(\)/.test(src('main.js')),
       'and the app repairs it when something has taken it away');

    //  ── who fetched it ───────────────────────────────────────────
    //  The helper logs which process took the payload, because "something on
    //  8081 fetched it" is not an answer when three browsers are armed and only
    //  one of them is the one the user is about to look at. The lookup parses
    //  netstat and tasklist output, which is exactly the kind of code that rots
    //  in silence, so it is measured against a REAL socket: this process
    //  connects to its own server and has to be identified by its own pid.
    console.log('── whoAsked() names the process on the other end ──');
    {
        const seen = [];
        const srv = http.createServer((req, res) => {
            seen.push(deliver.whoAsked(req, srv.address().port));
            res.end('ok');
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        await new Promise((resolve, reject) => {
            const rq = http.get({ host: '127.0.0.1', port: srv.address().port, path: '/x',
                                  headers: { 'user-agent': 'probe/1.0' } },
                                res => { res.resume(); res.on('end', resolve); });
            rq.on('error', reject);
        });
        await new Promise(r => srv.close(r));
        const label = seen[0] || '';
        ok(/\(pid \d+\)$/.test(label),
           'a real connection is attributed to a real pid -- the netstat row is ' +
           'matched on BOTH ports, so it cannot pick up our own listener', label);
        ok(label.includes(`pid ${process.pid}`),
           'and the pid is the process that actually asked', label + ' vs ' + process.pid);
        ok(/^(node|electron)\.exe /i.test(label),
           'named by its image, since it is not a browser -- never guessed from the UA',
           label);
    }

    console.log('── uaLabel() claims only what a UA really distinguishes ──');
    ok(deliver.uaLabel('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0') ===
       'Microsoft Edge', 'Edg/ is Edge');
    ok(deliver.uaLabel('Mozilla/5.0 Chrome/141 Safari/537.36 OPR/121.0') === 'Opera',
       'OPR/ is Opera');
    ok(deliver.uaLabel('Mozilla/5.0 YaBrowser/25.6 Safari/537.36') === 'Yandex Browser',
       'YaBrowser is Yandex');
    ok(deliver.uaLabel('Mozilla/5.0 Chrome/141 Vivaldi/7.5') === 'Vivaldi', 'Vivaldi says so');
    ok(deliver.uaLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 ' +
                       'Safari/537.36') === null,
       'a plain Chrome UA is claimed by nobody -- Brave sends the same one, and a ' +
       'wrong browser name is worse than a vague one');
    ok(deliver.whoAsked({ headers: {}, socket: {} }, 8081) === 'a browser',
       'no port and no UA falls back to the vague wording rather than to a guess');
    ok(deliver.whoAsked({ headers: { 'user-agent': 'x Edg/141' }, socket: {} }, 8081) ===
       'Microsoft Edge', 'and to the UA when that is all there is');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(empty, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
