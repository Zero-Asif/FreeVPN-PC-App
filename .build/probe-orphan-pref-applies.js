'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-orphan-pref-applies.js  --  is the STUCK proxy pref still being
//  applied, when the id that owns it is one nothing can load any more?
//
//  probe-strand-owner.js settled who owns it, and the answer changes the fix:
//
//    LIVE   bmdkiblidpidilbeebghppkifmdhheog  location=6 external-pref-download,
//           installed at Extensions\...\1.1.0.1_0, worker registered
//           -> preferences: {}          ... holds NO proxy
//    FOSSIL egclniilmgnaildaaiccpmakehnhledg  location=4 unpacked, path =
//           C:\ProgramData\freeproxy-vpn\browser-setup\extension, worker version
//           recorded as 1.1.0.3
//           -> preferences.proxy = socks5://127.0.0.1:9050    ... holds the strand
//
//  That folder's manifest today carries a `key` whose derived id is the LIVE one,
//  so nothing on disk can produce the fossil id again and no worker will ever run
//  for it. If Chromium still APPLIES its pref, then no change to
//  Extension/background.js can fix "brave e net pacchina" -- our extension cannot
//  release another extension's pref -- and claiming the fix works would be false.
//
//  So it is measured rather than argued. The state is already the failing one:
//  the app is not running, nothing is listening on 9050, Brave is not running.
//  A page is served on this machine's LAN address, which the stuck pref's
//  bypass_list ("localhost,127.0.0.1,<local>") does NOT cover -- <local> means
//  dotless hostnames, not private ranges -- so a request for it must travel
//  through socks5://127.0.0.1:9050 if that pref is in force. Nothing arrives if
//  it is; the request arrives if it is not.
//
//  Timing is the second reading. .build/probe-brave-start-clears.js measured the
//  live extension releasing its own pref 11.1 s after launch, so:
//      a hit within a few seconds  -> nothing was in force at all
//      a hit around 11 s           -> a LIVE pref was in force and was released
//      no hit at all               -> the fossil is in force: background.js cannot fix it
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const WINDOW_MS = 70000;
const RETRY_AT = [22000, 45000];

//  A LAN address, not loopback: the stuck pref bypasses 127.0.0.1 explicitly, so
//  a loopback target would load whether the proxy is in force or not and the
//  measurement would read "fine" every time.
function lanAddress() {
    for (const [name, addrs] of Object.entries(os.networkInterfaces()))
        for (const a of addrs || [])
            if (a.family === 'IPv4' && !a.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address)
                && !/^172\.1[67]\./.test(a.address))          // skip the Hyper-V vEthernet ranges
                return { name, address: a.address };
    return null;
}

const running = name => {
    try {
        return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' })
            .toLowerCase().includes(name.toLowerCase());
    } catch (e) { return false; }
};

//  Every precondition is asserted, because a measurement taken in the wrong state
//  reads as a clean bill of health. 9050 answering, or the app running, would make
//  "the request arrived" mean nothing at all.
const pre = [];
if (!fs.existsSync(BRAVE)) pre.push('brave.exe not found at ' + BRAVE);
if (running('FreeProxy VPN.exe')) pre.push('the desktop app is RUNNING -- shut it down first');
if (running('tor.exe')) pre.push('tor.exe is running, so 9050 may answer');
const braveWasUp = running('brave.exe');
const lan = lanAddress();
if (!lan) pre.push('no private LAN IPv4 address on this machine');

let listening = false;
try {
    listening = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
        .split('\n').some(l => /LISTENING/i.test(l) && /:9050\b/.test(l));
} catch (e) {}
if (listening) pre.push('something IS listening on 9050, so a dead proxy is not what is being tested');

console.log('══ preconditions ══');
console.log(`  app running       ${running('FreeProxy VPN.exe') ? 'YES' : 'no'}`);
console.log(`  9050 listening    ${listening ? 'YES' : 'no'}`);
console.log(`  brave already up  ${braveWasUp ? 'YES (its tabs are the user\'s -- it will be left alone)' : 'no'}`);
console.log(`  LAN target        ${lan ? lan.address + ' on ' + lan.name : '(none)'}`);
if (pre.length) {
    console.log('\nABORT: ' + pre.join('\n       '));
    process.exit(3);
}

const HITS = [];
let T0 = Date.now();
const rel = () => String(Date.now() - T0).padStart(6) + ' ms';

const server = http.createServer((req, res) => {
    if (!/^\/control/.test(req.url)) {
        HITS.push({ at: Date.now() - T0, url: req.url });
        console.log(`  ${rel()}  REQUEST ${req.url}`);
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>reached</title><h1>reached</h1>');
});

//  Node's own fetch honours no browser proxy pref, so this answers "is the server
//  reachable at that address at all". Without it, a Windows Firewall block on the
//  LAN interface would produce silence and read as "the fossil pref is in force" --
//  the one wrong conclusion this probe exists to avoid.
function control(url) {
    return new Promise(resolve => {
        const req = http.get(url, r => { r.resume(); resolve(r.statusCode); });
        req.on('error', e => resolve('ERROR ' + e.code));
        req.setTimeout(4000, () => { req.destroy(); resolve('TIMEOUT'); });
    });
}

server.listen(0, lan.address, async () => {
    const port = server.address().port;
    const url = n => `http://${lan.address}:${port}/probe-${n}`;
    console.log(`\n══ serving on ${lan.address}:${port} -- not bypassed by ` +
                `"localhost,127.0.0.1,<local>" ══`);

    const code = await control(`http://${lan.address}:${port}/control`);
    console.log(`  control fetch from node itself: ${code}`);
    if (code !== 200) {
        console.log('\nABORT: the server is not reachable on its own LAN address (firewall?), so ' +
                    'silence from\n       Brave would prove nothing.');
        server.close();
        process.exit(3);
    }

    const open = n => {
        console.log(`  ${rel()}  launching brave at ${url(n)}`);
        const p = spawn(BRAVE, ['--no-default-browser-check', url(n)],
                        { detached: true, stdio: 'ignore' });
        p.unref();
    };

    T0 = Date.now();
    open(1);
    setTimeout(() => console.log(`  ${rel()}  brave.exe running: ${running('brave.exe') ? 'yes' : 'NO -- it did not start'}`), 6000);
    for (const at of RETRY_AT) {
        //  A Chromium error page does not retry itself, so a second and third tab
        //  are opened later. If the pref is released partway through, one of these
        //  arrives and the earlier silence is explained.
        const n = RETRY_AT.indexOf(at) + 2;
        setTimeout(() => { if (Date.now() - T0 < WINDOW_MS) open(n); }, at);
    }

    await new Promise(r => setTimeout(r, WINDOW_MS));
    server.close();

    console.log('\n══ verdict ══');
    if (!HITS.length) {
        console.log(`  NOTHING arrived in ${WINDOW_MS} ms, across ${1 + RETRY_AT.length} attempts.`);
        console.log('  Brave has no internet with the app shut down -- and the only pref that could');
        console.log('  be doing it belongs to an id that will never have a worker again. A release');
        console.log('  inside Extension/background.js CANNOT reach it.');
    } else {
        const first = HITS[0].at;
        console.log(`  ${HITS.length} request(s) arrived, the first at ${first} ms.`);
        if (first < 8000)
            console.log('  Brave reached a non-bypassed address straight away, so NO extension proxy\n' +
                        '  pref was in force at start. The fossil record is inert residue: Chromium is\n' +
                        '  not applying it, because the extension that owns it is not loaded.');
        else
            console.log('  The first attempt did not arrive but a later one did -- consistent with the\n' +
                        '  11.1 s worker-start release measured in probe-brave-start-clears.js, i.e. a\n' +
                        '  LIVE pref that was released, which is exactly what the fix now does earlier.');
    }
    HITS.forEach(h => console.log(`    ${String(h.at).padStart(6)} ms  ${h.url}`));

    if (!braveWasUp) {
        //  Closed, not killed: /F would skip the profile write, and this browser was
        //  started by the probe so there are no tabs of the user's in it.
        console.log('\n  closing the Brave this probe started (gracefully -- its own tabs only)');
        try { execFileSync('taskkill', ['/IM', 'brave.exe'], { stdio: 'ignore' }); } catch (e) {}
    } else {
        console.log('\n  Brave was already running, so it is left exactly as it was.');
    }
    console.log('\nNo file was modified by this probe.');
    process.exit(HITS.length ? 0 : 1);
});
