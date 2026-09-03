'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-obfs4-quotes.js  --  READ-ONLY, temp data dirs, no proxy
//
//  ASK 3, the bridge-mode round. The shipped log says:
//
//    [WARN] TOR: ... CreateProcessA() failed: The system cannot find the
//                 file specified.
//    [WARN] TOR: Can't use bridge at [scrubbed]: there is no configured
//                 transport called "obfs4".   (x6)
//
//  main.js:1905 writes the plugin line QUOTED:
//      ClientTransportPlugin obfs4 exec "C:/.../lyrebird.exe"
//
//  I was about to "fix" that by dropping the quotes. But that single log
//  line is produced by TWO different causes and cannot tell them apart:
//
//    H1  tor keeps the quote characters and hands `"C:/...exe"` to
//        CreateProcessA, which has no such file
//    H2  tor strips the quotes and then splits the value on whitespace,
//        so a path containing a space becomes two argv entries and
//        CreateProcessA gets the truncated first half
//
//  If H2 is the real cause, deleting the quotes changes nothing at all --
//  and the deployed path is `C:\ProgramData\freeproxy-vpn\...`
//  (main.js:544 overrides userData exactly to avoid spaces), so H2 would
//  additionally mean the log came from something else entirely.
//
//  So: a 2x2. quotes x space, same bridge line, same binaries, four real
//  tor processes. The PT either launches or it does not, and tor says which
//  in its own words. Nothing outside os.tmpdir() and .build/ is written; no
//  registry value, no proxy setting, no user profile, and the ports are
//  190xx so a running app on 9050/9051 is untouched.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOR_EXE = path.join(ROOT, 'Tor', 'tor', 'tor.exe');
const LYRE_SRC = path.join(ROOT, 'Tor', 'tor', 'pluggable_transports', 'lyrebird.exe');
const GEOIP = path.join(ROOT, 'Tor', 'data', 'geoip');
const GEOIP6 = path.join(ROOT, 'Tor', 'data', 'geoip6');
const RUN_MS = 25000;

for (const [label, p] of [['tor.exe', TOR_EXE], ['lyrebird.exe', LYRE_SRC]]) {
    if (!fs.existsSync(p)) { console.log(`missing ${label}: ${p}`); process.exit(0); }
}

//  The three bridges are copied verbatim from main.js:1906-1908 so this
//  measures the line the app actually writes, not a tidier one.
const BRIDGES = [
    'Bridge obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gAVGcKRMVJaRJGaFoMK0IQWY9HfRRmRPf6VWB7uIKwFoiX3y7GFhRvmFMKOgA3FScOQ iat-mode=0',
    'Bridge obfs4 109.105.109.165:10527 8DFCD8FB3285E855F5A55BDCD4E1DB1AEDB3F8B6 cert=XCHbbbz2aO5B8iVKQV+sNqz8CxCaU7FHWNiQyPFKXYZBiQFHpOq73VKwIq0KPrOJYA iat-mode=0',
    'Bridge obfs4 45.145.95.6:27015 C5B7CD6946FF10C5B3E89691A7D3F2C122D2117C cert=TD7bwPBhFCFRlSPaG/dPFRhTbT14q4ExKb0C1Jze8P7WRvDJW9nWz9wWe4xdGEi+5u5yqA iat-mode=0',
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-obfs4-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => s.replace(/\\/g, '/');   //  main.js:1799, byte for byte

//  Two homes for the same binary: one whose absolute path has no space (the
//  shape C:\ProgramData\freeproxy-vpn produces) and one that has one (the
//  shape the default %APPDATA% would have produced for this very user, whose
//  Windows account is literally named "User pc").
const HOME_PLAIN = path.join(TMP, 'plainpath', 'pluggable_transports');
const HOME_SPACE = path.join(TMP, 'path with space', 'pluggable_transports');
for (const d of [HOME_PLAIN, HOME_SPACE]) {
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(LYRE_SRC, path.join(d, 'lyrebird.exe'));
}

const ARMS = [
    ['A  quoted   , no space in path   (what main.js:1905 ships)', true,  HOME_PLAIN],
    ['B  bare     , no space in path   (the proposed fix)',        false, HOME_PLAIN],
    ['C  quoted   , space in path',                                true,  HOME_SPACE],
    ['D  bare     , space in path',                                false, HOME_SPACE],
];

function torrcFor(i, quoted, home) {
    const dataDir = path.join(TMP, `data${i}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const lyre = path.join(home, 'lyrebird.exe');
    const exec = quoted ? `"${q(lyre)}"` : q(lyre);
    const lines = [
        `SocksPort 19${60 + i}0`,
        `DataDirectory ${q(dataDir)}`,
        `GeoIPFile ${q(GEOIP)}`,
        `GeoIPv6File ${q(GEOIP6)}`,
        'Log notice stdout',
        'ClientOnly 1',
        'UseBridges 1',
        `ClientTransportPlugin obfs4 exec ${exec}`,
        ...BRIDGES,
        '',
    ].join('\n');
    const file = path.join(TMP, `torrc${i}`);
    fs.writeFileSync(file, lines, 'utf8');
    return { file, dataDir, lyre, exec };
}

function classify(out) {
    const has = re => re.test(out);
    if (has(/CreateProcessA\(\) failed/i))            return 'PT DID NOT LAUNCH -- CreateProcessA() failed';
    if (has(/Could not launch.*managed proxy/i))      return 'PT DID NOT LAUNCH -- tor could not launch it';
    if (has(/Failed to parse\/validate config/i))     return 'CONFIG REJECTED -- tor refused the file';
    if (has(/conn_done_pt|Connected to pluggable transport/i))
        return 'PT LAUNCHED and tor connected THROUGH it';
    if (has(/conn_pt|Connecting to pluggable transport/i))
        return 'PT LAUNCHED (tor got as far as dialling through it)';
    if (has(/no configured transport called/i))       return 'PT MISSING -- transport never registered';
    return 'inconclusive -- see the log below';
}

(async () => {
    const L = [];
    L.push(`tor.exe        : ${TOR_EXE}`);
    L.push(`lyrebird src   : ${LYRE_SRC}`);
    L.push(`run per arm    : ${RUN_MS} ms`);
    L.push(`temp root      : ${TMP}`);
    L.push('');

    for (let i = 0; i < ARMS.length; i++) {
        const [tag, quoted, home] = ARMS[i];
        const cfg = torrcFor(i, quoted, home);
        let out = '';
        const child = spawn(TOR_EXE, ['-f', cfg.file], {
            cwd: path.join(ROOT, 'Tor', 'tor'), windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { out += d.toString(); });
        let exited = null;
        child.on('exit', c => { exited = c; });
        await sleep(RUN_MS);
        if (exited === null) {
            try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
        }
        await sleep(600);
        try { execFileSync('taskkill', ['/F', '/IM', 'lyrebird.exe'], { stdio: 'ignore' }); } catch (e) {}

        L.push(`──── ${tag}`);
        L.push(`   plugin line   : ClientTransportPlugin obfs4 exec ${cfg.exec}`);
        L.push(`   file is there : ${fs.existsSync(cfg.lyre) ? 'yes' : 'NO'}`);
        L.push(`   tor exited    : ${exited === null ? 'no, still running when killed' : 'yes, code ' + exited}`);
        L.push(`   VERDICT       : ${classify(out)}`);
        const keep = out.split(/\r?\n/).filter(l =>
            /CreateProcessA|managed proxy|pluggable transport|conn_pt|no configured transport|Bootstrapped|obfs4|Failed to parse|Could not launch|error|warn/i.test(l));
        L.push('   tor said      :');
        for (const l of keep.slice(0, 24)) L.push('      ' + l.trim());
        if (!keep.length) L.push('      (nothing matched -- full output below)');
        if (!keep.length) for (const l of out.split(/\r?\n/).slice(0, 20)) L.push('      ' + l.trim());
        L.push('');
        console.log(L.slice(-8).join('\n'));
    }

    L.push('── what this decides ─────────────────────────────────────────');
    L.push('   A vs B  : whether the quote characters are the defect');
    L.push('   B vs D  : whether a space in the path is a second, separate defect');
    L.push('   C vs A  : whether the space adds anything once the quotes are there');
    const text = L.join('\n');
    fs.writeFileSync(path.join(__dirname, 'probe-obfs4-quotes.txt'), text);
    console.log('\nwritten: .build/probe-obfs4-quotes.txt');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });
