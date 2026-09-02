'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-uiblock.js -- how long the connect path stops pumping window
//  messages.
//
//  Every call below runs on Electron's main thread inside startTor(),
//  which is the same thread that pumps the window's message queue.
//  Windows paints the "(Not Responding)" title and the ghost window
//  when that queue is not serviced for ~5 s. So the question is not
//  whether these calls are slow in the abstract -- it is how much of
//  that 5 s budget they spend, one after another, with the progress
//  bar on screen.
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

console.log(`\n── blocking calls on the connect path -- ${new Date().toISOString()} ──`);
console.log('   each one freezes the window for its whole duration\n');

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
console.log('  spawnSync, timeout 15000. NOT timed here: stopping it would take this');
console.log("  machine's DNS cache down. The 15 s timeout in main.js is the author's own");
console.log('  statement about how long it can take, and it is 3x the ~5 s after which');
console.log('  Windows paints "(Not Responding)".');

const sum = rows.reduce((a, r) => a + r.ms, 0);
console.log(`\n  measured total, dnscache excluded: ${sum.toFixed(0)} ms of frozen window`);
console.log('  on every connect and every switch that restarts tor.');
