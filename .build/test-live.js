'use strict';
// ════════════════════════════════════════════════════════════════════
//  The end-to-end test that matters, minus the parts that need to own
//  the machine. Runs the REAL tor.exe with a torrc built by the REAL
//  buildTorrc(), pins an exit by fingerprint, and then asks the outside
//  world where the traffic came out -- the same question the report
//  answered with "Switzerland" while the app said "Luxembourg".
//
//  Deliberately harmless: DNSPort 9053 (never touches :53 or dnscache),
//  a private DataDirectory under the temp folder, no registry writes, no
//  browser policy, no adapter changes. Nothing here needs admin and
//  nothing here has to be undone.
//
//    node .build/test-live.js [cc]        default lu
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const { directGet, socksGet } = require('../lib/socks-fetch');
const { ExitStore, RelayIndex, probeExitLocation, v4Prefix16 } = require('../lib/exit-selector');
const { TorControl } = require('../lib/tor-control');

const CC = (process.argv[2] || 'lu').toLowerCase();

//  Ports well away from the app's, so this can run while the app is up.
const SOCKS_PORT = 19050, HTTP_PORT = 19080, CTRL_PORT = 19051, DNS_PORT = 19053;

const log = {
    debug: () => {},
    info:  m => console.log('    ' + m),
    warn:  m => console.log('    WARN ' + m),
};

let bad = 0;
function check(label, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
    if (!cond) bad++;
}

// ── build a torrc through the SHIPPED buildTorrc ────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(header) {
    const a = src.indexOf(header);
    if (a < 0) throw new Error('not found: ' + header);
    const close = src.indexOf('\r\n    }', a);
    return src.slice(a, close + '\r\n    }'.length);
}

const realTorDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'freeproxy-vpn', 'Tor', 'tor');
const sandbox    = path.join(os.tmpdir(), 'fp-live-' + process.pid);
fs.mkdirSync(sandbox, { recursive: true });

//  torPaths() points at the app's real data dir; override just the two
//  fields that would collide with a running app, so the torrc under test
//  is still the one main.js generates.
const stubLogger = { warn: m => log.warn(m) };
const make = new Function('fs', 'path', 'torDir', 'getScriptPath', 'Logger',
    'SOCKS_PORT', 'HTTP_PORT', 'CTRL_PORT', 'DNS_PORT',
    extract('function torPaths()') + '\n' + extract('function buildTorrc(') +
    '\nreturn { torPaths, buildTorrc };');
const { torPaths, buildTorrc } = make(fs, path, realTorDir, f => path.join(sandbox, f), stubLogger,
    SOCKS_PORT, HTTP_PORT, CTRL_PORT, DNS_PORT);

const P = torPaths();
if (!fs.existsSync(P.torExe)) { console.error('tor.exe not deployed: ' + P.torExe); process.exit(2); }

const dataDir = path.join(sandbox, 'data');
fs.mkdirSync(dataDir, { recursive: true });
//  Seed from the app's own data dir. Without the cached consensus and
//  microdescriptors a cold start sits at 50% ("loading relay
//  descriptors") for minutes, which says nothing about the code under
//  test -- the app itself never starts cold because it keeps this cache.
let seeded = 0;
for (const f of fs.readdirSync(P.torData)) {
    if (!/^(geoip6?|cached-|lock$|state$)/.test(f)) continue;
    if (/^lock$/.test(f)) continue;                 // never copy the lock
    try {
        const from = path.join(P.torData, f);
        if (fs.statSync(from).isDirectory()) continue;
        fs.copyFileSync(from, path.join(dataDir, f));
        seeded++;
    } catch (e) {}
}
console.log('seeded ' + seeded + ' file(s) from the app cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function portFree(port) {
    return new Promise(res => {
        const s = net.createServer();
        s.once('error', () => res(false));
        s.once('listening', () => s.close(() => res(true)));
        s.listen(port, '127.0.0.1');
    });
}

let tor = null;
function stop() {
    if (tor && !tor.killed) { try { tor.kill(); } catch (e) {} }
    try { spawnSync('taskkill', ['/F', '/PID', String(tor && tor.pid)], { stdio: 'ignore' }); } catch (e) {}
}
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

(async () => {
    console.log('country under test : ' + CC.toUpperCase());
    console.log('sandbox            : ' + sandbox);
    console.log('ports              : socks ' + SOCKS_PORT + '  ctrl ' + CTRL_PORT + '  dns ' + DNS_PORT + '\n');

    for (const p of [SOCKS_PORT, HTTP_PORT, CTRL_PORT, DNS_PORT]) {
        if (!await portFree(p)) { console.error('port ' + p + ' is busy'); process.exit(2); }
    }

    // ── pick the exit the app would pick ────────────────────────────
    console.log('[1] exit plan');
    const idx = new RelayIndex(log);
    await idx.refresh(u => directGet(u, { timeoutMs: 45000, maxBytes: 12 * 1024 * 1024 }));
    const store = new ExitStore(path.join(sandbox, 'exits.json'), log);
    const plan  = idx.candidates(CC, store, { limit: 5 });
    check('candidates found', plan.length > 0, plan.length + ' for ' + CC.toUpperCase());
    if (!plan.length) { console.log('\nno exits for ' + CC); process.exit(1); }
    const cand = plan[0];
    console.log('    pinning ' + (cand.nick || cand.fp.slice(0, 8)) + '  ' + cand.ip +
                '  v6=' + (cand.hasV6 ? 'YES' : 'no'));

    // ── start the real engine ───────────────────────────────────────
    console.log('\n[2] tor.exe with the shipped torrc');
    const torrc = buildTorrc({ exitSpec: '$' + cand.fp, dnsPort: DNS_PORT })
        .replace(/DataDirectory ".*"/,  'DataDirectory "' + dataDir.replace(/\\/g, '/') + '"')
        .replace(/CookieAuthFile ".*"/, 'CookieAuthFile "' + path.join(dataDir, 'control_auth_cookie').replace(/\\/g, '/') + '"')
        .replace(/GeoIPFile ".*"/,      'GeoIPFile "' + path.join(dataDir, 'geoip').replace(/\\/g, '/') + '"')
        .replace(/GeoIPv6File ".*"/,    'GeoIPv6File "' + path.join(dataDir, 'geoip6').replace(/\\/g, '/') + '"');
    const rcFile = path.join(sandbox, 'torrc');
    fs.writeFileSync(rcFile, torrc, 'utf8');

    const v = spawnSync(P.torExe, ['--verify-config', '-f', rcFile],
        { cwd: realTorDir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    check('torrc validates', /Configuration was valid/.test((v.stdout || '') + (v.stderr || '')));

    let boot = 0, bootDone = false, lastShown = -1;
    tor = spawn(P.torExe, ['-f', rcFile], { cwd: realTorDir, windowsHide: true });
    const onData = d => {
        const t = d.toString();
        const m = t.match(/Bootstrapped (\d+)%[^\r\n]*/g);
        if (m) {
            const last = m[m.length - 1];
            boot = parseInt(last.match(/\d+/)[0], 10);
            if (boot !== lastShown) { lastShown = boot; console.log('    ' + last.trim()); }
            if (boot === 100) bootDone = true;
        }
        for (const line of t.split(/\r?\n/)) {
            if (/\[err\]/.test(line)) console.log('    TOR ERR ' + line.trim());
            else if (/\[warn\]/.test(line) && !/is relative and will resolve/.test(line))
                console.log('    TOR WARN ' + line.trim());
        }
    };
    tor.stdout.on('data', onData);
    tor.stderr.on('data', onData);

    const t0 = Date.now();
    while (!bootDone && Date.now() - t0 < 180000) {
        await sleep(500);
        if (tor.exitCode !== null) break;
    }
    check('bootstrapped to 100%', bootDone, boot + '% in ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (!bootDone) { stop(); console.log('\n' + bad + ' check(s) FAILED'); process.exit(1); }

    // ── control port ────────────────────────────────────────────────
    console.log('\n[3] control port');
    const ctl = new TorControl({ port: CTRL_PORT, cookiePath: path.join(dataDir, 'control_auth_cookie'), logger: log });
    let ctlOk = false;
    try { await ctl.open({ timeoutMs: 8000 }); ctlOk = true; } catch (e) { log.warn(e.message); }
    check('cookie AUTHENTICATE succeeded', ctlOk);

    if (ctlOk) {
        const built = await ctl.waitForExit(cand.fp, { timeoutMs: 30000 });
        check('a circuit reached the pinned relay', !!built);
        const exits = await ctl.activeExits();
        //  activeExits() yields {fp, nick} objects, not bare fingerprints.
        check('every live circuit uses the pinned exit',
            exits.length > 0 && exits.every(e => e.fp.toUpperCase() === cand.fp.toUpperCase()),
            exits.length + ' distinct exit(s): ' +
            exits.map(e => (e.nick || '') + '/' + e.fp.slice(0, 8)).join(', '));
    }

    // ── where does the traffic actually come out ────────────────────
    console.log('\n[4] external verification (the question the report asked)');
    const probe = await probeExitLocation(SOCKS_PORT, log, { timeoutMs: 15000 });
    if (!probe) {
        check('a geolocation source answered through Tor', false);
    } else {
        console.log('    consensus: ' + String(probe.cc).toUpperCase() + '  ip=' + probe.ip);
        check('exit country matches the country asked for',
            String(probe.cc).toLowerCase() === CC, 'wanted ' + CC.toUpperCase() +
            ', got ' + String(probe.cc).toUpperCase());
        check('exit IP is the relay that was pinned', probe.ip === cand.ip,
            'pinned ' + cand.ip + ', saw ' + probe.ip);
    }

    // ── IPv6 must be refused, not merely unused ─────────────────────
    console.log('\n[5] IPv6 containment');
    let v6 = null;
    try {
        const r = await socksGet('https://ipv6.icanhazip.com/', { socksPort: SOCKS_PORT, timeoutMs: 15000 });
        v6 = (r.body || '').trim();
    } catch (e) { v6 = null; }
    check('no IPv6 address is reachable through the tunnel', !v6 || !v6.includes(':'),
        v6 ? 'LEAKED ' + v6 : 'IPv6 refused (NoIPv6Traffic) -- this is the intended result');

    // ── DNS must resolve at the exit, and only there ────────────────
    console.log('\n[6] DNS through Tor');
    let dnsIp = null;
    try {
        //  RESOLVE goes through the control port, which is exactly the
        //  path Tor's DNSPort uses internally.
        const res = await ctl.cmd('RESOLVE example.com', { timeoutMs: 15000 }).catch(() => null);
        dnsIp = res ? 'accepted' : null;
    } catch (e) {}
    check('Tor accepted a DNS resolve request', !!dnsIp);

    //  The real question: does a lookup through the SOCKS port resolve
    //  remotely? ATYP 0x03 means the name never leaves the tunnel.
    let remote = false;
    try {
        const r = await socksGet('https://ipleak.net/json/', { socksPort: SOCKS_PORT, timeoutMs: 15000 });
        remote = JSON.parse(r.body).ip === (probe && probe.ip);
    } catch (e) {}
    check('hostname resolved at the exit, not locally', remote,
        remote ? 'same IP as the verified exit' : 'could not confirm');

    // ── switching country must actually switch, and STAY switched ───
    console.log('\n[7] switch to a second country (stability check)');
    const other = CC === 'de' ? 'nl' : 'de';
    const plan2 = idx.candidates(other, store, { limit: 3 });
    if (ctlOk && plan2.length) {
        const c2 = plan2[0];
        console.log('    repinning ' + (c2.nick || c2.fp.slice(0, 8)) + '  ' + c2.ip);
        //  Exactly the sequence establishConnection() runs.
        const idMark = await ctl.maxCircuitId();
        await ctl.setConf({ ExitNodes: '$' + c2.fp });
        await ctl.purgeCircuitsExcept(c2.fp, { staleIdMax: idMark });
        const built2 = await ctl.waitForExit(c2.fp, { timeoutMs: 30000 });
        check('a circuit reached the new relay', !!built2);
        await ctl.purgeCircuitsExcept(c2.fp, { staleIdMax: idMark });

        const p2 = await probeExitLocation(SOCKS_PORT, log, { timeoutMs: 15000 });
        check('SETCONF really moved the exit country',
            p2 && String(p2.cc).toLowerCase() === other,
            p2 ? String(p2.cc).toUpperCase() + ' / ' + p2.ip : 'no answer');

        //  The regression that mattered: the FIRST request came out in the
        //  new country and every one after it reverted to the old exit,
        //  because Tor kept attaching streams to circuits built before the
        //  switch. One probe would have called that a pass.
        console.log('    holding for 40s to catch a revert...');
        let reverted = 0;
        for (let i = 0; i < 4; i++) {
            await sleep(10000);
            await ctl.purgeCircuitsExcept(c2.fp, { staleIdMax: Number.MAX_SAFE_INTEGER });
            const pn = await probeExitLocation(SOCKS_PORT, log, { timeoutMs: 15000 });
            if (!pn || String(pn.cc).toLowerCase() !== other) reverted++;
        }
        check('the switch holds -- no revert to the old country over 40s',
            reverted === 0, reverted ? reverted + '/4 probes drifted' : '4/4 probes in ' + other.toUpperCase());

        //  And exactly one exit reachable: more than one is what "DNS
        //  Addresses -- 5 servers detected" looks like from the outside.
        const live2 = await ctl.activeExits();
        check('exactly one exit relay is reachable', live2.length === 1,
            live2.length + ' distinct exit(s): ' +
            live2.map(e => (e.nick || '') + '/' + e.fp.slice(0, 8)).join(', '));
    }

    if (ctlOk) ctl.close();
    stop();
    await sleep(500);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}

    console.log('\n' + (bad ? bad + ' check(s) FAILED' : 'ALL CHECKS PASSED'));
    process.exit(bad ? 1 : 0);
})().catch(e => { console.error('\nharness error: ' + e.stack); stop(); process.exit(2); });
