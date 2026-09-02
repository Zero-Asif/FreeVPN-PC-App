'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-uiblock-geo.js -- the OTHER half of the frozen window.
//
//  startTor()'s blocking calls are now off the main thread. This probe
//  answers what is left: applyGeolocationSpoof() runs on every connect
//  AND every switch, and everything it does to the registry, the
//  services and Firefox goes through synchronous execSync/PowerShell on
//  Electron's main thread -- the thread that pumps the window's message
//  queue, and the reason Windows paints "(Not Responding)".
//
//  NOTHING IS EXECUTED HERE. child_process.execSync is replaced before
//  the modules are loaded, so every command is COUNTED and returned as
//  an empty string instead of being run. No registry key, no service,
//  no Firefox profile and no policy is touched. The per-call cost is
//  measured separately, against a read-only `reg query` of a key this
//  app does not own, and one `powershell -NoProfile -Command $null`.
//
//  The state directory is a throwaway in TEMP, so the app's real
//  journal is not read or rewritten either.
// ════════════════════════════════════════════════════════════════════

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ── 1. what one synchronous shell call actually costs here ───────────
const REG_CMD = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuild';
const REPS = 10;
let t = process.hrtime.bigint();
for (let i = 0; i < REPS; i++) {
    try { cp.execSync(REG_CMD, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); } catch (e) {}
}
const perReg = ms(t) / REPS;

t = process.hrtime.bigint();
try {
    cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null"',
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
} catch (e) {}
const perPs1 = ms(t);
t = process.hrtime.bigint();
try {
    cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null"',
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
} catch (e) {}
const perPs2 = ms(t);

console.log(`\n── one synchronous call, measured -- ${new Date().toISOString()} ──`);
console.log(`  reg query, mean of ${REPS}:            ${perReg.toFixed(0)} ms`);
console.log(`  powershell -NoProfile "$null", cold:  ${perPs1.toFixed(0)} ms`);
console.log(`  powershell -NoProfile "$null", warm:  ${perPs2.toFixed(0)} ms`);

// ── 2. count what a connect/switch asks for, without running any of it ──
const calls = [];
cp.execSync = function (cmd, opts) {
    calls.push(String(cmd));
    return '';
};

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-uiblock-geo-'));
const quietLog = { info(){}, warn(){}, error(){}, debug(){}, success(){} };

//  applyAll's Firefox step writes user.js into REAL profiles with
//  fs.writeFileSync -- which does not go through execSync and so is not
//  stubbed by the recorder above. Allow writes only inside the throwaway
//  state dir; refuse and count everything else.
const blocked = [];
const realWrite  = fs.writeFileSync.bind(fs);
const realUnlink = fs.unlinkSync.bind(fs);
const ALLOW = path.resolve(stateDir).toLowerCase();
const insideAllow = p => {
    try { return path.resolve(String(p)).toLowerCase().startsWith(ALLOW); } catch (e) { return false; }
};
fs.writeFileSync = (p, ...r) => insideAllow(p) ? realWrite(p, ...r) : void blocked.push(String(p));
fs.unlinkSync    = (p, ...r) => insideAllow(p) ? realUnlink(p, ...r) : void blocked.push(String(p));

const { GeoSpoof } = require('../lib/geo-spoof.js');
//  The shape main.js's GEO_COORDS uses: lat/lng, not lat/lon. Passing `lon`
//  makes _ffBlock() throw on coord.lng.toFixed() and cuts the count short.
const COORD = { lat: 59.3293, lng: 18.0686, accuracy: 12 };      // Stockholm

let spoofCalls = 0, spoofMs = 0;
try {
    const geo = new GeoSpoof({ log: quietLog, stateDir });
    const t1 = process.hrtime.bigint();
    geo.applyAll(COORD);
    spoofMs = ms(t1);
    spoofCalls = calls.length;
} catch (e) {
    console.log('\n  geo.applyAll threw with execSync stubbed: ' + e.message);
    spoofCalls = calls.length;
}

const byExe = {};
for (const c of calls) {
    const exe = (c.trim().split(/[\s"]/)[0] || '?').toLowerCase().replace(/\.exe$/, '');
    byExe[exe] = (byExe[exe] || 0) + 1;
}

console.log('\n── applyGeolocationSpoof step 4: GeoSpoof.applyAll(coord) ──');
console.log(`  ${spoofCalls} synchronous shell call(s), by program:`);
for (const [exe, n] of Object.entries(byExe).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(3)} x ${exe}`);
}
const est = Object.entries(byExe).reduce((a, [exe, n]) =>
    a + n * (exe === 'powershell' ? perPs2 : perReg), 0);
console.log(`  own runtime with every command STUBBED OUT: ${spoofMs.toFixed(0)} ms`);
console.log(`  estimated real cost at the rates above:     ${est.toFixed(0)} ms of frozen window`);
console.log('  (reg-rate for reg/sc/netsh/certutil, warm-powershell rate for powershell;');
console.log('   netsh and sc are SLOWER than reg query, so this is a floor, not a guess.)');

//  Reads have to stay one call each -- their output IS the answer. Writes do
//  not: 30 `reg add` lines in one batch file cost one process spawn instead
//  of thirty, which is where the time actually goes.
const verb = c => {
    const m = /^(\w+)(?:\.exe)?\s+(\w+)?/.exec(c.trim());
    if (!m) return 'other';
    const p = m[1].toLowerCase(), v = (m[2] || '').toLowerCase();
    if (p === 'reg') return 'reg ' + v;
    return p;
};
const byVerb = {};
for (const c of calls) byVerb[verb(c)] = (byVerb[verb(c)] || 0) + 1;
console.log('\n── read vs write, because only the writes can be batched ──');
for (const [v, n] of Object.entries(byVerb).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(3)} x ${v}`);
}
const writes = (byVerb['reg add'] || 0) + (byVerb['reg delete'] || 0);
console.log(`  ${writes} of ${calls.length} are registry WRITES = ` +
            `${(writes * perReg).toFixed(0)} ms, and they carry no answer back.`);

if (est > 5000) {
    console.log('\n  > 5000 ms: on its own this crosses the threshold at which Windows');
    console.log('    paints "(Not Responding)" on the window.');
} else {
    console.log(`\n  Under the ~5000 ms "(Not Responding)" threshold on its own,`);
    console.log('    but it runs in the same second as everything else on the connect path.');
}

try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
console.log('\n  nothing was executed: execSync was replaced before the module loaded,');
console.log('  and the state dir was a throwaway in TEMP.');
console.log(`  ${blocked.length} file write(s) outside it were refused` +
            (blocked.length ? ` -- first: ${blocked[0]}` : '') +
            (blocked.length ? '\n  (those are the Firefox profiles the real run writes to)' : ''));
