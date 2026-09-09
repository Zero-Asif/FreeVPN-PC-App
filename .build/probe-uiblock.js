'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-uiblock.js -- what the connect path spends, and whether it
//  spends it on Electron's main thread.
//
//  WRITTEN when every call below ran synchronously inside startTor(), on
//  the same thread that pumps the window's message queue. Windows paints
//  "(Not Responding)" over a window whose queue has not been serviced for
//  ~5 s, and these calls together were most of that budget -- the reported
//  "country switching er somoy, 1st connect korar somoy, disconnect korar
//  somoy app not responding dekhacche abar thik hoye jacche".
//
//  THEY ARE NO LONGER SYNCHRONOUS, so the timings below are the cost of a
//  connect in WALL CLOCK, not in frozen window. The final section reads
//  main.js and says which they are, because a number this file prints must
//  never be readable as a live freeze once the freeze has been fixed.
//
//  Read-only or no-op commands only: taskkill against an image that is
//  not running, tor --verify-config against a throwaway file in TEMP,
//  and queries. Nothing here stops a service or changes any state --
//  `net stop dnscache`, the one call in that path that cannot be timed
//  without stopping the machine's DNS cache, is only QUERIED here.
// ════════════════════════════════════════════════════════════════════

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const torDir = path.join(__dirname, '..', 'Tor', 'tor');
const torExe = path.join(torDir, 'tor.exe');

const rows = [];
function time(what, fn, note = '') {
    const t0 = process.hrtime.bigint();
    let err = null;
    try { fn(); } catch (e) { err = (e.message || '').split('\n')[0].slice(0, 60); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push({ what, ms, note: note || (err ? 'threw: ' + err : '') });
    console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${what}${rows[rows.length - 1].note ? '   (' + rows[rows.length - 1].note + ')' : ''}`);
    return ms;
}

console.log(`\n── the cost of a connect -- ${new Date().toISOString()} ──`);
console.log('   each of these used to freeze the window for its whole duration\n');

//  killTor(), line 1897. Nothing to kill right now, so this is the FLOOR:
//  the cost of cmd.exe + taskkill starting up, before it has any work.
time('execSync taskkill /F /IM tor.exe /IM lyrebird.exe  (no tor running)',
     () => execSync('taskkill /F /IM tor.exe /IM lyrebird.exe',
                    { stdio: 'ignore', windowsHide: true }));

//  isAdmin(), line 523.
time('execSync net session',
     () => execSync('net session', { stdio: 'ignore', windowsHide: true }));

//  verifyTorrc(), line 1878 -- the real binary, a real config file.
const tmprc = path.join(os.tmpdir(), 'fp-uiblock-' + process.pid + '.torrc');
fs.writeFileSync(tmprc, [
    'SocksPort 9050',
    'ControlPort 9051',
    'CookieAuthentication 1',
    `DataDirectory ${path.join(os.tmpdir(), 'fp-uiblock-data-' + process.pid)}`,
].join('\n'), 'utf8');
if (fs.existsSync(torExe)) {
    const r = { status: null };
    time('spawnSync tor.exe --verify-config',
         () => { const x = spawnSync(torExe, ['--verify-config', '-f', tmprc],
                     { cwd: torDir, windowsHide: true, encoding: 'utf8', timeout: 20000 });
                 r.status = x.status; },
         '');
    console.log(`         (tor exited ${r.status})`);
    //  Twice, because the first run pays Defender's scan of tor.exe and the
    //  second does not -- and a switch after an update pays the first one.
    time('spawnSync tor.exe --verify-config  (second run, file cache warm)',
         () => spawnSync(torExe, ['--verify-config', '-f', tmprc],
                   { cwd: torDir, windowsHide: true, encoding: 'utf8', timeout: 20000 }));
} else {
    console.log('       --  tor.exe not at ' + torExe + ', skipped');
}
try { fs.unlinkSync(tmprc); } catch (e) {}
try { fs.rmSync(path.join(os.tmpdir(), 'fp-uiblock-data-' + process.pid),
                { recursive: true, force: true }); } catch (e) {}

//  isProcessRunning(), line 3799.
time('execSync tasklist /FI "IMAGENAME eq tor.exe" /NH',
     () => execSync('tasklist /FI "IMAGENAME eq tor.exe" /NH',
                    { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }));

//  The one that cannot be timed without stopping the machine's DNS cache.
//  Its STATE is readable, and that is what decides whether the app pays for
//  it at all: `net stop` on an already-stopped service returns immediately.
console.log('');
let dnsState = 'unknown';
try {
    const out = execSync('sc query dnscache', { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
    dnsState = (out.match(/STATE\s+:\s+\d+\s+(\w+)/) || [])[1] || 'unparsed';
} catch (e) { dnsState = 'query failed: ' + (e.message || '').split('\n')[0]; }
console.log(`  dnscache is ${dnsState} -- startTor() runs \`net stop dnscache /y\` on it,`);
console.log('  timeout 15000. NOT timed here: stopping it would take this machine\'s DNS');
console.log('  cache down. That 15 s is the author\'s own statement about how long it can');
console.log('  take, and it is 3x the ~5 s after which Windows paints "(Not Responding)" --');
console.log('  which is why it, above all, had to come off the main thread.');

const sum = rows.reduce((a, r) => a + r.ms, 0);
console.log(`\n  measured total, dnscache excluded: ${sum.toFixed(0)} ms`);
console.log('  on every connect and every switch that restarts tor.');

// ════════════════════════════════════════════════════════════════════
//  Is any of it still on the main thread?
//
//  The numbers above are only a freeze if startTor() waits for them
//  synchronously. Read main.js and say so, rather than leaving a reader to
//  assume the state of the code from the year the header was written.
// ════════════════════════════════════════════════════════════════════
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const from = mainSrc.indexOf('    async function startTor(');
const to   = mainSrc.indexOf('\r\n    }', mainSrc.indexOf("finish(false, 'timeout')", from));
const body = from > 0 && to > from ? mainSrc.slice(from, to) : '';

console.log('\n── and whether the window is still the thread that waits ──\n');
if (!body) {
    console.log('  could not locate startTor() in main.js -- say nothing rather than guess');
} else {
    const sync = (body.match(/\b(execSync|spawnSync|readFileSync|writeFileSync)\s*\(/g) || [])
        .map(s => s.replace(/\s*\($/, ''));
    const awaited = [
        ['taskkill',      /killTor\(\{\s*blocking:\s*false\s*\}\)/],
        ['verify-config', /await verifyTorrc\(/],
        ['net stop dnscache', /runQuiet\('net', \['stop', 'dnscache'/],
    ];
    for (const [what, re] of awaited) {
        console.log(`  ${re.test(body) || re.test(mainSrc) ? 'async ' : 'BLOCKS'}  ${what}`);
    }
    console.log(`  ${/runQuiet\('tasklist'/.test(mainSrc) ? 'async ' : 'BLOCKS'}  tasklist`);
    console.log('');
    console.log(`  synchronous calls left inside startTor(): ${sync.length}` +
                (sync.length ? '  -- ' + [...new Set(sync)].join(', ') : ''));
    console.log('  (a writeFileSync of the torrc is one small file on a local disk and is');
    console.log('   not what a 5 s budget is spent on; a *Sync spawn would be.)');
    const spawns = sync.filter(s => /exec|spawn/.test(s));
    console.log(`\n  ${spawns.length === 0
        ? 'NO synchronous spawn on the connect path -- the event loop keeps turning, so'
        : 'STILL ' + spawns.length + ' synchronous spawn(s) on the connect path, so'}`);
    console.log(`  the ${sum.toFixed(0)} ms above is ${spawns.length === 0
        ? 'wall clock the window stays paintable through' : 'frozen window'}.`);
}
